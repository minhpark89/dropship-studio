import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { binary, runProcess, probe } from "./media.js";

const pending = new Map();
const compatibleVideo = new Set(["h264", "vp8", "vp9", "av1"]);
const compatibleAudio = new Set(["aac", "opus", "vorbis", "mp3", "flac"]);

export async function playbackFile(store, media) {
  if (media.kind !== "video") return media.file;
  const compatibleContainer = [".mp4", ".m4v", ".webm"].includes(
    path.extname(media.file).toLowerCase(),
  );
  if (
    compatibleContainer &&
    compatibleVideo.has(media.videoCodec) &&
    (!media.hasAudio || compatibleAudio.has(media.audioCodec))
  )
    return media.file;
  if (
    media.previewFile &&
    (await fs
      .stat(media.previewFile)
      .then((stat) => stat.isFile())
      .catch(() => false))
  )
    return media.previewFile;
  const key = `${store.root}:${media.id}`;
  if (pending.has(key)) return pending.get(key);
  const work = createPreview(store, media);
  pending.set(key, work);
  try {
    return await work;
  } finally {
    pending.delete(key);
  }
}

async function createPreview(store, media) {
  const target = path.join(store.root, "thumbs", `${randomUUID()}-preview.mp4`);
  try {
    await runProcess(
      binary("ffmpeg", store.state.settings),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        media.file,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        "scale=w=min(1280\\,iw):h=min(1280\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        target,
      ],
      { timeout: Math.min(3600000, Math.max(120000, media.duration * 2000)) },
    );
    const metadata = await probe(target, store.state.settings);
    if (metadata.videoCodec !== "h264" || !metadata.width || !metadata.height)
      throw new Error("Không tạo được video xem trước tương thích.");
    store.patch("media", media.id, {
      previewFile: target,
      previewCodec: "h264",
    });
    return target;
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => {});
    throw error;
  }
}
