import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { timelineSchema, dimensions, durationOf } from "../shared/contracts.js";
import { binary, importMedia, probe, runProcess } from "./media.js";
import { StudioError, safeName } from "./store.js";

export function tempoFilters(speed) {
  const parts = [];
  let remainder = speed;
  while (remainder > 2) {
    parts.push("atempo=2");
    remainder /= 2;
  }
  while (remainder < 0.5) {
    parts.push("atempo=0.5");
    remainder /= 0.5;
  }
  parts.push(`atempo=${remainder}`);
  return parts.join(",");
}

export function validateTimeline(store, input) {
  const timeline = timelineSchema.parse(input);
  if (!timeline.clips.length)
    throw new StudioError("Hãy thêm ít nhất một clip hoặc ảnh vào timeline.");
  for (const clip of timeline.clips) {
    const media = store.require("media", clip.mediaId);
    if (media.kind === "audio")
      throw new StudioError("Không thể dùng tệp âm thanh làm clip hình.");
    if (media.kind === "video" && clip.outSec > media.duration + 0.05) {
      throw new StudioError(`Điểm cắt vượt thời lượng của ${media.name}.`);
    }
    if (media.kind === "image" && clip.outSec > 600)
      throw new StudioError("Mỗi ảnh trên timeline tối đa 600 giây.");
  }
  const duration = durationOf(timeline);
  if (duration > 7200) throw new StudioError("Mỗi lần xuất tối đa 2 giờ.");
  for (const overlay of [...timeline.texts, ...timeline.images]) {
    if (
      overlay.endSec <= overlay.startSec ||
      overlay.endSec > duration + 0.05
    ) {
      throw new StudioError(
        "Thời gian chữ/logo phải nằm trong timeline và có điểm cuối sau điểm đầu.",
      );
    }
  }
  for (const image of timeline.images) {
    if (store.require("media", image.mediaId).kind !== "image")
      throw new StudioError("Logo phải là tệp ảnh.");
  }
  if (timeline.music) {
    const media = store.require("media", timeline.music.mediaId);
    if (!media.hasAudio) throw new StudioError("Tệp nhạc không có âm thanh.");
    if (timeline.music.offsetSec >= media.duration)
      throw new StudioError("Điểm bắt đầu nhạc vượt thời lượng tệp.");
    if (timeline.music.startSec >= duration)
      throw new StudioError("Nhạc phải bắt đầu trong timeline.");
  }
  return timeline;
}

