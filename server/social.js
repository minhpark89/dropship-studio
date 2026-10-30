import fs from "node:fs";
import { z } from "zod";
import { StudioError } from "./store.js";
import {
  socialPageSchema,
  socialPagePatchSchema,
  socialPostSchema,
  socialPostPatchSchema,
  socialPublicationSchema,
  socialRevisionSchema,
} from "../shared/social-contracts.js";
import { createPostPackage, packageFilePath, validatePackageFileName } from "./social-package.js";
import { isPublishableVideo } from "../shared/output-media.js";
import { managedPageUnavailable } from "../shared/management.js";
import { publishedVideo } from './post-lifecycle.js';

const mediaKinds = new Set(["image", "video"]);

function now() {
  return new Date().toISOString();
}

function stripPatchDefaults(input, body) {
  const output = { ...input };
  for (const key of Object.keys(output)) {
    if (key !== "revision" && !Object.prototype.hasOwnProperty.call(body || {}, key)) delete output[key];
  }
  return output;
}

function assertRevision(entity, revision) {
  if (entity.revision !== revision)
    throw new StudioError("Bản ghi đã thay đổi; hãy tải lại trước khi tiếp tục.", "STALE_REVISION", 409);
}

function requirePage(store, id) {
  return store.require("socialPages", id);
}

function requireProject(store, id) {
  return store.require("projects", id);
}

function checkPageActive(page, action) {
  if (page.archived && ["create", "ready", "scheduled", "export"].includes(action))
    throw new StudioError("Page đã lưu trữ và không nhận nội dung mới.", "ARCHIVED_PAGE", 409);
}

function checkMedia(store, mediaIds, projectId) {
  const media = mediaIds.map((id) => store.require("media", id));
  for (const item of media) {
    if (!mediaKinds.has(item.kind))
      throw new StudioError("Bài đăng chỉ hỗ trợ một ảnh hoặc video.", "INVALID_MEDIA");
    if (item.projectId !== null && item.projectId !== projectId)
      throw new StudioError("Media phải thuộc cùng dự án hoặc chưa gán dự án.", "MEDIA_PROJECT_MISMATCH");
  }
  return media;
}

function normalizeScheduleTimes(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/))
    .map((item) => String(item).trim())
    .filter((item) => /^([01]\d|2[0-3]):[0-5]\d$/.test(item)))].slice(0, 24);
}

function scheduleTimeZone(value) {
  const candidate = String(value || "Asia/Bangkok").trim() || "Asia/Bangkok";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return "Asia/Bangkok";
  }
}

function zonedParts(timestamp, timeZone = "Asia/Bangkok") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: scheduleTimeZone(timeZone),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  if (values.hour === 24) values.hour = 0;
  return values;
}

function timeZoneOffset(timestamp, timeZone) {
  const parts = zonedParts(timestamp, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - timestamp;
}

function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let utc = wall - timeZoneOffset(wall, timeZone);
  // Recalculate once after applying the offset so DST boundaries use the
  // offset that is valid at the resulting instant.
  utc = wall - timeZoneOffset(utc, timeZone);
  return utc;
}

function scheduleCandidate(nowValue, dayOffset, hour, minute, timeZone) {
  const current = zonedParts(nowValue, timeZone);
  const date = new Date(Date.UTC(current.year, current.month - 1, current.day + dayOffset));
  return zonedWallTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timeZone);
}

function ensureLocalPagesForGroup(store, pageIds) {
  const metaPages = Array.isArray(store.state.settings?.meta?.pages) ? store.state.settings.meta.pages : [];
  const localByExternalId = new Map(store.state.socialPages.filter((page) => page.externalId).map((page) => [String(page.externalId), page]));
  let created = 0;
  for (const rawId of [...new Set((pageIds || []).map(String).filter(Boolean))]) {
    if (localByExternalId.has(rawId)) continue;
    const source = metaPages.find((page) => String(page.id) === rawId);
    if (!source) continue;
    const page = store.add("socialPages", {
      name: String(source.name || rawId).slice(0, 120),
      platform: "facebook",
      externalId: rawId,
      url: `https://www.facebook.com/${rawId}`,
      timezone: "Asia/Bangkok",
      notes: "Tự tạo từ nhóm Page Meta để Auto Post có thể xếp lịch.",
      archived: false,
      avatar: source.avatar || "",
      metaPageId: rawId,
      revision: 1,
    });
    localByExternalId.set(rawId, page);
    created += 1;
  }
  return created;
}

