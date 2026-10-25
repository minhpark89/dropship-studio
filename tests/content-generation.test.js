import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { generateContent, mountContentRoutes } from "../server/content.js";
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
