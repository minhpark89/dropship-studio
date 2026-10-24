import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { mountSocialRoutes } from "../server/social.js";

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
  const published = await json(await request(`/api/social/posts/${post.id}/publication`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: ready.revision, externalPostId: "manual_123", permalink: "https://facebook.com/demo/posts/1", publishedAt: new Date().toISOString() }) }));
  assert.equal(published.status, "published");
  assert.equal(published.publication.source, "manual");
  const edit = await request(`/api/social/posts/${post.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: published.revision, caption: "edit" }) });
  assert.equal(edit.status, 409);
  const duplicate = await request(`/api/social/posts/${post.id}/duplicate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: published.revision }) });
  assert.equal(duplicate.status, 201);
  assert.equal((await json(duplicate)).status, "draft");
});

