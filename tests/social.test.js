import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { autoScheduleWarehousePosts, mountSocialRoutes } from "../server/social.js";

const roots = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = path.resolve(".verification", `social-${randomUUID()}`);
  await fsp.mkdir(root, { recursive: true });
  roots.push(root);
  const store = new Store(root);
  const project = store.createProject("Dự án thử nghiệm");
  const file = path.join(root, "media", "fixture.mp4");
  await fsp.writeFile(file, Buffer.from("fixture-bytes-đăng"));
  const media = store.add("media", {
    projectId: project.id,
    kind: "video",
    name: "video thử.mp4",
    file,
    thumbnail: null,
    generated: false,
  });
  const app = express();
  app.use(express.json());
  mountSocialRoutes(app, store);
  app.use((error, req, res, next) => res.status(error.status || 400).json({ code: error.code || "INVALID_REQUEST", error: error.message }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, project, media, request: (url, options) => fetch(`${base}${url}`, options) };
}

async function json(response) {
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

test("Page and post CRUD enforce references and stale revisions", async () => {
  const { request, project, media } = await fixture();
  const pageResponse = await request("/api/social/pages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Page tiếng Việt", url: "https://facebook.com/demo" }),
  });
  assert.equal(pageResponse.status, 201);
  const page = await json(pageResponse);
  const postResponse = await request("/api/social/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, pageId: page.id, title: "Bài có dấu", caption: "Xin chào", mediaIds: [media.id] }),
  });
  assert.equal(postResponse.status, 201);
  const post = await json(postResponse);
  const stale = await request(`/api/social/posts/${post.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: 99, caption: "stale" }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, "STALE_REVISION");
  const removePage = await request(`/api/social/pages/${page.id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: page.revision }),
  });
  assert.equal(removePage.status, 409);
  const state = await json(await request("/api/social"));
  assert.equal(state.publishing.connected, false);
  assert.equal(state.posts[0].title, "Bài có dấu");
});

test("Store migrates missing social collections and persists them", async () => {
  const root = path.resolve(".verification", `social-migration-${randomUUID()}`);
  roots.push(root);
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(path.join(root, "studio.json"), JSON.stringify({ version: 1, projects: [], media: [], accounts: [], jobs: [], settings: {} }));
  const store = new Store(root);
  assert.deepEqual(store.state.socialPages, []);
  assert.deepEqual(store.state.socialPosts, []);
  store.add("socialPages", { name: "Persisted", platform: "facebook", externalId: "", url: "", timezone: "UTC", notes: "", archived: false, revision: 1 });
  const reopened = new Store(root);
  assert.equal(reopened.state.socialPages[0].name, "Persisted");
});

test("approved export is atomic, hashable, Unicode-safe, and has no absolute paths", async () => {
  const { request, project } = await fixture();
  const page = await json(await request("/api/social/pages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Export Page" }),
  }));
  const post = await json(await request("/api/social/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, pageId: page.id, title: "Tiêu đề 📦", caption: "Nội dung Unicode — ✓" }),
  }));
  const ready = await json(await request(`/api/social/posts/${post.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: post.revision, status: "ready" }),
  }));
  const exportedResponse = await request(`/api/social/posts/${post.id}/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: ready.revision }),
  });
  assert.equal(exportedResponse.status, 200);
  const exported = await json(exportedResponse);
  assert.ok(exported.manifest.files.every((file) => file.sha256 && file.size >= 0));
  assert.equal(JSON.stringify(exported).includes(path.parse(process.cwd()).root), false);
  const caption = await (await request(`/api/social/posts/${post.id}/package/${ready.revision}/caption.txt`)).text();
  assert.match(caption, /Nội dung Unicode/);
  const traversal = await request(`/api/social/posts/${post.id}/package/${ready.revision}/..%2Fpost.json`);
  assert.notEqual(traversal.status, 200);
});

