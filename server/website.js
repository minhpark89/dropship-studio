import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { request } from "playwright";
import { z } from "zod";
import { SecretStore } from "./secret-store.js";
import { StudioError } from "./store.js";

export const websiteImportSources = {
  highlight: {name:"Highlight website",provider:"cms",file:"D:/Highlight_Studio_Video/app/config/website_config.json"},
  longform: {name:"Longform website",provider:"legacy",file:"D:/LongForm_Studio_Video/Longform Studio/Longform Studio/data/data/registry/website_config.json"},
};
const siteSchema=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),name:z.string().trim().min(1).max(120),provider:z.enum(["cms","legacy"]).default("cms"),baseUrl:z.string().url().refine(value=>/^https?:\/\//i.test(value)&&!new URL(value).username&&!new URL(value).password),username:z.string().trim().min(1).max(200),password:z.string().max(1000).optional()});
const htmlEscape=value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
export function articleHtml(markdown) {
  return String(markdown).split(/\n\s*\n/).map(block=>{
    const safe=htmlEscape(block).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" rel="noopener noreferrer">$1</a>').replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>");
    const heading=safe.match(/^(#{1,3})\s+([\s\S]*)$/);
    return heading?`<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`:`<p>${safe.replaceAll("\n","<br>")}</p>`;
  }).join("\n");
}
function csrf(html) {
  return html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)/i)?.[1] || html.match(/name=["']_token["']\s+value=["']([^"']+)/i)?.[1] || "";
}
function loggedOut(response,html) {return /\/login(?:\?|$)|\/auth\//.test(new URL(response.url()).pathname)||/type=["']password["']/i.test(html);}

export class WebsiteService {
  constructor(store,{requestFactory=request,sources=websiteImportSources}={}) {
    this.store=store;this.requestFactory=requestFactory;this.sources=sources;this.secrets=new SecretStore(store.root);this.pending=new Set();
    store.state.settings.website ||= {activeId:"",connections:[]};
  }
  save(input) {
    const data=siteSchema.parse(input);
    const previous=this.store.state.settings.website.connections.find(site=>site.id===data.id);
    const oldSecret=this.secrets.get(`website-${data.id}`);
    const password=data.password && data.password!=="[saved]"?data.password:oldSecret?.password;
    if(!password)throw new StudioError("Enter the website password.","WEBSITE_PASSWORD_REQUIRED",422);
    this.secrets.set(`website-${data.id}`,{password});
    const {password:discarded,...publicData}=data;
    const site={...publicData,baseUrl:data.baseUrl.replace(/\/+$/,""),hasPassword:true,lastTest:null};
    const settings=this.store.state.settings.website;
    settings.connections=previous?settings.connections.map(item=>item.id===site.id?site:item):[...settings.connections,site];
    if(!settings.activeId)settings.activeId=site.id;
    this.store.save();return site;
  }
  async import(source) {
    const item=this.sources[source];if(!item)throw new StudioError("Unknown app source.","INVALID_SOURCE");
    let saved;
    try{saved=JSON.parse((await fs.readFile(item.file,"utf8")).replace(/^\uFEFF/,""));}catch{throw new StudioError(`Could not read the ${source} website settings on this PC.`,"IMPORT_NOT_FOUND",404);}
    return this.save({id:source,name:item.name,provider:item.provider,baseUrl:saved.base_url,username:saved.username,password:saved.password});
  }
  selected(id=this.store.state.settings.website.activeId) {
    const site=this.store.state.settings.website.connections.find(item=>item.id===id);
    if(!site)throw new StudioError("Choose a website in Settings.","WEBSITE_REQUIRED",422);
    return site;
  }
  async session(site) {
    const context=await this.requestFactory.newContext({baseURL:site.baseUrl,timeout:30000,extraHTTPHeaders:{"User-Agent":"ViralStudio/0.4","Accept-Language":"en-US,en;q=0.9"}});
    try {
      const login=await context.get("/login");const page=await login.text();const token=csrf(page);
      if(!login.ok()||!token)throw new Error("Login page unavailable");
      const password=this.secrets.get(`website-${site.id}`)?.password;
      await context.post("/login",{headers:{Origin:site.baseUrl,Referer:`${site.baseUrl}/login`},form:{_token:token,email:site.username,username:site.username,password}});
      for(const provider of ["cms","legacy"]) {
        const admin=await context.get(provider==="cms"?"/admin/dashboard":"/backend/posts?create=1");
        const adminHtml=await admin.text();const adminToken=csrf(adminHtml);
        if(admin.ok()&&!loggedOut(admin,adminHtml)&&adminToken)return {context,token:adminToken,provider};
      }
      throw new Error("Login not verified");
    } catch {await context.dispose();throw new StudioError("Website login could not be verified. Check the domain, username and password in Settings.","WEBSITE_LOGIN_FAILED",502);}
  }
  async test(id) {
    const site=this.selected(id),session=await this.session(site);
    try {
      const response=await session.context.get(session.provider==="cms"?"/admin/api/v1/posts?per_page=1":"/backend/posts",{headers:{"X-CSRF-TOKEN":session.token}});
      if(!response.ok()||loggedOut(response,await response.text()))throw new StudioError("Website login succeeded, but the Posts page is unavailable.","WEBSITE_POSTS_UNAVAILABLE",502);
      const result={ok:true,checkedAt:new Date().toISOString(),message:"Website login and article access verified."};
      site.provider=session.provider;site.lastTest=result;this.store.save();return result;
    } finally{await session.context.dispose();}
  }
  async publish(postId,{revision,siteId}={}) {
    const post=this.store.require("socialPosts",postId),site=this.selected(siteId);
    if(post.revision!==revision)throw new StudioError("Content changed. Reload it before publishing.","STALE_REVISION",409);
    if(post.contentType!=="news"||!post.articleBody?.trim())throw new StudioError("Generate and review the news article first.","ARTICLE_REQUIRED",422);
    if(post.status!=="draft")throw new StudioError("Return this content to Draft before publishing the website article.","DRAFT_REQUIRED",409);
    const original=structuredClone(post);
    const hash=createHash("sha256").update(post.title+'\n'+post.articleBody).digest("hex");
    if(post.website?.status==="published") {
      if(post.website.contentHash!==hash||post.website.siteId!==site.id)throw new StudioError("This article is already published. Open it on the website to edit it.","ARTICLE_ALREADY_PUBLISHED",409);
      return post;
    }
    if(this.pending.has(post.id))throw new StudioError("The article is already being sent.","WEBSITE_BUSY",409);
    this.pending.add(post.id);
    let session;
    try {
      session=await this.session(site);
      const slug=`${original.title.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,100)}-${post.id.slice(0,8)}`;
      const url=`${site.baseUrl}/blog/${slug}`;
      const existing=await session.context.get(url);
      let confirmed=existing.ok() && (await existing.text()).includes(htmlEscape(original.title));
      if(!confirmed && post.website?.submittedAt)throw new StudioError("The earlier publish result is unconfirmed. Check the website before sending again.","WEBSITE_UNCONFIRMED",409);
      if(!confirmed) {
        if(this.store.require("socialPosts",postId).revision!==revision)throw new StudioError("Content changed. Reload it before publishing.","STALE_REVISION",409);
        const payload={title:original.title,slug,description:articleHtml(original.articleBody),image:null,seo_title:original.title,seo_description:(original.caption||"").slice(0,300),og_title:original.title,og_image:null,twitter_title:original.title,twitter_image:null,is_active:true,is_home:true,is_top:false,category_ids:[],tag_ids:[]};
        this.store.patch("socialPosts",post.id,{website:{siteId:site.id,slug,url,status:"sending",submittedAt:new Date().toISOString(),contentHash:hash}});
        const response=session.provider==="cms"
          ? await session.context.post("/admin/api/v1/posts",{headers:{"X-CSRF-TOKEN":session.token,accept:"application/json"},data:payload})
          : await session.context.post("/backend/posts",{headers:{"X-CSRF-TOKEN":session.token},multipart:{_token:session.token,title:payload.title,slug,description:payload.description,image:"",seo_title:payload.seo_title,seo_description:payload.seo_description,is_active:"1",is_home:"1",is_top:"0"}});
        if(!response.ok())throw new StudioError("The website did not confirm article creation. Check the website before retrying.","WEBSITE_UNCONFIRMED",502);
        const publicPage=await session.context.get(url);
        confirmed=publicPage.ok() && (await publicPage.text()).includes(htmlEscape(original.title));
      }
      if(!confirmed)throw new StudioError("The article was sent, but its public URL is not confirmed yet.","WEBSITE_UNCONFIRMED",502);
      const latest=this.store.require("socialPosts",postId);
      const label=this.store.state.settings.content.articleLinkLabel || "Read the full article";
      return this.store.patch("socialPosts",post.id,{website:{siteId:site.id,status:"published",url,slug,contentHash:hash,publishedAt:new Date().toISOString(),contentChanged:latest.revision!==revision},linkUrl:url,linkLabel:label,firstComment:`${label}: ${url}`,revision:latest.revision+1,status:"draft",scheduledAt:null,approvedAt:null,approvedRevision:null,exportRevision:null,exportedAt:null});
    } finally {await session?.context.dispose();this.pending.delete(post.id);}
  }
}

export function mountWebsiteRoutes(app,store,options={}) {
  const service=new WebsiteService(store,options);
  app.get("/api/website/settings",(req,res)=>res.json(store.state.settings.website));
  app.post("/api/website/import",async(req,res)=>res.json(await service.import(z.enum(["highlight","longform"]).parse(req.body.source))));
  app.post("/api/website/connections",(req,res)=>res.json(service.save(req.body)));
  app.patch("/api/website/settings",(req,res)=>{const site=service.selected(req.body.activeId);store.state.settings.website.activeId=site.id;store.state.settings.content.articleWebsiteUrl=site.baseUrl;store.save();res.json(store.state.settings.website);});
  app.post("/api/website/test",async(req,res)=>res.json(await service.test(req.body.id)));
  app.post("/api/content/posts/:id/website",async(req,res)=>res.json(await service.publish(req.params.id,z.object({revision:z.number().int().positive(),siteId:z.string().optional()}).parse(req.body))));
  return service;
}
