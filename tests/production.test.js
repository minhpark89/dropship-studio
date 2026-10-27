import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { JobQueue } from "../server/queue.js";
import { ProductionService } from "../server/production.js";
import { createResearchService } from "../server/research.js";

async function fixture(t, options={}) {
  const root=path.resolve(".verification",`production-${randomUUID()}`);
  const store=new Store(root);
  store.state.settings.llm.enabled=true;
  const project=store.createProject("Batch QA");
  const queue=new JobQueue(store,{}, {intervalMs:0});
  const service=new ProductionService(store,queue,options);
  t.after(async()=>{await service.close();await queue.close();await fs.rm(root,{recursive:true,force:true});});
  return {store,project,queue,service,root};
}

test("product batch creates exactly N independent videos and repeated submissions are idempotent",async t=>{
  const {store,project,service}=await fixture(t,{llm:async(_system,input)=>({productName:"Travel mug",productBrief:"Steel travel mug",prompt:`Create a clean travel mug demonstration, opening shot variation ${input.variation}.`})});
  const request={requestId:randomUUID(),projectId:project.id,contentType:"product",autoResearch:false,productName:"Travel mug",count:3};
  const batch=service.create(request);
  assert.equal(service.create(request).id,batch.id);
  await service.worker;
  assert.equal(store.state.jobs.length,3);
  assert.equal(new Set(store.state.jobs.map(job=>job.payload.prompt)).size,3);
  assert.ok(store.state.jobs.every(job=>job.payload.provider==="dreamface" && !job.payload.autoAssemble));
  assert.ok(store.state.jobs.every(job=>job.production.contentType==="product" && job.production.batchId===batch.id));
  assert.equal(batch.status,"queued");
  assert.throws(()=>service.create({...request,count:4}),error=>error.code==="REQUEST_CONFLICT");
});

test("a single product render is marked for automatic local assembly after DreamFace", async t => {
  const {store,project,service}=await fixture(t,{llm:async()=>({productName:"Travel mug",productBrief:"Steel travel mug",prompt:"Create a clean travel mug demonstration with one opening shot."})});
  const batch=service.create({requestId:randomUUID(),projectId:project.id,contentType:"product",autoResearch:false,productName:"Travel mug",count:1});
  await service.worker;
  const job=store.require("jobs",batch.items[0].jobId);
  assert.equal(job.payload.autoAssemble,true);
});

test("retry prepares only failed items and restart recovers already-enqueued item IDs",async t=>{
  let failed=false;
  const {store,project,service,queue,root}=await fixture(t,{llm:async(_system,input)=>{
    if(input.variation===2 && !failed){failed=true;throw new Error("temporary failure");}
    return {productName:"Desk lamp",productBrief:"Adjustable desk lamp",prompt:`Show a desk lamp, varied camera movement, version ${input.variation}.`};
  }});
  const batch=service.create({requestId:randomUUID(),projectId:project.id,contentType:"product",autoResearch:false,productName:"Desk lamp",count:3});
  await service.worker;
  assert.equal(batch.status,"partial");
  const firstJobs=store.state.jobs.map(job=>job.id);
  service.retry(batch.id); await service.worker;
  assert.equal(store.state.jobs.length,3);
  assert.ok(firstJobs.every(id=>store.state.jobs.some(job=>job.id===id)));
  batch.items[0].jobId=null;batch.items[0].status="preparing";store.save();
  const recoveredStore=new Store(root);
  const recovered=new ProductionService(recoveredStore,queue);
  assert.equal(recoveredStore.state.productionBatches[0].items[0].jobId,firstJobs[0]);
  await recovered.close();
});

test("restart preserves terminal production item and batch status from linked jobs", async t => {
  const { store, project, queue, root } = await fixture(t);
  const batch = store.add("productionBatches", {
    projectId: project.id,
    request: { requestId: randomUUID(), projectId: project.id, contentType: "news", count: 2 },
    status: "queued",
    items: [
      { index: 0, status: "queued", jobId: null, error: null },
      { index: 1, status: "queued", jobId: null, error: null },
    ],
  });
  const completed = store.add("jobs", {
    type: "news", projectId: project.id,
    production: { batchId: batch.id, itemIndex: 0 },
    payload: {}, status: "completed", progress: 100, mediaId: randomUUID(), error: null,
  });
  const failed = store.add("jobs", {
    type: "news", projectId: project.id,
    production: { batchId: batch.id, itemIndex: 1 },
    payload: {}, status: "failed", progress: 75, mediaId: null, error: "provider timeout", errorCode: "PROVIDER_TIMEOUT",
  });
  const restartedStore = new Store(root);
  const restartedQueue = new JobQueue(restartedStore, {}, { intervalMs: 0 });
  const restarted = new ProductionService(restartedStore, restartedQueue);
  t.after(async () => { await restarted.close(); await restartedQueue.close(); });
  const recovered = restartedStore.require("productionBatches", batch.id);
  assert.equal(recovered.items[0].jobId, completed.id);
  assert.equal(recovered.items[0].status, "completed");
  assert.equal(recovered.items[1].jobId, failed.id);
  assert.equal(recovered.items[1].status, "failed");
  assert.equal(recovered.items[1].errorCode, "PROVIDER_TIMEOUT");
  assert.equal(recovered.status, "partial");
});

