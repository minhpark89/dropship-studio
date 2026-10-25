import assert from "node:assert/strict";
import test from "node:test";
import { createMetaClient, publicMeta, postPreflight } from "../server/meta.js";

test("Meta client uses the current Graph version and keeps token out of response data", async () => {
  const requests = [];
  const client = createMetaClient({
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "42", name: "Owner" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.me("user-token-123456");
  assert.equal(result.id, "42");
  assert.match(requests[0].url, /graph\.facebook\.com\/v26\.0\/me/);
  assert.match(requests[0].url, /access_token=user-token-123456/);
  const view = publicMeta({ accessToken: "secret", graphVersion: "v26.0", user: { id: "42" }, pages: [{ id: "9", name: "Page", accessToken: "page-secret" }], boundPageId: "9", boundPageName: "Page" });
  assert.equal(view.connected, true);
  assert.equal(view.pages[0].hasToken, true);
  assert.equal("accessToken" in view.pages[0], false);
  assert.equal("accessToken" in view, false);
});

test("Meta preflight blocks a local post without a matching bound Page and video", () => {
  const store = {
    state: {
      socialPages: [{ id: "local", externalId: "123", name: "Page" }],
      media: [],
    },
  };
  const post = { pageId: "local", status: "ready", caption: "caption", mediaIds: [] };
  const result = postPreflight(store, post, { accessToken: "token", boundPageId: "999", boundPageToken: "page-token", boundPageName: "Other" });
  assert.equal(result.ready, false);
  assert.equal(result.checks.find((item) => item.key === "page_match").ok, false);
  assert.equal(result.checks.find((item) => item.key === "video").ok, false);
});

test("Meta routes connect, redact tokens, and bind a Page", async () => {
  const { default: express } = await import("express");
  const { Store } = await import("../server/store.js");
  const { mountMetaRoutes } = await import("../server/meta.js");
  const { default: fs } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const root = path.resolve(".verification", `meta-route-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  const store = new Store(root);
  const app = express();
  app.use(express.json());
  mountMetaRoutes(app, store, { client: {
    me: async () => ({ id: "42", name: "Owner" }),
    pages: async () => ({ data: [{ id: "123", name: "Dropship Page", tasks: ["CREATE_CONTENT"], access_token: "page-token-secret" }] }),
  } });
  app.use((error, req, res, next) => res.status(error.status || 400).json({ code: error.code || "INVALID_REQUEST", error: error.message }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const invalidKind = await fetch(`${base}/api/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken: "user-token-secret-123", kind: "TEAM" }) });
    assert.equal(invalidKind.status, 400);
    const response = await fetch(`${base}/api/meta/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken: "user-token-secret-123" }) });
    assert.equal(response.status, 200);
    const connected = await response.json();
    assert.equal(connected.connected, true);
    assert.equal(connected.pages[0].hasToken, true);
    assert.equal(JSON.stringify(connected).includes("user-token-secret-123"), false);
    assert.equal(JSON.stringify(connected).includes("page-token-secret"), false);
    const boundResponse = await fetch(`${base}/api/meta/bind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "123" }) });
    assert.equal(boundResponse.status, 200);
    const bound = await boundResponse.json();
    assert.equal(bound.boundPage.id, "123");
    const snapshot = store.publicSnapshot();
    assert.equal(snapshot.settings.meta.accessToken, "[đã lưu]");
    assert.equal(snapshot.settings.meta.boundPageToken, "[đã lưu]");
    assert.equal(snapshot.settings.meta.pages[0].hasToken, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Meta vault keeps multiple token bindings and independent groups redacted", async () => {
  const { default: express } = await import("express");
  const { Store } = await import("../server/store.js");
  const { mountMetaRoutes } = await import("../server/meta.js");
  const { default: fs } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const root = path.resolve(".verification", `meta-vault-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  const store = new Store(root);
  const app = express();
  app.use(express.json());
  mountMetaRoutes(app, store, { client: {
    me: async (token) => ({ id: token.includes("two") ? "2" : "1", name: token.includes("two") ? "Owner Two" : "Owner One" }),
    pages: async (token) => ({ data: [{ id: "321", name: "Shared Page", tasks: ["CREATE_CONTENT"], access_token: `page-${token}` }] }),
  } });
  app.use((error, req, res, next) => res.status(error.status || 400).json({ code: error.code || "INVALID_REQUEST", error: error.message }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const first = await post("/api/tokens", { accessToken: "owner-one-token-123456", name: "Team One" });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(JSON.stringify(firstBody).includes("owner-one-token-123456"), false);
    const second = await post("/api/tokens", { accessToken: "owner-two-token-123456", name: "Team Two" });
    assert.equal(second.status, 201);
    const secondBody = await second.json();
    const group = await post("/api/token-groups", { name: "Team pool", tokenIds: [firstBody.token.id, secondBody.token.id], strategy: "least_recently_used" });
    assert.equal(group.status, 200);
    const pageGroup = await post("/api/groups", { name: "Shared content", pageIds: ["321"] });
    assert.equal(pageGroup.status, 200);
    const publicState = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(publicState.tokens.length, 2);
    assert.equal(publicState.tokenGroups[0].tokenIds.length, 2);
    assert.equal(publicState.pageGroups[0].pageIds[0], "321");
    assert.equal(JSON.stringify(publicState).includes("owner-one-token-123456"), false);
    assert.equal(JSON.stringify(publicState).includes("page-owner-one-token-123456"), false);
    assert.equal(JSON.stringify(store.publicSnapshot()).includes("page-owner-two-token-123456"), false);
    const disconnect = await fetch(`${base}/api/meta`, { method: "DELETE" });
    assert.equal(disconnect.status, 200);
    const disconnected = await disconnect.json();
    assert.equal(disconnected.connected, false);
    assert.equal(disconnected.tokens.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Meta Via Token requires App ID and App Secret, then redacts the secret", async () => {
  const { default: express } = await import("express");
  const { Store } = await import("../server/store.js");
  const { mountMetaRoutes } = await import("../server/meta.js");
  const { default: fs } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const root = path.resolve(".verification", `meta-via-token-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  const store = new Store(root);
  const debugCalls = [];
  const app = express();
  app.use(express.json());
  mountMetaRoutes(app, store, { client: {
    debugToken: async (input) => {
      debugCalls.push(input);
      return { data: { is_valid: true, app_id: input.appId } };
    },
    me: async () => ({ id: "99", name: "Via Owner" }),
    pages: async () => ({ data: [{ id: "987", name: "Via Page", access_token: "page-via-secret" }] }),
  } });
  app.use((error, req, res, next) => res.status(error.status || 400).json({ code: error.code || "INVALID_REQUEST", error: error.message }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken: "via-token-123456", kind: "VIA_TOKEN", appId: "app-123", appSecret: "app-secret-value", name: "Via connection" }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(debugCalls.length, 1);
    assert.equal(debugCalls[0].appId, "app-123");
    assert.equal(debugCalls[0].appSecret, "app-secret-value");
    assert.equal(JSON.stringify(body).includes("app-secret-value"), false);
    assert.equal(JSON.stringify(body).includes("via-token-123456"), false);
    assert.equal(store.state.settings.meta.tokens[0].kind, "VIA_TOKEN");
    assert.equal(store.state.settings.meta.tokens[0].appSecret, "app-secret-value");
    assert.equal(JSON.stringify(store.publicSnapshot()).includes("app-secret-value"), false);
    const publicState = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(publicState.tokens[0].appId, "app-123");
    assert.equal(publicState.tokens[0].hasAppSecret, true);
    assert.equal(JSON.stringify(publicState).includes("app-secret-value"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Meta Reel publish is explicit and idempotent after preflight", async () => {
  const { default: express } = await import("express");
  const { Store } = await import("../server/store.js");
  const { mountMetaRoutes } = await import("../server/meta.js");
  const { default: fs } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const root = path.resolve(".verification", `meta-publish-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  const store = new Store(root);
  const project = store.createProject("Publish QA");
  const page = store.add("socialPages", { name: "Page", platform: "facebook", externalId: "123", url: "https://www.facebook.com/page", timezone: "Asia/Bangkok", notes: "", archived: false });
  const mediaFile = path.join(root, "sample.mp4");
  await fs.writeFile(mediaFile, Buffer.from("video-bytes"));
  const media = store.add("media", { projectId: project.id, name: "sample.mp4", kind: "video", file: mediaFile, thumbnail: null, previewFile: null, bytes: 11, width: 720, height: 1280, duration: 5, generated: false });
  const post = store.add("socialPosts", { projectId: project.id, pageId: page.id, title: "Reel", caption: "Caption", mediaIds: [media.id], scheduledAt: null, status: "ready", notes: "", revision: 1 });
  const calls = [];
  const app = express();
  app.use(express.json());
  mountMetaRoutes(app, store, { client: {
    me: async () => ({ id: "42", name: "Owner" }),
    pages: async () => ({ data: [{ id: "123", name: "Page", access_token: "page-token" }] }),
    startReel: async (input) => { calls.push(["start", input.pageId, input.fileSize]); return { video_id: "video-1", upload_url: "https://upload.test/chunk" }; },
    uploadChunk: async () => { calls.push(["upload"]); return {}; },
    finishReel: async () => { calls.push(["finish"]); return { id: "post-1" }; },
  } });
  app.use((error, req, res, next) => res.status(error.status || 400).json({ code: error.code || "INVALID_REQUEST", error: error.message }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jsonRequest = (url, body) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await jsonRequest("/api/meta/connect", { accessToken: "user-token-123456" })).status, 200);
    assert.equal((await jsonRequest("/api/meta/bind", { pageId: "123" })).status, 200);
    const first = await jsonRequest("/api/meta/publish/reel", { postId: post.id, idempotencyKey: "publish-test-123" });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.externalPostId, "post-1");
    assert.equal(firstBody.permalink, "https://www.facebook.com/post-1");
    const second = await jsonRequest("/api/meta/publish/reel", { postId: post.id, idempotencyKey: "publish-test-123" });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), firstBody);
    assert.deepEqual(calls.map((item) => item[0]), ["start", "upload", "finish"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
