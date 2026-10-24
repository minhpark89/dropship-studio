import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { StudioError } from "./store.js";

const packageNames = new Set(["post.json", "caption.txt", "manifest.json"]);
const mediaName = /^media\.(?:jpg|jpeg|png|gif|webp|mp4|mov|webm|m4v|mkv|avi)$/i;
const locks = new Set();

function timestamp() {
  return new Date().toISOString();
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fs.createReadStream(file);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

export function validatePackageFileName(name) {
  if (!packageNames.has(name) && !mediaName.test(name))
    throw new StudioError("Tệp handoff không hợp lệ.", "INVALID_PACKAGE_FILE", 400);
  return name;
}

export function packageFilePath(store, postId, revision, name) {
  validatePackageFileName(name);
  const base = path.resolve(store.root, "exports", "posts", postId, String(revision));
  const file = path.resolve(base, name);
  if (!file.startsWith(`${base}${path.sep}`)) throw new StudioError("Đường dẫn tệp không hợp lệ.", "INVALID_PACKAGE_FILE", 400);
  return file;
}

export async function createPostPackage(store, post) {
  if (locks.has(post.id)) throw new StudioError("Bản export này đang được tạo.", "EXPORT_IN_PROGRESS", 409);
  locks.add(post.id);
  const revision = post.revision;
  const root = path.join(store.root, "exports", "posts", post.id);
  const target = path.join(root, String(revision));
  const temporary = path.join(root, `.${revision}.${randomUUID()}.tmp`);
  try {
    await fsp.mkdir(root, { recursive: true });
    await fsp.mkdir(temporary);
    const media = post.mediaIds?.[0] ? store.require("media", post.mediaIds[0]) : null;
    const exportedAt = timestamp();
    const publicationInstruction = "This is a local handoff package. Upload or schedule it manually in the configured Page tool; no automatic publisher is connected.";
    const postData = {
      id: post.id,
      revision,
      projectId: post.projectId,
      pageId: post.pageId,
      title: post.title,
      caption: post.caption,
      notes: post.notes,
      scheduledAt: post.scheduledAt,
      status: post.status,
      exportedAt,
      publicationInstruction,
    };
    const postBytes = Buffer.from(`${JSON.stringify(postData, null, 2)}\n`, "utf8");
    const captionBytes = Buffer.from(`${post.caption || ""}\n`, "utf8");
    await fsp.writeFile(path.join(temporary, "post.json"), postBytes, { mode: 0o600 });
    await fsp.writeFile(path.join(temporary, "caption.txt"), captionBytes, { mode: 0o600 });
    const files = [
      { name: "post.json", size: postBytes.length, sha256: createHash("sha256").update(postBytes).digest("hex") },
      { name: "caption.txt", size: captionBytes.length, sha256: createHash("sha256").update(captionBytes).digest("hex") },
    ];
    if (media) {
      const extension = path.extname(media.file).toLowerCase() || ".bin";
      const name = `media${extension}`;
      await fsp.copyFile(media.file, path.join(temporary, name));
      const stat = await fsp.stat(path.join(temporary, name));
      files.push({ name, size: stat.size, sha256: await hashFile(path.join(temporary, name)), mediaId: media.id });
    }
    const manifest = { id: post.id, revision, files, publicationInstruction };
    await fsp.writeFile(path.join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(temporary, target);
    post.exportRevision = revision;
    post.exportedAt = exportedAt;
    post.updatedAt = exportedAt;
    store.save();
    return {
      id: post.id,
      revision,
      files: [...files.map(({ name }) => name), "manifest.json"].map((name) => ({ name, url: `/api/social/posts/${post.id}/package/${revision}/${name}` })),
      manifest,
    };
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    locks.delete(post.id);
  }
}