test("news batch keeps each source paired with its own render and leaves the editor timeline unchanged",async t=>{
  const reports=[{title:"Space mission today",summary:"Launch confirmed",source:"Agency",url:"https://example.test/space"},{title:"Technology report today",summary:"New report published",source:"Agency",url:"https://example.test/tech"}];
  const research={discover:async()=>({articles:reports,warnings:[]}),research:async(request,store,{articles})=>store.add("researchResults",{projectId:request.projectId,topic:request.topic,headline:articles[0].title,script:"The source has published today's update.",articles,imageQueries:[articles[0].title],imageMediaIds:[],warnings:[]})};
  const {store,project,service}=await fixture(t,{research,imageSearch:async()=>({images:[{title:"News still"}]}),downloadImage:async({store,projectId})=>store.add("media",{projectId,kind:"image",file:"unused.png",duration:5})});
  service.queue={enqueueRender:({projectId,timeline},options)=>store.add("jobs",{type:"render",projectId,payload:{timeline},production:options.production,status:"queued"})};
  const original=structuredClone(project.timeline);
  const batch=service.create({requestId:randomUUID(),projectId:project.id,contentType:"news",topic:"today",count:2,engine:"preview"});
  await service.worker;
  assert.equal(batch.status,"queued");
  assert.equal(store.state.jobs.length,2);
  for(const [index,item] of batch.items.entries()) {
    const job=store.require("jobs",item.jobId);
    const source=store.require("researchResults",job.production.researchId);
    assert.equal(source.articles[0].url,reports[index].url);
    assert.ok(job.payload.timeline.texts.some(text=>text.text==="Source: Agency"));
  }
  assert.deepEqual(project.timeline,original);
});

test("news broadcast uses the research result selected in the UI", async t => {
  let discovered = 0;
  const {store, project, service} = await fixture(t, {
    research: {
      discover: async () => {
        discovered += 1;
        throw new Error("The selected research should avoid rediscovery.");
      },
      research: async () => {
        throw new Error("The selected research should be reused.");
      },
    },
    llm: async () => ({
      headline: "A verified Washington development",
      summary: "A verified development is drawing attention today. Officials say more details are expected as the debate continues.",
      imageQueries: ["Washington development"],
    }),
    imageSearch: async () => ({ images: [], warnings: [] }),
  });
  const image = store.add("media", {
    projectId: project.id,
    kind: "image",
    file: "unused.png",
    duration: 5,
    sourceUrl: "https://example.test/story",
  });
  const selected = store.add("researchResults", {
    projectId: project.id,
    topic: "Washington news",
    headline: "A verified Washington development",
    script: "Officials say more details are expected as the debate continues.",
    articles: [{
      id: randomUUID(),
      title: "A verified Washington development",
      summary: "A verified development is drawing attention today.",
      source: "Example News",
      url: "https://example.test/story",
      imageUrl: "https://example.test/editorial.jpg",
    }],
    imageQueries: ["Washington development"],
    imageSearchResults: [],
    imageMediaIds: [image.id],
    warnings: [],
  });
  service.queue = {
    enqueueNews: ({ projectId, plan, imageMediaIds, production }) => store.add("jobs", {
      type: "news",
      projectId,
      payload: { plan, imageMediaIds },
      production,
      status: "queued",
    }),
  };
  const batch = service.create({
    requestId: randomUUID(),
    projectId: project.id,
    contentType: "news",
    autoResearch: true,
    researchId: selected.id,
    topic: "Washington news",
    engine: "dreamface",
    count: 3,
  });
  await service.worker;
  assert.equal(discovered, 0);
  assert.equal(batch.status, "queued", JSON.stringify(batch.items));
  const jobs = batch.items.map((item) => store.require("jobs", item.jobId));
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every((job) => job.production.researchId === selected.id));
  assert.ok(jobs.every((job) => JSON.stringify(job.payload.imageMediaIds) === JSON.stringify(jobs[0].payload.imageMediaIds)));
  assert.ok(jobs.every((job) => job.payload.plan.source === "Example News"));
});

