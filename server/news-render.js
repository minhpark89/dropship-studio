import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { binary, importMedia, probe, runProcess } from "./media.js";
import { StudioError, safeName } from "./store.js";

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;
const TRANSITION = 0.42;

function fontPaths(style = "news") {
  const roots = [
    path.resolve(import.meta.dirname, "../dist/fonts/news"),
    path.resolve(import.meta.dirname, "../public/fonts/news"),
  ];
  const find = (name) => roots.map((root) => path.join(root, name)).find((candidate) => fs.existsSync(candidate));
  const families = {
    news: { headline: "BarlowCondensed-ExtraBold.ttf", label: "BarlowCondensed-Bold.ttf", body: "BarlowCondensed-Regular.ttf" },
    viral: { headline: "Anton-Regular.ttf", label: "Anton-Regular.ttf", body: "BarlowCondensed-Bold.ttf" },
    minimal: { headline: "BeVietnamPro-ExtraBold.ttf", label: "BeVietnamPro-ExtraBold.ttf", body: "BarlowCondensed-Regular.ttf" },
  };
  const family = families[style] || families.news;
  const headline = find(family.headline) || find(families.news.headline);
  const label = find(family.label) || headline;
  const body = find(family.body) || label;
  return headline && label && body ? { headline, label, body } : null;
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
  const target = width / Math.max(1, height);
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
  const fonts = fontPaths(plan?.fontStyle);
  if (!fonts) throw new StudioError("The bundled news font is missing.", "NEWS_FONT_MISSING", 500);
  const duration = Math.max(12, Math.min(60, Number(presenter.duration) || 15));
  const visualVariant = Math.max(1, Math.min(50, Number(plan?.visualVariant || plan?.variation || 1)));
  const segment = (duration + (usable.length - 1) * TRANSITION) / usable.length;
  const frames = Math.max(30, Math.round(segment * FPS));
  const tempRoot = path.join(store.root, "temp");
  const directory = await fsPromises.mkdtemp(path.join(tempRoot, "news-broadcast-"));
  const ffmpeg = binary("ffmpeg", store.state.settings);
  const safePlan = {
    headline: clean(plan?.headline || "News update", 100),
    narration: clean(plan?.narration || "", 500),
    source: clean(plan?.source || "News report", 100),
    brand: clean(plan?.brand || "NEWS UPDATE", 24).toUpperCase(),
  };
  const preset = {
    news: { accent: "#d71920", cta: "#f6c945", panel: "#f7f5ef", ink: "#081a32", dark: "#071526", headlineSize: 55, bodySize: 35 },
    viral: { accent: "#ff6b35", cta: "#facc15", panel: "#fff7ed", ink: "#24120b", dark: "#201018", headlineSize: 62, bodySize: 38 },
    minimal: { accent: "#1f2937", cta: "#e5e7eb", panel: "#ffffff", ink: "#111827", dark: "#111827", headlineSize: 52, bodySize: 32 },
  }[plan?.fontStyle] || { accent: "#d71920", cta: "#f6c945", panel: "#f7f5ef", ink: "#081a32", dark: "#071526", headlineSize: 55, bodySize: 35 };
  try {
    signal.throwIfAborted();
    await Promise.all([
      fsPromises.copyFile(fonts.headline, path.join(directory, "news-headline.ttf")),
      fsPromises.copyFile(fonts.label, path.join(directory, "news-label.ttf")),
      fsPromises.copyFile(fonts.body, path.join(directory, "news-body.ttf")),
    ]);
    const headlineFile = await writeText(directory, "headline.txt", wrap(safePlan.headline, 27, 3).toUpperCase());
    const sourceFile = await writeText(directory, "source.txt", `SOURCE: ${clean(safePlan.source, 42).toUpperCase()}`);
    const brandFile = await writeText(directory, "brand.txt", safePlan.brand.toUpperCase());
    const cornerFile = await writeText(directory, "corner.txt", "US NEWS");
    const captionLabelFile = await writeText(directory, "caption-label.txt", "WHAT WE KNOW");
    const presenterLabelFile = await writeText(directory, "presenter-label.txt", "ON CAMERA");
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
      const variantSeed = (visualVariant - 1) * 5 + index;
      const direction = variantSeed % 2 === 0 ? "in" : "out";
      const zoomDelta = 0.105 + (variantSeed % 3) * 0.018;
      const start = direction === "in" ? 1.018 + (variantSeed % 3) * 0.008 : 1.15 - (variantSeed % 3) * 0.008;
      const end = direction === "in" ? start + zoomDelta : start - zoomDelta;
      const zoom = `${start.toFixed(4)}${direction === "in" ? "+" : "-"}${Math.abs(end - start).toFixed(4)}*on/${Math.max(1, frames - 1)}`;
      const panXValues = ["0.22", "0.48", "0.70", "0.36", "0.58"];
      const panYValues = ["0.24", "0.42", "0.64", "0.76"];
      const panX = `(iw-iw/zoom)*(${panXValues[variantSeed % panXValues.length]})`;
      const panY = `(ih-ih/zoom)*(${panYValues[variantSeed % panYValues.length]})`;
      filters.push(`[${index}:v]split=2[bgsrc${index}][herosrc${index}]`);
      filters.push(`[bgsrc${index}]scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,zoompan=z='${zoom}':x='${panX}':y='${panY}':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},setsar=1,format=yuv420p[shot${index}]`);
      // The editorial image is fitted inside a dedicated card. This keeps the
      // complete source photo visible while the cropped branch only supplies
      // the moving full-frame background.
      filters.push(`[herosrc${index}]scale=920:860:force_original_aspect_ratio=decrease,pad=920:860:(ow-iw)/2:(oh-ih)/2:color=#0b1629,zoompan=z='1':x='0':y='0':d=${frames}:s=920x860:fps=${FPS},setsar=1,format=yuv420p[hero${index}]`);
    }
    let background = "shot0";
    let backgroundDuration = segment;
    let editorial = "hero0";
    let editorialDuration = segment;
    for (let index = 1; index < usable.length; index += 1) {
      const output = `mix${index}`;
      filters.push(`[${background}][shot${index}]xfade=transition=fade:duration=${TRANSITION}:offset=${Math.max(0, backgroundDuration - TRANSITION).toFixed(3)}[${output}]`);
      background = output;
      backgroundDuration += segment - TRANSITION;
      const editorialOutput = `heroMix${index}`;
      filters.push(`[${editorial}][hero${index}]xfade=transition=fade:duration=${TRANSITION}:offset=${Math.max(0, editorialDuration - TRANSITION).toFixed(3)}[${editorialOutput}]`);
      editorial = editorialOutput;
      editorialDuration += segment - TRANSITION;
    }
    const pFilter = presenterFilter(342, 384);
    filters.push(`[${presenterInput}:v]${pFilter},scale=342:384,setsar=1,format=rgba[mc]`);
    filters.push(`[${presenterInput}:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11[voice]`);
    filters.push(`[${background}]drawbox=x=0:y=0:w=iw:h=ih:color=${preset.dark}@0.30:t=fill[dim]`);
    filters.push(`[dim]drawbox=x=48:y=42:w=984:h=74:color=${preset.accent}:t=fill,drawtext=fontfile=news-label.ttf:textfile=brand.txt:fontcolor=white:fontsize=31:x=78:y=62[header]`);
    filters.push(`[header]drawbox=x=700:y=42:w=332:h=74:color=${preset.cta}:t=fill,drawtext=fontfile=news-label.ttf:textfile=cta.txt:fontcolor=${preset.dark}:fontsize=22:line_spacing=0:x=725:y=58[headerCta]`);
    filters.push(`[headerCta]drawbox=x=48:y=140:w=984:h=900:color=${preset.panel}@0.98:t=fill[heroCard]`);
    filters.push(`[heroCard][${editorial}]overlay=x=80:y=160:enable='lt(t,${duration.toFixed(3)})'[heroPlaced]`);
    filters.push(`[heroPlaced]drawbox=x=48:y=140:w=984:h=900:color=#ffffff@0.74:t=4[layout]`);
    filters.push(`[layout]drawbox=x=48:y=1068:w=390:h=420:color=${preset.dark}@0.96:t=fill[mcframe]`);
    filters.push(`[mcframe][mc]overlay=x=72:y=1092:enable='lt(t,${duration.toFixed(3)})'[presenter]`);
    filters.push(`[presenter]drawbox=x=48:y=1068:w=390:h=52:color=${preset.accent}:t=fill,drawtext=fontfile=news-label.ttf:textfile=presenter-label.txt:fontcolor=white:fontsize=27:x=72:y=1082:enable='lt(t,${duration.toFixed(3)})'[label]`);
    filters.push(`[label]drawbox=x=460:y=1068:w=572:h=250:color=${preset.dark}@0.94:t=fill,drawtext=fontfile=news-label.ttf:textfile=caption-label.txt:fontcolor=${preset.cta}:fontsize=24:x=488:y=1096:enable='lt(t,${duration.toFixed(3)})'[captionPanel]`);
    filters.push(`[captionPanel]drawbox=x=48:y=1518:w=984:h=220:color=${preset.panel}@0.98:t=fill,drawbox=x=48:y=1518:w=12:h=220:color=${preset.accent}:t=fill,drawtext=fontfile=news-headline.ttf:textfile=headline.txt:fontcolor=${preset.ink}:fontsize=${preset.headlineSize}:line_spacing=4:x=86:y=1548:enable='lt(t,${duration.toFixed(3)})'[headline]`);
    filters.push(`[headline]drawbox=x=872:y=1518:w=160:h=220:color=${preset.accent}:t=fill,drawtext=fontfile=news-label.ttf:textfile=corner.txt:fontcolor=white:fontsize=26:x='872+(160-text_w)/2':y=1610:enable='lt(t,${duration.toFixed(3)})'[corner]`);
    filters.push(`[corner]drawbox=x=48:y=1738:w=984:h=62:color=${preset.dark}@0.94:t=fill,drawtext=fontfile=news-body.ttf:textfile=source.txt:fontcolor=white:fontsize=24:x=78:y=1757:enable='lt(t,${duration.toFixed(3)})'[sourcebar]`);
    let captionVideo = "sourcebar";
    const captionDuration = duration / usableCaptionList.length;
    for (let index = 0; index < captionFiles.length; index += 1) {
      const start = index * captionDuration;
      const end = Math.min(duration, (index + 1) * captionDuration + 0.08);
      const output = `caption${index}`;
      filters.push(`[${captionVideo}]drawbox=x=460:y=1128:w=572:h=190:color=${preset.dark}@0.94:t=fill:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})',drawtext=fontfile=news-body.ttf:textfile=caption-${index}.txt:fontcolor=white:fontsize=${preset.bodySize}:line_spacing=4:borderw=1:bordercolor=${preset.dark}:shadowcolor=#000000@0.65:shadowx=2:shadowy=3:x=488:y=1160:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${output}]`);
      captionVideo = output;
    }
    const ctaStart = Math.max(0, duration - 4.2);
    filters.push(`[${captionVideo}]drawbox=x=700:y=42:w=332:h=74:color=${preset.cta}:t=fill:enable='gte(t,${ctaStart.toFixed(3)})',drawtext=fontfile=news-label.ttf:textfile=cta.txt:fontcolor=${preset.dark}:fontsize=22:line_spacing=0:x=725:y=58:enable='gte(t,${ctaStart.toFixed(3)})'[outv]`);
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
      mediaType: "news-video",
    });
  } finally {
    const resolved = path.resolve(directory);
    if (resolved.startsWith(path.resolve(tempRoot) + path.sep)) await fsPromises.rm(resolved, { recursive: true, force: true }).catch(() => {});
  }
}
