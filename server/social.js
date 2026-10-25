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

function validatePostPayload(store, payload, { existing = null, reapprove = false } = {}) {
  const projectId = payload.projectId ?? existing?.projectId;
  const pageId = payload.pageId ?? existing?.pageId;
  requireProject(store, projectId);
  const page = requirePage(store, pageId);
  const mediaIds = payload.mediaIds ?? existing?.mediaIds ?? [];
  const media = checkMedia(store, mediaIds, projectId);
  const status = payload.status ?? existing?.status ?? "draft";
  const scheduledAt = payload.scheduledAt === undefined ? existing?.scheduledAt ?? null : payload.scheduledAt;
  if (page.archived && (!existing || payload.pageId !== undefined && payload.pageId !== existing.pageId)) checkPageActive(page, "create");
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
    checkPageActive(page, "create");
    const post = store.add("socialPosts", { ...input, revision: 1, exportRevision: null, exportedAt: null });
    res.status(201).json(post);
  });

  app.patch("/api/social/posts/:id", (req, res) => {
    const input = stripPatchDefaults(socialPostPatchSchema.parse(req.body), req.body);
    const post = store.require("socialPosts", req.params.id);
    assertRevision(post, input.revision);
    if (post.status === "published") throw new StudioError("Bài đã ghi nhận đăng và không thể sửa.", "IMMUTABLE_PUBLISHED", 409);
    const { revision, ...changes } = input;
    const contentChanged = ["caption", "mediaIds", "pageId", "title"].some((key) => changes[key] !== undefined && JSON.stringify(changes[key]) !== JSON.stringify(post[key]));
    const explicitlyReapproved = contentChanged && (changes.status === "ready" || changes.status === "scheduled");
    if (contentChanged && !explicitlyReapproved) {
      changes.status = "draft";
      changes.scheduledAt = null;
    }
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
    checkPageActive(requirePage(store, source.pageId), "create");
    const duplicate = store.add("socialPosts", {
      projectId: source.projectId,
      pageId: source.pageId,
      pageGroupId: source.pageGroupId || "",
      tokenGroupId: source.tokenGroupId || "",
      title: `${source.title} (copy)`.slice(0, 200),
      caption: source.caption,
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
    Object.assign(post, {
      status: "published",
      revision: input.revision + 1,
      publication: { source: "manual", externalPostId: input.externalPostId, permalink: input.permalink, publishedAt: input.publishedAt },
      updatedAt: now(),
    });
    store.save();
    res.json(post);
  });
}

