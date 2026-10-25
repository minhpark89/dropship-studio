import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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
    category: page.category || "",
    avatar: page.avatar || "",
    tasks: Array.isArray(page.tasks) ? page.tasks : [],
    hasToken: Boolean(page.accessToken),
    tokenIds: Object.keys(page.tokenBindings || {}),
    groupIds: Array.isArray(page.groupIds) ? page.groupIds : [],
  };
}

function maskToken(value) {
  const token = String(value || "");
  return token.length > 12 ? `${token.slice(0, 6)}…${token.slice(-4)}` : token ? "***" : "";
}

function fingerprint(value) {
  return value ? createHash("sha256").update(String(value)).digest("hex") : "";
}

function publicToken(token) {
  return {
    id: token.id,
    name: token.name || token.id,
    ownerName: token.ownerName || "",
    kind: token.kind || "USER",
    status: token.status || "UNKNOWN",
    errorMessage: token.errorMessage || "",
    note: token.note || "",
    pagesCount: Number(token.pagesCount || 0),
    lastChecked: token.lastChecked || null,
    createdAt: token.createdAt || null,
    lastUsed: token.lastUsed || null,
    totalCalls: Number(token.totalCalls || 0),
    appUsagePct: Number(token.appUsagePct || 0),
    cputimePct: Number(token.cputimePct || 0),
    timePct: Number(token.timePct || 0),
    rateStatus: token.rateStatus || "NORMAL",
    tokenMasked: maskToken(token.token),
    hasToken: Boolean(token.token),
  };
}

function publicTokenGroup(group) {
  return {
    id: group.id,
    name: group.name,
    strategy: group.strategy || "least_recently_used",
    tokenIds: Array.isArray(group.tokenIds) ? group.tokenIds : [],
    pageSourceTokenId: group.pageSourceTokenId || "",
    pageIds: Array.isArray(group.pageIds) ? group.pageIds : [],
    note: group.note || "",
    createdAt: group.createdAt || null,
    updatedAt: group.updatedAt || null,
    pagesSyncedAt: group.pagesSyncedAt || null,
  };
}

function publicPageGroup(group) {
  return {
    id: group.id,
    name: group.name,
    pageIds: Array.isArray(group.pageIds) ? group.pageIds : [],
    folderBinding: group.folderBinding || "",
    scheduleConfig: group.scheduleConfig || { times: [], staggerMinutes: 15 },
    createdAt: group.createdAt || null,
    updatedAt: group.updatedAt || null,
  };
}

