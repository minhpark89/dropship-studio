import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StudioError, safeName } from "./store.js";

const accepted = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".m4v",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
]);
const images = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export function binary(name, settings = {}) {
  const configured =
    settings[`${name}Path`] || process.env[name.toUpperCase() + "_PATH"];
  if (configured)
    return fsSync.existsSync(configured)
      ? path.resolve(configured)
      : configured;
  const candidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, "bin", `${name}.exe`)
      : null,
    path.resolve(import.meta.dirname, "..", "bin", `${name}.exe`),
  ].filter(Boolean);
  return candidates.find((candidate) => fsSync.existsSync(candidate)) ?? name;
}

export function runProcess(
  command,
  args,
  { signal, cwd, onLine, timeout = 0 } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StudioError("Đã hủy tác vụ.", "CANCELLED"));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeout)
      : null;
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = (stdout + text).slice(-4 * 1024 * 1024);
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const line of lines) onLine?.(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-128 * 1024);
    });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(
        new StudioError(
          `Không chạy được ${path.basename(command)}: ${error.message}`,
          "EXECUTABLE_UNAVAILABLE",
          500,
        ),
      );
    });
    child.on("close", (code) => {
      cleanup();
      if (signal?.aborted)
        return reject(new StudioError("Đã hủy tác vụ.", "CANCELLED"));
      if (timedOut)
        return reject(
          new StudioError(
            "Quá thời gian đọc tệp media.",
            "PROCESS_TIMEOUT",
            500,
          ),
        );
      if (code !== 0)
        return reject(
          new StudioError(
            stderr.slice(-6000) || `Tiến trình kết thúc với mã ${code}.`,
            "PROCESS_FAILED",
            500,
          ),
        );
      resolve({ stdout, stderr });
    });
  });
}

export async function probe(file, settings) {
  const { stdout } = await runProcess(
    binary("ffprobe", settings),
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
    { timeout: 30000 },
  );
  const result = JSON.parse(stdout);
  const video = result.streams.find((stream) => stream.codec_type === "video");
  const audio = result.streams.find((stream) => stream.codec_type === "audio");
  const isImage = images.has(path.extname(file).toLowerCase());
  if (!video && !audio)
    throw new StudioError(
      "Tệp không chứa hình ảnh hoặc âm thanh.",
      "INVALID_MEDIA",
    );
  const [numerator, denominator] = (video?.avg_frame_rate || "0/1")
    .split("/")
    .map(Number);
  const duration = Number(
    result.format.duration || video?.duration || audio?.duration || 0,
  );
  return {
    kind: isImage ? "image" : video ? "video" : "audio",
    duration: isImage ? 5 : duration,
    width: video?.width || 0,
    height: video?.height || 0,
    fps: denominator ? numerator / denominator : 0,
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    bytes: Number(result.format.size || 0),
  };
}

export async function importMedia(
  store,
  input,
  { projectId, name, move = false, generated = false, jobId = null, mediaType = "general" } = {},
) {
  if (projectId) store.require("projects", projectId);
  const extension = path.extname(name || input).toLowerCase();
  if (!accepted.has(extension))
    throw new StudioError(
      `Định dạng ${extension || "(không có đuôi)"} chưa hỗ trợ.`,
      "INVALID_MEDIA",
    );
  const source = path.resolve(input);
  const stat = await fs.stat(source);
  if (!stat.isFile())
    throw new StudioError("Hãy chọn một tệp media.", "INVALID_MEDIA");
  const metadata = await probe(source, store.state.settings);
  if (
    metadata.kind !== "image" &&
    (!Number.isFinite(metadata.duration) || metadata.duration <= 0)
  ) {
    throw new StudioError("Không đọc được thời lượng media.", "INVALID_MEDIA");
  }
  const file = path.join(
    store.root,
    generated ? "exports" : "media",
    `${randomUUID()}${extension}`,
  );
  if (move) await fs.rename(source, file);
  else await fs.copyFile(source, file);
  let thumbnail = null;
  if (metadata.kind !== "audio") {
    thumbnail = path.join(store.root, "thumbs", `${randomUUID()}.jpg`);
    try {
      await runProcess(
        binary("ffmpeg", store.state.settings),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          file,
          "-frames:v",
          "1",
          "-vf",
          "scale=420:-2",
          "-update",
          "1",
          thumbnail,
        ],
        { timeout: 30000 },
      );
    } catch {
      thumbnail = null;
    }
  }
  return store.add("media", {
    ...metadata,
    name: safeName(name || path.basename(input)),
    projectId: projectId || null,
    file,
    thumbnail,
    generated,
    jobId,
    mediaType: String(mediaType || "general").trim().slice(0, 60) || "general",
  });
}

export async function checkTools(settings) {
  const results = await Promise.allSettled(
    ["ffmpeg", "ffprobe"].map(async (name) => {
      const command = binary(name, settings);
      const { stdout } = await runProcess(command, ["-version"], {
        timeout: 10000,
      });
      return {
        name,
        available: true,
        version: stdout.split(/\r?\n/)[0],
        path: command,
      };
    }),
  );
  return results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : {
          name: ["ffmpeg", "ffprobe"][index],
          available: false,
          error: result.reason.message,
        },
  );
}
