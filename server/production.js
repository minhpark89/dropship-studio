import { z } from "zod";
import { productionRequestSchema } from "../shared/production-contracts.js";
import { defaultTimeline } from "../shared/contracts.js";
import { buildResearchAssemblyTimeline } from "../shared/research-assembly.js";
import { createResearchService } from "./research.js";
import { requestJsonContent } from "./llm.js";
import { searchImageQueries, downloadImageAsset, newsImageCandidates } from "./image-search.js";
import { StudioError } from "./store.js";
import { newsPlanSchema, writeNewsNarration, rankNewsImages } from "./news-plan.js";

const productOutput = z.object({ productName: z.string().trim().min(1).max(200), productBrief: z.string().trim().min(1).max(4000), prompt: z.string().trim().min(20).max(16000) });

const VISUAL_VARIATION_DIRECTIVES = [
  "Open with a wide establishing shot, then make a slow left-to-right reveal.",
  "Open with a tight detail shot, then pull back to show the full product in use.",
  "Open with a top-down composition, then cut to a smooth handheld-style close-up.",
  "Open with a side profile and a gentle push-in, then finish on a clean hero frame.",
  "Open with a quick three-quarter angle, then use a measured orbit around the product.",
];

function productVariationDirective(index, total) {
  return `Render variation ${index} of ${total}. ${VISUAL_VARIATION_DIRECTIVES[(index - 1) % VISUAL_VARIATION_DIRECTIVES.length]} Keep the same verified content facts, but change the visual opening, shot order, camera path, background framing and pacing so this output is visibly different from the other variations.`;
}

function selectNewsVariant(ids, variation) {
  const source = [...new Set((ids || []).filter(Boolean))];
  if (source.length <= 1) return source;
  const offset = (Math.max(1, Number(variation) || 1) - 1) % source.length;
  const rotated = [...source.slice(offset), ...source.slice(0, offset)];
  return Math.max(1, Number(variation) || 1) % 2 === 0 ? rotated.reverse() : rotated;
}

