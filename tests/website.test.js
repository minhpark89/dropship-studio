import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {Store} from "../server/store.js";
import {SecretStore} from "../server/secret-store.js";
import {WebsiteService,articleHtml} from "../server/website.js";
import {createDreamFaceSlots,normalizeProxy,parseProxy,saveDreamFaceCredentials} from "../server/dreamface-accounts.js";

async function fixture(t,options={}) {
  const root=path.resolve(".verification",`website-${randomUUID()}`),store=new Store(root);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const calls=[];const createdUrls=new Set();
  const response=(url,text="",ok=true)=>({ok:()=>ok,url:()=>`https://news.example${url}`,text:async()=>text});
  const context={
    get:async(url)=>{
      calls.push({method:"GET",url});
      if(url==="/login")return response(url,'<meta name="csrf-token" content="login-csrf">');
      if(url==="/admin/dashboard")return response(url,'<meta name="csrf-token" content="admin-csrf">');
      if(url.includes("/blog/")){await options.beforeProbe?.(store);const exists=createdUrls.has(url);return response(url,exists?'<h1>News &amp; facts</h1>':"",exists);}
      return response(url,'{"data":[]}');
    },
    post:async(url,payload)=>{
      calls.push({method:"POST",url,payload});
      if(url==="/admin/api/v1/posts"){
        if(options.failCreate)throw new Error("Network interrupted");
        await options.onCreate?.(store);createdUrls.add(`https://news.example/blog/${payload.data.slug}`);
      }
      return response(url,'{}');
    },dispose:async()=>{},
  };
  const service=new WebsiteService(store,{requestFactory:{newContext:async()=>context},sources:options.sources});
  service.save({id:"test",name:"News",provider:"legacy",baseUrl:"https://news.example/",username:"editor",password:"private-password"});
  const post=store.add("socialPosts",{title:"News & facts",caption:"Daily briefing",articleBody:"## Facts\n\nThe report confirms the news.",contentType:"news",status:"draft",revision:1,firstComment:"",coverImageUrl:""});
  return {root,store,service,post,calls};
}

test("website credentials are encrypted outside snapshots; import keeps source configuration unchanged",async t=>{
  const f=await fixture(t);
  assert.doesNotMatch(JSON.stringify(f.store.publicSnapshot()),/private-password/);
  const encrypted=await fs.readFile(path.join(f.root,".private","website-test.json"),"utf8");
  assert.doesNotMatch(encrypted,/private-password/);
  const secrets=new SecretStore(f.root);
  assert.equal(secrets.get("website-test").password,"private-password");
  f.service.save({id:"test",name:"Changed",baseUrl:"https://news.example",username:"editor"});
  assert.equal(secrets.get("website-test").password,"private-password");
  const source=path.join(f.root,"source.json");const content=JSON.stringify({base_url:"https://news.example",username:"writer",password:"import-password"});
  await fs.writeFile(source,content);
  f.service.sources.highlight={file:source,name:"Highlight",provider:"cms"};
  const imported=await f.service.import("highlight");
  assert.equal(imported.hasPassword,true);assert.equal(imported.password,undefined);
  assert.equal(await fs.readFile(source,"utf8"),content);
  assert.throws(()=>secrets.get("../outside"),/Invalid secret/);
});

test("website connection test discovers migrated CMS without creating an article",async t=>{
  const {service,calls}=await fixture(t);
  assert.equal((await service.test("test")).ok,true);
  assert.equal(service.selected().provider,"cms");
  assert.deepEqual(calls.filter(call=>call.method==="POST").map(call=>call.url),["/login"]);
  assert.ok(calls.some(call=>call.url==="/admin/api/v1/posts?per_page=1"));
});

