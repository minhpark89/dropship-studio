import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { AVATAR_APPLY_POLICY, autoAssignTokenGroup, createMetaClient, publicMeta, postPreflight } from "../server/meta.js";

test("bulk Page avatar updates use a serialized, batched Meta request policy", () => {
  assert.equal(AVATAR_APPLY_POLICY.delayMs, 1000);
  assert.equal(AVATAR_APPLY_POLICY.batchSize, 10);
  assert.equal(AVATAR_APPLY_POLICY.batchPauseMs, 5000);
});

test("token pools automatically split verified Pages across healthy tokens", () => {
  const tokenOne = "token-one-123456";
  const tokenTwo = "token-two-123456";
  const fingerprint = (value) => createHash("sha256").update(value).digest("hex");
  const meta = {
    tokens: [
      { id: "tok-1", token: tokenOne, status: "ACTIVE", totalCalls: 0 },
      { id: "tok-2", token: tokenTwo, status: "ACTIVE", totalCalls: 0 },
    ],
    pages: ["p1", "p2", "p3", "p4"].map((id) => ({
      id,
      tokenBindings: {
        "tok-1": { status: "VERIFIED", pageToken: `page-${id}-one`, verifiedPageId: id, credentialFingerprint: fingerprint(tokenOne) },
        "tok-2": { status: "VERIFIED", pageToken: `page-${id}-two`, verifiedPageId: id, credentialFingerprint: fingerprint(tokenTwo) },
      },
    })),
  };
  const group = { id: "pool-1", tokenIds: ["tok-1", "tok-2"], pageIds: ["p1", "p2", "p3", "p4"] };
  const result = autoAssignTokenGroup(meta, group, { strategy: "round_robin" });
  assert.equal(result.assignedCount, 4);
  assert.equal(result.blockedCount, 0);
  assert.deepEqual(group.pageTokenBindings, { p1: "tok-1", p2: "tok-2", p3: "tok-1", p4: "tok-2" });
  assert.deepEqual(result.loads, { "tok-1": 2, "tok-2": 2 });
});

test("round robin keeps uneven Page pools within one Page of each other", () => {
  const fingerprint = (value) => createHash("sha256").update(value).digest("hex");
  const tokens = Array.from({ length: 30 }, (_, index) => ({ id: `tok-${index}`, token: `token-${index}-123456`, status: "ACTIVE", totalCalls: 0 }));
  const pages = Array.from({ length: 100 }, (_, pageIndex) => ({
    id: `page-${pageIndex}`,
    tokenBindings: Object.fromEntries(tokens.map((token) => [token.id, {
      status: "VERIFIED",
      pageToken: `${token.id}-${pageIndex}`,
      verifiedPageId: `page-${pageIndex}`,
      credentialFingerprint: fingerprint(token.token),
    }])),
  }));
  const meta = { tokens, pages };
  const group = { id: "pool-balance", tokenIds: tokens.map((token) => token.id), pageIds: pages.map((page) => page.id) };
  const result = autoAssignTokenGroup(meta, group, { strategy: "round_robin" });
  const loads = Object.values(result.loads);
  assert.equal(result.assignedCount, 100);
  assert.equal(result.blockedCount, 0);
  assert.equal(Math.min(...loads), 3);
  assert.equal(Math.max(...loads), 4);
  assert.equal(loads.filter((load) => load === 4).length, 10);
});