test("scheduled dates, publication, and duplicate semantics are explicit", async () => {
  const { request, project } = await fixture();
  const page = await json(await request("/api/social/pages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Schedule Page" }) }));
  const post = await json(await request("/api/social/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, pageId: page.id, title: "Planned", caption: "caption" }) }));
  const invalid = await request(`/api/social/posts/${post.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: post.revision, status: "scheduled", scheduledAt: "2020-01-01T00:00:00Z" }) });
  assert.equal(invalid.status, 400);
  const ready = await json(await request(`/api/social/posts/${post.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: post.revision, status: "ready" }) }));
  const duplicate = await request(`/api/social/posts/${post.id}/duplicate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: ready.revision }) });
  assert.equal(duplicate.status, 201);
  assert.equal((await json(duplicate)).status, "draft");
  const published = await json(await request(`/api/social/posts/${post.id}/publication`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: ready.revision, externalPostId: "manual_123", permalink: "https://facebook.com/demo/posts/1", publishedAt: new Date().toISOString() }) }));
  assert.equal(published.status, "published");
  assert.equal(published.publication.source, "manual");
  assert.equal(published.removedFromQueue, true);
  assert.equal((await json(await request("/api/social"))).posts.some((item) => item.id === post.id), false);
});

test("Meta Pages sync into local channels and a Page group schedules warehouse posts", async () => {
  const { request, store, project, media } = await fixture();
  store.state.settings.meta = {
    pages: [
      { id: "111111", name: "First Page", avatar: "https://example.test/first.jpg" },
      { id: "222222", name: "Second Page", avatar: "https://example.test/second.jpg" },
    ],
    pageGroups: [{ id: "group_alpha", name: "Alpha group", pageIds: ["111111", "222222"], scheduleConfig: { times: ["23:59"], staggerMinutes: 10 } }],
    tokenGroups: [],
  };
  store.save();
  const synced = await json(await request("/api/social/pages/sync-meta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }));
  assert.equal(synced.createdCount, 2);
  const localPages = store.state.socialPages;
  const postA = await json(await request("/api/social/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, title: "Warehouse A", caption: "A", mediaIds: [media.id] }) }));
  const postB = await json(await request("/api/social/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, title: "Warehouse B", caption: "B", mediaIds: [media.id] }) }));
  const startAt = new Date(Date.now() + 120_000).toISOString();
  const scheduled = await json(await request("/api/social/groups/group_alpha/schedule", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ postIds: [postA.id, postB.id], startAt, staggerMinutes: 10 }) }));
  assert.equal(scheduled.scheduled.length, 2);
  assert.deepEqual(scheduled.scheduled.map((post) => post.pageId), localPages.map((page) => page.id));
  assert.ok(scheduled.scheduled.every((post) => post.status === "scheduled" && post.pageGroupId === "group_alpha"));
  assert.equal(Date.parse(scheduled.scheduled[1].scheduledAt) - Date.parse(scheduled.scheduled[0].scheduledAt), 600_000);
});

test("an enabled Page group automatically takes warehouse drafts into its daily slots", async () => {
  const { store, project, media } = await fixture();
  const page = store.add("socialPages", { name: "Automation Page", platform: "facebook", externalId: "333333", url: "https://facebook.com/automation", timezone: "Asia/Bangkok", notes: "", archived: false, revision: 1 });
  const now = new Date(Date.now() + 120_000);
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const group = { id: "group_daily", name: "Daily", pageIds: [page.externalId], scheduleConfig: { times: [time], staggerMinutes: 0, dailyLimit: 1, enabled: true, autoPublish: true, tokenGroupId: "pool_daily" } };
  store.state.settings.meta.pageGroups = [group];
  store.state.settings.meta.tokenGroups = [{ id: "pool_daily", name: "Daily pool", tokenIds: ["token-1"] }];
  const post = store.add("socialPosts", {
    projectId: project.id,
    pageId: "",
    pageGroupId: "",
    contentType: "news",
    title: "Warehouse draft",
    caption: "Ready for the daily Page slot.",
    firstComment: "Read more: https://example.test/article",
    linkUrl: "",
    linkLabel: "",
    sourceUrl: "",
    coverImageUrl: "",
    articleBody: "# Warehouse\n\nThis is a complete article body for the scheduled news post.",
    researchId: null,
    mediaIds: [media.id],
    scheduledAt: null,
    status: "draft",
    notes: "",
    revision: 1,
    automationSource: "render-warehouse",
  });
  store.save();
  const result = autoScheduleWarehousePosts(store, group.id);
  assert.equal(result.scheduled.length, 1);
  assert.equal(result.scheduled[0].id, post.id);
  assert.equal(post.status, "scheduled");
  assert.equal(post.pageId, page.id);
  assert.equal(post.pageGroupId, group.id);
  assert.equal(post.tokenGroupId, "pool_daily");
  assert.equal(post.automationSource, "daily-automation");
  assert.ok(Date.parse(post.scheduledAt) > Date.now());
});

test("an enabled Page group takes a completed generated video even when Content was created manually", async () => {
  const { store, project } = await fixture();
  const page = store.add("socialPages", { name: "Manual Content Page", platform: "facebook", externalId: "444444", url: "https://facebook.com/manual-content", timezone: "Asia/Bangkok", notes: "", archived: false, revision: 1 });
  const mediaFile = path.join(store.root, "media", "generated-manual.mp4");
  await fsp.writeFile(mediaFile, Buffer.from("generated-video"));
  const media = store.add("media", { projectId: project.id, kind: "video", name: "Generated manual.mp4", file: mediaFile, thumbnail: null, generated: true, mediaType: "product-video" });
  const now = new Date(Date.now() + 120_000);
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const group = { id: "group_manual", name: "Manual content", pageIds: [page.externalId], scheduleConfig: { times: [time], staggerMinutes: 0, dailyLimit: 1, enabled: true, autoPublish: true } };
  store.state.settings.meta.pageGroups = [group];
  store.state.settings.meta.tokenGroups = [];
  const post = store.add("socialPosts", {
    projectId: project.id,
    pageId: "",
    pageGroupId: "",
    contentType: "product",
    title: "Manual Content",
    caption: "Ready to post.",
    firstComment: "Shop now: https://shop.example/product",
    mediaIds: [media.id],
    scheduledAt: null,
    status: "draft",
    revision: 1,
    automationSource: "",
  });
  const result = autoScheduleWarehousePosts(store, group.id);
  assert.equal(result.scheduled.length, 1);
  assert.equal(result.scheduled[0].id, post.id);
  assert.equal(post.pageId, page.id);
  assert.equal(post.automationSource, "daily-automation");
});