export function normalizeScheduleConfig(value, fallback = {}) {
  const input = value && typeof value === "object" ? value : {};
  const times = normalizeScheduleTimes(input.times ?? input.slots ?? fallback.times);
  const staggerMinutes = Math.max(0, Math.min(1440, Number(input.staggerMinutes ?? input.stagger_minutes ?? fallback.staggerMinutes ?? 15) || 0));
  const dailyLimitValue = Number(input.dailyLimit ?? input.postsPerDay ?? input.posts_per_day ?? fallback.dailyLimit ?? 0);
  const dailyLimit = Number.isFinite(dailyLimitValue) ? Math.max(0, Math.min(200, Math.floor(dailyLimitValue))) : 0;
  const hasExplicitAutomation = Object.prototype.hasOwnProperty.call(input, "enabled") || Object.prototype.hasOwnProperty.call(input, "autoPublish");
  const enabled = hasExplicitAutomation
    ? input.enabled === true || input.autoPublish === true
    : fallback.enabled === true || fallback.autoPublish === true;
  return {
    times,
    staggerMinutes,
    dailyLimit,
    enabled,
    autoPublish: input.autoPublish === undefined ? enabled : input.autoPublish === true,
    timezone: String(input.timezone || fallback.timezone || "Asia/Bangkok"),
    tokenGroupId: String(input.tokenGroupId ?? input.token_group_id ?? fallback.tokenGroupId ?? ""),
  };
}

export function syncMetaPages(store, requestedIds = []) {
  const metaPages = Array.isArray(store.state.settings?.meta?.pages) ? store.state.settings.meta.pages : [];
  const allowed = new Set((Array.isArray(requestedIds) ? requestedIds : []).map(String).filter(Boolean));
  const selected = metaPages.filter((page) => !allowed.size || allowed.has(String(page.id)));
  if (!selected.length) throw new StudioError("Chưa có Page Meta để tạo Page local.", "META_PAGES_EMPTY", 409);
  const localByExternalId = new Map(store.state.socialPages.filter((page) => page.externalId).map((page) => [String(page.externalId), page]));
  const created = [];
  const updated = [];
  for (const source of selected) {
    const externalId = String(source.id || "").trim();
    if (!/^\d{1,40}$/.test(externalId)) continue;
    const next = {
      name: String(source.name || externalId).slice(0, 120),
      platform: "facebook",
      externalId,
      url: `https://www.facebook.com/${externalId}`,
      timezone: "Asia/Bangkok",
      notes: "Đồng bộ từ Meta · giữ local để gắn Content và lịch đăng.",
      archived: false,
      avatar: source.avatar || "",
      metaPageId: externalId,
      revision: 1,
    };
    const existing = localByExternalId.get(externalId);
    if (existing) {
      const changed = existing.name !== next.name || existing.url !== next.url || existing.avatar !== next.avatar || existing.archived;
      if (changed) {
        Object.assign(existing, next, { revision: Number(existing.revision || 1) + 1, updatedAt: now() });
        updated.push(existing);
      }
      continue;
    }
    const page = store.add("socialPages", next);
    created.push(page);
    localByExternalId.set(externalId, page);
  }
  if (updated.length) store.save();
  return { pages: [...created, ...updated], createdCount: created.length, updatedCount: updated.length, skippedCount: selected.length - created.length - updated.length };
}

