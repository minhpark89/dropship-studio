import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { StudioError } from "./store.js";
import { importMedia } from "./media.js";
import { generateImageEndpoint, resolveMcImageConfig } from "./mc-image.js";
import { requestJsonContent } from "./llm.js";
import { autoScheduleWarehousePosts, normalizeScheduleConfig } from "./social.js";
import { classifyMetaFailure, metaResponseDetails } from "./meta-errors.js";
import { mountManagementRoutes } from "./management.js";
import { cleanupPublishedMedia, publishedVideo, returnPostToWarehouse } from "./post-lifecycle.js";
import { managedPageUnavailable } from "../shared/management.js";

const GRAPH_VERSION = "v26.0";
const accessTokenSchema = z.string().trim().min(10).max(5000);
const pageIdSchema = z.string().regex(/^\d{1,40}$/);
const tokenKindSchema = z.enum(["USER", "SYSTEM_USER", "VIA_TOKEN"]);
const appIdSchema = z.string().trim().min(1).max(200);
const appSecretSchema = z.string().trim().min(1).max(5000);
export const AVATAR_APPLY_POLICY = Object.freeze({ delayMs: 1000, batchSize: 10, batchPauseMs: 5000 });
const MAX_PAGE_COLLECTIONS = 500;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isMetaRateLimitError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return /rate.?limit|too many|(#4)|(#17)|(#32)|(#613)|throttl/.test(message);
}

function safeMessage(value, ...secrets) {
  const message = String(value || "Meta request failed");
  return secrets.filter(Boolean).reduce((current, secret) => current.split(String(secret)).join("[redacted]"), message);
}

