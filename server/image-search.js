import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { importMedia } from "./media.js";

export const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";
const MAX_QUERY_LENGTH = 300;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

function cleanQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0" ||
    /^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

export function isPublicImageUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

function safeImageUrl(value) {
  return isPublicImageUrl(value) ? new URL(value).toString() : null;
}

async function boundedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("image search response quá lớn");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("image search response quá lớn");
  return new TextDecoder().decode(bytes);
}

function metadataValue(metadata, name) {
  const value = metadata?.[name]?.value;
  return typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) : "";
}

export function parseWikimediaImages(body, query, maxResults = 6) {
  const pages = Object.values(body?.query?.pages || {});
  const images = [];
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    const imageUrl = safeImageUrl(info?.thumburl || info?.url);
    if (!imageUrl) continue;
    images.push({
      id: `wikimedia:${page.pageid || imageUrl}`,
      query,
      title: String(page.title || "").replace(/^File:/i, "").slice(0, 300),
      imageUrl,
      pageUrl: safeImageUrl(page.canonicalurl || page.fullurl),
      width: Number(info.width) || 0,
      height: Number(info.height) || 0,
      mime: String(info.mime || "").slice(0, 80),
      license: metadataValue(info.extmetadata, "LicenseShortName"),
      attribution: metadataValue(info.extmetadata, "Artist"),
    });
    if (images.length >= maxResults) break;
  }
  return images;
}

export async function searchWikimediaImages(query, { fetchImpl = globalThis.fetch, maxResults = 6, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const normalized = cleanQuery(query);
  if (!normalized) return [];
  const url = new URL(WIKIMEDIA_API);
  url.search = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: normalized,
    gsrnamespace: "6",
    gsrlimit: String(Math.min(20, Math.max(1, maxResults))),
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "1600",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Wikimedia HTTP ${response.status}`);
    return parseWikimediaImages(JSON.parse(await boundedText(response)), normalized, maxResults);
  } finally {
    clearTimeout(timer);
  }
}

export async function searchImageQueries(queries, { fetchImpl = globalThis.fetch, maxResultsPerQuery = 4, maxResults = 24, concurrency = 2 } = {}) {
  const uniqueQueries = [...new Set((Array.isArray(queries) ? queries : []).map(cleanQuery).filter(Boolean))].slice(0, 12);
  const images = [];
  const warnings = [];
  let cursor = 0;
  async function worker() {
    while (cursor < uniqueQueries.length) {
      const query = uniqueQueries[cursor++];
      try {
        images.push(...await searchWikimediaImages(query, { fetchImpl, maxResults: maxResultsPerQuery }));
      } catch {
        warnings.push(`Không thể tìm ảnh Wikimedia cho "${query}".`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueQueries.length || 1) }, () => worker()));
  const seen = new Set();
  const deduped = images.filter((image) => {
    if (seen.has(image.imageUrl)) return false;
    seen.add(image.imageUrl);
    return true;
  }).slice(0, maxResults);
  return { images: deduped, warnings: [...new Set(warnings)] };
}

function extensionFor(url, contentType) {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const byType = { "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp" };
  if (byType[type]) return byType[type];
  const extension = path.extname(url.pathname).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].includes(extension) ? extension : ".jpg";
}

export async function downloadImageAsset({ image, store, projectId, fetchImpl = globalThis.fetch }) {
  if (!image?.imageUrl || !isPublicImageUrl(image.imageUrl)) throw new Error("URL ảnh không hợp lệ hoặc trỏ vào mạng nội bộ.");
  const sourceUrl = new URL(image.imageUrl);
  const response = await fetchImpl(sourceUrl, {
    headers: { accept: "image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.2" },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Không tải được ảnh (HTTP ${response.status}).`);
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/")) throw new Error("Nguồn không trả về ảnh.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Ảnh vượt quá giới hạn 20 MB.");
  const extension = extensionFor(sourceUrl, contentType);
  const temporary = path.join(store.root, "temp", `${randomUUID()}${extension}`);
  await fs.writeFile(temporary, bytes, { flag: "wx" });
  try {
    return await importMedia(store, temporary, {
      projectId,
      name: `${String(image.title || "Wikimedia image").slice(0, 100)}${extension}`,
      move: true,
    });
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
