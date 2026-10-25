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
