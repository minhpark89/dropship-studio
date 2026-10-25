import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { createResearchService, dedupeArticles, mountResearchRoutes, parseFeed } from "../server/research.js";

const roots = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function fixture({ fetchImpl, llm = {}, queue } = {}) {
  const root = path.resolve(".verification", `research-${randomUUID()}`);
  await fsp.mkdir(root, { recursive: true });
  roots.push(root);
  const store = new Store(root);
  const project = store.createProject("Research test");
  store.state.settings.llm = {
    ...store.state.settings.llm,
    ...llm,
  };
  const app = express();
  app.use(express.json());
  mountResearchRoutes(app, store, { fetchImpl, queue });
  app.use((error, req, res, next) => res.status(error.status || 400).json({ code: error.code || "INVALID_REQUEST", error: error.message }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, project, request: (url, options) => fetch(`${base}${url}`, options) };
}

async function json(response) {
  return JSON.parse(await response.text());
}

const rss = `<?xml version="1.0"?><rss><channel><title>Test Feed</title>
  <item><title>Topic one</title><description><![CDATA[Summary one]]></description><link>https://example.test/one?utm_source=test</link><pubDate>Mon, 20 Oct 2025 10:00:00 GMT</pubDate><enclosure url="https://images.test/one.jpg" type="image/jpeg" /></item>
  <item><title>Topic duplicate</title><description>Summary duplicate</description><link>https://example.test/one</link></item>
</channel></rss>`;

test("RSS parser and deduplication keep bounded article metadata", () => {
  const parsed = parseFeed(rss, "https://example.test/feed.xml");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].source, "Test Feed");
  assert.equal(parsed[0].imageUrl, "https://images.test/one.jpg");
  const unique = dedupeArticles(parsed, { maxArticles: 10, topic: "one" });
  assert.equal(unique.length, 1);
  assert.equal(unique[0].relevance, 1);
});

test("research falls back visibly when LLM is disabled and never exposes the key", async () => {
  const fetchImpl = async () => new Response(rss, { headers: { "content-type": "application/rss+xml" } });
  const { request, project } = await fixture({ fetchImpl });
  const settings = await json(await request("/api/settings/llm"));
  assert.equal(settings.apiKey, "");
  const response = await request("/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, topic: "one", feeds: ["https://example.test/feed.xml"], maxArticles: 5 }),
  });
  assert.equal(response.status, 201);
  const result = await json(response);
  assert.equal(result.projectId, project.id);
  assert.equal(result.articles.length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("LLM")));
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("research uses an OpenAI-compatible JSON response and redacts settings", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ headline: "Generated", angle: "Angle", script: "Script", imageQueries: ["generated query"] }) } }] }), { headers: { "content-type": "application/json" } });
    }
    return new Response(rss, { headers: { "content-type": "application/rss+xml" } });
  };
  const { request, project, store } = await fixture({ fetchImpl, llm: { enabled: true, apiKey: "secret-token", endpoint: "https://llm.example.test/v1", model: "test-model" } });
  const settingResponse = await request("/api/settings/llm");
  assert.equal((await json(settingResponse)).apiKey, "[đã lưu]");
  const response = await request("/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, topic: "one", feeds: ["https://example.test/feed.xml"] }),
  });
  assert.equal(response.status, 201);
  const result = await json(response);
  assert.equal(result.headline, "Generated");
  assert.equal(result.warnings.length, 0);
  assert.equal(calls[1].options.headers.authorization, "Bearer secret-token");
  assert.equal(JSON.stringify(await json(await request("/api/settings/llm"))).includes("secret-token"), false);
  assert.equal(store.state.settings.llm.apiKey, "secret-token");
});

test("LLM settings can discover models from an OpenAI-compatible endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: [{ id: "qwen2.5" }, { id: "gpt-4.1-mini" }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  const { request } = await fixture({
    fetchImpl,
    llm: { apiKey: "stored-key", endpoint: "http://127.0.0.1:11434/v1", model: "qwen2.5" },
  });
  const response = await request("/api/settings/llm/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "http://127.0.0.1:11434/v1" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await json(response)).models, ["qwen2.5", "gpt-4.1-mini"]);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/v1/models");
  assert.equal(calls[0].options.headers.authorization, "Bearer stored-key");
});

test("LLM connection test calls the saved model without exposing the key", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ headline: "Connection OK", angle: "", script: "", imageQueries: [] }) } }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  const { request } = await fixture({
    fetchImpl,
    llm: { enabled: true, apiKey: "secret-token", endpoint: "https://llm.example.test/v1", model: "test-model" },
  });
  const response = await request("/api/settings/llm/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.ok, true);
  assert.equal(body.model, "test-model");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret-token");
  assert.equal(JSON.stringify(body).includes("secret-token"), false);
});

