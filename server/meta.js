import fs from "node:fs/promises";
import { z } from "zod";
import { StudioError } from "./store.js";

const GRAPH_VERSION = "v24.0";
const accessTokenSchema = z.string().trim().min(10).max(5000);
const pageIdSchema = z.string().regex(/^\d{1,40}$/);

function safeMessage(value, token = "") {
  const message = String(value || "Meta request failed");
  return token ? message.split(token).join("[redacted]") : message;
}

function publicPage(page) {
  return {
    id: page.id,
    name: page.name || page.id,
    tasks: Array.isArray(page.tasks) ? page.tasks : [],
    hasToken: Boolean(page.accessToken),
  };
}

function publicMeta(meta) {
  return {
    connected: Boolean(meta?.accessToken),
    graphVersion: meta?.graphVersion || GRAPH_VERSION,
    user: meta?.user || null,
    pages: (meta?.pages || []).map(publicPage),
    boundPage: meta?.boundPageId
      ? { id: meta.boundPageId, name: meta.boundPageName || meta.boundPageId }
      : null,
  };
}

function graphEndpoint(graphBase, version, path, params = {}) {
  const url = new URL(`${graphBase.replace(/\/+$/, "")}/${version}/${String(path).replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

async function jsonResponse(response, token) {
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || body?.error) {
    const message = body?.error?.message || `Meta Graph HTTP ${response.status}`;
    throw new StudioError(safeMessage(message, token), "META_GRAPH_ERROR", response.status >= 400 && response.status < 600 ? 502 : 502);
  }
  return body || {};
}

export function createMetaClient({ fetchImpl = globalThis.fetch, graphBase = "https://graph.facebook.com", graphVersion = GRAPH_VERSION } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");
  const request = async ({ token, path, method = "GET", params = {}, body = null, headers = {} }) => {
    const requestHeaders = { accept: "application/json", ...headers };
    let requestBody = body;
    const requestParams = { ...params };
    if (method === "GET") requestParams.access_token = token;
    else if (body instanceof URLSearchParams) {
      body.set("access_token", token);
      requestHeaders["content-type"] = "application/x-www-form-urlencoded";
    } else if (!body) {
      requestParams.access_token = token;
    }
    const response = await fetchImpl(graphEndpoint(graphBase, graphVersion, path, requestParams), {
      method,
      headers: requestHeaders,
      body: requestBody,
    });
    return jsonResponse(response, token);
  };
  return {
    me: (token) => request({ token, path: "me", params: { fields: "id,name" } }),
    pages: (token) => request({ token, path: "me/accounts", params: { fields: "id,name,access_token,tasks" } }),
    startReel: ({ token, pageId, fileSize }) => request({
      token,
      path: `${pageId}/video_reels`,
      method: "POST",
      body: new URLSearchParams({ upload_phase: "start", file_size: String(fileSize), upload_type: "chunked" }),
    }),
    finishReel: ({ token, pageId, videoId, description }) => request({
      token,
      path: `${pageId}/video_reels`,
      method: "POST",
      body: new URLSearchParams({ upload_phase: "finish", video_id: String(videoId), video_state: "PUBLISHED", description: String(description || "").slice(0, 2000) }),
    }),
    uploadChunk: async ({ token, uploadUrl, bytes }) => {
      const response = await fetchImpl(uploadUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          Authorization: `OAuth ${token}`,
          offset: "0",
          file_size: String(bytes.byteLength),
          "content-type": "application/octet-stream",
        },
        body: bytes,
      });
      return jsonResponse(response, token);
    },
  };
}

function metaState(store) {
  store.state.settings.meta ??= {};
  const meta = store.state.settings.meta;
  meta.pages ??= [];
  meta.publications ??= [];
  return meta;
}

function requireToken(meta) {
  if (!meta.accessToken) throw new StudioError("Hãy kết nối Meta bằng access token của bạn trước.", "META_NOT_CONNECTED", 409);
  return meta.accessToken;
}

function requireBoundPage(meta) {
  if (!meta.boundPageId || !meta.boundPageToken)
    throw new StudioError("Hãy chọn Page Meta trước khi kiểm tra hoặc đăng bài.", "META_PAGE_NOT_BOUND", 409);
  return meta.pages.find((page) => page.id === meta.boundPageId) || {
    id: meta.boundPageId,
    name: meta.boundPageName || meta.boundPageId,
    accessToken: meta.boundPageToken,
  };
}

function postPreflight(store, post, meta) {
  const checks = [];
  checks.push({ key: "connected", ok: Boolean(meta.accessToken), message: meta.accessToken ? "Meta đã kết nối." : "Chưa có Meta access token." });
  checks.push({ key: "page", ok: Boolean(meta.boundPageId && meta.boundPageToken), message: meta.boundPageId ? `Đã chọn Page ${meta.boundPageName || meta.boundPageId}.` : "Chưa chọn Page." });
  checks.push({ key: "status", ok: Boolean(post && ["ready", "scheduled"].includes(post.status)), message: post ? `Trạng thái hiện tại: ${post.status}.` : "Không tìm thấy bài đăng." });
  const page = post ? store.state.socialPages.find((item) => item.id === post.pageId) : null;
  checks.push({ key: "page_match", ok: Boolean(post && page && page.externalId && page.externalId === meta.boundPageId), message: page?.externalId ? `Page local: ${page.externalId}.` : "Bài chưa gắn Page ID Meta." });
  const media = post?.mediaIds?.[0] ? store.state.media.find((item) => item.id === post.mediaIds[0]) : null;
  checks.push({ key: "video", ok: Boolean(media?.kind === "video" && media.file), message: media?.kind === "video" ? "Đã có video local." : "Reel cần đúng một video local." });
  checks.push({ key: "caption", ok: Boolean(String(post?.caption || "").trim()), message: post?.caption ? "Đã có caption." : "Caption đang trống." });
  return { ready: checks.every((check) => check.ok), checks };
}

export function mountMetaRoutes(app, store, { client = createMetaClient() } = {}) {
  app.get("/api/meta", (req, res) => res.json(publicMeta(metaState(store))));

  app.post("/api/meta/connect", async (req, res) => {
    const accessToken = accessTokenSchema.parse(req.body?.accessToken);
    const user = await client.me(accessToken);
    const pageResponse = await client.pages(accessToken);
    const pages = Array.isArray(pageResponse?.data)
      ? pageResponse.data.filter((page) => pageIdSchema.safeParse(String(page.id)).success).map((page) => ({
        id: String(page.id),
        name: String(page.name || page.id).slice(0, 200),
        tasks: Array.isArray(page.tasks) ? page.tasks.slice(0, 30).map(String) : [],
        accessToken: String(page.access_token || ""),
      }))
      : [];
    if (!pages.length) throw new StudioError("Meta không trả về Page có quyền quản lý.", "META_NO_PAGES", 409);
    const meta = metaState(store);
    meta.enabled = true;
    meta.accessToken = accessToken;
    meta.user = { id: String(user.id || ""), name: String(user.name || "").slice(0, 200) };
    meta.pages = pages;
    if (!pages.some((page) => page.id === meta.boundPageId)) {
      meta.boundPageId = "";
      meta.boundPageName = "";
      meta.boundPageToken = "";
    }
    store.save();
    res.json(publicMeta(meta));
  });

  app.post("/api/meta/refresh-pages", async (req, res) => {
    const meta = metaState(store);
    const token = requireToken(meta);
    const response = await client.pages(token);
    meta.pages = (response.data || []).filter((page) => pageIdSchema.safeParse(String(page.id)).success).map((page) => ({
      id: String(page.id), name: String(page.name || page.id).slice(0, 200), tasks: Array.isArray(page.tasks) ? page.tasks.slice(0, 30).map(String) : [], accessToken: String(page.access_token || ""),
    }));
    store.save();
    res.json(publicMeta(meta));
  });

  app.post("/api/meta/bind", (req, res) => {
    const meta = metaState(store);
    requireToken(meta);
    const pageId = pageIdSchema.parse(String(req.body?.pageId || ""));
    const page = meta.pages.find((item) => item.id === pageId);
    if (!page?.accessToken) throw new StudioError("Page không có page access token trong quyền hiện tại.", "META_PAGE_TOKEN_MISSING", 409);
    meta.boundPageId = page.id;
    meta.boundPageName = page.name;
    meta.boundPageToken = page.accessToken;
    store.save();
    res.json(publicMeta(meta));
  });

  app.delete("/api/meta", (req, res) => {
    const meta = metaState(store);
    Object.assign(meta, { enabled: false, accessToken: "", user: null, pages: [], boundPageId: "", boundPageName: "", boundPageToken: "" });
    store.save();
    res.json(publicMeta(meta));
  });

  app.post("/api/meta/preflight", (req, res) => {
    const postId = z.string().uuid().parse(req.body?.postId);
    const post = store.require("socialPosts", postId);
    res.json(postPreflight(store, post, metaState(store)));
  });

  app.post("/api/meta/publish/reel", async (req, res) => {
    const postId = z.string().uuid().parse(req.body?.postId);
    const idempotencyKey = z.string().trim().min(8).max(160).parse(req.body?.idempotencyKey || `${postId}:${store.require("socialPosts", postId).revision}`);
    const post = store.require("socialPosts", postId);
    const meta = metaState(store);
    const existing = meta.publications.find((item) => item.idempotencyKey === idempotencyKey);
    if (existing?.status === "published") return res.json(existing);
    const check = postPreflight(store, post, meta);
    if (!check.ready) throw new StudioError("Preflight Meta chưa đạt; chưa gửi bài.", "META_PREFLIGHT_FAILED", 409);
    const page = requireBoundPage(meta);
    const media = store.state.media.find((item) => item.id === post.mediaIds[0]);
    const bytes = await fs.readFile(media.file);
    const start = await client.startReel({ token: page.accessToken, pageId: page.id, fileSize: bytes.byteLength });
    const videoId = start.video_id || start.id;
    if (!videoId) throw new StudioError("Meta không trả về video ID sau bước start.", "META_UPLOAD_FAILED", 502);
    if (start.upload_url) await client.uploadChunk({ token: page.accessToken, uploadUrl: start.upload_url, bytes });
    const finish = await client.finishReel({ token: page.accessToken, pageId: page.id, videoId, description: post.caption });
    const externalPostId = String(finish.id || videoId);
    const record = { idempotencyKey, status: "published", pageId: page.id, pageName: page.name, externalPostId, permalink: finish.permalink || `https://www.facebook.com/${externalPostId}`, publishedAt: new Date().toISOString() };
    meta.publications = meta.publications.filter((item) => item.idempotencyKey !== idempotencyKey).concat(record).slice(-200);
    Object.assign(post, { status: "published", publication: { source: "meta", externalPostId: record.externalPostId, permalink: record.permalink || `https://www.facebook.com/${record.externalPostId}`, publishedAt: record.publishedAt }, revision: post.revision + 1, updatedAt: record.publishedAt });
    store.save();
    res.json(record);
  });
}

export { publicMeta, postPreflight };