function nextGroupScheduleStart(group, startAt, nowValue = Date.now()) {
  if (startAt) {
    const timestamp = Date.parse(startAt);
    if (!Number.isFinite(timestamp) || timestamp <= nowValue) throw new StudioError("Thời gian bắt đầu phải ở tương lai.", "INVALID_SCHEDULE", 400);
    return timestamp;
  }
  const times = normalizeScheduleTimes(group.scheduleConfig?.times);
  if (!times.length) throw new StudioError("Nhóm chưa có khung giờ đăng. Hãy đặt giờ hoặc nhập thời gian bắt đầu.", "GROUP_SCHEDULE_REQUIRED", 409);
  const timeZone = scheduleTimeZone(group.scheduleConfig?.timezone);
  const candidates = [];
  for (const dayOffset of [0, 1, 2]) {
    for (const time of times) {
      const [hours, minutes] = time.split(":").map(Number);
      const candidate = scheduleCandidate(nowValue, dayOffset, hours, minutes, timeZone);
      if (candidate > nowValue) candidates.push(candidate);
    }
  }
  const result = Math.min(...candidates);
  if (!Number.isFinite(result)) throw new StudioError("Không tìm được khung giờ tương lai của nhóm.", "GROUP_SCHEDULE_REQUIRED", 409);
  return result;
}

export function schedulePostsForGroup(store, groupId, { postIds = [], startAt = null, staggerMinutes, tokenGroupId = "" } = {}) {
  const group = (store.state.settings?.meta?.pageGroups || []).find((item) => item.id === String(groupId));
  if (!group) throw new StudioError("Không tìm thấy nhóm Page.", "META_PAGE_GROUP_NOT_FOUND", 404);
  if (group.purpose === 'review' || group.id.startsWith('pgrp_hold_')) throw new StudioError('Nhóm chờ xử lý không dùng để đăng bài.', 'GROUP_ON_HOLD', 409);
  const pageIds = [...new Set((group.pageIds || []).map(String))].filter(id => !managedPageUnavailable(store.state.settings.meta.pages?.find(page => String(page.id) === id), store.state.socialPages.find(page => String(page.externalId) === id)));
  if (!pageIds.length) throw new StudioError("Nhóm Page đang trống.", "GROUP_PAGES_EMPTY", 409);
  ensureLocalPagesForGroup(store, pageIds);
  const localPages = pageIds.map((id) => store.state.socialPages.find((page) => String(page.externalId) === id && !page.archived)).filter(Boolean);
  if (localPages.length !== pageIds.length) throw new StudioError("Một số Page trong nhóm chưa có binding Meta hợp lệ.", "PAGE_MAPPING_REQUIRED", 409);
  const ids = [...new Set((Array.isArray(postIds) ? postIds : []).map(String))];
  if (!ids.length) throw new StudioError("Chọn ít nhất một video trong kho bài.", "POST_SELECTION_EMPTY", 422);
  const posts = ids.map((id) => store.require("socialPosts", id));
  const scheduleConfig = normalizeScheduleConfig(group.scheduleConfig);
  const start = nextGroupScheduleStart({ ...group, scheduleConfig }, startAt, Date.now());
  const spacing = Math.max(0, Math.min(1440, Number(staggerMinutes ?? scheduleConfig.staggerMinutes ?? 15) || 0));
  const selectedTokenGroup = String(tokenGroupId || scheduleConfig.tokenGroupId || "");
  if (selectedTokenGroup && !(store.state.settings?.meta?.tokenGroups || []).some((item) => item.id === selectedTokenGroup))
    throw new StudioError("KhÃ´ng tÃ¬m tháº¥y pool token Ä‘Ã£ chá»n.", "META_TOKEN_GROUP_NOT_FOUND", 404);
  if (selectedTokenGroup) {
    group.scheduleConfig = normalizeScheduleConfig({ ...scheduleConfig, tokenGroupId: selectedTokenGroup }, scheduleConfig);
  }
  const scheduled = posts.map((post, index) => {
    if (post.status === "published") throw new StudioError("Bài đã đăng không thể xếp lịch lại.", "IMMUTABLE_PUBLISHED", 409);
    const page = localPages[index % localPages.length];
    const changes = {
      pageId: page.id,
      pageGroupId: String(group.id),
      ...(selectedTokenGroup ? { tokenGroupId: selectedTokenGroup } : {}),
      warehouse: null,
      automationHold: false,
      status: "scheduled",
      scheduledAt: new Date(start + index * spacing * 60_000).toISOString(),
      automationStatus: null,
      automationError: null,
      automationAttempts: 0,
      automationNextAttemptAt: null,
      automationRetryBlocked: false,
      automationBlockedReason: null,
      automationErrorDetails: null,
    };
    validatePostPayload(store, { ...post, ...changes }, { existing: post, reapprove: true });
    return { post, page, changes };
  });
  for (const { post, changes } of scheduled) Object.assign(post, changes, { revision: Number(post.revision || 1) + 1, updatedAt: now() });
  store.save();
  return { group, scheduled: scheduled.map(({ post }) => post) };
}