test("news batches can use a supplied article URL without running keyword discovery", async t => {
  let discovered = 0;
  let fetchedUrl = "";
  const { store, project, service } = await fixture(t, {
    fetchImpl: async (url) => {
      fetchedUrl = String(url);
      return new Response(`<!doctype html><html><head><title>Direct article headline</title><meta name="description" content="A supplied article summary with verified context." /><meta property="og:image" content="https://news.example.test/direct-story.jpg" /></head><body><main>Article body</main></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
    },
    research: {
      discover: async () => { discovered += 1; throw new Error("keyword discovery should not run for a direct link"); },
      research: async (request, localStore, { articles }) => localStore.add("researchResults", {
        projectId: request.projectId,
        topic: request.topic,
        niche: request.niche,
        language: "en",
        headline: articles[0].title,
        angle: "Direct source",
        script: articles[0].summary,
        articles: articles.map((article) => ({ ...article, id: randomUUID(), relevance: 1 })),
        imageQueries: [articles[0].title],
        imageSearchResults: [],
        imageMediaIds: [],
        warnings: [],
      }),
    },
    imageSearch: async () => ({ images: [], warnings: [] }),
    downloadImage: async ({ store: localStore, projectId, image }) => localStore.add("media", { projectId, kind: "image", file: "unused.jpg", imageUrl: image.imageUrl, sourceUrl: image.pageUrl || image.imageUrl, duration: 5 }),
  });
  service.queue = {
    enqueueRender: ({ projectId, timeline }, options) => store.add("jobs", { type: "render", projectId, payload: { timeline }, production: options.production, status: "queued" }),
  };
  const batch = service.create({
    requestId: randomUUID(),
    projectId: project.id,
    contentType: "news",
    topic: "",
    sourceUrl: "https://news.example.test/direct-story",
    count: 1,
    engine: "preview",
  });
  await service.worker;
  assert.equal(fetchedUrl, "https://news.example.test/direct-story");
  assert.equal(discovered, 0);
  assert.equal(batch.status, "queued", JSON.stringify(batch.items));
  assert.equal(store.require("researchResults", batch.items[0].researchId).articles[0].title, "Direct article headline");
});

test("news batch rotates the same story's editorial visuals and records each variation", async t => {
  const { store, project, service } = await fixture(t, {
    llm: async () => ({
      headline: "A verified development remains unresolved",
      summary: "Officials confirmed the development today, while the available report leaves the next step open for now.",
      imageQueries: ["city meeting", "official document", "public building"],
    }),
  });
  const images = ["city-meeting.jpg", "official-document.jpg", "public-building.jpg"].map((name) => store.add("media", {
    projectId: project.id,
    kind: "image",
    name,
    file: path.join(store.root, "media", name),
    sourceUrl: `https://images.example.test/${name}`,
    duration: 5,
  }));
  const research = store.add("researchResults", {
    projectId: project.id,
    topic: "verified development",
    headline: "A verified development remains unresolved",
    script: "Officials confirmed the development today, while the available report leaves the next step open for now.",
    articles: [{ id: randomUUID(), title: "Verified report", summary: "Officials confirmed the development.", source: "Example News", url: "https://example.test/report" }],
    imageQueries: ["city meeting", "official document", "public building"],
    imageSearchResults: [],
    imageMediaIds: images.map((image) => image.id),
    warnings: [],
  });
  service.queue = {
    enqueueNews: ({ projectId, plan, imageMediaIds, production }) => store.add("jobs", {
      type: "news", projectId, payload: { plan, imageMediaIds }, production, status: "queued",
    }),
  };
  const batch = service.create({
    requestId: randomUUID(),
    projectId: project.id,
    contentType: "news",
    autoResearch: true,
    researchId: research.id,
    topic: research.topic,
    engine: "dreamface",
    count: 3,
    variationPolicy: "visual-unique",
  });
  await service.worker;
  const jobs = batch.items.map((item) => store.require("jobs", item.jobId));
  assert.equal(new Set(jobs.map((job) => JSON.stringify(job.payload.imageMediaIds))).size, 3);
  assert.deepEqual(jobs.map((job) => job.payload.plan.visualVariant), [1, 2, 3]);
  assert.ok(jobs.every((job) => job.production.variationPolicy === "visual-unique"));
});

test("auto research excludes stale stories using the US Eastern date",async()=>{
  const rss='<rss><channel><title>Tech</title><item><title>Space current</title><link>https://example.test/current</link><pubDate>Sun, 25 Oct 2026 05:00:00 GMT</pubDate></item><item><title>Space yesterday in New York</title><link>https://example.test/old</link><pubDate>Sun, 25 Oct 2026 02:00:00 GMT</pubDate></item></channel></rss>';
  const service=createResearchService({now:()=>"2026-10-25T12:00:00Z",fetchImpl:async()=>new Response(rss)});
  const {articles}=await service.discover({topic:"space",count:5});
  assert.deepEqual(articles.map(article=>article.url),["https://example.test/current"]);
  await assert.rejects(()=>service.discover({topic:"unrelated",count:5}),error=>error.code==="NO_CURRENT_NEWS");
});

test("completed jobs attach source context to Library videos and retries preserve it",async t=>{
  const {store,project,queue}=await fixture(t);
  const context={contentType:"product",title:"Travel mug"};
  const [job]=queue.enqueueGeneration({projectId:project.id,provider:"dreamface",model:"DreamFace video",duration:10,ratio:"9:16",prompts:["A travel mug demo"],contentContext:context});
  queue.generateDreamFace=async()=>store.add("media",{projectId:project.id,kind:"video",generated:true});
  await queue.execute(job,null,new AbortController());
  assert.equal(job.status,"completed");
  assert.equal(store.require("media",job.mediaId).production.title,"Travel mug");
});