test("Meta client uses the current Graph version and keeps token out of response data", async () => {
  const requests = [];
  const client = createMetaClient({
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      const payload = String(url).includes("me/accounts")
        ? { data: [{ id: "9", name: "Page", picture: { data: { url: "https://cdn.example/page.png" } } }] }
        : { id: "42", name: "Owner" };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.me("user-token-123456");
  assert.equal(result.id, "42");
  assert.match(requests[0].url, /graph\.facebook\.com\/v26\.0\/me/);
  assert.match(requests[0].url, /access_token=user-token-123456/);
  const pages = await client.pages("user-token-123456");
  assert.match(requests[1].url, /me\/accounts/);
  assert.match(requests[1].url, /picture(%7B|\{)url/);
  assert.equal(pages.data[0].picture.data.url, "https://cdn.example/page.png");
  const view = publicMeta({ accessToken: "secret", graphVersion: "v26.0", user: { id: "42" }, pages: [{ id: "9", name: "Page", accessToken: "page-secret" }], boundPageId: "9", boundPageName: "Page" });
  assert.equal(view.connected, true);
  assert.equal(view.pages[0].hasToken, true);
  assert.equal("accessToken" in view.pages[0], false);
  assert.equal("accessToken" in view, false);
  const avatarView = publicMeta({ pages: [{ id: "9", name: "Page", avatar: "/api/media/avatar/thumbnail", avatarMediaId: "media-1", avatarSource: "ai-meta", avatarStatus: "updated" }] });
  assert.equal(avatarView.pages[0].avatar, "/api/media/avatar/thumbnail");
  assert.equal(avatarView.pages[0].avatarMediaId, "media-1");
  assert.equal(avatarView.pages[0].avatarStatus, "updated");
});

test("Meta client follows Page pagination so a token can load all managed Pages", async () => {
  const requests = [];
  const client = createMetaClient({
    fetchImpl: async (url) => {
      const value = String(url);
      requests.push(value);
      if (value.includes("page=2")) {
        return new Response(JSON.stringify({ data: [{ id: "3", name: "Page 3" }] }), { status: 200 });
      }
      if (value.includes("me/accounts")) {
        return new Response(JSON.stringify({ data: [{ id: "1", name: "Page 1" }, { id: "2", name: "Page 2" }], paging: { next: "https://graph.facebook.com/v26.0/me/accounts?page=2" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "42", name: "Owner" }), { status: 200 });
    },
  });
  const result = await client.pages("user-token-123456");
  assert.deepEqual(result.data.map((page) => page.id), ["1", "2", "3"]);
  assert.equal(requests.length, 2);
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
  assert.equal(result.checks.find((item) => item.key === "first_comment").ok, false);
});

test("Meta News preflight requires the verified website URL in first comment", () => {
  const store = {
    state: {
      socialPages: [{ id: "local", externalId: "123", name: "Page" }],
      media: [{ id: "video", kind: "video", file: "C:/video.mp4" }],
    },
  };
  const post = {
    pageId: "local",
    status: "ready",
    caption: "caption",
    mediaIds: ["video"],
    contentType: "news",
    website: { status: "published", url: "https://site.example/news/verified" },
    firstComment: "Read this: https://site.example/news/old",
  };
  const result = postPreflight(store, post, { accessToken: "token", boundPageId: "123", boundPageToken: "page-token" });
  assert.equal(result.ready, false);
  assert.equal(result.checks.find((item) => item.key === "first_comment").ok, false);
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
  const post = store.add("socialPosts", { projectId: project.id, pageId: page.id, title: "Reel", caption: "Caption", firstComment: "Read the full article: https://news.example/story", mediaIds: [media.id], scheduledAt: null, status: "ready", notes: "", revision: 1 });
  const calls = [];
  const app = express();
  app.use(express.json());
  mountMetaRoutes(app, store, { client: {
    me: async () => ({ id: "42", name: "Owner" }),
    pages: async () => ({ data: [{ id: "123", name: "Page", access_token: "page-token" }] }),
    startReel: async (input) => { calls.push(["start", input.pageId, input.fileSize]); return { video_id: "video-1", upload_url: "https://upload.test/chunk" }; },
    uploadChunk: async () => { calls.push(["upload"]); return {}; },
    finishReel: async () => { calls.push(["finish"]); return { id: "post-1" }; },
    comment: async (input) => { calls.push(["comment", input.objectId, input.message]); return { id: "comment-1" }; },
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
    assert.equal(firstBody.firstCommentStatus, "published");
    assert.equal(firstBody.removedFromQueue, true);
    assert.equal(firstBody.mediaCleanup.removed, true);
    assert.equal(firstBody.title, post.title);
    assert.equal(firstBody.projectId, project.id);
    assert.equal(store.state.socialPosts.some((item) => item.id === post.id), false);
    assert.equal(store.state.media.some((item) => item.id === media.id), false);
    assert.equal(await fs.access(mediaFile).then(() => true, () => false), false);
    assert.equal(store.state.settings.meta.publications[0].externalPostId, "post-1");
    const second = await jsonRequest("/api/meta/publish/reel", { postId: post.id, idempotencyKey: "publish-test-123" });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), firstBody);
    assert.deepEqual(calls.map((item) => item[0]), ["start", "upload", "finish", "comment"]);
    assert.deepEqual(calls[3], ["comment", "post-1", "Read the full article: https://news.example/story"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const manualRetry of [false, true]) test(`Meta retries only the failed comment ${manualRetry ? "after publish-now changes the revision" : "with the original key"}`, async () => {
  const { default: express } = await import("express");
  const { Store } = await import("../server/store.js");
  const { mountMetaRoutes } = await import("../server/meta.js");
  const { mountSocialRoutes } = await import("../server/social.js");
  const { default: fs } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const root = path.resolve(".verification", `meta-comment-error-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  const store = new Store(root);
  const project = store.createProject("Comment QA");
  const page = store.add("socialPages", { name: "Page", platform: "facebook", externalId: "321", url: "https://www.facebook.com/page", timezone: "Asia/Bangkok", notes: "", archived: false });
  const mediaFile = path.join(root, "sample.mp4");
  await fs.writeFile(mediaFile, Buffer.from("video-bytes"));
  const media = store.add("media", { projectId: project.id, name: "sample.mp4", kind: "video", file: mediaFile, thumbnail: null, previewFile: null, bytes: 11, width: 720, height: 1280, duration: 5, generated: false });
  const post = store.add("socialPosts", { projectId: project.id, pageId: page.id, title: "Reel", caption: "Caption", firstComment: "Read the full article: https://news.example/story", mediaIds: [media.id], scheduledAt: null, status: "ready", notes: "", revision: 1 });
  const calls = [];
  let commentAttempts = 0;
  const app = express();
  app.use(express.json());
  mountSocialRoutes(app, store);
  mountMetaRoutes(app, store, { client: {
    me: async () => ({ id: "42", name: "Owner" }),
    pages: async () => ({ data: [{ id: "321", name: "Page", access_token: "page-token" }] }),
    startReel: async () => { calls.push("start"); return { video_id: "video-1", upload_url: "https://upload.test/chunk" }; },
    uploadChunk: async () => { calls.push("upload"); return {}; },
    finishReel: async () => { calls.push("finish"); return { id: "post-1" }; },
    comment: async () => { commentAttempts += 1; calls.push("comment"); if (commentAttempts === 1) throw new Error("Graph comment failed"); return { id: "comment-1" }; },
  } });
  app.use((error, req, res, next) => res.status(error.status || 400).json({ code: error.code || "INVALID_REQUEST", error: error.message }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jsonRequest = (url, body) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await jsonRequest("/api/meta/connect", { accessToken: "user-token-123456" })).status, 200);
    assert.equal((await jsonRequest("/api/meta/bind", { pageId: "321" })).status, 200);
    const first = await jsonRequest("/api/meta/publish/reel", { postId: post.id, idempotencyKey: "comment-retry-123" });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.status, "published_comment_error");
    assert.equal(firstBody.removedFromQueue, false);
    assert.equal(firstBody.firstCommentError, "Graph comment failed");
    assert.equal(store.state.socialPosts.some((item) => item.id === post.id), true);
    assert.equal(store.state.media.some((item) => item.id === media.id), true);
    assert.equal(await fs.access(mediaFile).then(() => true, () => false), true);
    assert.equal(store.state.socialPosts[0].automationError, "Graph comment failed");
    let retryKey = "comment-retry-123";
    if (manualRetry) {
      Object.assign(post, { automationRetryBlocked: true, automationAttempts: 3, automationBlockedReason: "retry_exhausted" });
      store.save();
      const retry = await jsonRequest(`/api/social/posts/${post.id}/publish-now`, { revision: post.revision });
      assert.equal(retry.status, 200);
      const queued = await retry.json();
      assert.equal(queued.automationRetryBlocked, false);
      assert.equal(queued.revision, 2);
      retryKey = `schedule:${post.id}:${queued.revision}`;
    }
    const second = await jsonRequest("/api/meta/publish/reel", { postId: post.id, idempotencyKey: retryKey });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.status, "published");
    assert.equal(secondBody.firstCommentStatus, "published");
    assert.equal(secondBody.removedFromQueue, true);
    assert.equal(secondBody.mediaCleanup.removed, true);
    assert.equal(store.state.socialPosts.some((item) => item.id === post.id), false);
    assert.equal(store.state.media.some((item) => item.id === media.id), false);
    assert.equal(await fs.access(mediaFile).then(() => true, () => false), false);
    assert.equal(store.state.settings.meta.publications.length, 1);
    assert.equal(store.state.settings.meta.publications[0].idempotencyKey, "comment-retry-123");
    assert.deepEqual(calls, ["start", "upload", "finish", "comment", "comment"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