function localScheduleKey(timestamp, timeZone = "Asia/Bangkok") {
  const date = zonedParts(timestamp, timeZone);
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function nextGroupSlots(group, used, count, nowValue = Date.now()) {
  const config = normalizeScheduleConfig(group.scheduleConfig);
  if (!config.times.length || !count) return [];
  const timeZone = scheduleTimeZone(config.timezone);
  const slots = [];
  for (let dayOffset = 0; dayOffset < 31 && slots.length < count; dayOffset += 1) {
    for (const time of config.times.slice().sort()) {
      const [hours, minutes] = time.split(":").map(Number);
      const candidate = scheduleCandidate(nowValue, dayOffset, hours, minutes, timeZone);
      if (candidate <= nowValue) continue;
      const iso = new Date(candidate).toISOString();
      if (used.has(iso)) continue;
      used.add(iso);
      slots.push(iso);
    }
  }
  return slots;
}

export function autoScheduleWarehousePosts(store, groupId, { limit, tokenGroupId = "" } = {}) {
  const group = (store.state.settings?.meta?.pageGroups || []).find((item) => item.id === String(groupId));
  if (!group) throw new StudioError("Không tìm thấy nhóm Page.", "META_PAGE_GROUP_NOT_FOUND", 404);
  const config = normalizeScheduleConfig(group.scheduleConfig);
  if (!config.enabled || !config.autoPublish || !config.times.length || group.purpose === 'review' || group.id.startsWith('pgrp_hold_')) return { group, scheduled: [] };
  const pageIds = [...new Set((group.pageIds || []).map(String))].filter(id => !managedPageUnavailable(store.state.settings.meta.pages?.find(page => String(page.id) === id), store.state.socialPages.find(page => String(page.externalId) === id)));
  if (!pageIds.length) return { group, scheduled: [] };
  ensureLocalPagesForGroup(store, pageIds);
  const localPages = pageIds.map((id) => store.state.socialPages.find((page) => String(page.externalId) === id && !page.archived)).filter(Boolean);
  if (localPages.length !== pageIds.length) return { group, scheduled: [] };
  const dailyLimit = Math.max(1, Number(limit || config.dailyLimit || config.times.length) || config.times.length);
  const today = localScheduleKey(Date.now(), config.timezone);
  const existingToday = (store.state.socialPosts || []).filter((post) => post.pageGroupId === group.id && post.status === "scheduled" && post.scheduledAt && localScheduleKey(post.scheduledAt, config.timezone) === today).length;
  const futureAutoPosts = (store.state.socialPosts || [])
    .filter((post) => post.pageGroupId === group.id && post.status === "scheduled" && !post.automationRetryBlocked && post.automationSource === "daily-automation" && post.scheduledAt && Date.parse(post.scheduledAt) > Date.now())
    .sort((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt));
  if (futureAutoPosts.length) {
    const expectedSlots = nextGroupSlots(group, new Set(), futureAutoPosts.length);
    const scheduleChanged = futureAutoPosts.some((post, index) => post.scheduledAt !== expectedSlots[index]);
    if (scheduleChanged && expectedSlots.length === futureAutoPosts.length) {
      futureAutoPosts.forEach((post, index) => Object.assign(post, {
        scheduledAt: expectedSlots[index],
        automationError: null,
        automationNextAttemptAt: null,
        revision: Number(post.revision || 1) + 1,
        updatedAt: now(),
      }));
      store.save();
    }
    return { group, scheduled: [], rescheduled: scheduleChanged ? futureAutoPosts : [] };
  }
  const hasFutureSlot = (store.state.socialPosts || []).some((post) => post.pageGroupId === group.id && post.status === "scheduled" && post.scheduledAt && Date.parse(post.scheduledAt) > Date.now());
  if (hasFutureSlot) return { group, scheduled: [] };
  const capacity = Math.max(0, dailyLimit - existingToday);
  if (!capacity) return { group, scheduled: [] };
  const candidates = (store.state.socialPosts || [])
    .filter((post) => {
      if (!["draft", "ready"].includes(post.status) || post.pageGroupId || !post.mediaIds?.length || post.archivedAt || post.deletedAt || post.warehouse?.returnedAt || post.automationHold) return false;
      if (post.automationError) return false;
      if (!String(post.firstComment || "").trim()) return false;
      const media = store.state.media.find((item) => item.id === post.mediaIds[0]);
      const legacyWarehouseSource = ["render-warehouse", "warehouse-sync", "news-render"].includes(post.automationSource);
      if (!isPublishableVideo(media, store.state.jobs || []) && !legacyWarehouseSource) return false;
      if (post.contentType === "news") {
        return Boolean(String(post.caption || "").trim() && String(post.articleBody || "").trim());
      }
      return true;
    })
    .slice()
    .sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0))
    .slice(0, capacity);
  if (!candidates.length) return { group, scheduled: [] };
  const used = new Set((store.state.socialPosts || []).filter((post) => post.pageGroupId === group.id && post.scheduledAt).map((post) => new Date(post.scheduledAt).toISOString()));
  const slots = nextGroupSlots(group, used, candidates.length);
  const selectedTokenGroup = String(tokenGroupId || config.tokenGroupId || "");
  if (selectedTokenGroup && !(store.state.settings?.meta?.tokenGroups || []).some((item) => item.id === selectedTokenGroup))
    throw new StudioError("Không tìm thấy pool token đã chọn.", "META_TOKEN_GROUP_NOT_FOUND", 404);
  const scheduled = [];
  for (let index = 0; index < candidates.length && index < slots.length; index += 1) {
    const post = candidates[index];
    const page = localPages[index % localPages.length];
    const changes = {
      pageId: page.id,
      pageGroupId: String(group.id),
      ...(selectedTokenGroup ? { tokenGroupId: selectedTokenGroup } : {}),
      status: "scheduled",
      scheduledAt: slots[index],
      automationSource: "daily-automation",
      automationStatus: null,
      automationError: null,
      automationAttempts: 0,
      automationNextAttemptAt: null,
      automationRetryBlocked: false,
      automationBlockedReason: null,
      automationErrorDetails: null,
    };
    validatePostPayload(store, { ...post, ...changes }, { existing: post, reapprove: true });
    Object.assign(post, changes, { revision: Number(post.revision || 1) + 1, updatedAt: now() });
    scheduled.push(post);
  }
  if (scheduled.length) store.save();
  return { group, scheduled };
}