function publicMeta(meta) {
  const active = (meta?.tokens || []).find((token) => token.id === meta?.activeTokenId);
  return {
    connected: meta?.enabled !== false && Boolean(active?.token || meta?.accessToken),
    graphVersion: meta?.graphVersion || GRAPH_VERSION,
    user: meta?.user || null,
    activeToken: active ? { id: active.id, name: active.name || active.id } : null,
    pages: (meta?.pages || []).map(publicPage),
    tokens: (meta?.tokens || []).map(publicToken),
    tokenGroups: (meta?.tokenGroups || []).map(publicTokenGroup),
    pageGroups: (meta?.pageGroups || []).map(publicPageGroup),
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
  meta.tokens ??= [];
  meta.tokenGroups ??= [];
  meta.pageGroups ??= [];
  for (const group of meta.tokenGroups) {
    group.tokenIds = Array.isArray(group.tokenIds) ? group.tokenIds : [];
    group.pageIds = Array.isArray(group.pageIds) ? group.pageIds : [];
  }
  for (const group of meta.pageGroups) {
    group.pageIds = Array.isArray(group.pageIds) ? group.pageIds : [];
    group.scheduleConfig ??= { times: [], staggerMinutes: 15 };
  }
  if (meta.enabled !== false && !meta.activeTokenId && meta.tokens.length) meta.activeTokenId = meta.tokens[0].id;
  if (meta.enabled !== false && meta.activeTokenId) {
    const active = meta.tokens.find((token) => token.id === meta.activeTokenId);
    if (active?.token && !meta.accessToken) meta.accessToken = active.token;
  }
  return meta;
}

function upsertToken(meta, accessToken, { user = null, pages = [] } = {}) {
  const token = String(accessToken || "").trim();
  const existing = meta.tokens.find((item) => item.token === token);
  const timestamp = new Date().toISOString();
  const entry = existing || {
    id: `tok_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    createdAt: timestamp,
    totalCalls: 0,
    callCountHour: 0,
    usageWindowStart: Date.now(),
  };
  Object.assign(entry, {
    name: entry.name || user?.name || `Token ${meta.tokens.length + 1}`,
    ownerName: user?.name || entry.ownerName || "",
    kind: entry.kind || "USER",
    token,
    status: "ACTIVE",
    errorMessage: "",
    pagesCount: pages.length,
    lastChecked: timestamp,
    appUsagePct: Number(entry.appUsagePct || 0),
    cputimePct: Number(entry.cputimePct || 0),
    timePct: Number(entry.timePct || 0),
    rateStatus: entry.rateStatus || "NORMAL",
  });
  meta.enabled = true;
  if (!existing) meta.tokens.push(entry);
  meta.activeTokenId = entry.id;
  return entry;
}

function syncPages(meta, tokenEntry, pages) {
  const seen = new Set();
  const verifiedAt = new Date().toISOString();
  for (const source of Array.isArray(pages) ? pages : []) {
    const id = String(source.id || source.page_id || "").trim();
    const pageToken = String(source.access_token || source.accessToken || source.page_token || "").trim();
    if (!/^\d{1,40}$/.test(id) || !pageToken) continue;
    seen.add(id);
    let page = meta.pages.find((item) => item.id === id);
    if (!page) {
      page = { id, name: String(source.name || source.page_name || id).slice(0, 200), tasks: [], groupIds: [], tokenBindings: {} };
      meta.pages.push(page);
    }
    page.name = String(source.name || source.page_name || page.name || id).slice(0, 200);
    page.category = String(source.category || page.category || "").slice(0, 200);
    page.avatar = String(source.avatar || page.avatar || "");
    page.tasks = Array.isArray(source.tasks) ? source.tasks.slice(0, 30).map(String) : page.tasks || [];
    page.tokenBindings ??= {};
    page.tokenBindings[tokenEntry.id] = {
      tokenId: tokenEntry.id,
      pageToken,
      credentialFingerprint: fingerprint(tokenEntry.token),
      tasks: page.tasks,
      status: "VERIFIED",
      verifiedAt,
    };
    page.accessToken = pageToken;
  }
  for (const page of meta.pages) {
    const binding = page.tokenBindings?.[tokenEntry.id];
    if (binding && !seen.has(page.id)) {
      delete page.tokenBindings[tokenEntry.id];
      if (page.accessToken === binding.pageToken) {
        const replacement = Object.values(page.tokenBindings || {})[0];
        page.accessToken = replacement?.pageToken || "";
      }
    }
  }
}

function healthyToken(meta, ids = []) {
  const allowed = ids.length ? new Set(ids) : null;
  const candidates = meta.tokens.filter((token) => token.status === "ACTIVE" && token.token && (!allowed || allowed.has(token.id)));
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => (a.rateStatus === "COOLDOWN_80") - (b.rateStatus === "COOLDOWN_80") || Number(a.appUsagePct || 0) - Number(b.appUsagePct || 0) || Number(a.callCountHour || 0) - Number(b.callCountHour || 0) || String(a.lastUsed || "").localeCompare(String(b.lastUsed || "")))[0];
}

function requireToken(meta) {
  if (meta.enabled === false) throw new StudioError("Hãy kết nối Meta bằng access token của bạn trước.", "META_NOT_CONNECTED", 409);
  const active = meta.tokens.find((token) => token.id === meta.activeTokenId && token.token);
  const token = active?.token || meta.accessToken;
  if (!token) throw new StudioError("Hãy kết nối Meta bằng access token của bạn trước.", "META_NOT_CONNECTED", 409);
  return token;
}

function requireBoundPage(meta, tokenIds = []) {
  if (!meta.boundPageId || !meta.boundPageToken)
    throw new StudioError("Hãy chọn Page Meta trước khi kiểm tra hoặc đăng bài.", "META_PAGE_NOT_BOUND", 409);
  const current = meta.pages.find((page) => page.id === meta.boundPageId);
  if (current?.tokenBindings && meta.tokens?.length) {
    const allowed = new Set(tokenIds || []);
    const ids = Object.keys(current.tokenBindings).filter((id) => current.tokenBindings[id]?.pageToken && (!allowed.size || allowed.has(id)));
    const selected = healthyToken(meta, ids);
    const binding = selected ? current.tokenBindings[selected.id] : null;
    if (binding) {
      selected.lastUsed = new Date().toISOString();
      selected.totalCalls = Number(selected.totalCalls || 0) + 1;
      return { id: current.id, name: current.name || current.id, accessToken: binding.pageToken, tokenId: selected.id };
    }
  }
  return current || {
    id: meta.boundPageId,
    name: meta.boundPageName || meta.boundPageId,
    accessToken: meta.boundPageToken,
  };
}

function postPreflight(store, post, meta) {
  const checks = [];
  const active = meta.tokens?.find((token) => token.id === meta.activeTokenId && token.token);
  const connected = meta.enabled !== false && Boolean(active?.token || meta.accessToken);
  const managedPage = meta.pages?.find((item) => item.id === meta.boundPageId);
  const bound = Boolean(meta.boundPageId && (managedPage?.accessToken || meta.boundPageToken));
  checks.push({ key: "connected", ok: connected, message: connected ? "Meta đã kết nối." : "Chưa có Meta access token." });
  checks.push({ key: "page", ok: bound, message: meta.boundPageId ? `Đã chọn Page ${meta.boundPageName || meta.boundPageId}.` : "Chưa chọn Page." });
  checks.push({ key: "status", ok: Boolean(post && ["ready", "scheduled"].includes(post.status)), message: post ? `Trạng thái hiện tại: ${post.status}.` : "Không tìm thấy bài đăng." });
  const page = post ? store.state.socialPages.find((item) => item.id === post.pageId) : null;
  checks.push({ key: "page_match", ok: Boolean(post && page && page.externalId && page.externalId === meta.boundPageId), message: page?.externalId ? `Page local: ${page.externalId}.` : "Bài chưa gắn Page ID Meta." });
  if (post?.pageGroupId) {
    const group = (meta.pageGroups || []).find((item) => item.id === post.pageGroupId);
    const inGroup = Boolean(group && group.pageIds.includes(meta.boundPageId));
    checks.push({ key: "page_group", ok: inGroup, message: inGroup ? `Page thuộc nhóm ${group.name}.` : "Page bind không thuộc nhóm Page của bài." });
  }
  if (post?.tokenGroupId) {
    const group = (meta.tokenGroups || []).find((item) => item.id === post.tokenGroupId);
    const pageTokenIds = new Set(Object.keys(managedPage?.tokenBindings || {}));
    const inGroup = Boolean(group && group.tokenIds.some((id) => pageTokenIds.has(id)));
    checks.push({ key: "token_group", ok: inGroup, message: inGroup ? `Token khỏe được chọn từ nhóm ${group.name}.` : "Page chưa có token thuộc pool đã chọn." });
  }
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
        category: String(page.category || "").slice(0, 200),
        avatar: String(page.picture?.data?.url || page.avatar || ""),
        tasks: Array.isArray(page.tasks) ? page.tasks.slice(0, 30).map(String) : [],
        accessToken: String(page.access_token || ""),
      }))
      : [];
    if (!pages.length) throw new StudioError("Meta không trả về Page có quyền quản lý.", "META_NO_PAGES", 409);
    const meta = metaState(store);
    meta.enabled = true;
    meta.accessToken = accessToken;
    meta.user = { id: String(user.id || ""), name: String(user.name || "").slice(0, 200) };
    const tokenEntry = upsertToken(meta, accessToken, { user: meta.user, pages });
    syncPages(meta, tokenEntry, pages);
    if (!meta.pages.some((page) => page.id === meta.boundPageId && page.accessToken)) {
      meta.boundPageId = "";
      meta.boundPageName = "";
      meta.boundPageToken = "";
    }
    store.save();
    res.json(publicMeta(meta));
  });

  app.post("/api/meta/refresh-pages", async (req, res) => {
    const meta = metaState(store);
    const tokenId = String(req.body?.tokenId || meta.activeTokenId || "");
    const selected = meta.tokens.find((item) => item.id === tokenId && item.token);
    const token = selected?.token || requireToken(meta);
    let response;
    try {
      response = await client.pages(token);
    } catch (error) {
      if (selected) {
        selected.status = "ERROR";
        selected.errorMessage = safeMessage(error.message, token);
        selected.lastChecked = new Date().toISOString();
        store.save();
      }
      throw error;
    }
    const pages = (response.data || []).filter((page) => pageIdSchema.safeParse(String(page.id)).success).map((page) => ({
      id: String(page.id), name: String(page.name || page.id).slice(0, 200), category: String(page.category || "").slice(0, 200), avatar: String(page.picture?.data?.url || page.avatar || ""), tasks: Array.isArray(page.tasks) ? page.tasks.slice(0, 30).map(String) : [], accessToken: String(page.access_token || ""),
    }));
    meta.pages = meta.pages.filter((page) => page.id === meta.boundPageId || page.tokenBindings);
    const tokenEntry = selected || meta.tokens.find((item) => item.token === token);
    if (tokenEntry) {
      tokenEntry.status = "ACTIVE";
      tokenEntry.errorMessage = "";
      tokenEntry.pagesCount = pages.length;
      tokenEntry.lastChecked = new Date().toISOString();
      syncPages(meta, tokenEntry, pages);
    }
    for (const page of pages) {
      const existing = meta.pages.find((item) => item.id === page.id);
      if (!existing) meta.pages.push(page);
    }
    meta.pages = meta.pages.map((page) => ({
      ...page,
      ...(pages.find((item) => item.id === page.id) || {}),
    }));
    store.save();
    res.json(publicMeta(meta));
  });

  app.post("/api/meta/bind", (req, res) => {
    const meta = metaState(store);
    const tokenId = String(req.body?.tokenId || meta.activeTokenId || "");
    const selectedToken = meta.tokens.find((item) => item.id === tokenId && item.token);
    requireToken(meta);
    const pageId = pageIdSchema.parse(String(req.body?.pageId || ""));
    const page = meta.pages.find((item) => item.id === pageId);
    if (!page?.accessToken) throw new StudioError("Page không có page access token trong quyền hiện tại.", "META_PAGE_TOKEN_MISSING", 409);
    const binding = selectedToken ? page.tokenBindings?.[selectedToken.id] : null;
    if (selectedToken && !binding?.pageToken) throw new StudioError("Token này chưa được xác minh cho Page đã chọn.", "META_PAGE_TOKEN_MISSING", 409);
    if (selectedToken) {
      meta.activeTokenId = selectedToken.id;
      meta.accessToken = selectedToken.token;
      meta.user = { id: selectedToken.userId || meta.user?.id || "", name: selectedToken.ownerName || meta.user?.name || "" };
    }
    meta.boundPageId = page.id;
    meta.boundPageName = page.name;
    meta.boundPageToken = binding?.pageToken || page.accessToken;
    store.save();
    res.json(publicMeta(meta));
  });

  const listTokens = () => metaState(store).tokens.map(publicToken);
  const listTokenGroups = () => metaState(store).tokenGroups.map(publicTokenGroup);
  const listPageGroups = () => metaState(store).pageGroups.map(publicPageGroup);

  app.get(["/api/meta/tokens", "/api/tokens"], (req, res) => res.json({ tokens: listTokens() }));
  app.get(["/api/meta/token-groups", "/api/token-groups"], (req, res) => res.json({ groups: listTokenGroups() }));
  app.get(["/api/meta/page-groups", "/api/groups"], (req, res) => res.json({ groups: listPageGroups() }));
  app.get("/api/pages", (req, res) => {
    const meta = metaState(store);
    res.json({ pages: meta.pages.map(publicPage), groups: listPageGroups(), mappingHealth: {
      totalPages: meta.pages.length,
      verified: meta.pages.filter((page) => Object.keys(page.tokenBindings || {}).length > 0).length,
      mappedCredentials: new Set(meta.pages.flatMap((page) => Object.keys(page.tokenBindings || {}))).size,
    } });
  });

  app.post(["/api/meta/tokens", "/api/tokens"], async (req, res) => {
    const accessToken = accessTokenSchema.parse(req.body?.accessToken || req.body?.token);
    const user = await client.me(accessToken);
    const pageResponse = await client.pages(accessToken);
    const pages = Array.isArray(pageResponse?.data) ? pageResponse.data.filter((page) => pageIdSchema.safeParse(String(page.id)).success).map((page) => ({
      id: String(page.id), name: String(page.name || page.id).slice(0, 200), category: String(page.category || "").slice(0, 200), avatar: String(page.picture?.data?.url || page.avatar || ""), tasks: Array.isArray(page.tasks) ? page.tasks.slice(0, 30).map(String) : [], accessToken: String(page.access_token || ""),
    })) : [];
    if (!pages.length) throw new StudioError("Meta không trả về Page có quyền quản lý.", "META_NO_PAGES", 409);
    const meta = metaState(store);
    const entry = upsertToken(meta, accessToken, { user, pages });
    entry.name = String(req.body?.name || entry.name).trim().slice(0, 120) || entry.name;
    entry.kind = String(req.body?.kind || entry.kind || "USER").slice(0, 40);
    entry.note = String(req.body?.note || entry.note || "").slice(0, 2000);
    entry.userId = String(user.id || entry.userId || "");
    meta.activeTokenId = entry.id;
    meta.accessToken = accessToken;
    meta.user = { id: String(user.id || ""), name: String(user.name || "").slice(0, 200) };
    syncPages(meta, entry, pages);
    store.save();
    res.status(201).json({ token: publicToken(entry), pages: pages.map(publicPage) });
  });

  app.post(["/api/meta/tokens/:id/refresh-pages", "/api/tokens/:id/refresh-pages"], async (req, res) => {
    const meta = metaState(store);
    const entry = meta.tokens.find((item) => item.id === req.params.id);
    if (!entry?.token) throw new StudioError("Không tìm thấy token.", "META_TOKEN_NOT_FOUND", 404);
    let user;
    let response;
    try {
      user = await client.me(entry.token);
      response = await client.pages(entry.token);
    } catch (error) {
      entry.status = "ERROR";
      entry.errorMessage = safeMessage(error.message, entry.token);
      entry.lastChecked = new Date().toISOString();
      store.save();
      throw error;
    }
    const pages = Array.isArray(response?.data) ? response.data : [];
    meta.enabled = true;
    entry.status = "ACTIVE";
    entry.errorMessage = "";
    entry.pagesCount = pages.length;
    entry.lastChecked = new Date().toISOString();
    entry.ownerName = String(user.name || entry.ownerName || "").slice(0, 200);
    entry.userId = String(user.id || entry.userId || "");
    meta.activeTokenId = entry.id;
    meta.accessToken = entry.token;
    meta.user = { id: entry.userId, name: entry.ownerName };
    syncPages(meta, entry, pages);
    store.save();
    res.json({ token: publicToken(entry), syncedPages: pages.length });
  });

  app.delete(["/api/meta/tokens/:id", "/api/tokens/:id"], (req, res) => {
    const meta = metaState(store);
    const before = meta.tokens.length;
    meta.tokens = meta.tokens.filter((item) => item.id !== req.params.id);
    if (before === meta.tokens.length) throw new StudioError("Không tìm thấy token.", "META_TOKEN_NOT_FOUND", 404);
    for (const page of meta.pages) {
      if (page.tokenBindings) delete page.tokenBindings[req.params.id];
      const replacement = Object.values(page.tokenBindings || {})[0];
      page.accessToken = replacement?.pageToken || "";
    }
    for (const group of meta.tokenGroups) group.tokenIds = (group.tokenIds || []).filter((id) => id !== req.params.id);
    if (meta.activeTokenId === req.params.id) {
      const replacement = meta.tokens.find((token) => token.token);
      meta.activeTokenId = replacement?.id || "";
      meta.accessToken = replacement?.token || "";
      meta.user = replacement ? { id: replacement.userId || "", name: replacement.ownerName || "" } : null;
    }
    store.save();
    res.json({ ok: true });
  });

  app.post(["/api/meta/token-groups", "/api/token-groups"], (req, res) => {
    const meta = metaState(store);
    const body = req.body || {};
    const name = z.string().trim().min(1).max(120).parse(body.name);
    const strategy = z.enum(["round_robin", "least_recently_used", "random"]).catch("least_recently_used").parse(body.strategy || "least_recently_used");
    const tokenIds = [...new Set((Array.isArray(body.tokenIds) ? body.tokenIds : body.token_ids || []).map(String))];
    if (tokenIds.some((id) => !meta.tokens.some((token) => token.id === id))) throw new StudioError("Nhóm chứa token không tồn tại.", "META_TOKEN_NOT_FOUND", 404);
    const id = String(body.id || `tgrp_${randomUUID().replaceAll("-", "").slice(0, 12)}`);
    const now = new Date().toISOString();
    let group = meta.tokenGroups.find((item) => item.id === id);
    if (!group) { group = { id, createdAt: now }; meta.tokenGroups.push(group); }
    Object.assign(group, { name, strategy, tokenIds, note: String(body.note || "").slice(0, 2000), pageSourceTokenId: String(body.pageSourceTokenId || body.page_source_token_id || group.pageSourceTokenId || ""), updatedAt: now });
    if (group.pageSourceTokenId) group.pageIds = meta.pages.filter((page) => page.tokenBindings?.[group.pageSourceTokenId]).map((page) => page.id);
    store.save();
    res.json({ group: publicTokenGroup(group) });
  });

  app.post(["/api/meta/token-groups/:id/rebind-pages", "/api/token-groups/:id/rebind-pages"], (req, res) => {
    const meta = metaState(store);
    const group = meta.tokenGroups.find((item) => item.id === req.params.id);
    if (!group) throw new StudioError("Không tìm thấy nhóm token.", "META_TOKEN_GROUP_NOT_FOUND", 404);
    if (!group.pageSourceTokenId || !meta.tokens.some((token) => token.id === group.pageSourceTokenId)) throw new StudioError("Nhóm chưa có token nguồn Page hợp lệ.", "META_TOKEN_SOURCE_NOT_FOUND", 409);
    group.pageIds = meta.pages.filter((page) => page.tokenBindings?.[group.pageSourceTokenId]).map((page) => page.id);
    group.pagesSyncedAt = new Date().toISOString();
    store.save();
    res.json({ group: publicTokenGroup(group) });
  });

  app.delete(["/api/meta/token-groups/:id", "/api/token-groups/:id"], (req, res) => {
    const meta = metaState(store);
    meta.tokenGroups = meta.tokenGroups.filter((item) => item.id !== req.params.id);
    store.save();
    res.json({ ok: true });
  });

  app.post(["/api/meta/page-groups", "/api/groups"], (req, res) => {
    const meta = metaState(store);
    const body = req.body || {};
    const name = z.string().trim().min(1).max(120).parse(body.name);
    const pageIds = [...new Set((Array.isArray(body.pageIds) ? body.pageIds : body.page_ids || []).map(String))];
    const known = new Set(meta.pages.map((page) => page.id));
    if (pageIds.some((id) => !known.has(id))) throw new StudioError("Nhóm chứa Page không tồn tại.", "META_PAGE_NOT_FOUND", 404);
    const id = String(body.id || `pgrp_${randomUUID().replaceAll("-", "").slice(0, 12)}`);
    const now = new Date().toISOString();
    let group = meta.pageGroups.find((item) => item.id === id);
    if (!group) { group = { id, createdAt: now }; meta.pageGroups.push(group); }
    Object.assign(group, { name, pageIds, folderBinding: String(body.folderBinding || body.folder_binding || group.folderBinding || ""), scheduleConfig: body.scheduleConfig || body.schedule_config || group.scheduleConfig || { times: [], staggerMinutes: 15 }, updatedAt: now });
    for (const page of meta.pages) page.groupIds = meta.pageGroups.filter((item) => item.pageIds.includes(page.id)).map((item) => item.id);
    store.save();
    res.json({ group: publicPageGroup(group) });
  });

  app.delete(["/api/meta/page-groups/:id", "/api/groups/:id"], (req, res) => {
    const meta = metaState(store);
    meta.pageGroups = meta.pageGroups.filter((item) => item.id !== req.params.id);
    for (const page of meta.pages) page.groupIds = (page.groupIds || []).filter((id) => id !== req.params.id);
    store.save();
    res.json({ ok: true });
  });

  app.delete("/api/meta", (req, res) => {
    const meta = metaState(store);
    Object.assign(meta, { enabled: false, activeTokenId: "", accessToken: "", user: null, pages: [], boundPageId: "", boundPageName: "", boundPageToken: "" });
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
    const tokenGroup = post.tokenGroupId ? meta.tokenGroups.find((group) => group.id === post.tokenGroupId) : null;
    const page = requireBoundPage(meta, tokenGroup?.tokenIds || []);
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