function publicPage(page) {
  const bindings = Object.values(page.tokenBindings || {});
  const verified = bindings.filter((binding) => binding?.status === "VERIFIED" && binding.pageToken);
  const failed = bindings.find((binding) => binding?.status === "ERROR" || binding?.errorMessage);
  return {
    id: page.id,
    name: page.name || page.id,
    category: page.category || "",
    avatar: /^https?:\/\//i.test(String(page.avatar || "")) ? `/api/meta/pages/${page.id}/avatar` : page.avatar || "",
    avatarMediaId: page.avatarMediaId || "",
    avatarSource: page.avatarSource || (page.avatarMediaId ? "ai" : "meta"),
    avatarUpdatedAt: page.avatarUpdatedAt || null,
    avatarStatus: page.avatarStatus || (page.avatar ? "ready" : "missing"),
    avatarError: page.avatarError || "",
    tasks: Array.isArray(page.tasks) ? page.tasks : [],
    hasToken: Boolean(page.accessToken),
    tokenIds: Object.keys(page.tokenBindings || {}),
    groupIds: Array.isArray(page.groupIds) ? page.groupIds : [],
    health: page.publishingHealth?.blocked ? "ERROR" : verified.length ? "HEALTHY" : failed ? "ERROR" : "UNVERIFIED",
    errorMessage: String(page.publishingHealth?.blocked ? page.publishingHealth.message : failed?.errorMessage || ""),
    publishingHealth: page.publishingHealth || null,
    bindingCount: bindings.length,
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
    appId: token.appId || "",
    hasAppSecret: Boolean(token.appSecret),
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
  const assignmentLoads = group.assignmentLoads && typeof group.assignmentLoads === "object" ? group.assignmentLoads : {};
  return {
    id: group.id,
    name: group.name,
    strategy: group.strategy || "least_recently_used",
    tokenIds: Array.isArray(group.tokenIds) ? group.tokenIds : [],
    pageSourceTokenId: group.pageSourceTokenId || "",
    pageIds: Array.isArray(group.pageIds) ? group.pageIds : [],
    note: group.note || "",
    maxPagesPerToken: Number(group.maxPagesPerToken || 0),
    autoAssign: group.autoAssign !== false,
    pageAssignments: group.pageTokenBindings && typeof group.pageTokenBindings === "object" ? { ...group.pageTokenBindings } : {},
    assignmentLoads: Object.fromEntries(Object.entries(assignmentLoads).map(([id, count]) => [id, Number(count || 0)])),
    assignedPageCount: Number(group.assignedPageCount || Object.keys(group.pageTokenBindings || {}).length || 0),
    assignmentBlockedCount: Number(group.assignmentBlockedCount || 0),
    assignmentUpdatedAt: group.assignmentUpdatedAt || null,
    createdAt: group.createdAt || null,
    updatedAt: group.updatedAt || null,
    pagesSyncedAt: group.pagesSyncedAt || null,
  };
}

function publicPageGroup(group) {
  return {
    id: group.id,
    purpose: group.purpose || (group.id.startsWith('pgrp_hold_') ? 'review' : 'active'),
    name: group.name,
    pageIds: Array.isArray(group.pageIds) ? group.pageIds : [],
    folderBinding: group.folderBinding || "",
    scheduleConfig: normalizeScheduleConfig(group.scheduleConfig),
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
    pages: (meta?.pages || []).filter(page => page.management?.status !== 'deleted').map(publicPage),
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

async function jsonResponse(response, token, extraSecrets = []) {
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || body?.error) {
    const message = body?.error?.message || `Meta Graph HTTP ${response.status}`;
    const redacted = [token, ...extraSecrets].filter(Boolean).reduce((value, secret) => safeMessage(value, secret), message);
    const error = new StudioError(redacted, "META_GRAPH_ERROR", 502);
    error.metaError = metaResponseDetails(response, body);
    throw error;
  }
  return body || {};
}

async function collectPagedPages(first, token, fetchImpl) {
  const pages = Array.isArray(first?.data) ? [...first.data] : [];
  const seen = new Set();
  let next = first?.paging?.next || "";
  let requests = 1;
  while (next && requests < MAX_PAGE_COLLECTIONS && !seen.has(String(next))) {
    seen.add(String(next));
    let url;
    try {
      url = new URL(String(next));
      if (!['http:', 'https:'].includes(url.protocol)) break;
      if (!url.searchParams.has("access_token")) url.searchParams.set("access_token", token);
    } catch {
      break;
    }
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    const body = await jsonResponse(response, token);
    if (Array.isArray(body.data)) pages.push(...body.data);
    next = body?.paging?.next || "";
    requests += 1;
  }
  return { ...first, data: pages };
}

export function createMetaClient({ fetchImpl = globalThis.fetch, graphBase = "https://graph.facebook.com", graphVersion = GRAPH_VERSION } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");
  const request = async ({ token, path, method = "GET", params = {}, body = null, headers = {}, signal }) => {
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
      signal,
    });
    return jsonResponse(response, token);
  };
  return {
    me: (token) => request({ token, path: "me", params: { fields: "id,name" } }),
    pageStatus: ({ token, pageId, signal }) => request({ token, path: String(pageId), params: { fields: "id,name,is_published" }, signal }),
    pages: async (token) => collectPagedPages(
      await request({ token, path: "me/accounts", params: { fields: "id,name,access_token,tasks,picture{url}" } }),
      token,
      fetchImpl,
    ),
    updatePagePicture: async ({ token, pageId, bytes, filename = "page-avatar.png" }) => {
      const form = new FormData();
      const contentType = /\.jpe?g$/i.test(String(filename)) ? "image/jpeg" : "image/png";
      form.append("source", new Blob([bytes], { type: contentType }), filename);
      form.append("access_token", token);
      const response = await fetchImpl(graphEndpoint(graphBase, graphVersion, `${pageId}/picture`), {
        method: "POST",
        body: form,
      });
      return jsonResponse(response, token);
    },
    debugToken: async ({ token, appId, appSecret }) => {
      const appAccessToken = `${appId}|${appSecret}`;
      const url = graphEndpoint(graphBase, graphVersion, "debug_token", {
        input_token: token,
        access_token: appAccessToken,
      });
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
      });
      return jsonResponse(response, token, [appSecret, appAccessToken]);
    },
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
    videoStatus: ({ token, videoId }) => request({ token, path: String(videoId), params: { fields: "id,status,permalink_url" } }),
    comment: ({ token, objectId, message }) => request({
      token,
      path: `${objectId}/comments`,
      method: "POST",
      body: new URLSearchParams({ message: String(message || "").slice(0, 10000) }),
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
  if (!meta.graphVersion || meta.graphVersion === "v24.0") meta.graphVersion = GRAPH_VERSION;
  meta.pages ??= [];
  meta.publications ??= [];
  meta.tokens ??= [];
  meta.tokenGroups ??= [];
  meta.pageGroups ??= [];
  for (const group of meta.tokenGroups) {
    group.tokenIds = Array.isArray(group.tokenIds) ? group.tokenIds : [];
    group.pageIds = Array.isArray(group.pageIds) ? group.pageIds : [];
    group.strategy = normalizeTokenStrategy(group.strategy);
    group.maxPagesPerToken = Math.max(0, Math.min(50, Math.floor(Number(group.maxPagesPerToken || 0) || 0)));
    group.pageTokenBindings = group.pageTokenBindings && typeof group.pageTokenBindings === "object" ? group.pageTokenBindings : {};
    group.assignmentLoads = group.assignmentLoads && typeof group.assignmentLoads === "object" ? group.assignmentLoads : {};
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

function upsertToken(meta, accessToken, { user = null, pages = [], appId = "", appSecret = "" } = {}) {
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
    appId: appId || entry.appId || "",
    appSecret: appSecret || entry.appSecret || "",
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

async function validateViaToken(client, { token, appId, appSecret }) {
  if (typeof client.debugToken !== "function") {
    throw new StudioError("Meta client chưa hỗ trợ kiểm tra Via token.", "META_VIA_TOKEN_UNSUPPORTED", 502);
  }
  const debug = await client.debugToken({ token, appId, appSecret });
  const data = debug?.data || {};
  if (data.is_valid !== true) {
    throw new StudioError("Via token không hợp lệ hoặc đã hết hạn.", "META_VIA_TOKEN_INVALID", 401);
  }
  if (data.app_id && String(data.app_id) !== String(appId)) {
    throw new StudioError("App ID không khớp với Via token.", "META_VIA_TOKEN_APP_MISMATCH", 400);
  }
  return data;
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

const tokenStrategies = new Set(["round_robin", "least_recently_used", "random"]);

function normalizeTokenStrategy(value, fallback = "round_robin") {
  const candidate = String(value || "").trim();
  return tokenStrategies.has(candidate) ? candidate : fallback;
}

function usableTokenBinding(meta, page, tokenId) {
  const token = meta.tokens.find((item) => item.id === tokenId);
  const binding = page?.tokenBindings?.[tokenId];
  return Boolean(token?.status === "ACTIVE" && token.token && binding?.status === "VERIFIED" && binding.pageToken && String(binding.verifiedPageId || page.id) === String(page.id) && binding.credentialFingerprint === fingerprint(token.token));
}

function tokenGroupPageIds(meta, group) {
  const configured = [...new Set((Array.isArray(group.pageIds) ? group.pageIds : []).map(String).filter(Boolean))];
  const sourceId = String(group.pageSourceTokenId || "");
  if (sourceId) return meta.pages.filter((page) => usableTokenBinding(meta, page, sourceId)).map((page) => page.id);
  const tokenIds = new Set((group.tokenIds || []).map(String));
  const derived = meta.pages.filter((page) => [...tokenIds].some((tokenId) => usableTokenBinding(meta, page, tokenId))).map((page) => page.id);
  return [...new Set([...configured, ...derived])].filter((id) => meta.pages.some((page) => page.id === id));
}

export function autoAssignTokenGroup(meta, group, { strategy = group.strategy, maxPagesPerToken = group.maxPagesPerToken, pageIds = null } = {}) {
  const normalizedStrategy = normalizeTokenStrategy(strategy);
  const max = Number.isFinite(Number(maxPagesPerToken)) ? Math.max(0, Math.min(50, Math.floor(Number(maxPagesPerToken)))) : 0;
  const tokenIds = [...new Set((group.tokenIds || []).map(String).filter(Boolean))];
  const selectedPageIds = pageIds ? [...new Set(pageIds.map(String))] : tokenGroupPageIds(meta, group);
  const pages = selectedPageIds.map((id) => meta.pages.find((page) => page.id === id)).filter(Boolean);
  const loads = Object.fromEntries(tokenIds.map((id) => [id, 0]));
  const assignments = {};
  const blocked = [];
  let cursor = 0;
  for (const page of pages) {
    let choices = tokenIds.filter((tokenId) => usableTokenBinding(meta, page, tokenId));
    if (!choices.length) {
      blocked.push({ pageId: page.id, code: "missing_mapping" });
      continue;
    }
    if (max > 0) choices = choices.filter((tokenId) => loads[tokenId] < max);
    if (!choices.length) {
      blocked.push({ pageId: page.id, code: "token_capacity" });
      continue;
    }
    let selected;
    if (normalizedStrategy === "round_robin") {
      const available = new Set(choices);
      for (let offset = 0; offset < tokenIds.length; offset += 1) {
        const candidate = tokenIds[(cursor + offset) % tokenIds.length];
        if (available.has(candidate)) {
          selected = candidate;
          cursor = (tokenIds.indexOf(candidate) + 1) % tokenIds.length;
          break;
        }
      }
    } else if (normalizedStrategy === "random") {
      selected = choices[Math.floor(Math.random() * choices.length)];
    } else {
      selected = choices.slice().sort((left, right) => {
        const a = meta.tokens.find((token) => token.id === left) || {};
        const b = meta.tokens.find((token) => token.id === right) || {};
        return String(a.lastUsed || "").localeCompare(String(b.lastUsed || "")) || Number(a.totalCalls || 0) - Number(b.totalCalls || 0) || tokenIds.indexOf(left) - tokenIds.indexOf(right);
      })[0];
    }
    if (!selected) {
      blocked.push({ pageId: page.id, code: "missing_mapping" });
      continue;
    }
    assignments[page.id] = selected;
    loads[selected] += 1;
  }
  Object.assign(group, {
    strategy: normalizedStrategy,
    maxPagesPerToken: max,
    autoAssign: true,
    pageIds: selectedPageIds,
    pageTokenBindings: assignments,
    assignmentLoads: loads,
    assignedPageCount: Object.keys(assignments).length,
    assignmentBlockedCount: blocked.length,
    assignmentUpdatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { group, assignedCount: Object.keys(assignments).length, blockedCount: blocked.length, blocked, loads };
}

function healthyToken(meta, ids = [], strategy = "least_recently_used") {
  const allowed = ids.length ? new Set(ids) : null;
  const candidates = meta.tokens.filter((token) => token.status === "ACTIVE" && token.token && (!allowed || allowed.has(token.id)));
  if (!candidates.length) return null;
  const healthy = candidates.filter((token) => token.rateStatus !== "COOLDOWN_80" && Number(token.appUsagePct || 0) < 80);
  const pool = healthy.length ? healthy : candidates;
  if (strategy === "random") return pool[Math.floor(Math.random() * pool.length)];
  return [...pool].sort((a, b) => String(a.lastUsed || "").localeCompare(String(b.lastUsed || "")) || Number(a.appUsagePct || 0) - Number(b.appUsagePct || 0) || Number(a.callCountHour || 0) - Number(b.callCountHour || 0) || Number(a.totalCalls || 0) - Number(b.totalCalls || 0))[0];
}

function requireToken(meta) {
  if (meta.enabled === false) throw new StudioError("Hãy kết nối Meta bằng access token của bạn trước.", "META_NOT_CONNECTED", 409);
  const active = meta.tokens.find((token) => token.id === meta.activeTokenId && token.token);
  const token = active?.token || meta.accessToken;
  if (!token) throw new StudioError("Hãy kết nối Meta bằng access token của bạn trước.", "META_NOT_CONNECTED", 409);
  return token;
}

function requireBoundPage(meta, tokenIds = [], tokenGroup = null) {
  if (!meta.boundPageId || !meta.boundPageToken)
    throw new StudioError("Hãy chọn Page Meta trước khi kiểm tra hoặc đăng bài.", "META_PAGE_NOT_BOUND", 409);
  const current = meta.pages.find((page) => page.id === meta.boundPageId);
  if (current?.tokenBindings && meta.tokens?.length) {
    const allowed = new Set(tokenIds || []);
    const ids = Object.keys(current.tokenBindings).filter((id) => current.tokenBindings[id]?.pageToken && (!allowed.size || allowed.has(id)));
    const assignedId = tokenGroup?.pageTokenBindings?.[current.id];
    const selected = healthyToken(meta, assignedId && ids.includes(assignedId) ? [assignedId] : ids, tokenGroup?.strategy);
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

function requirePostPage(store, meta, post, tokenIds = [], tokenGroup = null) {
  const local = store.state.socialPages.find((page) => page.id === post?.pageId && !page.archived);
  const targetId = String(local?.externalId || "").trim();
  const current = targetId ? meta.pages.find((page) => page.id === targetId) : null;
  if (managedPageUnavailable(current, local) && !current?.publishingHealth?.blocked) throw new StudioError("Page đang chờ xử lý, lưu trữ hoặc chưa công khai. Mở Quản lý Page để xử lý trước.", "META_PAGE_ON_HOLD", 409);
  if (current?.publishingHealth?.blocked) {
    const error = new StudioError(current.publishingHealth.message || "Page đang bị giới hạn đăng; xử lý trên Facebook trước khi cho phép thử lại.", "META_PAGE_PUBLISHING_BLOCKED", 409);
    error.metaError = current.publishingHealth.details;
    throw error;
  }
  const resolvedGroup = tokenGroup || (post?.pageGroupId ? meta.pageGroups.find((group) => group.id === post.pageGroupId && group.scheduleConfig?.tokenGroupId) && meta.tokenGroups.find((group) => group.id === meta.pageGroups.find((item) => item.id === post.pageGroupId)?.scheduleConfig?.tokenGroupId) : null) || meta.tokenGroups.find((group) => group.pageTokenBindings?.[current?.id]);
  const resolvedTokenIds = tokenIds.length ? tokenIds : resolvedGroup?.tokenIds || [];
  if (current?.tokenBindings && meta.tokens?.length) {
    const allowed = new Set(resolvedTokenIds || []);
    const ids = Object.keys(current.tokenBindings).filter((id) => current.tokenBindings[id]?.pageToken && (!allowed.size || allowed.has(id)));
    const assignedId = resolvedGroup?.pageTokenBindings?.[current.id];
    const selected = healthyToken(meta, assignedId && ids.includes(assignedId) ? [assignedId] : ids, resolvedGroup?.strategy);
    const binding = selected ? current.tokenBindings[selected.id] : null;
    if (binding) {
      selected.lastUsed = new Date().toISOString();
      selected.totalCalls = Number(selected.totalCalls || 0) + 1;
      return { id: current.id, name: current.name || current.id, accessToken: binding.pageToken, tokenId: selected.id };
    }
  }
  if (current?.accessToken) return { id: current.id, name: current.name || current.id, accessToken: current.accessToken };
  if (targetId && targetId === meta.boundPageId && meta.boundPageToken) return requireBoundPage(meta, resolvedTokenIds, resolvedGroup);
  throw new StudioError("Page local chưa có token Meta khỏe để đăng.", "META_PAGE_NOT_BOUND", 409);
}

function postPreflight(store, post, meta) {
  const checks = [];
  const active = meta.tokens?.find((token) => token.id === meta.activeTokenId && token.token);
  const localPage = post ? store.state.socialPages.find((item) => item.id === post.pageId) : null;
  const targetPageId = String(localPage?.externalId || "").trim();
  const targetManagedPage = meta.pages?.find((item) => item.id === targetPageId);
  const managedPage = targetManagedPage || meta.pages?.find((item) => item.id === meta.boundPageId);
  const connected = meta.enabled !== false && Boolean(active?.token || meta.accessToken || managedPage?.accessToken);
  const bound = Boolean(managedPage?.accessToken || (targetPageId && targetPageId === meta.boundPageId && meta.boundPageToken));
  checks.push({ key: "connected", ok: connected, message: connected ? "Meta đã kết nối." : "Chưa có Meta access token." });
  checks.push({ key: "page", ok: bound, message: targetPageId ? `Đã chọn Page ${localPage?.name || targetPageId}.` : "Chưa gắn Page local với Meta." });
  checks.push({ key: "status", ok: Boolean(post && ["ready", "scheduled"].includes(post.status)), message: post ? `Trạng thái hiện tại: ${post.status}.` : "Không tìm thấy bài đăng." });
  const page = localPage;
  checks.push({ key: "page_match", ok: Boolean(post && page && page.externalId && targetManagedPage && page.externalId === targetManagedPage.id), message: page?.externalId ? `Page local: ${page.externalId}.` : "Bài chưa gắn Page ID Meta." });
  checks.push({ key: "publishing_permission", ok: !targetManagedPage?.publishingHealth?.blocked, message: targetManagedPage?.publishingHealth?.blocked ? targetManagedPage.publishingHealth.message : "Page không có lỗi giới hạn đăng đã ghi nhận." });
  checks.push({ key: "page_lifecycle", ok: !managedPageUnavailable(targetManagedPage, localPage), message: "Page phải đang dùng, không lưu trữ hoặc chờ xử lý." });
  if (post?.pageGroupId) {
    const group = (meta.pageGroups || []).find((item) => item.id === post.pageGroupId);
    const inGroup = Boolean(group && targetPageId && group.pageIds.includes(targetPageId));
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
  const firstComment = String(post?.firstComment || "").trim();
  const requiredLink = post?.contentType === "news" ? String(post?.website?.url || "").trim() : String(post?.linkUrl || "").trim();
  const firstCommentReady = Boolean(firstComment) && (!requiredLink || firstComment.includes(requiredLink));
  checks.push({ key: "first_comment", ok: firstCommentReady, message: !firstComment ? "Cần first comment chứa link đã xác minh trước khi đăng." : requiredLink && !firstComment.includes(requiredLink) ? "First comment chưa chứa đúng URL đã xác minh." : "Đã có first comment đúng URL." });
  return { ready: checks.every((check) => check.ok), checks };
}

export function mountMetaRoutes(app, store, { client = createMetaClient(), llm = requestJsonContent, fetchImpl = globalThis.fetch } = {}) {
  const management = mountManagementRoutes(app, store, { client, postPreflight });
  app.get("/api/meta/pages/:id/avatar", async (req, res) => {
    const meta = metaState(store);
    const page = meta.pages.find((item) => item.id === String(req.params.id));
    const source = String(page?.avatar || "");
    if (!page || !/^https?:\/\//i.test(source)) throw new StudioError("Không tìm thấy avatar Meta của Page.", "META_PAGE_AVATAR_NOT_FOUND", 404);
    const response = await fetchImpl(source, { headers: { accept: "image/*" } });
    if (!response.ok) throw new StudioError("Không tải được avatar Meta hiện tại.", "META_PAGE_AVATAR_UNAVAILABLE", 502);
    const contentType = String(response.headers.get("content-type") || "image/jpeg").split(";", 1)[0];
    if (!contentType.startsWith("image/")) throw new StudioError("Meta không trả về tệp ảnh avatar.", "META_PAGE_AVATAR_INVALID", 502);
    res.set("Content-Type", contentType).set("Cache-Control", "private, max-age=300").send(Buffer.from(await response.arrayBuffer()));
  });
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
        selected.errorMessage = safeMessage(error.message, token, selected.appSecret);
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
    meta.pages = meta.pages.map((page) => {
      const incoming = pages.find((item) => item.id === page.id);
      if (!incoming) return page;
      return {
        ...page,
        ...incoming,
        // Graph can omit picture URLs on refresh; retain a generated or cached avatar.
        avatar: incoming.avatar || page.avatar || "",
        avatarMediaId: page.avatarMediaId || "",
        avatarSource: page.avatarSource || (incoming.avatar ? "meta" : ""),
        avatarUpdatedAt: page.avatarUpdatedAt || null,
        avatarStatus: incoming.avatar || page.avatar ? "ready" : "missing",
        avatarError: page.avatarError || "",
      };
    });
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
    const kind = tokenKindSchema.parse(req.body?.kind || "USER");
    const credentials = kind === "VIA_TOKEN"
      ? {
        appId: appIdSchema.parse(req.body?.appId),
        appSecret: appSecretSchema.parse(req.body?.appSecret),
      }
      : { appId: "", appSecret: "" };
    if (kind === "VIA_TOKEN") await validateViaToken(client, { token: accessToken, ...credentials });
    const user = await client.me(accessToken);
    const pageResponse = await client.pages(accessToken);
    const pages = Array.isArray(pageResponse?.data) ? pageResponse.data.filter((page) => pageIdSchema.safeParse(String(page.id)).success).map((page) => ({
      id: String(page.id), name: String(page.name || page.id).slice(0, 200), category: String(page.category || "").slice(0, 200), avatar: String(page.picture?.data?.url || page.avatar || ""), tasks: Array.isArray(page.tasks) ? page.tasks.slice(0, 30).map(String) : [], accessToken: String(page.access_token || ""),
    })) : [];
    if (!pages.length) throw new StudioError("Meta không trả về Page có quyền quản lý.", "META_NO_PAGES", 409);
    const meta = metaState(store);
    const entry = upsertToken(meta, accessToken, { user, pages, ...credentials });
    entry.name = String(req.body?.name || entry.name).trim().slice(0, 120) || entry.name;
    entry.kind = kind;
    entry.appId = kind === "VIA_TOKEN" ? credentials.appId : "";
    entry.appSecret = kind === "VIA_TOKEN" ? credentials.appSecret : "";
    entry.note = String(req.body?.note || entry.note || "").slice(0, 2000);
    entry.userId = String(user.id || entry.userId || "");
    meta.activeTokenId = entry.id;
    meta.accessToken = accessToken;
    meta.user = { id: String(user.id || ""), name: String(user.name || "").slice(0, 200) };
    syncPages(meta, entry, pages);
    store.save();
    res.status(201).json({ token: publicToken(entry), pages: pages.map(publicPage) });
  });

  app.post(["/api/meta/tokens/bulk", "/api/tokens/bulk"], async (req, res) => {
    const body = req.body || {};
    const raw = Array.isArray(body.accessTokens || body.tokens)
      ? (body.accessTokens || body.tokens)
      : String(body.text || "").split(/[\r\n,]+/);
    const tokens = [...new Set(raw.map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 100);
    if (!tokens.length) throw new StudioError("Hãy dán ít nhất một token.", "META_TOKEN_LIST_EMPTY", 422);
    const kind = tokenKindSchema.parse(body.kind || "SYSTEM_USER");
    const meta = metaState(store);
    const results = [];
    for (const rawToken of tokens) {
      let token;
      try {
        token = accessTokenSchema.parse(rawToken);
        const credentials = kind === "VIA_TOKEN"
          ? { appId: appIdSchema.parse(body.appId), appSecret: appSecretSchema.parse(body.appSecret) }
          : { appId: "", appSecret: "" };
        if (kind === "VIA_TOKEN") await validateViaToken(client, { token, ...credentials });
        const user = await client.me(token);
        const pageResponse = await client.pages(token);
        const pages = Array.isArray(pageResponse?.data)
          ? pageResponse.data.filter((page) => pageIdSchema.safeParse(String(page.id)).success).map((page) => ({
            id: String(page.id), name: String(page.name || page.id).slice(0, 200), category: String(page.category || "").slice(0, 200), avatar: String(page.picture?.data?.url || page.avatar || ""), tasks: Array.isArray(page.tasks) ? page.tasks.slice(0, 30).map(String) : [], accessToken: String(page.access_token || ""),
          }))
          : [];
        if (!pages.length) throw new StudioError("Token không trả về Page có quyền quản lý.", "META_NO_PAGES", 409);
        const entry = upsertToken(meta, token, { user, pages, ...(kind === "VIA_TOKEN" ? { appId: body.appId, appSecret: body.appSecret } : {}) });
        entry.name = String(body.name || entry.name).trim().slice(0, 120) || entry.name;
        entry.kind = kind;
        entry.note = String(body.note || entry.note || "").slice(0, 2000);
        entry.userId = String(user.id || entry.userId || "");
        syncPages(meta, entry, pages);
        results.push({ ok: true, token: publicToken(entry), pages: pages.length });
      } catch (error) {
        results.push({ ok: false, tokenMasked: maskToken(token || rawToken), error: safeMessage(error.message, token, body.appSecret) });
      }
    }
    store.save();
    res.status(201).json({ results, meta: publicMeta(meta) });
  });

  app.post(["/api/meta/tokens/:id/refresh-pages", "/api/tokens/:id/refresh-pages"], async (req, res) => {
    const meta = metaState(store);
    const entry = meta.tokens.find((item) => item.id === req.params.id);
    if (!entry?.token) throw new StudioError("Không tìm thấy token.", "META_TOKEN_NOT_FOUND", 404);
    let user;
    let response;
    try {
      if (entry.kind === "VIA_TOKEN") {
        await validateViaToken(client, { token: entry.token, appId: entry.appId, appSecret: entry.appSecret });
      }
      user = await client.me(entry.token);
      response = await client.pages(entry.token);
    } catch (error) {
      entry.status = "ERROR";
      entry.errorMessage = safeMessage(error.message, entry.token, entry.appSecret);
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
    for (const group of meta.tokenGroups) {
      group.tokenIds = (group.tokenIds || []).filter((id) => id !== req.params.id);
      group.pageTokenBindings = Object.fromEntries(Object.entries(group.pageTokenBindings || {}).filter(([, tokenId]) => tokenId !== req.params.id));
      group.assignmentLoads = Object.fromEntries(Object.entries(group.assignmentLoads || {}).filter(([tokenId]) => tokenId !== req.params.id));
      group.assignedPageCount = Object.keys(group.pageTokenBindings).length;
    }
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
    const maxPagesPerToken = Math.max(0, Math.min(50, Math.floor(Number(body.maxPagesPerToken ?? body.max_pages_per_token ?? group.maxPagesPerToken ?? 0) || 0)));
    Object.assign(group, { name, strategy, tokenIds, maxPagesPerToken, autoAssign: body.autoAssign !== false, note: String(body.note || "").slice(0, 2000), pageSourceTokenId: String(body.pageSourceTokenId || body.page_source_token_id || group.pageSourceTokenId || ""), updatedAt: now });
    if (group.pageSourceTokenId) group.pageIds = meta.pages.filter((page) => page.tokenBindings?.[group.pageSourceTokenId]).map((page) => page.id);
    else group.pageIds = tokenGroupPageIds(meta, group);
    const assignment = group.autoAssign ? autoAssignTokenGroup(meta, group, { strategy, maxPagesPerToken }) : null;
    store.save();
    res.json({ group: publicTokenGroup(group), assignment: assignment ? { assignedCount: assignment.assignedCount, blockedCount: assignment.blockedCount, loads: assignment.loads, blocked: assignment.blocked } : null });
  });

  app.post(["/api/meta/token-groups/:id/auto-assign", "/api/token-groups/:id/auto-assign"], (req, res) => {
    const meta = metaState(store);
    const group = meta.tokenGroups.find((item) => item.id === req.params.id);
    if (!group) throw new StudioError("Không tìm thấy nhóm token.", "META_TOKEN_GROUP_NOT_FOUND", 404);
    const strategy = normalizeTokenStrategy(req.body?.strategy, group.strategy);
    const maxPagesPerToken = req.body?.maxPagesPerToken === undefined && req.body?.max_pages_per_token === undefined
      ? group.maxPagesPerToken
      : Math.max(0, Math.min(50, Math.floor(Number(req.body?.maxPagesPerToken ?? req.body?.max_pages_per_token) || 0)));
    const requestedPageIds = Array.isArray(req.body?.pageIds) ? req.body.pageIds.map(String) : null;
    const assignment = autoAssignTokenGroup(meta, group, { strategy, maxPagesPerToken, pageIds: requestedPageIds });
    store.save();
    res.json({ group: publicTokenGroup(group), assignment: { assignedCount: assignment.assignedCount, blockedCount: assignment.blockedCount, loads: assignment.loads, blocked: assignment.blocked } });
  });

  app.post(["/api/meta/token-groups/:id/rebind-pages", "/api/token-groups/:id/rebind-pages"], (req, res) => {
    const meta = metaState(store);
    const group = meta.tokenGroups.find((item) => item.id === req.params.id);
    if (!group) throw new StudioError("Không tìm thấy nhóm token.", "META_TOKEN_GROUP_NOT_FOUND", 404);
    if (!group.pageSourceTokenId || !meta.tokens.some((token) => token.id === group.pageSourceTokenId)) throw new StudioError("Nhóm chưa có token nguồn Page hợp lệ.", "META_TOKEN_SOURCE_NOT_FOUND", 409);
    group.pageIds = meta.pages.filter((page) => page.tokenBindings?.[group.pageSourceTokenId]).map((page) => page.id);
    group.pagesSyncedAt = new Date().toISOString();
    if (group.autoAssign !== false) autoAssignTokenGroup(meta, group);
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
    Object.assign(group, { name, pageIds, folderBinding: String(body.folderBinding || body.folder_binding || group.folderBinding || ""), scheduleConfig: normalizeScheduleConfig(body.scheduleConfig || body.schedule_config || group.scheduleConfig || {}), updatedAt: now });
    for (const page of meta.pages) page.groupIds = meta.pageGroups.filter((item) => item.pageIds.includes(page.id)).map((item) => item.id);
    store.save();
    try {
      autoScheduleWarehousePosts(store, group.id);
    } catch {
      // The group remains saved; its next scheduler tick will surface any
      // missing Page/token binding in the post status panel.
    }
    res.json({ group: publicPageGroup(group) });
  });

  app.delete(["/api/meta/page-groups/:id", "/api/groups/:id"], (req, res) => {
    const meta = metaState(store);
    meta.pageGroups = meta.pageGroups.filter((item) => item.id !== req.params.id);
    for (const page of meta.pages) page.groupIds = (page.groupIds || []).filter((id) => id !== req.params.id);
    store.save();
    res.json({ ok: true });
  });

  app.post(["/api/meta/page-groups/:id/prune", "/api/groups/:id/prune"], (req, res) => {
    const meta = metaState(store);
    const group = meta.pageGroups.find((item) => item.id === req.params.id);
    if (!group) throw new StudioError("Không tìm thấy nhóm Page.", "META_PAGE_GROUP_NOT_FOUND", 404);
    const before = [...group.pageIds];
    const healthy = (page) => !page.publishingHealth?.blocked && Object.entries(page.tokenBindings || {}).some(([tokenId, binding]) => {
      const token = meta.tokens.find((item) => item.id === tokenId);
      return token?.status === "ACTIVE" && Boolean(binding?.pageToken) && binding.status !== "ERROR";
    });
    group.pageIds = group.pageIds.filter((id) => healthy(meta.pages.find((page) => page.id === id) || {}));
    for (const page of meta.pages) page.groupIds = meta.pageGroups.filter((item) => item.pageIds.includes(page.id)).map((item) => item.id);
    group.updatedAt = new Date().toISOString();
    store.save();
    res.json({ group: publicPageGroup(group), removedPageIds: before.filter((id) => !group.pageIds.includes(id)) });
  });

  app.post("/api/meta/page-avatars/generate", async (req, res) => {
    const body = req.body || {};
    const meta = metaState(store);
    const group = body.groupId ? meta.pageGroups.find((item) => item.id === String(body.groupId)) : null;
    if (body.groupId && !group) throw new StudioError("Không tìm thấy nhóm Page.", "META_PAGE_GROUP_NOT_FOUND", 404);
    const requestedIds = Array.isArray(body.pageIds) ? body.pageIds.map(String) : group?.pageIds || [];
    const pages = [...new Set(requestedIds)].map((id) => meta.pages.find((page) => page.id === id)).filter(Boolean).slice(0, 200);
    if (!pages.length) throw new StudioError("Chọn ít nhất một Page để đổi avatar.", "META_PAGE_SELECTION_EMPTY", 422);
    const config = await resolveMcImageConfig(store);
    if (config.enabled === false || !config.endpoint || !config.model) throw new StudioError("Chưa cấu hình AI image endpoint cho avatar.", "META_AVATAR_IMAGE_CONFIG_REQUIRED", 422);
    let prompt = String(body.prompt || "Professional editorial social media page avatar, clean bold composition, no text, no logos, square portrait.").trim();
    if (body.useLlm === true) {
      const generated = await llm(store, "Return JSON {prompt}. Rewrite the supplied avatar brief into one precise image-generation prompt for a consistent square social-media Page avatar. Keep the brand subject and visual intent, use a polished editorial style, and forbid text, watermarks, logos, trademarks and real-person likenesses unless explicitly requested. Do not add unsupported claims or named people.", {
        brief: prompt,
        pages: pages.map((page) => ({ name: page.name, category: page.category })).slice(0, 20),
      });
      prompt = z.object({ prompt: z.string().trim().min(10).max(3500) }).parse(generated).prompt;
    }
    const output = await generateImageEndpoint({ config, prompt: prompt.slice(0, 3500) });
    const extension = output.extension === ".jpg" ? ".jpg" : ".png";
    const temporary = path.join(store.root, "temp", `${randomUUID()}${extension}`);
    await fs.writeFile(temporary, output.bytes);
    let media;
    try {
      media = await importMedia(store, temporary, { name: `AI Page Avatar ${new Date().toISOString().replace(/[:.]/g, "-")}${extension}`, generated: true, move: true, mediaType: "page-avatar" });
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    const apply = body.apply === true;
    const bytes = apply ? await fs.readFile(media.file) : null;
    const avatarUrl = `/api/media/${media.id}/thumbnail`;
    const results = [];
    const tokenRateState = new Map();
    const pausedTokenIds = new Set();
    for (const page of pages) {
      const bindingEntry = Object.entries(page.tokenBindings || {}).find(([tokenId, binding]) => {
        const token = meta.tokens.find((item) => item.id === tokenId);
        return token?.status === "ACTIVE" && binding?.pageToken && binding.status !== "ERROR";
      });
      if (!bindingEntry) {
        page.avatarStatus = "error";
        page.avatarError = "Page không có token khỏe.";
        results.push({ pageId: page.id, pageName: page.name, ok: false, error: "Page không có token khỏe." });
        continue;
      }
      if (!apply) {
        page.avatar = avatarUrl;
        page.avatarMediaId = media.id;
        page.avatarSource = "ai-preview";
        page.avatarUpdatedAt = new Date().toISOString();
        page.avatarStatus = "preview";
        page.avatarError = "";
        results.push({ pageId: page.id, pageName: page.name, ok: true, status: "preview" });
        continue;
      }
      const tokenId = bindingEntry[0];
      if (pausedTokenIds.has(tokenId)) {
        const error = "Meta đang giới hạn tốc độ; Page được tạm bỏ qua để tránh gửi dồn request.";
        page.avatarStatus = "error";
        page.avatarError = error;
        results.push({ pageId: page.id, pageName: page.name, ok: false, error, status: "rate_limited" });
        continue;
      }
      try {
        if (typeof client.updatePagePicture !== "function") throw new StudioError("Meta client chưa hỗ trợ cập nhật avatar.", "META_AVATAR_UPDATE_UNSUPPORTED", 502);
        const state = tokenRateState.get(tokenId) || { calls: 0, lastCallAt: 0 };
        const elapsed = Date.now() - state.lastCallAt;
        const spacingWait = state.calls > 0 ? Math.max(0, AVATAR_APPLY_POLICY.delayMs - elapsed) : 0;
        const batchWait = state.calls > 0 && state.calls % AVATAR_APPLY_POLICY.batchSize === 0 ? AVATAR_APPLY_POLICY.batchPauseMs : 0;
        await wait(Math.max(spacingWait, batchWait));
        await client.updatePagePicture({ token: bindingEntry[1].pageToken, pageId: page.id, bytes, filename: `page-${page.id}${extension}` });
        tokenRateState.set(tokenId, { calls: state.calls + 1, lastCallAt: Date.now() });
        page.avatar = avatarUrl;
        page.avatarMediaId = media.id;
        page.avatarSource = "ai-meta";
        page.avatarUpdatedAt = new Date().toISOString();
        page.avatarStatus = "updated";
        page.avatarError = "";
        results.push({ pageId: page.id, pageName: page.name, ok: true, status: "updated" });
      } catch (error) {
        if (isMetaRateLimitError(error)) pausedTokenIds.add(tokenId);
        page.avatarStatus = "error";
        page.avatarError = safeMessage(error.message, bindingEntry[1].pageToken);
        results.push({ pageId: page.id, pageName: page.name, ok: false, error: page.avatarError, status: isMetaRateLimitError(error) ? "rate_limited" : "error" });
      }
    }
    store.save();
    res.status(201).json({ media: { id: media.id, url: `/api/media/${media.id}/file`, thumbnailUrl: avatarUrl }, avatarUrl, prompt, promptSource: body.useLlm === true ? "llm" : "manual", apply, throttle: { ...AVATAR_APPLY_POLICY, tokenCount: tokenRateState.size, rateLimitedTokenCount: pausedTokenIds.size }, results });
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

  app.post("/api/meta/pages/:id/resume-publishing", (req, res) => {
    const page = metaState(store).pages.find(item => item.id === req.params.id);
    if (!page) throw new StudioError("Không tìm thấy Page.", "META_PAGE_NOT_FOUND", 404);
    page.publishingHealth = { ...page.publishingHealth, blocked: false, resumedAt: new Date().toISOString() };
    store.save();
    res.json({ page: publicPage(page) });
  });

  const publishTokenNextAt = new Map();
  const reservePublishSlot = async (page) => {
    const key = String(page?.tokenId || `page:${page?.id || "unknown"}`);
    const current = Date.now();
    const next = Math.max(current, Number(publishTokenNextAt.get(key) || 0));
    publishTokenNextAt.set(key, next + 2_000);
    if (next > current) await wait(next - current);
  };

  const sendFirstComment = async (page, videoId, message) => {
    try {
      if (typeof client.videoStatus === "function") {
        const video = await client.videoStatus({ token: page.accessToken, videoId });
        if (video.status?.video_status !== "ready" || video.status?.publishing_phase?.publish_status !== "published") {
          throw new StudioError("Meta đang xử lý video; sẽ chỉ thử lại bình luận, không đăng lại video.", "META_VIDEO_PROCESSING", 409);
        }
      }
      return await client.comment({ token: page.accessToken, objectId: videoId, message });
    } catch (error) {
      // A just-published video may not be visible to the comments edge yet.
      if (error.metaError?.code === 100 && error.metaError?.subcode === 33) error.code = "META_VIDEO_PROCESSING";
      throw error;
    }
  };

  const publishReelAttempt = async ({ postId, idempotencyKey }) => {
    const parsedPostId = z.string().uuid().parse(postId);
    const requestedKey = z.string().trim().min(8).max(160).parse(idempotencyKey || `${parsedPostId}:${store.require("socialPosts", parsedPostId).revision}`);
    const meta = metaState(store);
    // A manual retry changes the revision/key, but the already-published Reel
    // must keep its original record and only retry the failed first comment.
    const existing = meta.publications.find((item) => item.idempotencyKey === requestedKey)
      || meta.publications.find((item) => item.postId === parsedPostId && item.status === "published_comment_error");
    const parsedKey = existing?.idempotencyKey || requestedKey;
    if (existing?.status === "published") return existing;
    const post = store.require("socialPosts", parsedPostId);
    if (existing?.status === "published_comment_error") {
      const check = postPreflight(store, post, meta);
      if (!check.ready) throw new StudioError("Preflight Meta chưa đạt; hãy sửa first comment trước khi thử lại.", "META_PREFLIGHT_FAILED", 409);
      if (typeof client.comment !== "function") throw new StudioError("Meta client chưa hỗ trợ đăng first comment.", "META_COMMENT_UNSUPPORTED", 502);
      const tokenGroup = post.tokenGroupId ? meta.tokenGroups.find((group) => group.id === post.tokenGroupId) : null;
      const page = requirePostPage(store, meta, post, tokenGroup?.tokenIds || [], tokenGroup);
      try {
        await reservePublishSlot(page);
        await sendFirstComment(page, existing.externalPostId, post.firstComment);
      } catch (error) {
        const retryRecord = {
          ...existing,
          postId: existing.postId || post.id,
          projectId: existing.projectId || post.projectId,
          title: existing.title || post.title,
          contentType: existing.contentType || post.contentType,
          status: "published_comment_error",
          firstCommentStatus: "error",
          firstCommentError: safeMessage(error.message, page.accessToken),
          firstCommentErrorDetails: classifyMetaFailure(error),
          removedFromQueue: false,
        };
        meta.publications = meta.publications.filter((item) => item.idempotencyKey !== parsedKey).concat(retryRecord);
        Object.assign(post, {
          automationStatus: "meta_error",
          automationError: retryRecord.firstCommentError,
          publication: {
            source: "meta",
            externalPostId: retryRecord.externalPostId,
            permalink: retryRecord.permalink,
            publishedAt: retryRecord.publishedAt,
            firstCommentStatus: "error",
            firstCommentError: retryRecord.firstCommentError,
          },
          updatedAt: new Date().toISOString(),
        });
        store.save();
        return { ...retryRecord, post: { ...post } };
      }
      const mediaCleanup = await cleanupPublishedMedia(store, post.mediaIds?.[0], post.id);
      const recovered = { ...existing, postId: existing.postId || post.id, projectId: existing.projectId || post.projectId, title: existing.title || post.title, contentType: existing.contentType || post.contentType, status: "published", firstCommentStatus: "published", removedFromQueue: true, mediaCleanup };
      delete recovered.firstCommentError;
      delete recovered.firstCommentErrorDetails;
      meta.publications = meta.publications.filter((item) => item.idempotencyKey !== parsedKey).concat(recovered);
      store.state.socialPosts = store.state.socialPosts.filter((item) => item.id !== post.id);
      store.save();
      return recovered;
    }
    const check = postPreflight(store, post, meta);
    if (!check.ready) throw new StudioError("Preflight Meta chưa đạt; chưa gửi bài.", "META_PREFLIGHT_FAILED", 409);
    if (typeof client.comment !== "function") throw new StudioError("Meta client chưa hỗ trợ đăng first comment.", "META_COMMENT_UNSUPPORTED", 502);
    const tokenGroup = post.tokenGroupId ? meta.tokenGroups.find((group) => group.id === post.tokenGroupId) : null;
    const page = requirePostPage(store, meta, post, tokenGroup?.tokenIds || [], tokenGroup);
    const media = store.state.media.find((item) => item.id === post.mediaIds[0]);
    const bytes = await fs.readFile(media.file);
    await reservePublishSlot(page);
    const start = await client.startReel({ token: page.accessToken, pageId: page.id, fileSize: bytes.byteLength });
    const videoId = start.video_id || start.id;
    if (!videoId) throw new StudioError("Meta không trả về video ID sau bước start.", "META_UPLOAD_FAILED", 502);
    if (start.upload_url) await client.uploadChunk({ token: page.accessToken, uploadUrl: start.upload_url, bytes });
    const finish = await client.finishReel({ token: page.accessToken, pageId: page.id, videoId, description: post.caption });
    const externalPostId = String(finish.id || videoId);
    // Persist the published video before checking readiness or sending a comment.
    // A processing delay or process exit must never cause another video upload.
    const pendingRecord = { idempotencyKey: parsedKey, postId: post.id, projectId: post.projectId, mediaIds: [...post.mediaIds], title: post.title, contentType: post.contentType, status: "published_comment_error", pageId: page.id, pageName: page.name, externalPostId, permalink: finish.permalink || `https://www.facebook.com/${externalPostId}`, firstCommentStatus: "error", firstCommentError: "Đang chờ Meta xử lý video trước khi gửi bình luận.", removedFromQueue: false, publishedAt: new Date().toISOString() };
    meta.publications = meta.publications.filter(item => item.idempotencyKey !== parsedKey).concat(pendingRecord);
    store.save();
    let firstCommentStatus = "published";
    let firstCommentError = "";
    let firstCommentErrorDetails = null;
    try {
      await sendFirstComment(page, externalPostId, post.firstComment);
    } catch (error) {
      firstCommentStatus = "error";
      firstCommentError = safeMessage(error.message, page.accessToken);
      firstCommentErrorDetails = classifyMetaFailure(error);
    }
    const mediaCleanup = firstCommentError
      ? { removed: false, reason: "first_comment_failed" }
      : await cleanupPublishedMedia(store, post.mediaIds?.[0], post.id);
    const record = { idempotencyKey: parsedKey, postId: post.id, projectId: post.projectId, mediaIds: [...post.mediaIds], title: post.title, contentType: post.contentType, status: firstCommentError ? "published_comment_error" : "published", pageId: page.id, pageName: page.name, externalPostId, permalink: finish.permalink || `https://www.facebook.com/${externalPostId}`, firstCommentStatus, ...(firstCommentError ? { firstCommentError, firstCommentErrorDetails } : {}), removedFromQueue: !firstCommentError, mediaCleanup, publishedAt: new Date().toISOString() };
    meta.publications = meta.publications.filter((item) => item.idempotencyKey !== parsedKey).concat(record);
    if (firstCommentError) {
      Object.assign(post, {
        automationStatus: "meta_error",
        automationError: firstCommentError,
        publication: {
          source: "meta",
          externalPostId: record.externalPostId,
          permalink: record.permalink,
          publishedAt: record.publishedAt,
          firstCommentStatus: "error",
          firstCommentError,
        },
        updatedAt: record.publishedAt,
      });
      store.save();
      return { ...record, post: { ...post } };
    }
    store.state.socialPosts = store.state.socialPosts.filter((item) => item.id !== post.id);
    store.save();
    return record;
  };

  const publishReel = async (input) => {
    try {
      const result = await publishReelAttempt(input);
      const page = metaState(store).pages.find(item => item.id === result?.pageId);
      if (page && ['published', 'published_comment_error'].includes(result.status)) {
        page.publishingHealth = { ...page.publishingHealth, lastSucceededAt: result.publishedAt };
        page.management ||= {};
        page.management.revision = Number(page.management.revision || 0) + 1;
        store.save();
      }
      return result;
    }
    catch (error) {
      const details = classifyMetaFailure(error);
      if (details.kind === "security_restriction") {
        const post = store.state.socialPosts.find(item => item.id === input.postId);
        const local = store.state.socialPages.find(item => item.id === post?.pageId);
        const page = metaState(store).pages.find(item => item.id === local?.externalId);
        if (page) {
          page.publishingHealth = { blocked: true, message: safeMessage(error.message, page.accessToken), details, failedAt: new Date().toISOString() };
          page.management ||= {};
          page.management.revision = Number(page.management.revision || 0) + 1;
          store.save();
        }
      }
      const failedPost=store.state.socialPosts.find(item=>item.id===input.postId);
      if(failedPost && !failedPost.warehouse && failedPost.automationStatus!=='publishing' && !details.retryable && !publishedVideo(store,failedPost)){
        Object.assign(failedPost,{automationError:safeMessage(error.message),automationErrorDetails:details,automationAttempts:Number(failedPost.automationAttempts || 0)+1,automationBlockedReason:details.kind});
        returnPostToWarehouse(store,failedPost,{automatic:true});store.save();
      }
      throw error;
    }
  };

  app.post("/api/meta/publish/reel", async (req, res) => {
    const postId = z.string().uuid().parse(req.body?.postId);
    const idempotencyKey = z.string().trim().min(8).max(160).parse(req.body?.idempotencyKey || `${postId}:${store.require("socialPosts", postId).revision}`);
    res.json(await publishReel({ postId, idempotencyKey }));
  });

  const autoPublishNews = async (postId) => {
    const meta = metaState(store);
    if (meta.enabled === false || !meta.boundPageId) throw new StudioError("Kết nối Meta và chọn Page trước khi auto post News.", "META_PAGE_NOT_BOUND", 409);
    const localPage = store.state.socialPages.find((page) => page.externalId === meta.boundPageId && !page.archived);
    if (!localPage) throw new StudioError("Hãy tạo hoặc gắn local Page trùng với Page Meta trước khi auto post News.", "META_LOCAL_PAGE_REQUIRED", 409);
    let post = store.require("socialPosts", postId);
    if (post.pageId !== localPage.id || post.status !== "ready") {
      post = store.patch("socialPosts", post.id, { pageId: localPage.id, status: "ready", scheduledAt: null, revision: post.revision + 1 });
    }
    return publishReel({ postId: post.id, idempotencyKey: `news-auto:${post.id}:${post.revision}` });
  };

  return { publishReel, autoPublishNews, close: management.close };
}

export { publicMeta, postPreflight };