export function validatePostPayload(store, payload, { existing = null, reapprove = false } = {}) {
  const projectId = payload.projectId ?? existing?.projectId;
  const pageId = payload.pageId ?? existing?.pageId;
  requireProject(store, projectId);
  const page = pageId ? requirePage(store, pageId) : null;
  const mediaIds = payload.mediaIds ?? existing?.mediaIds ?? [];
  const media = checkMedia(store, mediaIds, projectId);
  const status = payload.status ?? existing?.status ?? "draft";
  if (!page && status !== "draft") throw new StudioError("Assign a Page before approving or scheduling Content.", "PAGE_REQUIRED", 409);
  const researchId = payload.researchId ?? existing?.researchId;
  if (researchId && store.require("researchResults", researchId).projectId !== projectId) throw new StudioError("The research must belong to this project.", "RESEARCH_PROJECT_MISMATCH");
  const scheduledAt = payload.scheduledAt === undefined ? existing?.scheduledAt ?? null : payload.scheduledAt;
  if (page?.archived && (!existing || payload.pageId !== undefined && payload.pageId !== existing.pageId)) checkPageActive(page, "create");
  if (status === "ready" || status === "scheduled") checkPageActive(page, status);
  if (status === "ready" || status === "scheduled") {
    if (!(payload.caption ?? existing?.caption ?? "").trim() && media.length === 0)
      throw new StudioError("Bài đã duyệt cần có caption hoặc media.", "REVIEW_REQUIRED");
  }
  if (status === "scheduled") {
    if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt)) || Date.parse(scheduledAt) <= Date.now())
      throw new StudioError("Lịch đăng phải là thời điểm UTC trong tương lai.", "INVALID_SCHEDULE");
  }
  if (scheduledAt !== null && (Number.isNaN(Date.parse(scheduledAt)) || Date.parse(scheduledAt) <= Date.now()) && status !== "draft")
    throw new StudioError("Lịch đăng phải là thời điểm trong tương lai.", "INVALID_SCHEDULE");
  if (status === "draft" && scheduledAt !== null && !reapprove)
    throw new StudioError("Bản nháp không được giữ lịch đăng.", "INVALID_SCHEDULE");
  return { page, media };
}

