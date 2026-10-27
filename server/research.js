import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  llmSettingsSchema,
  researchArticleSchema,
  researchImageSchema,
  researchRequestSchema,
  researchResultSchema,
} from "../shared/research-contracts.js";
import { StudioError } from "./store.js";
import { importMedia } from "./media.js";
import { downloadImageAsset, searchImageQueries, newsImageCandidates } from "./image-search.js";
import { buildResearchAssemblyTimeline } from "../shared/research-assembly.js";
import { normalizeLlmEndpoint } from "./llm.js";
import { readChatCompletion } from "./llm-response.js";

const DEFAULT_FEEDS = [
  "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml",
  "https://feeds.bbci.co.uk/news/rss.xml",
];
const MAX_FEED_BYTES = 1024 * 1024;
const MAX_FEED_ITEMS = 40;
const MAX_FEED_CONCURRENCY = 3;
const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i;

function cleanText(value, limit = 4000) {
  if (!value) return "";
  const withoutCdata = String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");
  const withoutTags = withoutCdata.replace(/<[^>]*>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
  return decoded.replace(/\s+/g, " ").trim().slice(0, limit);
}

function tagValue(block, name) {
  const expression = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  return block.match(expression)?.[1] || "";
}

function attributeValue(tag, name) {
  const expression = new RegExp(`${name}\\s*=\\s*[\"']([^\"']+)[\"']`, "i");
  return tag.match(expression)?.[1] || "";
}

function parseDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(cleanText(value, 100));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function extractImageUrl(block) {
  const mediaMatch = block.match(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*>/i);
  if (mediaMatch) {
    const url = attributeValue(mediaMatch[0], "url") || attributeValue(mediaMatch[0], "href");
    if (url) return safeUrl(url);
  }
  const imageMatch = cleanText(block, 8000).match(/https?:\/\/[^\s"']+\.(?:jpe?g|png|webp|gif)(?:\?[^\s"']*)?/i);
  return imageMatch ? safeUrl(imageMatch[0]) : null;
}

function safeUrl(value, base) {
  try {
    const url = new URL(cleanText(value, 2000), base);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseEntry(block, atom, feedUrl) {
  const title = cleanText(tagValue(block, "title"), 500);
  const description = tagValue(block, atom ? "summary" : "description") || tagValue(block, "content:encoded") || tagValue(block, "content");
  const linkTag = block.match(/<link\b[^>]*>/i)?.[0] || "";
  const link = atom ? attributeValue(linkTag, "href") || tagValue(block, "link") : tagValue(block, "link") || attributeValue(linkTag, "href");
  const url = safeUrl(link || tagValue(block, "guid"), feedUrl);
  if (!title || !url) return null;
  const publishedAt = parseDate(tagValue(block, atom ? "published" : "pubDate") || tagValue(block, "updated"));
  return {
    title,
    summary: cleanText(description),
    url,
    publishedAt,
    imageUrl: extractImageUrl(block),
  };
}

export function parseFeed(xml, feedUrl = "") {
  const source = cleanText(tagValue(xml, "title"), 200);
  const atom = /<feed\b/i.test(xml) || /<entry\b/i.test(xml);
  const elementName = atom ? "entry" : "item";
  const entries = [];
  const expression = new RegExp(`<${elementName}\\b[^>]*>[\\s\\S]*?</${elementName}>`, "gi");
  for (const match of xml.matchAll(expression)) {
    const entry = parseEntry(match[0], atom, feedUrl);
    if (entry) entries.push({ ...entry, source: source || domainOf(feedUrl) });
    if (entries.length >= MAX_FEED_ITEMS) break;
  }
  return entries;
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function canonicalArticleUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

function relevanceScore(title, summary, topic) {
  const haystack = `${title} ${summary}`.toLocaleLowerCase();
  const tokens = topic.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 2);
  if (!tokens.length) return 0.2;
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return Math.min(1, hits / tokens.length);
}

export function dedupeArticles(entries, { maxArticles = 6, topic = "" } = {}) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const unique = [];
  for (const entry of entries) {
    const key = canonicalArticleUrl(entry.url);
    const titleKey = entry.title.toLocaleLowerCase().replace(/\W+/gu, " ").trim();
    if (!key || seenUrls.has(key) || (titleKey && seenTitles.has(titleKey))) continue;
    seenUrls.add(key);
    if (titleKey) seenTitles.add(titleKey);
    unique.push({ ...entry, relevance: relevanceScore(entry.title, entry.summary, topic) });
  }
  unique.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return String(b.publishedAt || "").localeCompare(String(a.publishedAt || ""));
  });
  return unique.slice(0, maxArticles);
}

async function readBoundedBody(response, maxBytes = MAX_FEED_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("feed quá lớn");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("feed quá lớn");
  return new TextDecoder().decode(bytes);
}

async function fetchFeed(url, fetchImpl, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseFeed(await readBoundedBody(response), url);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeeds(feeds, fetchImpl, warnings) {
  const output = [];
  let cursor = 0;
  async function worker() {
    while (cursor < feeds.length) {
      const index = cursor++;
      const url = feeds[index];
      try {
        output.push(...await fetchFeed(url, fetchImpl));
      } catch {
        warnings.push(`Không thể tải feed ${domainOf(url) || url}.`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_FEED_CONCURRENCY, feeds.length) }, () => worker()));
  return output;
}

function endpointUrl(endpoint) {
  return `${normalizeLlmEndpoint(endpoint)}/chat/completions`;
}

function parseModelContent(content) {
  if (content && typeof content === "object") return content;
  const text = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return JSON.parse(text);
}

async function requestLlm({ settings, request, articles, fetchImpl }) {
  const prompt = {
    topic: request.topic,
    niche: request.niche,
    language: request.language,
    articles: articles.map(({ title, summary, source, url, publishedAt }) => ({ title, summary, source, url, publishedAt })),
    output: {
      headline: "short headline",
      angle: "editorial angle",
      script: "Five short narration sentences, one per line, 6-10 words each, for a 15-second news video",
      imageQueries: ["query"],
    },
  };
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(settings.timeoutSeconds || 90) * 1000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
    const response = await fetchImpl(endpointUrl(settings.endpoint), {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return only valid JSON with headline, angle, script, and imageQueries. Write in American English for a US audience. Base every factual claim on the supplied article titles and summaries. Do not invent dates, numbers, quotes, or events. Keep the headline under 55 characters. Write the script as five concise narration sentences, one per line, for a 15-second news video. No timestamps, scene directions, Visual/VO labels, markdown, or production notes. Image queries must be in English and describe relevant editorial images. If no sources are supplied, do not invent a news story." },
          { role: "user", content: JSON.stringify(prompt) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
    const content = await readChatCompletion(response);
    return parseModelContent(content);
  } finally {
    clearTimeout(timer);
  }
}

function fallbackContent(request, articles) {
  const headline = articles[0]?.title || request.topic;
  const angle = articles.length
    ? `A source-based summary of ${request.topic} from ${articles.length} reports.`
    : `Research draft on ${request.topic}; sources are needed before publication.`;
  const script = articles.length
    ? `${headline}. ${articles.slice(0, 3).map((article) => article.summary || article.title).join(" ")}`.slice(0, 4000)
    : `Research draft on ${request.topic}. Verify sources and update the facts before use.`;
  const imageQueries = [request.topic, ...articles.slice(0, 3).map((article) => article.title)].filter(Boolean).slice(0, 30);
  return { headline, angle, script, imageQueries };
}

function normalizeLlmContent(content, request, articles) {
  const fallback = fallbackContent(request, articles);
  const imageQueries = Array.isArray(content?.imageQueries)
    ? content.imageQueries.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean).slice(0, 30)
    : fallback.imageQueries;
  return {
    headline: typeof content?.headline === "string" && content.headline.trim() ? content.headline.trim().slice(0, 500) : fallback.headline,
    angle: typeof content?.angle === "string" && content.angle.trim() ? content.angle.trim().slice(0, 4000) : fallback.angle,
    script: typeof content?.script === "string" && content.script.trim() ? content.script.trim().slice(0, 12000) : fallback.script,
    imageQueries,
  };
}

function publicLlmSettings(settings) {
  const parsed = llmSettingsSchema.parse(settings || {});
  return { ...parsed, apiKey: parsed.apiKey ? "[đã lưu]" : "" };
}

function llmModelsUrl(endpoint) {
  const base = new URL(normalizeLlmEndpoint(endpoint));
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
    throw new StudioError("Endpoint LLM phải là URL HTTP/HTTPS hợp lệ.", "INVALID_LLM_ENDPOINT");
  base.search = "";
  base.hash = "";
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL("models", base);
}

async function listLlmModels({ endpoint, apiKey = "", timeoutSeconds = 30, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Math.min(120000, Number(timeoutSeconds || 30) * 1000)));
  try {
    const headers = { accept: "application/json" };
    if (apiKey && apiKey !== "[đã lưu]") headers.authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(llmModelsUrl(endpoint), { headers, signal: controller.signal });
    if (!response.ok) throw new StudioError(`Không tải được danh sách model (HTTP ${response.status}).`, "LLM_MODELS_FAILED", 502);
    const body = await response.json();
    const values = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    const models = [...new Set(values.map((item) => typeof item === "string" ? item : item?.id || item?.name || item?.model).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].slice(0, 300);
    if (!models.length) throw new StudioError("Endpoint không trả về model theo định dạng OpenAI-compatible.", "LLM_MODELS_EMPTY", 502);
    return { models };
  } finally {
    clearTimeout(timer);
  }
}

async function testLlmConnection({ settings, fetchImpl }) {
  const startedAt = Date.now();
  const content = await requestLlm({
    settings,
    request: {
      topic: "connection test",
      niche: "system",
      language: "en",
    },
    articles: [],
    fetchImpl,
  });
  const preview = typeof content === "string"
    ? content.trim().slice(0, 600)
    : JSON.stringify(content).slice(0, 600);
  return {
    ok: true,
    model: settings.model,
    latencyMs: Date.now() - startedAt,
    preview,
  };
}

function validateFeedUrls(feeds) {
  return feeds.map((value) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new StudioError("Feed chỉ hỗ trợ HTTP/HTTPS.", "INVALID_FEED");
    return url.toString();
  });
}

export function createResearchService({ fetchImpl = globalThis.fetch, now = () => new Date().toISOString() } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch implementation is required");
  return {
    async discover({ topic, feeds = [], count = 12 }) {
      const warnings = [];
      const sources = feeds.length ? feeds : [
        `https://news.google.com/rss/search?q=${encodeURIComponent(`${topic} when:1d`)}&hl=en-US&gl=US&ceid=US:en`,
      ];
      const entries = await fetchFeeds(validateFeedUrls(sources), fetchImpl, warnings);
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
      const today = day.format(new Date(now()));
      const current = entries.filter(article => article.publishedAt && day.format(new Date(article.publishedAt)) === today);
      const articles = dedupeArticles(current, { topic, maxArticles: count }).filter(article => article.relevance > 0);
      if (!articles.length) throw new StudioError("No matching reports from today (US Eastern time). Try a broader niche or another RSS feed.", "NO_CURRENT_NEWS", 422);
      return { articles, warnings };
    },
    async research(requestInput, store, { articles: selectedArticles } = {}) {
      const request = researchRequestSchema.parse(requestInput);
      store.require("projects", request.projectId);
      const warnings = [];
      const feeds = validateFeedUrls(request.feeds?.length ? request.feeds : DEFAULT_FEEDS);
      const rawArticles = selectedArticles || await fetchFeeds(feeds, fetchImpl, warnings);
      const articles = dedupeArticles(rawArticles, { maxArticles: request.maxArticles, topic: request.topic });
      let content;
      const llm = llmSettingsSchema.parse(store.state.settings?.llm || {});
      // Local OpenAI-compatible servers (for example Ollama/LM Studio) may not
      // require an API key. The endpoint setting is the source of truth; a
      // remote provider can still reject the request and fall back visibly.
      if (llm.enabled) {
        try {
          content = await requestLlm({ settings: llm, request, articles, fetchImpl });
        } catch {
          warnings.push("LLM không khả dụng; kết quả đang dùng bản tóm lược từ feed.");
        }
      } else {
        warnings.push("LLM chưa được bật; kết quả đang dùng bản tóm lược từ feed.");
      }
      const normalized = normalizeLlmContent(content, request, articles);
      const articleRecords = articles.map((article) => researchArticleSchema.parse({
        id: randomUUID(),
        title: article.title,
        summary: article.summary,
        source: article.source,
        url: article.url,
        publishedAt: article.publishedAt,
        imageUrl: request.includeImages ? article.imageUrl : null,
        imageQuery: normalized.imageQueries.find((query) => query.toLocaleLowerCase().includes(article.title.toLocaleLowerCase().slice(0, 24))) || "",
        relevance: article.relevance,
      }));
      const result = researchResultSchema.parse({
        id: randomUUID(),
        projectId: request.projectId,
        topic: request.topic,
        niche: request.niche,
        language: request.language,
        createdAt: now(),
        ...normalized,
        articles: articleRecords,
        imageSearchResults: [],
        imageMediaIds: [],
        warnings: [...new Set(warnings)],
      });
      return store.add("researchResults", result);
    },
  };
}

export function mountResearchRoutes(app, store, options = {}) {
  const service = options.service || createResearchService(options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  app.get("/api/settings/llm", (req, res) => {
    res.json(publicLlmSettings(store.state.settings?.llm));
  });

  app.patch("/api/settings/llm", (req, res) => {
    const body = req.body || {};
    const current = llmSettingsSchema.parse(store.state.settings?.llm || {});
    const submittedKey = body.apiKey === "[đã lưu]" ? current.apiKey : body.apiKey;
    const normalizedBody = body.endpoint ? { ...body, endpoint: normalizeLlmEndpoint(body.endpoint) } : body;
    const next = llmSettingsSchema.parse({ ...current, ...normalizedBody, apiKey: submittedKey === undefined ? current.apiKey : submittedKey });
    store.state.settings.llm = next;
    store.save();
    res.json(publicLlmSettings(next));
  });

  app.post("/api/settings/llm/models", async (req, res) => {
    const body = z.object({
      endpoint: z.string().url(),
      apiKey: z.string().max(2000).optional(),
    }).parse(req.body || {});
    const current = llmSettingsSchema.parse(store.state.settings?.llm || {});
    const apiKey = body.apiKey === undefined || body.apiKey === "" || body.apiKey === "[đã lưu]" ? current.apiKey : body.apiKey;
    res.json(await listLlmModels({ endpoint: body.endpoint, apiKey, timeoutSeconds: current.timeoutSeconds, fetchImpl }));
  });

  app.post("/api/settings/llm/test", async (req, res) => {
    const settings = llmSettingsSchema.parse(store.state.settings?.llm || {});
    res.json(await testLlmConnection({ settings, fetchImpl }));
  });

  app.get("/api/research", (req, res) => {
    const projectId = req.query.projectId;
    if (projectId) z.string().uuid().parse(projectId);
    const results = store.state.researchResults.filter((result) => !projectId || result.projectId === projectId);
    res.json({ results });
  });

  app.post("/api/research/:id/search-images", async (req, res) => {
    const result = store.require("researchResults", req.params.id);
    const requestedQueries = Array.isArray(req.body?.queries) ? req.body.queries : result.imageQueries;
    const searched = await searchImageQueries(requestedQueries, { fetchImpl, maxResultsPerQuery: 4, maxResults: 24 });
    const warnings = [...new Set([...(result.warnings || []), ...searched.warnings])];
    const imageSearchResults = searched.images.map((image) => researchImageSchema.parse(image));
    const updated = store.patch("researchResults", result.id, { imageSearchResults, warnings });
    res.status(201).json({ result: updated, images: imageSearchResults, warnings: searched.warnings });
  });

  app.post("/api/research/:id/import-search-images", async (req, res) => {
    const result = store.require("researchResults", req.params.id);
    const searchResults = result.imageSearchResults || [];
    const requested = Array.isArray(req.body?.imageIds) ? req.body.imageIds : searchResults.map((image) => image.id);
    const selected = searchResults.filter((image) => requested.includes(image.id)).slice(0, 12);
    const imported = [];
    const warnings = [];
    for (const image of selected) {
      try {
        const media = await downloadImageAsset({ image, store, projectId: result.projectId, fetchImpl });
        imported.push({ imageId: image.id, mediaId: media.id });
      } catch (error) {
        warnings.push(`${image.title || image.query}: ${error.message}`);
      }
    }
    const imageMediaIds = [...new Set([...(result.imageMediaIds || []), ...imported.map((item) => item.mediaId)])];
    const updated = store.patch("researchResults", result.id, {
      imageMediaIds,
      warnings: [...new Set([...(result.warnings || []), ...warnings])],
    });
    res.status(201).json({ result: updated, imported, warnings });
  });

  app.post("/api/research/:id/auto-video", async (req, res) => {
    const result = store.require("researchResults", req.params.id);
    let imageSearchResults = result.imageSearchResults || [];
    let warnings = [...(result.warnings || [])];
    if (!imageSearchResults.length) {
      const searched = await searchImageQueries(result.imageQueries || [result.topic], {
        fetchImpl,
        maxResultsPerQuery: 3,
        maxResults: 12,
      });
      imageSearchResults = searched.images.map((image) => researchImageSchema.parse(image));
      warnings = [...new Set([...warnings, ...searched.warnings])];
    }
    if (!newsImageCandidates(result.articles,imageSearchResults).length && !(result.imageMediaIds || []).length) {
      throw new StudioError("LLM chưa tìm được ảnh công khai để dựng video.", "IMAGE_SEARCH_EMPTY", 502);
    }
    const existingMediaIds = [...new Set(result.imageMediaIds || [])];
    // Keep the one-click news cut close to the reference short: five images
    // at three seconds each keeps the first review render around 15 seconds.
    const selected = newsImageCandidates(result.articles,imageSearchResults).slice(0, 5);
    const missing = selected.slice(existingMediaIds.length);
    const imported = [];
    for (const image of missing) {
      try {
        const media = await downloadImageAsset({ image, store, projectId: result.projectId, fetchImpl });
        imported.push({ imageId: image.id, mediaId: media.id });
      } catch (error) {
        warnings.push(`${image.title || image.query}: ${error.message}`);
      }
    }
    const imageMediaIds = [...new Set([...existingMediaIds, ...imported.map((item) => item.mediaId)])].slice(0, 5);
    if (!imageMediaIds.length) throw new StudioError("Không tải được ảnh công khai để dựng video.", "IMAGE_IMPORT_EMPTY", 502);
    const updatedResult = store.patch("researchResults", result.id, {
      imageSearchResults,
      imageMediaIds,
      warnings: [...new Set(warnings)],
    });
    const project = store.require("projects", result.projectId);
    const assets = imageMediaIds.map((id) => store.state.media.find((media) => media.id === id)).filter(Boolean);
    const baseTimeline = {
      ...project.timeline,
      ratio: "9:16",
      resolution: 720,
      fps: 30,
      quality: "draft",
    };
    const assembly = buildResearchAssemblyTimeline(
      baseTimeline,
      assets,
      updatedResult,
      undefined,
      { template: "news-short" },
    );
    const updatedProject = store.patch("projects", project.id, { timeline: assembly.timeline });
    const job = options.queue?.enqueueRender({
      projectId: project.id,
      name: `News auto · ${updatedResult.headline || updatedResult.topic}`,
      timeline: assembly.timeline,
    }, { production: { contentType: "news", researchId: result.id, topic: result.topic } }) || null;
    res.status(201).json({
      result: updatedResult,
      project: updatedProject,
      imported,
      warnings: [...new Set(warnings)],
      assembly: { additions: assembly.additions.length, overlays: assembly.overlays.length },
      job,
    });
  });

  app.post("/api/research/:id/import-images", async (req, res) => {
    const result = store.require("researchResults", req.params.id);
    const requested = Array.isArray(req.body?.articleIds) ? req.body.articleIds : result.articles.map((article) => article.id);
    const selected = result.articles.filter((article) => requested.includes(article.id) && article.imageUrl);
    const imported = [];
    for (const article of selected.slice(0, 12)) {
      const sourceUrl = new URL(article.imageUrl);
      if (!isPublicRemoteUrl(sourceUrl)) continue;
      const response = await fetchImpl(sourceUrl, {
        headers: { accept: "image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.2" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) continue;
      const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
      if (contentType && !contentType.startsWith("image/")) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) continue;
      const extension = imageExtension(sourceUrl, contentType);
      const temporary = path.join(store.root, "temp", `${randomUUID()}${extension}`);
      try {
        await fs.writeFile(temporary, bytes, { flag: "wx" });
        const media = await importMedia(store, temporary, {
          projectId: result.projectId,
          name: `${article.title.slice(0, 80)}${extension}`,
          move: true,
          mediaType: "news-editorial",
        });
        imported.push({ articleId: article.id, mediaId: media.id });
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    }
    const imageMediaIds = [...new Set([...(result.imageMediaIds || []), ...imported.map((item) => item.mediaId)])];
    const updated = store.patch("researchResults", result.id, { imageMediaIds });
    res.status(201).json({ result: updated, imported });
  });

  app.post("/api/research", async (req, res) => {
    const result = await service.research(req.body, store);
    res.status(201).json(result);
  });
}

function isPublicRemoteUrl(url) {
  if (!["http:", "https:"].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) return false;
  if (/^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
  return true;
}

function imageExtension(url, contentType) {
  const byType = { "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp" };
  if (byType[contentType.split(";")[0]]) return byType[contentType.split(";")[0]];
  const ext = path.extname(url.pathname).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].includes(ext) ? ext : ".jpg";
}

export { DEFAULT_FEEDS, fallbackContent, normalizeLlmContent, publicLlmSettings };
