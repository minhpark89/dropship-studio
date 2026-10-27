import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { createContentFromMedia, generateContent, inferResearchId, mediaContentType, mountContentRoutes } from "../server/content.js";
import { mountSocialRoutes } from "../server/social.js";

async function fixture(t,options={}) {
  const root=path.resolve(".verification",`content-generation-${randomUUID()}`);
  const store=new Store(root),project=store.createProject("Content QA");
  const app=express();app.use(express.json());mountSocialRoutes(app,store);mountContentRoutes(app,store,options);
  app.use((error,req,res,next)=>res.status(error.status || 400).json({code:error.code,error:error.message}));
  const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const request=(route,data,method="POST")=>fetch(base+route,{method,headers:{"content-type":"application/json"},body:JSON.stringify(data)});
  return {store,project,request};
}

test("legacy News renders are classified and linked back to their saved research", () => {
  const store = { state: { researchResults: [
    { id: "research-news", projectId: "project-1", headline: "Trump rallies Michigan Republicans in Port Huron", articles: [{ title: "Port Huron rally draws crowd" }] },
    { id: "research-other", projectId: "project-1", headline: "Weather update for California", articles: [] },
  ] } };
  const media = { projectId: "project-1", name: "News · Trump rallies Michigan Republicans in Port Huron.mp4", production: null };
  assert.equal(mediaContentType(media), "news");
  assert.equal(inferResearchId(store, media), "research-news");
  assert.equal(mediaContentType({ name: "Product · travel mug.mp4", production: null }), "product");
});