function preparationMessage(error, fallback) {
  const message = String(error?.message || "").replace(/\s+/g, " ").trim();
  return message ? message.slice(0, 800) : fallback;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlText(value, max = 1200) {
  return decodeHtml(String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim().slice(0, max);
}

function htmlMeta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>|<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`, "i");
  const match = html.match(expression);
  return match?.[1] || match?.[2] || "";
}

async function articleFromUrl(fetchImpl, sourceUrl) {
  const response = await fetchImpl(sourceUrl, { headers: { accept: "text/html,application/xhtml+xml" } });
  if (!response.ok) throw new StudioError(`Could not load the news link (HTTP ${response.status}).`, "NEWS_SOURCE_FETCH_FAILED", 422);
  const html = (await response.text()).slice(0, 1_000_000);
  const title = htmlText(htmlMeta(html, "og:title") || html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1], 500);
  const summary = htmlText(htmlMeta(html, "og:description") || htmlMeta(html, "description") || html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || html, 4000);
  if (!title) throw new StudioError("The news link has no readable title.", "NEWS_SOURCE_EMPTY", 422);
  const source = new URL(sourceUrl).hostname.replace(/^www\./i, "");
  const candidateImage = htmlMeta(html, "og:image");
  let imageUrl = null;
  try {
    const parsed = new URL(candidateImage, sourceUrl);
    if (["http:", "https:"].includes(parsed.protocol)) imageUrl = parsed.toString();
  } catch { /* A missing or malformed og:image is fine; Wikimedia search can fill it. */ }
  return { title, summary, source, url: sourceUrl, publishedAt: null, imageUrl };
}

export class ProductionService {
  constructor(store, queue, { fetchImpl = globalThis.fetch, research, llm, imageSearch = searchImageQueries, downloadImage = downloadImageAsset } = {}) {
    this.store = store;
    this.queue = queue;
    this.controller = new AbortController();
    this.fetch = (url, options = {}) => fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal });
    this.research = research || createResearchService({ fetchImpl: this.fetch });
    this.llm = llm || ((system, input) => requestJsonContent(store, system, input, {fetchImpl:this.fetch}));
    this.imageSearch = imageSearch;
    this.downloadImage = downloadImage;
    this.worker = null;
    this.newsMediaPromises = new Map();
    this.syncTimer = null;
    this.onStoreChange = () => {
      if (this.syncTimer) return;
      this.syncTimer = setTimeout(() => {
        this.syncTimer = null;
        this.syncLinkedJobs();
      }, 0);
    };
    store.on("change", this.onStoreChange);
    for (const batch of store.state.productionBatches) {
      let interrupted = false;
      for (const item of batch.items) {
        const job = store.state.jobs.find(job => job.production?.batchId === batch.id && job.production.itemIndex === item.index);
        if (job) {
          // Rebuild the production view from the authoritative job state on
          // every server start.  The old recovery path marked every linked
          // item as queued, including jobs that had already completed or
          // failed, so the UI could keep showing stale queued batches after a
          // restart and lose the actual render outcome.
          item.jobId = job.id;
          if (job.status === "completed") {
            item.status = "completed";
            item.error = null;
            item.errorCode = null;
          } else if (["failed", "cancelled"].includes(job.status)) {
            item.status = "failed";
            item.error = job.error || "The linked job failed.";
            item.errorCode = job.errorCode || "JOB_FAILED";
          } else if (job.status === "interrupted") {
            item.status = "interrupted";
            item.error = job.error || "The linked job was interrupted.";
            item.errorCode = job.errorCode || "JOB_INTERRUPTED";
            interrupted = true;
          } else {
            item.status = job.status === "preparing" ? "preparing" : "queued";
            item.error = null;
            item.errorCode = null;
          }
        }
        else if (["pending", "preparing"].includes(item.status)) { item.status = "interrupted"; interrupted = true; }
      }
      if (interrupted) batch.status = "interrupted";
      else if (batch.items.every(item => item.status === "completed")) batch.status = "completed";
      else if (batch.items.some(item => ["failed", "interrupted"].includes(item.status))) batch.status = batch.items.some(item => item.jobId && !["failed", "interrupted"].includes(item.status)) ? "partial" : "failed";
      else if (batch.items.some(item => item.status === "preparing")) batch.status = "preparing";
      else if (batch.items.some(item => item.status === "queued")) batch.status = "queued";
    }
    store.save();
  }

  syncLinkedJobs() {
    let changed = false;
    for (const batch of this.store.state.productionBatches) {
      let interrupted = false;
      for (const item of batch.items) {
        const job = this.store.state.jobs.find((candidate) => candidate.production?.batchId === batch.id && candidate.production.itemIndex === item.index);
        if (!job) continue;
        const nextStatus = job.status === "completed"
          ? "completed"
          : ["failed", "cancelled"].includes(job.status)
            ? "failed"
            : job.status === "interrupted"
              ? "interrupted"
              : ["preparing"].includes(job.status)
                ? "preparing"
                : ["queued", "scheduled"].includes(job.status)
                  ? "queued"
                  : item.status;
        const nextError = ["failed", "interrupted"].includes(nextStatus) ? job.error || "The linked job failed." : null;
        const nextCode = ["failed", "interrupted"].includes(nextStatus) ? job.errorCode || "JOB_FAILED" : null;
        if (item.jobId !== job.id || item.status !== nextStatus || item.error !== nextError || item.errorCode !== nextCode) {
          Object.assign(item, { jobId: job.id, status: nextStatus, error: nextError, errorCode: nextCode });
          changed = true;
        }
        interrupted ||= nextStatus === "interrupted";
      }
      const nextBatchStatus = interrupted
        ? "interrupted"
        : batch.items.every((item) => item.status === "completed")
          ? "completed"
          : batch.items.some((item) => ["failed", "interrupted"].includes(item.status))
            ? batch.items.some((item) => item.jobId && !["failed", "interrupted"].includes(item.status)) ? "partial" : "failed"
            : batch.items.some((item) => item.status === "preparing")
              ? "preparing"
              : batch.items.some((item) => item.status === "queued")
                ? "queued"
                : batch.status;
      if (batch.status !== nextBatchStatus) {
        batch.status = nextBatchStatus;
        changed = true;
      }
    }
    if (changed) this.store.save();
  }

  create(input) {
    const request = productionRequestSchema.parse(input);
    const existing = this.store.state.productionBatches.find(batch => batch.request.requestId === request.requestId);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) throw new StudioError("This request was already used with different options.", "REQUEST_CONFLICT", 409);
      return existing;
    }
    this.store.require("projects", request.projectId);
    if (!this.store.state.settings.llm?.enabled) throw new StudioError("Enable and test the LLM in Settings first.", "LLM_DISABLED", 409);
    if (request.researchId) {
      const research = this.store.require("researchResults", request.researchId);
      if (research.projectId !== request.projectId)
        throw new StudioError("Use research from this project.", "RESEARCH_PROJECT_MISMATCH", 409);
    }
    for (const id of request.references) {
      const media = this.store.require("media", id);
      if (media.kind !== "image" || media.projectId && media.projectId !== request.projectId) throw new StudioError("Use product images from this project.", "INVALID_REFERENCE");
    }
    if (request.accountId !== "auto" && this.store.require("accounts", request.accountId).provider !== "dreamface") throw new StudioError("Select a DreamFace profile.", "INVALID_ACCOUNT");
    const batch = this.store.add("productionBatches", {
      projectId: request.projectId, request, status: "pending", sources: [], warnings: [],
      items: Array.from({length:request.count}, (_, index) => ({index,status:"pending",jobId:null,researchId:null,error:null})),
    });
    this.kick();
    return batch;
  }

  retry(id) {
    const batch = this.store.require("productionBatches", id);
    for (const item of batch.items) {
      if (!item.jobId && ["failed", "interrupted"].includes(item.status)) {
        item.status = "pending";
        item.error = null;
        item.errorCode = null;
      }
    }
    batch.error = null;
    batch.errorCode = null;
    if (batch.items.some(item => item.status === "pending")) batch.status = "pending";
    this.store.save();
    this.kick();
    return batch;
  }

  kick() {
    if (this.worker || this.controller.signal.aborted) return;
    this.worker = Promise.resolve().then(() => this.drain()).finally(() => { this.worker = null; });
  }

  async drain() {
    while (!this.controller.signal.aborted) {
      const batch = this.store.state.productionBatches.find(batch => batch.items.some(item => item.status === "pending"));
      if (!batch) return;
      const request = batch.request;
      batch.status = "preparing";
      this.store.save();
      try {
        if (request.sourceUrl && !batch.sources.length) {
          batch.sources = [await articleFromUrl(this.fetch, request.sourceUrl)];
          batch.warnings = [];
          this.store.save();
        } else if (request.researchId && !batch.sources.length) {
          const research = this.store.require("researchResults", request.researchId);
          batch.sources = research.articles || [];
          batch.warnings = research.warnings || [];
          this.store.save();
        } else if ((request.contentType === "news" || request.autoResearch) && !batch.sources.length) {
          const discovery = await this.research.discover({topic:request.topic,feeds:request.feeds,count:request.count});
          batch.sources = discovery.articles;
          batch.warnings = discovery.warnings;
          if (batch.sources.length < request.count) batch.warnings.push(`${batch.sources.length} current stories found; extra videos use different versions of these stories.`);
          this.store.save();
        }
        const work = async () => {
          while (!this.controller.signal.aborted) {
            const item = batch.items.find(item => item.status === "pending");
            if (!item) return;
            item.status = "preparing";
            item.error = null;
            item.errorCode = null;
            this.store.save();
            try { await this.prepareItem(batch, item); }
            catch (error) {
              item.status = this.controller.signal.aborted ? "interrupted" : "failed";
              item.errorCode = error?.code || "PREPARATION_FAILED";
              item.error = preparationMessage(error, "Could not prepare this video. Check the sources and LLM, then retry.");
            }
            this.store.save();
          }
        };
        // Keep News preparation's LLM calls in order. The provider render
        // jobs still run concurrently once queued, while this avoids sending
        // two long JSON generations and the shared image ranking request at
        // the same time to a gateway that may reject one of them.
        await Promise.all(request.contentType === "news" ? [work()] : [work(), work()]);
      } catch (error) {
        for (const item of batch.items.filter(item => item.status === "pending")) {
          item.status = this.controller.signal.aborted ? "interrupted" : "failed";
          item.errorCode = error?.code || "RESEARCH_FAILED";
          item.error = preparationMessage(error, "Research failed. Check the source feed and try again.");
        }
        batch.errorCode = error?.code || "RESEARCH_FAILED";
        batch.error = preparationMessage(error, "Research failed. Check the source feed and try again.");
      }
      batch.status = this.controller.signal.aborted ? "interrupted" : batch.items.every(item => item.jobId) ? "queued" : batch.items.some(item => item.jobId) ? "partial" : "failed";
      this.store.save();
    }
  }

  async prepareItem(batch, item) {
    const request = batch.request;
      const source = batch.sources.length ? batch.sources[item.index % batch.sources.length] : null;
    let research = item.researchId
      ? this.store.require("researchResults", item.researchId)
      : request.researchId
        ? this.store.require("researchResults", request.researchId)
        : null;
    if (research && !item.researchId) {
      item.researchId = research.id;
      this.store.save();
    }
    if (request.contentType === "news" && !research) {
      research = await this.research.research({projectId:request.projectId,topic:source.title.slice(0,200),niche:`${request.topic} · video ${item.index + 1}`,language:"en",maxArticles:1},this.store,{articles:[source]});
      if (research.warnings?.some(warning=>warning.includes("LLM"))) throw new StudioError("Research LLM failed. Test the saved model, then retry.","LLM_FAILED",502);
      item.researchId = research.id;
      this.store.save();
    }
    let newsPlan = null;
    if (request.contentType === "news" && request.engine !== "preview") {
      const callLlm = (_store, system, input) => this.llm(system, input);
      let narration;
      try {
        narration = await writeNewsNarration(this.store, research, {
          llm: callLlm,
          variation: item.index + 1,
          total: request.count,
        });
      } catch (error) {
        // A transient gateway timeout or malformed JSON should not make a
        // whole News batch disappear. Retry one LLM generation before the
        // preparation item is marked failed and shown to the user.
        if (!["LLM_FAILED", "LLM_INVALID_RESPONSE"].includes(error?.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 1200));
        narration = await writeNewsNarration(this.store, research, {
          llm: callLlm,
          variation: item.index + 1,
          total: request.count,
        });
      }
      const sharedMedia = await this.prepareNewsMedia(batch, request, research, narration, callLlm);
      newsPlan = newsPlanSchema.parse({
        ...narration,
        imageMediaIds: selectNewsVariant(sharedMedia.imageMediaIds, item.index + 1),
        selectedImageIds: sharedMedia.selectedImageIds,
        variation: item.index + 1,
        visualVariant: item.index + 1,
        fontStyle: request.fontStyle,
      });
      item.title = newsPlan.headline;
      item.newsPlan = newsPlan;
      this.store.save();
    } else if (!item.prompt) {
      if (research) {
        item.title = research.headline;
        item.prompt = `Create a vertical news video for a US audience. Use American English narration and captions. Explain only the supplied verified facts. Use relevant editorial visuals and a professional presenter; do not impersonate a real broadcaster or use its logo.\n${research.headline}\n${research.script}\nSource: ${source?.source || ""}. ${productVariationDirective(item.index + 1, request.count)}`;
      } else {
        const generated = productOutput.parse(await this.llm(
          "Create one product video concept. Return productName, productBrief and prompt. If researching, select a real product or product category mentioned in the supplied report. If no product is supported, return an empty productName. Never invent prices, discounts, performance claims, customer experiences or availability. For a supplied product, use only the brief and reference images. Each variation must change the hook, shots, and pacing. Include a simple CTA without invented offers.",
          {productName:request.productName,productBrief:request.productBrief,source,variation:item.index+1,total:request.count,duration:request.duration,ratio:request.ratio},
        ));
        item.title = generated.productName;
        item.productBrief = generated.productBrief;
        item.prompt = `${generated.prompt}\nAll speech, captions and calls to action must be American English. Preserve the supplied product's appearance.\n${productVariationDirective(item.index + 1, request.count)}`;
      }
      this.store.save();
    }
    this.controller.signal.throwIfAborted();
    const production = {
      batchId: batch.id,
      itemIndex: item.index,
      variation: item.index + 1,
      visualVariant: item.index + 1,
      variationPolicy: request.variationPolicy,
      autoCreateContent: request.autoCreateContent === true,
      presenterMode: request.contentType === "news" && request.accountId !== "auto" ? "same-account" : "auto-rotate",
      contentType: request.contentType,
      researchId: item.researchId,
      topic: request.topic,
      sourceUrl: request.sourceUrl,
      fontStyle: request.fontStyle,
      title: item.title,
      productBrief: item.productBrief || request.productBrief,
      productUrl: request.productUrl,
      sources: source ? [source] : [],
    };
    let job;
    if (request.engine === "preview") {
      if (!research) throw new StudioError("Preview mode is available for researched news only.", "RESEARCH_REQUIRED", 422);
      let assets = (research.imageMediaIds || []).map(id=>this.store.state.media.find(media=>media.id===id)).filter(Boolean);
      if (!assets.length) {
        const found = await this.imageSearch(research.imageQueries,{fetchImpl:this.fetch,maxResultsPerQuery:4,maxResults:16});
        for (const image of newsImageCandidates(research.articles,found.images).slice(0,5)) {
          try { assets.push(await this.downloadImage({image,store:this.store,projectId:request.projectId,fetchImpl:this.fetch})); }
          catch { /* A failed image can be skipped if another valid one is available. */ }
        }
        this.store.patch("researchResults",research.id,{imageMediaIds:assets.map(media=>media.id),imageSearchResults:found.images});
      }
      if (!assets.length) throw new StudioError("No usable editorial images were found. Retry with another niche.","IMAGE_SEARCH_EMPTY",422);
      const variantAssets = selectNewsVariant(assets.slice(0, 5).map((asset) => asset.id), item.index + 1).map((id) => assets.find((asset) => asset.id === id)).filter(Boolean);
      const assembly = buildResearchAssemblyTimeline({...defaultTimeline(),quality:"draft"},variantAssets,research,undefined,{template:"news-short"});
      this.controller.signal.throwIfAborted();
      job = this.queue.enqueueRender({projectId:request.projectId,name:`News · ${item.title}`,timeline:assembly.timeline},{production});
    } else if (request.contentType === "news") {
      job = this.queue.enqueueNews({ projectId: request.projectId, accountId: request.accountId, name: `News · ${newsPlan.headline}`, plan: newsPlan, imageMediaIds: newsPlan.imageMediaIds, production });
    } else {
      job = this.queue.enqueueGeneration({projectId:request.projectId,provider:"dreamface",accountId:request.accountId,kind:"video",mode:request.references.length?"reference":"text",model:"DreamFace video",duration:request.duration,ratio:request.ratio,prompts:[item.prompt],references:request.references,autoAssemble:request.count === 1},{production})[0];
    }
    item.jobId = job.id;
    item.status = "queued";
    item.error = null;
  }

  async prepareNewsMedia(batch, request, research, narration, callLlm) {
    const targetImageCount = 5;
    const savedResearchIds = Array.isArray(research.imageMediaIds) ? research.imageMediaIds : [];
    const cachedIds = [...new Set([
      ...(Array.isArray(batch.newsImageMediaIds) ? batch.newsImageMediaIds : []),
      ...savedResearchIds,
    ])].filter((id) => this.store.state.media.some((media) => media.id === id && media.kind === "image"));
    if (cachedIds.length >= targetImageCount) {
      batch.newsImageMediaIds = cachedIds.slice(0, 8);
      batch.newsSelectedImageIds ??= [];
      this.store.save();
      return {
        imageMediaIds: cachedIds.slice(0, targetImageCount),
        selectedImageIds: Array.isArray(batch.newsSelectedImageIds) ? batch.newsSelectedImageIds : [],
      };
    }
    const prior = this.newsMediaPromises.get(batch.id);
    if (prior) return prior;
    const promise = (async () => {
      let candidates = newsImageCandidates(research.articles, research.imageSearchResults || []);
      if (candidates.length < targetImageCount) {
        const found = await this.imageSearch(
          [...narration.imageQueries, ...(research.imageQueries || [])],
          { fetchImpl: this.fetch, maxResultsPerQuery: 4, maxResults: 20 },
        );
        candidates = newsImageCandidates(research.articles, found.images);
        this.store.patch("researchResults", research.id, {
          imageSearchResults: found.images,
          imageSearchWarnings: found.warnings,
        });
      }
      const ranked = await rankNewsImages(this.store, research, candidates, { llm: callLlm });
      const assets = cachedIds
        .map((id) => this.store.state.media.find((media) => media.id === id))
        .filter((media) => media?.kind === "image");
      const assetKeys = new Set(assets.map((media) => media.sourceUrl).filter(Boolean));
      const existing = this.store.state.media.filter((media) => media.projectId === request.projectId && media.kind === "image");
      for (const image of ranked.slice(0, 16)) {
        if (assetKeys.has(image.pageUrl || image.imageUrl)) continue;
        const cached = existing.find((media) => media.sourceUrl && media.sourceUrl === (image.pageUrl || image.imageUrl));
        if (cached) {
          assets.push(cached);
          assetKeys.add(cached.sourceUrl);
          if (assets.length >= 5) break;
          continue;
        }
        try {
          const media = await this.downloadImage({ image, store: this.store, projectId: request.projectId, fetchImpl: this.fetch });
          assets.push(media);
          if (media.sourceUrl) assetKeys.add(media.sourceUrl);
        } catch {
          // Keep the remaining verified article images.
        }
        if (assets.length >= 5) break;
      }
      const minimumImageCount = candidates.length >= 3 ? 3 : 1;
      if (assets.length < minimumImageCount) {
        throw new StudioError("News video needs at least three verified editorial images. Search returned too few usable images; retry with a broader topic.", "IMAGE_SEARCH_INSUFFICIENT", 422);
      }
      const imageMediaIds = assets.map((media) => media.id);
      const selectedImageIds = ranked.map((image) => image.id);
      batch.newsImageMediaIds = imageMediaIds;
      batch.newsSelectedImageIds = selectedImageIds;
      this.store.patch("researchResults", research.id, { imageMediaIds });
      this.store.save();
      return { imageMediaIds, selectedImageIds };
    })();
    this.newsMediaPromises.set(batch.id, promise);
    try {
      return await promise;
    } catch (error) {
      this.newsMediaPromises.delete(batch.id);
      throw error;
    }
  }

  async close() {
    this.controller.abort();
    await this.worker;
    this.store.off("change", this.onStoreChange);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.newsMediaPromises.clear();
  }
}

export function mountProductionRoutes(app, store, queue, options = {}) {
  const service = new ProductionService(store,queue,options);
  app.post("/api/production/batches",(req,res)=>res.status(202).json(service.create(req.body)));
  app.post("/api/production/batches/:id/retry",(req,res)=>res.status(202).json(service.retry(req.params.id)));
  return service;
}