test("research can call a local OpenAI-compatible endpoint without an API key", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ headline: "Local model", angle: "Local angle", script: "Local script", imageQueries: ["local query"] }) } }] }), { headers: { "content-type": "application/json" } });
    }
    return new Response(rss, { headers: { "content-type": "application/rss+xml" } });
  };
  const { request, project } = await fixture({ fetchImpl, llm: { enabled: true, apiKey: "", endpoint: "http://127.0.0.1:11434/v1", model: "qwen2.5" } });
  const response = await request("/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, topic: "one", feeds: ["https://example.test/feed.xml"] }),
  });
  assert.equal(response.status, 201);
  const result = await json(response);
  assert.equal(result.headline, "Local model");
  assert.equal(result.warnings.length, 0);
  assert.equal(calls.length, 2);
  assert.equal("authorization" in calls[1].options.headers, false);
});

test("LLM failure is converted to a visible warning and feed result remains usable", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("chat/completions")) throw new Error("offline");
    return new Response(rss);
  };
  const { request, project } = await fixture({ fetchImpl, llm: { enabled: true, apiKey: "test-key" } });
  const response = await request("/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, topic: "one", feeds: ["https://example.test/feed.xml"] }),
  });
  assert.equal(response.status, 201);
  const result = await json(response);
  assert.equal(result.articles.length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("không khả dụng")));
});

test("research image queries search Wikimedia and persist attribution metadata", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("commons.wikimedia.org")) {
      return new Response(JSON.stringify({ query: { pages: {
        42: { pageid: 42, title: "File:Editorial mountain.jpg", canonicalurl: "https://commons.wikimedia.org/wiki/File:Editorial_mountain.jpg", imageinfo: [{ thumburl: "https://upload.wikimedia.org/example/mountain.jpg", width: 1200, height: 800, mime: "image/jpeg", extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, Artist: { value: "Example photographer" } } }] },
      } } }), { headers: { "content-type": "application/json" } });
    }
    return new Response(rss, { headers: { "content-type": "application/rss+xml" } });
  };
  const { request, project } = await fixture({ fetchImpl });
  const created = await json(await request("/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, topic: "one", feeds: ["https://example.test/feed.xml"], maxArticles: 5 }),
  }));
  const response = await request(`/api/research/${created.id}/search-images`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries: ["mountain", "mountain"] }),
  });
  assert.equal(response.status, 201);
  const payload = await json(response);
  assert.equal(payload.images.length, 1);
  assert.equal(payload.result.imageSearchResults[0].license, "CC BY-SA 4.0");
  assert.equal(payload.result.imageSearchResults[0].attribution, "Example photographer");
});

test("one-click news video searches, imports, assembles and queues a vertical draft", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1kAAAAASUVORK5CYII=", "base64");
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("commons.wikimedia.org")) {
      return new Response(JSON.stringify({ query: { pages: {
        99: { pageid: 99, title: "File:News image.png", canonicalurl: "https://commons.wikimedia.org/wiki/File:News_image.png", imageinfo: [{ thumburl: "https://upload.wikimedia.org/news.png", width: 720, height: 1280, mime: "image/png", extmetadata: {} }] },
      } } }), { headers: { "content-type": "application/json" } });
    }
    if (value.includes("upload.wikimedia.org")) return new Response(png, { headers: { "content-type": "image/png" } });
    return new Response(rss, { headers: { "content-type": "application/rss+xml" } });
  };
  let enqueued = null;
  const queue = { enqueueRender(input) { enqueued = input; return { id: "render-job", status: "queued" }; } };
  const { request, project } = await fixture({ fetchImpl, queue });
  const created = await json(await request("/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, topic: "one", feeds: ["https://example.test/feed.xml"], maxArticles: 5 }),
  }));
  const response = await request(`/api/research/${created.id}/auto-video`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 201);
  const payload = await json(response);
  assert.equal(payload.imported.length, 1);
  assert.equal(payload.assembly.additions, 1);
  assert.ok(payload.assembly.overlays >= 2);
  assert.equal(payload.project.timeline.ratio, "9:16");
  assert.equal(payload.project.timeline.resolution, 720);
  assert.equal(payload.project.timeline.quality, "draft");
  assert.equal(payload.job.id, "render-job");
  assert.equal(enqueued.timeline.texts.length >= 2, true);
});