export async function renderTimeline(store, job, signal, progress) {
  const timeline = validateTimeline(store, job.payload.timeline);
  const canvas = dimensions(timeline);
  const duration = durationOf(timeline);
  const tempRoot = path.join(store.root, "temp");
  const directory = await fs.mkdtemp(path.join(tempRoot, "render-"));
  const ffmpeg = binary("ffmpeg", store.state.settings);
  const crf = { draft: 27, standard: 21, high: 17 }[timeline.quality];
  const encoding = [
    "-c:v",
    "libx264",
    "-preset",
    timeline.quality === "draft" ? "ultrafast" : "veryfast",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-threads",
    String(Math.max(1, Math.min(32, Number(store.state.settings.renderThreads) || 4))),
  ];
  const baseArgs = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-nostdin",
    "-progress",
    "pipe:1",
    "-stats_period",
    "0.5",
  ];
  let lastProgress = 0;
  const report = (percent, stage) => {
    if (Date.now() - lastProgress > 450 || percent >= 99) {
      progress(Math.min(99, percent), stage);
      lastProgress = Date.now();
    }
  };
  const run = (args, total, start, weight, stage) =>
    runProcess(ffmpeg, [...baseArgs, ...args], {
      signal,
      cwd: directory,
      onLine: (line) => {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match)
          report(
            start + Math.min(1, Number(match[1]) / 1000000 / total) * weight,
            stage,
          );
      },
    });

  try {
    let completed = 0;
    const entries = [];
    for (let index = 0; index < timeline.clips.length; index += 1) {
      signal.throwIfAborted();
      const clip = timeline.clips[index];
      const media = store.require("media", clip.mediaId);
      const length = (clip.outSec - clip.inSec) / clip.speed;
      const args = [];
      if (media.kind === "image")
        args.push(
          "-loop",
          "1",
          "-framerate",
          String(timeline.fps),
          "-i",
          media.file,
        );
      else
        args.push(
          "-ss",
          String(clip.inSec),
          "-t",
          String(clip.outSec - clip.inSec),
          "-i",
          media.file,
        );
      const audible =
        media.hasAudio &&
        timeline.originalAudio !== "mute" &&
        media.kind !== "image";
      if (!audible)
        args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      const { width, height } = canvas;
      const fit =
        clip.fit === "cover"
          ? `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${width}:${height}`
          : `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
      const zoom =
        clip.zoom > 1
          ? `,scale=${Math.ceil((width * clip.zoom) / 2) * 2}:${Math.ceil((height * clip.zoom) / 2) * 2},crop=${width}:${height}`
          : "";
      const volume =
        clip.volume *
        { keep: 1, lower: 0.25, boost: 1.5, mute: 0 }[timeline.originalAudio];
      const videoFilter = `[0:v]setpts=(PTS-STARTPTS)/${clip.speed},${fit}${zoom},fps=${timeline.fps},setsar=1,format=yuv420p[v]`;
      const audioFilter = audible
        ? `[0:a]asetpts=PTS-STARTPTS,${tempoFilters(clip.speed)},volume=${volume},aresample=48000,apad,atrim=duration=${length}[a]`
        : `[1:a]atrim=duration=${length},asetpts=PTS-STARTPTS[a]`;
      const filename = `clip-${index}.mp4`;
      args.push(
        "-filter_complex_threads",
        "2",
        "-filter_complex",
        `${videoFilter};${audioFilter}`,
        "-map",
        "[v]",
        "-map",
        "[a]",
        ...encoding,
        "-t",
        String(length),
        filename,
      );
      const stage = `Chuẩn hóa clip ${index + 1}/${timeline.clips.length}`;
      progress((completed / duration) * 70, stage);
      await run(
        args,
        length,
        (completed / duration) * 70,
        (length / duration) * 70,
        stage,
      );
      entries.push(`file '${filename}'`);
      completed += length;
    }

    await fs.writeFile(
      path.join(directory, "clips.txt"),
      entries.join("\n"),
      "utf8",
    );
    progress(71, "Ghép các clip");
    await run(
      [
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        "clips.txt",
        "-c",
        "copy",
        "merged.mp4",
      ],
      duration,
      71,
      3,
      "Ghép các clip",
    );

    const args = ["-i", "merged.mp4"];
    const filters = [];
    let video = "0:v";
    let inputIndex = 1;
    for (let index = 0; index < timeline.images.length; index += 1) {
      const overlay = timeline.images[index];
      const media = store.require("media", overlay.mediaId);
      args.push(
        "-loop",
        "1",
        "-framerate",
        String(timeline.fps),
        "-i",
        media.file,
      );
      const size = Math.max(2, Math.round(canvas.width * overlay.scale));
      filters.push(
        `[${inputIndex}:v]scale=${size}:-1,format=rgba,colorchannelmixer=aa=${overlay.opacity}[logo${index}]`,
      );
      filters.push(
        `[${video}][logo${index}]overlay=x=main_w*${overlay.x}-overlay_w/2:y=main_h*${overlay.y}-overlay_h/2:enable='gte(t,${overlay.startSec})*lt(t,${overlay.endSec})':eof_action=repeat[v${index}]`,
      );
      video = `v${index}`;
      inputIndex += 1;
    }

    if (timeline.texts.length) {
      const fonts = [
        process.env.STUDIO_FONT_PATH,
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      ].filter(Boolean);
      const font = fonts.find((file) => fsSync.existsSync(file));
      if (!font)
        throw new StudioError(
          "Chưa tìm thấy font chữ. Đặt STUDIO_FONT_PATH tới một tệp .ttf.",
          "FONT_MISSING",
        );
      await fs.copyFile(font, path.join(directory, "font.ttf"));
      for (let index = 0; index < timeline.texts.length; index += 1) {
        const text = timeline.texts[index];
        await fs.writeFile(
          path.join(directory, `text-${index}.txt`),
          text.text,
          "utf8",
        );
        const box = text.background
          ? ":box=1:boxcolor=black@0.6:boxborderw=12"
          : "";
        filters.push(
          `[${video}]drawtext=fontfile=font.ttf:textfile=text-${index}.txt:expansion=none:fontsize=${text.size}:fontcolor=${text.color}:borderw=2:bordercolor=black:shadowx=1:shadowy=1:x=w*${text.x}-tw/2:y=h*${text.y}-th/2:enable='gte(t,${text.startSec})*lt(t,${text.endSec})'${box}[text${index}]`,
        );
        video = `text${index}`;
      }
    }

    let audio = "0:a";
    if (timeline.music) {
      const music = timeline.music;
      const media = store.require("media", music.mediaId);
      if (music.loop) args.push("-stream_loop", "-1");
      args.push("-ss", String(music.offsetSec), "-i", media.file);
      const musicDuration = duration - music.startSec;
      filters.push(
        `[${inputIndex}:a]asetpts=PTS-STARTPTS,${tempoFilters(music.speed)},volume=${music.volume},apad,atrim=duration=${musicDuration},afade=t=in:st=0:d=${Math.min(music.fadeIn, musicDuration)},afade=t=out:st=${Math.max(0, musicDuration - music.fadeOut)}:d=${Math.min(music.fadeOut, musicDuration)},adelay=${Math.round(music.startSec * 1000)}:all=1[music]`,
      );
      filters.push(
        "[0:a][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[audio]",
      );
      audio = "audio";
    }
    if (filters.length) {
      await fs.writeFile(
        path.join(directory, "filters.txt"),
        filters.join(";\n"),
        "utf8",
      );
      args.push(
        "-filter_complex_threads",
        "2",
        "-filter_complex_script",
        "filters.txt",
      );
    }
    args.push(
      "-map",
      video.includes(":") ? video : `[${video}]`,
      "-map",
      audio.includes(":") ? audio : `[${audio}]`,
    );
    if (filters.length) args.push(...encoding);
    else args.push("-c", "copy");
    args.push("-t", String(duration), "-movflags", "+faststart", "output.mp4");
    progress(75, "Xuất chữ, logo và âm thanh");
    await run(args, duration, 75, 23, "Xuất chữ, logo và âm thanh");
    signal.throwIfAborted();
    const output = path.join(directory, "output.mp4");
    const metadata = await probe(output, store.state.settings);
    if (
      metadata.width !== canvas.width ||
      metadata.height !== canvas.height ||
      Math.abs(metadata.duration - duration) >
        Math.max(0.3, timeline.clips.length / timeline.fps)
    ) {
      throw new StudioError(
        "Kiểm tra đầu ra thất bại: kích thước hoặc thời lượng không khớp timeline.",
        "OUTPUT_VALIDATION_FAILED",
        500,
      );
    }
    progress(99, "Lưu vào thư viện");
    return await importMedia(store, output, {
      projectId: job.projectId,
      name: `${safeName(job.name)}.mp4`,
      move: true,
      generated: true,
      jobId: job.id,
    });
  } finally {
    const resolved = path.resolve(directory);
    if (resolved.startsWith(path.resolve(tempRoot) + path.sep)) {
      await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
    }
  }
}