test("explicit website publishing preserves the article, sets exact first comment URL and does not duplicate on retry",async t=>{
  const {service,post,calls}=await fixture(t);
  const result=await service.publish(post.id,{revision:1});
  assert.equal(result.website.status,"published");
  assert.match(result.linkUrl,/^https:\/\/news.example\/blog\/news-facts-/);
  assert.equal(result.firstComment,`Read the full article: ${result.linkUrl}`);
  assert.equal(result.revision,2);assert.equal(result.status,"draft");
  await service.publish(post.id,{revision:2});
  const sent=calls.filter(call=>call.url==="/admin/api/v1/posts");assert.equal(sent.length,1);
  assert.match(sent[0].payload.data.description,/<h2>Facts<\/h2>/);
  assert.equal(sent[0].payload.headers["X-CSRF-TOKEN"],"admin-csrf");
  assert.doesNotMatch(articleHtml('<script>alert(1)</script>\n\n[Source](https://news.example/a)\n\n[bad](javascript:alert(1))'),/<script>|href="javascript:/);
});

test("force revision publishing creates a new verified URL after repairing article content", async t => {
  const { service, post, calls } = await fixture(t);
  const first = await service.publish(post.id, { revision: 1 });
  const firstUrl = first.website.url;
  const current = service.store.require("socialPosts", post.id);
  current.articleBody += "\n\n![News image](https://images.example/second.jpg)";
  current.revision += 1;
  const second = await service.publish(post.id, { revision: current.revision, forceRevision: true });
  assert.equal(second.website.status, "published");
  assert.match(second.website.url, /-r3$/);
  assert.notEqual(second.website.url, firstUrl);
  assert.equal(calls.filter(call => call.url === "/admin/api/v1/posts").length, 2);
});

test("website publishing sends the verified research illustration to the article",async t=>{
  const {service,post,calls}=await fixture(t);
  post.coverImageUrl="https://images.example/news.jpg";
  post.articleBody="![News illustration](https://images.example/news.jpg)\n\n## Facts\n\nThe report confirms the news.";
  const result=await service.publish(post.id,{revision:post.revision});
  assert.equal(result.website.status,"published");
  const sent=calls.find(call=>call.url==="/admin/api/v1/posts");
  assert.equal(sent.payload.data.image,"https://images.example/news.jpg");
  assert.match(sent.payload.data.description,/<img src="https:\/\/images.example\/news.jpg"/);
});

test("editing during authentication blocks stale publication before any external article is created",async t=>{
  let changed=false;
  const f=await fixture(t,{beforeProbe:store=>{if(!changed){changed=true;store.state.socialPosts[0].revision++;}}});
  await assert.rejects(f.service.publish(f.post.id,{revision:1}),error=>error.code==="STALE_REVISION");
  assert.equal(f.calls.filter(call=>call.url==="/admin/api/v1/posts").length,0);
});

test("unknown create result cannot be resubmitted automatically",async t=>{
  const {service,post,calls}=await fixture(t,{failCreate:true});
  await assert.rejects(service.publish(post.id,{revision:1}),/Network interrupted/);
  await assert.rejects(service.publish(post.id,{revision:1}),error=>error.code==="WEBSITE_UNCONFIRMED");
  assert.equal(calls.filter(call=>call.url==="/admin/api/v1/posts").length,1);
});

test("DreamFace profiles generate distinct persisted credentials and stay unverified until connection",async t=>{
  const {store}=await fixture(t);
  const accounts=createDreamFaceSlots(store,{count:3,namePrefix:"Render"});
  assert.equal(new Set(accounts.map(account=>account.email)).size,3);
  for(const account of accounts) {
    assert.match(account.email,/@gmail\.com$/);assert.equal(account.status,"needs_login");
    const credentials=saveDreamFaceCredentials(store,account);
    assert.ok(credentials.password.length>=32);
    assert.equal(credentials.email,account.email);
    assert.ok(!JSON.stringify(store.publicSnapshot()).includes(credentials.password));
  }
  assert.equal(createDreamFaceSlots(store,{count:1,namePrefix:"Render"})[0].name,"Render 04");
  const secret=new SecretStore(store.root);secret.delete(`dreamface-${accounts[0].id}`);
  assert.equal(secret.get(`dreamface-${accounts[0].id}`),null);
});

test("DreamFace bulk profiles keep one proxy per slot and reject ambiguous proxy lists",async t=>{
  const {store}=await fixture(t);
  const proxies=["127.0.0.1:8080","https://proxy.example:9443","socks5://127.0.0.1:1080"];
  const accounts=createDreamFaceSlots(store,{count:3,namePrefix:"Proxy",proxies});
  assert.deepEqual(accounts.map(account=>account.proxy),[
    "http://127.0.0.1:8080",
    "https://proxy.example:9443",
    "socks5://127.0.0.1:1080",
  ]);
  const shared=createDreamFaceSlots(store,{count:2,namePrefix:"Shared",proxies:["http://127.0.0.1:9000"]});
  assert.deepEqual(shared.map(account=>account.proxy),["http://127.0.0.1:9000","http://127.0.0.1:9000"]);
  assert.throws(()=>createDreamFaceSlots(store,{count:3,namePrefix:"Bad",proxies:["127.0.0.1:1","127.0.0.1:2"]}),error=>error.code==="INVALID_PROXY_LIST");
  assert.equal(normalizeProxy("http://user:password@127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.deepEqual(parseProxy("127.0.0.1:8080:user:password"), {
    server: "http://127.0.0.1:8080", username: "user", password: "password",
  });
});
