import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { binary, importMedia, probe, runProcess } from "./media.js";
import { StudioError, safeName } from "./store.js";

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;
const TRANSITION = 0.42;

function fontPath() {
  const candidates = [
    path.resolve(import.meta.dirname, "../dist/fonts/news/BarlowCondensed-ExtraBold.ttf"),
    path.resolve(import.meta.dirname, "../public/fonts/news/BarlowCondensed-ExtraBold.ttf"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function clean(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function wrap(value, maxChars = 28, maxLines = 2) {
  const words = clean(value).split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > maxChars) {
      lines.push(line);
      line = word;
    } else line = next;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  return lines.slice(0, maxLines).join("\n");
}

function sentences(value) {
  return clean(value, 1000)
    .split(/(?<=[.!?])\s+/u)
    .map((item) => clean(item, 180))
    .filter((item) => item.length > 8)
    .slice(0, 5);
}

function presenterFilter(width, height) {
  const target = 320 / 360;
  const aspect = width / Math.max(1, height);
  if (aspect > target) {
    const crop = Math.round(height * target);
    return `scale=-2:${height},crop=${crop}:${height}`;
  }
  const crop = Math.round(width / target);
  return `scale=${width}:-2,crop=${width}:${crop}`;
}

async function writeText(directory, name, value) {
  const file = path.join(directory, name);
  await fsPromises.writeFile(file, String(value || ""), "utf8");
  return file;
}

function reportFromProgress(line, duration, update, stage, start, weight) {
  const match = /^out_time_us=(\d+)/.exec(line);
  if (!match) return;
  const ratio = Math.min(1, Number(match[1]) / 1_000_000 / Math.max(0.1, duration));
  update(Math.min(99, start + ratio * weight), stage);
}

/**
 * Produce the news broadcast composition around a real DreamFace Avatar file.
 * The Avatar video remains one continuous foreground track while the editorial
 * background uses animated Ken Burns shots and overlapping xfade transitions.
 */
export async function renderNewsBroadcast(store, job, presenter, plan, images, signal, update = () => {}) {
  if (!presenter?.file || presenter.kind !== "video" || !presenter.hasAudio) {
    throw new StudioError("DreamFace did not return a presenter video with audio.", "NEWS_PRESENTER_AUDIO_REQUIRED", 422);
  }
  const usable = images.filter((item) => item?.file && item.kind === "image").slice(0, 5);
  if (!usable.length) throw new StudioError("News broadcast needs at least one verified editorial image.", "NEWS_IMAGES_REQUIRED", 422);
  const font = fontPath();
  if (!font) throw new StudioError("The bundled news font is missing.", "NEWS_FONT_MISSING", 500);
  const duration = Math.max(12, Math.min(60, Number(presenter.duration) || 15));
  const segment = (duration + (usable.length - 1) * TRANSITION) / usable.length;
  const frames = Math.max(30, Math.round(segment * FPS));
  const tempRoot = path.join(store.root, "temp");
  const directory = await fsPromises.mkdtemp(path.join(tempRoot, "news-broadcast-"));
  const ffmpeg = binary("ffmpeg", store.state.settings);
  const safePlan = {
    headline: clean(plan?.headline || "News update", 100),
    narration: clean(plan?.narration || "", 500),
    source: clean(plan?.source || "News report", 100),
    brand: clean(plan?.brand || "VIRAL NEWS", 24),
  };
  try {
    signal.throwIfAborted();
    await fsPromises.copyFile(font, path.join(directory, "news-font.ttf"));
    const headlineFile = await writeText(directory, "headline.txt", wrap(safePlan.headline, 27, 3).toUpperCase());
    const sourceFile = await writeText(directory, "source.txt", `SOURCE: ${safePlan.source.toUpperCase()}`);
    const brandFile = await writeText(directory, "brand.txt", safePlan.brand.toUpperCase());
    const ctaFile = await writeText(directory, "cta.txt", "FULL STORY\nIN THE FIRST COMMENT");
    const captionFiles = [];
    const captionList = sentences(safePlan.narration).filter((item) => !/first comment/i.test(item));
    const usableCaptionList = captionList.length ? captionList : [safePlan.headline];
    for (let index = 0; index < usableCaptionList.length; index += 1) {
      captionFiles.push(await writeText(directory, `caption-${index}.txt`, wrap(usableCaptionList[index], 31, 2).toUpperCase()));
    }
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-nostdin", "-progress", "pipe:1", "-stats_period", "0.5"];
    for (const image of usable) args.push("-loop", "1", "-i", image.file);
    args.push("-i", presenter.file);
    const presenterInput = usable.length;
    const filters = [];
    for (let index = 0; index < usable.length; index += 1) {
      const direction = index % 2 === 0 ? "in" : "out";
      const start = direction === "in" ? 1.025 : 1.14;
      const end = direction === "in" ? 1.14 : 1.025;
      const zoom = `${start.toFixed(4)}${direction === "in" ? "+" : "-"}${Math.abs(end - start).toFixed(4)}*on/${Math.max(1, frames - 1)}`;
      const panX = `(iw-iw/zoom)*(${index % 3 === 0 ? "0.28" : index % 3 === 1 ? "0.56" : "0.40"})`;
      const panY = `(ih-ih/zoom)*(${index % 2 === 0 ? "0.30" : "0.62"})`;
      filters.push(`[${index}:v]scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,zoompan=z='${zoom}':x='${panX}':y='${panY}':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},setsar=1,format=yuv420p[shot${index}]`);
    }
    let background = "shot0";
    let backgroundDuration = segment;
    for (let index = 1; index < usable.length; index += 1) {
      const output = `mix${index}`;
      filters.push(`[${background}][shot${index}]xfade=transition=fade:duration=${TRANSITION}:offset=${Math.max(0, backgroundDuration - TRANSITION).toFixed(3)}[${output}]`);
      background = output;
      backgroundDuration += segment - TRANSITION;
    }
    const presenterMeta = await probe(presenter.file, store.state.settings);
    const pFilter = presenterFilter(320, 360);
    filters.push(`[${presenterInput}:v]${pFilter},scale=320:360,setsar=1,format=rgba[mc]`);
    filters.push(`[${presenterInput}:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11[voice]`);
    filters.push(`[${background}]drawbox=x=0:y=0:w=iw:h=ih:color=#071526@0.12:t=fill[dim]`);
    filters.push(`[dim]drawbox=x=58:y=958:w=354:h=405:color=#071526@0.95:t=fill[mcframe]`);
    filters.push(`[mcframe][mc]overlay=x=75:y=978:enable='lt(t,${duration.toFixed(3)})'[presenter]`);
    filters.push(`[presenter]drawbox=x=58:y=958:w=354:h=52:color=#d71920:t=fill,drawtext=fontfile=news-font.ttf:textfile=brand.txt:fontcolor=white:fontsize=30:x=75:y=968:enable='lt(t,${duration.toFixed(3)})'[label]`);
    filters.push(`[label]drawbox=x=64:y=1410:w=348:h=56:color=#d71920:t=fill,drawtext=fontfile=news-font.ttf:textfile=brand.txt:fontcolor=white:fontsize=32:x=82:y=1420:enable='lt(t,${duration.toFixed(3)})'[strap]`);
    filters.push(`[strap]drawbox=x=64:y=1466:w=952:h=184:color=white@0.96:t=fill,drawtext=fontfile=news-font.ttf:textfile=headline.txt:fontcolor=#081a32:fontsize=50:line_spacing=2:x=88:y=1490:enable='lt(t,${duration.toFixed(3)})'[headline]`);
    filters.push(`[headline]drawbox=x=900:y=1466:w=116:h=184:color=#d71920:t=fill,drawtext=fontfile=news-font.ttf:textfile=brand.txt:fontcolor=white:fontsize=26:x=915:y=1530:enable='lt(t,${duration.toFixed(3)})'[corner]`);
    filters.push(`[corner]drawbox=x=64:y=1650:w=836:h=54:color=#071526@0.88:t=fill,drawtext=fontfile=news-font.ttf:textfile=source.txt:fontcolor=white:fontsize=24:x=88:y=1665:enable='lt(t,${duration.toFixed(3)})'[sourcebar]`);
    let captionVideo = "sourcebar";
    const captionDuration = duration / usableCaptionList.length;
    for (let index = 0; index < captionFiles.length; index += 1) {
      const start = index * captionDuration;
      const end = Math.min(duration, (index + 1) * captionDuration + 0.08);
      const output = `caption${index}`;
      filters.push(`[${captionVideo}]drawtext=fontfile=news-font.ttf:textfile=caption-${index}.txt:fontcolor=white:fontsize=42:line_spacing=0:borderw=3:bordercolor=#071526:shadowcolor=#071526@0.8:shadowx=2:shadowy=3:x=430:y=1120:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${output}]`);
      captionVideo = output;
    }
    const ctaStart = Math.max(0, duration - 4.2);
    filters.push(`[${captionVideo}]drawbox=x=64:y=128:w=470:h=118:color=#f6c945@0.96:t=fill:enable='gte(t,${ctaStart.toFixed(3)})',drawtext=fontfile=news-font.ttf:textfile=cta.txt:fontcolor=#071526:fontsize=34:line_spacing=0:x=88:y=146:enable='gte(t,${ctaStart.toFixed(3)})'[outv]`);
    args.push("-filter_complex_threads", "4", "-filter_complex", filters.join(";"), "-map", "[outv]", "-map", "[voice]", "-t", duration.toFixed(3), "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "output.mp4");
    update(8, "Building smooth news transitions");
    await runProcess(ffmpeg, args, {
      signal,
      cwd: directory,
      timeout: Math.max(120000, Number(store.state.settings.maxWaitMinutes || 30) * 60000),
      onLine: (line) => reportFromProgress(line, duration, update, "Rendering broadcast graphics", 8, 86),
    });
    signal.throwIfAborted();
    const output = path.join(directory, "output.mp4");
    const metadata = await probe(output, store.state.settings);
    if (metadata.width !== WIDTH || metadata.height !== HEIGHT || !metadata.hasAudio || Math.abs(metadata.duration - duration) > 0.5) {
      throw new StudioError("The broadcast output failed its audio, frame size or duration check.", "NEWS_OUTPUT_VALIDATION_FAILED", 500);
    }
    update(98, "Validating news broadcast");
    return await importMedia(store, output, {
      projectId: job.projectId,
      name: `${safeName(job.name || "News broadcast")}.mp4`,
      generated: true,
      move: true,
      jobId: job.id,
    });
  } finally {
    const resolved = path.resolve(directory);
    if (resolved.startsWith(path.resolve(tempRoot) + path.sep)) await fsPromises.rm(resolved, { recursive: true, force: true }).catch(() => {});
  }
}