test("product content creates only a first comment and appends the configured store link",async t=>{
  let calls=0;
  const options={llm:async()=>{calls++;return {title:"Travel mug",firstComment:"See the mug here: https://invented.example/offer"};}};
  const {store,project}=await fixture(t,options);
  store.state.settings.content.storeUrl="https://shop.example/mug";
  const draft=await generateContent(store,{projectId:project.id,contentType:"product",title:"Travel mug"},options);
  assert.equal(draft.articleBody,"");assert.equal(draft.caption,"");
  assert.match(draft.firstComment,/https:\/\/shop.example\/mug/);
  assert.doesNotMatch(draft.firstComment,/invented.example/);
  store.state.settings.content.storeUrl="";
  const withoutLink=await generateContent(store,{projectId:project.id,contentType:"product"},options);
  assert.equal(withoutLink.linkUrl,"");
  assert.doesNotMatch(withoutLink.firstComment,/https?:\/\//);
  assert.equal(calls,2);
});

test("news content keeps the article separate, cites the actual research and requires Page assignment only at approval",async t=>{
  let calls=0;
  const article="A new report describes the confirmed launch.\n\n## What happened\nThe agency announced the mission and explained its purpose. The report offers no further timing details, and no additional claims are included here.";
  const options={articleReader:async()=>"Confirmed launch details from the source.",llm:async(system,input)=>{calls++;assert.match(system,/Ground every claim/);assert.equal(input.sources[0].text,"Confirmed launch details from the source.");return {title:"Agency reports launch",caption:"What the agency confirmed today.",articleBody:article};}};
  const {store,project,request}=await fixture(t,options);
  store.state.settings.content.articleWebsiteUrl="https://news.example/article";
  const research=store.add("researchResults",{projectId:project.id,topic:"Space",headline:"Agency launch",articles:[{title:"Launch confirmed",source:"Agency",url:"https://agency.example/report",summary:"Launch details"}]});
  const media=store.add("media",{projectId:project.id,kind:"video",generated:true,production:{contentType:"news",researchId:research.id}});
  const response=await request(`/api/content/from-media/${media.id}`,{});
  assert.equal(response.status,201);
  const post=await response.json();
  assert.equal(post.pageId,"");assert.equal(post.status,"draft");
  assert.match(post.articleBody,/https:\/\/agency.example\/report/);
  assert.notEqual(post.articleBody,post.caption);
  assert.equal(post.firstComment,"Read the full article: https://news.example/article");
  const repeated=await (await request(`/api/content/from-media/${media.id}`,{})).json();
  assert.equal(repeated.id,post.id);assert.equal(calls,1);
  const approve=await request(`/api/social/posts/${post.id}`,{revision:1,status:"ready"},"PATCH");
  assert.equal(approve.status,409);assert.equal((await approve.json()).code,"PAGE_REQUIRED");
  const page=store.add("socialPages",{name:"News",archived:false});
  const approved=await (await request(`/api/social/posts/${post.id}`,{revision:1,pageId:page.id,status:"ready"},"PATCH")).json();
  // Export without a binary attachment to exercise the article artifact.
  store.require("socialPosts",post.id).mediaIds=[];
  const exported=await (await request(`/api/social/posts/${post.id}/export`,{revision:approved.revision})).json();
  assert.ok(exported.files.some(file=>file.name==="article.md"));
  const saved=await fs.readFile(path.join(store.root,"exports","posts",post.id,String(approved.revision),"article.md"),"utf8");
  assert.match(saved,/What happened/);
});

test("Content rejects research and videos from another project before calling the LLM",async t=>{
  const {store,project}=await fixture(t);
  const other=store.createProject("Other");
  const research=store.add("researchResults",{projectId:other.id,articles:[]});
  const media=store.add("media",{projectId:other.id,kind:"video"});
  const options={llm:async()=>assert.fail("Cross-project sources reached the LLM")};
  await assert.rejects(()=>generateContent(store,{projectId:project.id,contentType:"news",researchId:research.id},options),error=>error.code==="RESEARCH_PROJECT_MISMATCH");
  await assert.rejects(()=>generateContent(store,{projectId:project.id,contentType:"product",mediaId:media.id},options),error=>error.code==="MEDIA_PROJECT_MISMATCH");
});

test("news render automation leaves a Content error that can be regenerated", async t => {
  let fail = false;
  const options = {
    articleReader: async () => "Officials confirmed the reported development.",
    llm: async () => {
      if (fail) throw new Error("LLM temporarily unavailable");
      return { title: "Verified news update", caption: "A verified update.", articleBody: "The report confirms the development and provides additional context for readers. Officials said the available evidence supports the update, while the published source contains the details readers should review before drawing further conclusions." };
    },
  };
  const { store, project, request } = await fixture(t, options);
  store.state.settings.content.articleWebsiteUrl = "https://news.example.test";
  const research = store.add("researchResults", {
    projectId: project.id,
    headline: "Verified news update",
    script: "Officials confirmed the reported development.",
    articles: [{ title: "Verified source", source: "Agency", url: "https://agency.example.test/story", summary: "Confirmed details" }],
  });
  const media = store.add("media", { projectId: project.id, kind: "video", generated: true, name: "News broadcast.mp4", production: { contentType: "news", researchId: research.id, title: research.headline } });
  const post = await createContentFromMedia(store, media.id, { source: "news-render", options });
  assert.equal(post.automationStatus, "generated");
  assert.equal(post.automationError, null);
  fail = true;
  const regenerated = await (await request(`/api/content/posts/${post.id}/regenerate`, {})).json();
  assert.equal(regenerated.id, post.id);
  assert.equal(regenerated.automationStatus, "error");
  assert.match(regenerated.automationError, /LLM temporarily unavailable/);
  assert.match(regenerated.firstComment, /https:\/\/news\.example\.test/);
});

test("news content carries a public research illustration into the article", async t => {
  const options = {
    articleReader: async () => "Confirmed launch details from the source.",
    llm: async () => ({ title: "Agency reports launch", caption: "A verified update.", articleBody: "The report confirms the development and gives readers enough context to understand what happened without adding unsupported claims." }),
  };
  const { store, project } = await fixture(t, options);
  store.state.settings.content.articleWebsiteUrl = "https://news.example/article";
  const research = store.add("researchResults", {
    projectId: project.id,
    topic: "Space",
    headline: "Agency launch",
    articles: [{ title: "Launch confirmed", source: "Agency", url: "https://agency.example/report", summary: "Launch details", imageUrl: "https://images.example/launch.jpg" }],
  });
  const media = store.add("media", { projectId: project.id, kind: "video", generated: true, production: { contentType: "news", researchId: research.id } });
  const post = await createContentFromMedia(store, media.id, { source: "news-render", options });
  assert.equal(post.coverImageUrl, "https://images.example/launch.jpg");
  assert.match(post.articleBody, /!\[News illustration\]\(https:\/\/images\.example\/launch\.jpg\)/);
});

test("news content places multiple verified research images throughout the article", async t => {
  const options = {
    articleReader: async () => "The source confirms the event and its location.",
    llm: async () => ({
      title: "Agency reports launch",
      caption: "A verified update.",
      articleBody: "The report confirms the development and gives readers enough context to understand what happened.\n\n## What happened\nThe available report describes the event and identifies the people involved.\n\n## What remains unknown\nThe source does not provide every detail, so readers should follow the original coverage.",
    }),
  };
  const { store, project } = await fixture(t, options);
  store.state.settings.content.articleWebsiteUrl = "https://news.example/article";
  const research = store.add("researchResults", {
    projectId: project.id,
    topic: "Space",
    headline: "Agency launch",
    articles: [{ title: "Launch confirmed", source: "Agency", url: "https://agency.example/report", summary: "Launch details" }],
    imageSearchResults: [
      { id: "image-1", imageUrl: "https://images.example/one.jpg", title: "Launch site" },
      { id: "image-2", imageUrl: "https://images.example/two.jpg", title: "Agency briefing" },
      { id: "image-3", imageUrl: "https://images.example/three.jpg", title: "Mission hardware" },
    ],
  });
  const media = store.add("media", { projectId: project.id, kind: "video", generated: true, production: { contentType: "news", researchId: research.id } });
  const post = await createContentFromMedia(store, media.id, { source: "news-render", options });
  assert.equal(post.coverImageUrl, "https://images.example/one.jpg");
  assert.equal((post.articleBody.match(/!\[[^\]]*\]\(https:\/\/images\.example\//g) || []).length, 3);
  assert.match(post.articleBody, /Agency briefing/);
  assert.match(post.articleBody, /Mission hardware/);
  assert.ok(post.articleBody.indexOf("## Sources") > post.articleBody.indexOf("Mission hardware"));
});

test("published news content can repair missing inline images before a revision publish", async t => {
  const { store, project, request } = await fixture(t);
  const research = store.add("researchResults", {
    projectId: project.id,
    topic: "Space",
    headline: "Agency launch",
    articles: [{ title: "Launch confirmed", source: "Agency", url: "https://agency.example/report", summary: "Launch details" }],
    imageSearchResults: [
      { id: "image-1", imageUrl: "https://images.example/one.jpg", title: "Launch site" },
      { id: "image-2", imageUrl: "https://images.example/two.jpg", title: "Agency briefing" },
      { id: "image-3", imageUrl: "https://images.example/three.jpg", title: "Mission hardware" },
    ],
  });
  const post = store.add("socialPosts", {
    projectId: project.id,
    contentType: "news",
    title: "Agency launch",
    caption: "Verified update",
    articleBody: "The report confirms the launch.\n\n![News illustration](https://images.example/one.jpg)\n\n## Sources\n- [Agency](https://agency.example/report)",
    coverImageUrl: "https://images.example/one.jpg",
    researchId: research.id,
    mediaIds: [],
    status: "draft",
    revision: 1,
    website: { status: "published", contentHash: "old", url: "https://news.example/blog/agency-launch" },
  });
  const response = await request(`/api/content/posts/${post.id}/repair-images`, { revision: 1 });
  assert.equal(response.status, 200);
  const repaired = await response.json();
  assert.equal((repaired.articleBody.match(/!\[[^\]]*\]\(https:\/\/images\.example\//g) || []).length, 3);
  assert.equal(repaired.website.contentChanged, true);
  assert.equal(repaired.revision, 2);
});

test("published News can sync its verified website URL into the exact first comment", async t => {
  const { store, project, request } = await fixture(t);
  const post = store.add("socialPosts", {
    projectId: project.id,
    contentType: "news",
    title: "Verified report",
    articleBody: "A verified report.",
    firstComment: "Read the old link: https://old.example/article",
    website: { status: "published", url: "https://news.example/blog/verified-report" },
    mediaIds: [],
    status: "draft",
    revision: 1,
  });
  const response = await request(`/api/content/posts/${post.id}/sync-first-comment`, { revision: 1 });
  assert.equal(response.status, 200);
  const synced = await response.json();
  assert.equal(synced.firstComment, "Read the full article: https://news.example/blog/verified-report");
  assert.equal(synced.linkUrl, "https://news.example/blog/verified-report");
  assert.equal(synced.revision, 2);
});