function publicPage(page) {
  return { ...page };
}

function publicPost(post) {
  return { ...post };
}

export function mountSocialRoutes(app, store) {
  app.get("/api/social", (req, res) => res.json({
    pages: store.state.socialPages.map(publicPage),
    posts: store.state.socialPosts.map(publicPost),
    publishing: { connected: false, mode: "handoff" },
  }));

  app.post("/api/social/pages", (req, res) => {
    const input = socialPageSchema.parse(req.body);
    const page = store.add("socialPages", { ...input, revision: 1 });
    res.status(201).json(page);
  });

  app.post("/api/social/pages/sync-meta", (req, res) => {
    res.status(201).json(syncMetaPages(store, req.body?.pageIds || req.body?.page_ids || []));
  });

  app.post(["/api/social/groups/:id/schedule", "/api/social/page-groups/:id/schedule"], (req, res) => {
    res.json(schedulePostsForGroup(store, req.params.id, req.body || {}));
  });

  app.post(["/api/social/groups/:id/automation", "/api/social/page-groups/:id/automation"], (req, res) => {
    const group = (store.state.settings?.meta?.pageGroups || []).find((item) => item.id === String(req.params.id));
    if (!group) throw new StudioError("Không tìm thấy nhóm Page.", "META_PAGE_GROUP_NOT_FOUND", 404);
    if (group.purpose === 'review' || group.id.startsWith('pgrp_hold_')) throw new StudioError('Nhóm chờ xử lý luôn tắt Auto Post.', 'GROUP_ON_HOLD', 409);
    group.scheduleConfig = normalizeScheduleConfig(req.body?.scheduleConfig || req.body || {}, group.scheduleConfig || {});
    group.updatedAt = now();
    store.save();
    res.json({ group });
  });

  app.post("/api/social/posts/:id/publish-now", (req, res) => {
    const post = store.require("socialPosts", req.params.id);
    const revision = z.number().int().positive().parse(req.body?.revision);
    assertRevision(post, revision);
    if (post.status === "published") throw new StudioError("Bài đã đăng không thể đăng lại.", "IMMUTABLE_PUBLISHED", 409);
    if (post.deletedAt || post.archivedAt) throw new StudioError('Khôi phục bài trước khi đăng.', 'POST_ON_HOLD', 409);
    const requestedGroupId = String(req.body?.pageGroupId || req.body?.groupId || post.pageGroupId || "");
    const group = requestedGroupId ? (store.state.settings?.meta?.pageGroups || []).find((item) => item.id === requestedGroupId) : null;
    if (group?.pageIds?.length) ensureLocalPagesForGroup(store, group.pageIds);
    const groupPages = group?.pageIds?.length
      ? group.pageIds.map((id) => store.state.socialPages.find((page) => String(page.externalId) === String(id) && !page.archived)).filter(Boolean)
      : [];
    const pageId = String(req.body?.pageId || post.pageId || groupPages[0]?.id || "");
    const page = pageId ? requirePage(store, pageId) : null;
    if (!page) throw new StudioError("Chọn Page trước khi đăng ngay.", "PAGE_REQUIRED", 409);
    checkPageActive(page, "scheduled");
    const changes = {
      pageId,
      ...(requestedGroupId ? { pageGroupId: requestedGroupId } : {}),
      ...(req.body?.tokenGroupId ? { tokenGroupId: String(req.body.tokenGroupId) } : {}),
      status: "scheduled",
      scheduledAt: new Date(Date.now() + 3_000).toISOString(),
      warehouse: null,
      automationHold: false,
      automationSource: "manual-now",
      automationStatus: null,
      automationError: null,
      automationAttempts: 0,
      automationNextAttemptAt: null,
      automationRetryBlocked: false,
      automationBlockedReason: null,
      automationErrorDetails: null,
    };
    validatePostPayload(store, { ...post, ...changes }, { existing: post, reapprove: true });
    Object.assign(post, changes, { revision: revision + 1, updatedAt: now() });
    store.save();
    res.json(post);
  });

  app.patch("/api/social/pages/:id", (req, res) => {
    const input = stripPatchDefaults(socialPagePatchSchema.parse(req.body), req.body);
    const page = requirePage(store, req.params.id);
    assertRevision(page, input.revision);
    const { revision, ...changes } = input;
    const next = { ...page, ...changes, revision: revision + 1, updatedAt: now() };
    Object.assign(page, next);
    store.save();
    res.json(page);
  });

  app.delete("/api/social/pages/:id", (req, res) => {
    const { revision } = socialRevisionSchema.parse(req.body);
    const page = requirePage(store, req.params.id);
    assertRevision(page, revision);
    if (store.state.socialPosts.some((post) => post.pageId === page.id))
      throw new StudioError("Không thể xóa Page đang được bài đăng tham chiếu.", "PAGE_REFERENCED", 409);
    store.state.socialPages = store.state.socialPages.filter((item) => item.id !== page.id);
    store.save();
    res.status(204).end();
  });

  app.post("/api/social/posts", (req, res) => {
    const input = socialPostSchema.parse(req.body);
    const { page } = validatePostPayload(store, input);
    if (page) checkPageActive(page, "create");
    const post = store.add("socialPosts", { ...input, revision: 1, exportRevision: null, exportedAt: null });
    res.status(201).json(post);
  });

  app.patch("/api/social/posts/:id", (req, res) => {
    const input = stripPatchDefaults(socialPostPatchSchema.parse(req.body), req.body);
    const post = store.require("socialPosts", req.params.id);
    assertRevision(post, input.revision);
    if (post.automationStatus === "publishing") throw new StudioError("Bài đang đăng; chờ tác vụ kết thúc.", "POST_BUSY", 409);
    if (post.status === "published") throw new StudioError("Bài đã ghi nhận đăng và không thể sửa.", "IMMUTABLE_PUBLISHED", 409);
    const { revision, ...changes } = input;
    const contentChanged = ["caption", "articleBody", "researchId", "firstComment", "linkUrl", "linkLabel", "sourceUrl", "coverImageUrl", "contentType", "mediaIds", "pageId", "title"].some((key) => changes[key] !== undefined && JSON.stringify(changes[key]) !== JSON.stringify(post[key]));
    if(publishedVideo(store,post) && Object.entries(changes).some(([key,value])=>!['firstComment','notes','status','scheduledAt'].includes(key) && JSON.stringify(value)!==JSON.stringify(post[key])))throw new StudioError('Video đã đăng; chỉ sửa bình luận chưa gửi hoặc ghi chú.','ALREADY_PUBLISHED',409);
    const explicitlyReapproved = contentChanged && (changes.status === "ready" || changes.status === "scheduled");
    if (contentChanged && !explicitlyReapproved) {
      changes.status = "draft";
      changes.scheduledAt = null;
    }
    if(changes.status==="ready" || changes.status==="scheduled"){changes.automationHold=false;changes.warehouse=null;}
    validatePostPayload(store, { ...post, ...changes }, { existing: post, reapprove: explicitlyReapproved });
    Object.assign(post, changes, { revision: revision + 1, updatedAt: now() });
    store.save();
    res.json(post);
  });

  app.delete("/api/social/posts/:id", (req, res) => {
    const { revision } = socialRevisionSchema.parse(req.body);
    const post = store.require("socialPosts", req.params.id);
    assertRevision(post, revision);
    if (post.status === "published") throw new StudioError("Bài đã ghi nhận đăng và không thể xóa.", "IMMUTABLE_PUBLISHED", 409);
    store.state.socialPosts = store.state.socialPosts.filter((item) => item.id !== post.id);
    store.save();
    res.status(204).end();
  });

  app.post("/api/social/posts/:id/duplicate", (req, res) => {
    const { revision } = socialRevisionSchema.parse(req.body);
    const source = store.require("socialPosts", req.params.id);
    assertRevision(source, revision);
    if (source.pageId) checkPageActive(requirePage(store, source.pageId), "create");
    const duplicate = store.add("socialPosts", {
      projectId: source.projectId,
      pageId: source.pageId,
      pageGroupId: source.pageGroupId || "",
      tokenGroupId: source.tokenGroupId || "",
      contentType: source.contentType || "product",
      title: `${source.title} (copy)`.slice(0, 200),
      caption: source.caption,
      firstComment: source.firstComment || "",
      linkUrl: source.linkUrl || "",
      linkLabel: source.linkLabel || "",
      sourceUrl: source.sourceUrl || "",
      coverImageUrl: source.coverImageUrl || "",
      articleBody: source.articleBody || "",
      researchId: source.researchId || null,
      mediaIds: [...source.mediaIds],
      scheduledAt: null,
      status: "draft",
      notes: source.notes,
      revision: 1,
      exportRevision: null,
      exportedAt: null,
    });
    res.status(201).json(duplicate);
  });

  app.post("/api/social/posts/:id/export", async (req, res) => {
    const { revision } = socialRevisionSchema.parse(req.body);
    const post = store.require("socialPosts", req.params.id);
    assertRevision(post, revision);
    const page = requirePage(store, post.pageId);
    checkPageActive(page, "export");
    if (!(post.status === "ready" || post.status === "scheduled"))
      throw new StudioError("Chỉ có thể export bài đã duyệt hoặc có lịch.", "EXPORT_NOT_READY", 409);
    res.json(await createPostPackage(store, post));
  });

  app.get("/api/social/posts/:id/package/:revision/:name", async (req, res) => {
    const revision = z.coerce.number().int().positive().parse(req.params.revision);
    const name = validatePackageFileName(req.params.name);
    const post = store.require("socialPosts", req.params.id);
    if (post.exportRevision !== revision) throw new StudioError("Không tìm thấy gói handoff.", "NOT_FOUND", 404);
    const file = packageFilePath(store, post.id, revision, name);
    if (!fs.existsSync(file)) throw new StudioError("Không tìm thấy tệp.", "NOT_FOUND", 404);
    res.sendFile(file, { dotfiles: "allow" });
  });

  app.post("/api/social/posts/:id/publication", (req, res) => {
    const input = socialPublicationSchema.parse(req.body);
    const post = store.require("socialPosts", req.params.id);
    assertRevision(post, input.revision);
    if (post.status === "published") throw new StudioError("Bài đã được ghi nhận trước đó.", "IMMUTABLE_PUBLISHED", 409);
    const page = requirePage(store, post.pageId);
    if (page.archived) throw new StudioError("Page đã lưu trữ.", "ARCHIVED_PAGE", 409);
    if (!(post.status === "ready" || post.status === "scheduled")) throw new StudioError("Bài phải được duyệt trước khi ghi nhận đăng.", "PUBLICATION_NOT_READY", 409);
    const published = {
      ...post,
      status: "published",
      revision: input.revision + 1,
      publication: { source: "manual", externalPostId: input.externalPostId, permalink: input.permalink, publishedAt: input.publishedAt },
      updatedAt: now(),
      removedFromQueue: true,
    };
    store.state.socialPosts = store.state.socialPosts.filter((item) => item.id !== post.id);
    store.save();
    res.json(published);
  });
}

