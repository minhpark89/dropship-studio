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
    for (const batch of store.state.productionBatches) {
      let interrupted = false;
      for (const item of batch.items) {
        const job = store.state.jobs.find(job => job.production?.batchId === batch.id && job.production.itemIndex === item.index);
        if (job) { item.jobId = job.id; item.status = "queued"; }
        else if (["pending", "preparing"].includes(item.status)) { item.status = "interrupted"; interrupted = true; }
      }
      if (interrupted) batch.status = "interrupted";
    }
    store.save();
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
      if (!item.jobId && ["failed", "interrupted"].includes(item.status)) { item.status = "pending"; item.error = null; }
    }
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
        if ((request.contentType === "news" || request.autoResearch) && !batch.sources.length) {
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
            this.store.save();
            try { await this.prepareItem(batch, item); }
            catch (error) {
              item.status = this.controller.signal.aborted ? "interrupted" : "failed";
              item.error = error instanceof StudioError ? error.message : "Could not prepare this video. Check the sources and LLM, then retry.";
            }
            this.store.save();
          }
        };
        await Promise.all([work(),work()]);
      } catch (error) {
        for (const item of batch.items.filter(item => item.status === "pending")) {
          item.status = this.controller.signal.aborted ? "interrupted" : "failed";
          item.error = error instanceof StudioError ? error.message : "Research failed. Check the source feed and try again.";
        }
      }
      batch.status = this.controller.signal.aborted ? "interrupted" : batch.items.every(item => item.jobId) ? "queued" : batch.items.some(item => item.jobId) ? "partial" : "failed";
      this.store.save();
    }
  }

  async prepareItem(batch, item) {
    const request = batch.request;
    const source = batch.sources.length ? batch.sources[item.index % batch.sources.length] : null;
    let research = item.researchId ? this.store.require("researchResults", item.researchId) : null;
    if (request.contentType === "news" && !research) {
      research = await this.research.research({projectId:request.projectId,topic:source.title.slice(0,200),niche:`${request.topic} · video ${item.index + 1}`,language:"en",maxArticles:1},this.store,{articles:[source]});
      if (research.warnings?.some(warning=>warning.includes("LLM"))) throw new StudioError("Research LLM failed. Test the saved model, then retry.","LLM_FAILED",502);
      item.researchId = research.id;
      this.store.save();
    }
    let newsPlan = null;
    if (request.contentType === "news" && request.engine !== "preview") {
      const callLlm = (_store, system, input) => this.llm(system, input);
      const narration = await writeNewsNarration(this.store, research, { llm: callLlm });
      let candidates = newsImageCandidates(research.articles, research.imageSearchResults || []);
      if (candidates.length < 2) {
        const found = await this.imageSearch([...narration.imageQueries, ...(research.imageQueries || [])], { fetchImpl: this.fetch, maxResultsPerQuery: 4, maxResults: 20 });
        candidates = newsImageCandidates(research.articles, found.images);
        this.store.patch("researchResults", research.id, { imageSearchResults: found.images, imageSearchWarnings: found.warnings });
      }
      const ranked = await rankNewsImages(this.store, research, candidates, { llm: callLlm });
      const assets = [];
      const existing = this.store.state.media.filter((media) => media.projectId === request.projectId && media.kind === "image");
      for (const image of ranked.slice(0, 5)) {
        const cached = existing.find((media) => media.sourceUrl && media.sourceUrl === (image.pageUrl || image.imageUrl));
        if (cached) { assets.push(cached); continue; }
        try { assets.push(await this.downloadImage({ image, store: this.store, projectId: request.projectId, fetchImpl: this.fetch })); }
        catch { /* keep the remaining verified article images */ }
      }
      if (!assets.length) throw new StudioError("No usable editorial images were found. Retry with another niche.", "IMAGE_SEARCH_EMPTY", 422);
      this.store.patch("researchResults", research.id, { imageMediaIds: assets.map((media) => media.id) });
      newsPlan = newsPlanSchema.parse({ ...narration, imageMediaIds: assets.map((media) => media.id), selectedImageIds: ranked.map((image) => image.id) });
      item.title = newsPlan.headline;
      item.newsPlan = newsPlan;
      this.store.save();
    } else if (!item.prompt) {
      if (research) {
        item.title = research.headline;
        item.prompt = `Create a vertical news video for a US audience. Use American English narration and captions. Explain only the supplied verified facts. Use relevant editorial visuals and a professional presenter; do not impersonate a real broadcaster or use its logo.\n${research.headline}\n${research.script}\nSource: ${source?.source || ""}. Version ${item.index+1}: vary the opening shot and pacing.`;
      } else {
        const generated = productOutput.parse(await this.llm(
          "Create one product video concept. Return productName, productBrief and prompt. If researching, select a real product or product category mentioned in the supplied report. If no product is supported, return an empty productName. Never invent prices, discounts, performance claims, customer experiences or availability. For a supplied product, use only the brief and reference images. Each variation must change the hook, shots, and pacing. Include a simple CTA without invented offers.",
          {productName:request.productName,productBrief:request.productBrief,source,variation:item.index+1,total:request.count,duration:request.duration,ratio:request.ratio},
        ));
        item.title = generated.productName;
        item.productBrief = generated.productBrief;
        item.prompt = `${generated.prompt}\nAll speech, captions and calls to action must be American English. Preserve the supplied product's appearance.`;
      }
      this.store.save();
    }
    this.controller.signal.throwIfAborted();
    const production = {batchId:batch.id,itemIndex:item.index,contentType:request.contentType,researchId:item.researchId,topic:request.topic,title:item.title,productBrief:item.productBrief || request.productBrief,productUrl:request.productUrl,sources:source?[source]:[]};
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
      const assembly = buildResearchAssemblyTimeline({...defaultTimeline(),quality:"draft"},assets.slice(0,5),research,undefined,{template:"news-short"});
      this.controller.signal.throwIfAborted();
      job = this.queue.enqueueRender({projectId:request.projectId,name:`News · ${item.title}`,timeline:assembly.timeline},{production});
    } else if (request.contentType === "news") {
      job = this.queue.enqueueNews({ projectId: request.projectId, accountId: request.accountId, name: `News · ${newsPlan.headline}`, plan: newsPlan, imageMediaIds: newsPlan.imageMediaIds, production });
    } else {
      job = this.queue.enqueueGeneration({projectId:request.projectId,provider:"dreamface",accountId:request.accountId,kind:"video",mode:request.references.length?"reference":"text",model:"DreamFace video",duration:request.duration,ratio:request.ratio,prompts:[item.prompt],references:request.references,autoAssemble:false},{production})[0];
    }
    item.jobId = job.id;
    item.status = "queued";
    item.error = null;
  }

  async close() {
    this.controller.abort();
    await this.worker;
  }
}

export function mountProductionRoutes(app, store, queue, options = {}) {
  const service = new ProductionService(store,queue,options);
  app.post("/api/production/batches",(req,res)=>res.status(202).json(service.create(req.body)));
  app.post("/api/production/batches/:id/retry",(req,res)=>res.status(202).json(service.retry(req.params.id)));
  return service;
}
