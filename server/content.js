import { z } from "zod";
import { socialPostSchema } from "../shared/social-contracts.js";
import { validatePostPayload } from "./social.js";
import { requestJsonContent } from "./llm.js";
import { readArticleText } from "./article-text.js";
import { StudioError } from "./store.js";

const generationInput = z.object({projectId:z.string().uuid(),mediaId:z.string().uuid().optional(),contentType:z.enum(["news","product"]),researchId:z.string().uuid().nullable().optional(),title:z.string().max(200).default(""),productBrief:z.string().max(4000).default(""),linkUrl:z.string().max(2000).default("")});

function link(value) {
  if (!value) return "";
  try { const url = new URL(value); if (["https:","http:"].includes(url.protocol) && !url.username && !url.password) return url.toString(); } catch { /* Return a useful validation error below. */ }
  throw new StudioError("Set a valid store or article URL in Settings.","CONTENT_LINK_REQUIRED",422);
}

export async function generateContent(store, raw, options = {}) {
  const input = generationInput.parse(raw);
  store.require("projects",input.projectId);
  const media = input.mediaId ? store.require("media",input.mediaId) : null;
  if (media && media.projectId && media.projectId !== input.projectId) throw new StudioError("Use media from this project.","MEDIA_PROJECT_MISMATCH");
  const meta = media?.production || {};
  const defaults = store.state.settings.content || {};
  const llm = options.llm || ((system,data)=>requestJsonContent(store,system,data,options));
  if (input.contentType === "product") {
    const storeUrl = link(input.linkUrl || meta.productUrl || defaults.storeUrl);
    const generated = await llm("Return title and firstComment. Write a concise first comment for the supplied product video. Use only the supplied product facts. No article, no invented discount, price, testimonial, medical claim or URL. The app will append the real store link.", {title:input.title || meta.title || media?.name,productBrief:input.productBrief || meta.productBrief || "",storeName:defaults.storeName || ""});
    const parsed = z.object({title:z.string().trim().min(1).max(200),firstComment:z.string().trim().min(1).max(4000)}).parse(generated);
    const comment = parsed.firstComment.replace(/https?:\/\/\S+/g,"").trim();
    return {contentType:"product",title:parsed.title,caption:"",articleBody:"",researchId:null,firstComment:storeUrl?`${comment}\n${defaults.storeLinkLabel || "Shop now"}: ${storeUrl}`:comment,linkUrl:storeUrl,linkLabel:defaults.storeLinkLabel || "Shop now",sourceUrl:""};
  }
  const researchId = input.researchId || meta.researchId;
  if (!researchId) throw new StudioError("Select the research used for this news video.","RESEARCH_REQUIRED",422);
  const research = store.require("researchResults",researchId);
  if (research.projectId !== input.projectId) throw new StudioError("Use research from this project.","RESEARCH_PROJECT_MISMATCH");
  const sources = research.articles.slice(0,3);
  if (!sources.length) throw new StudioError("Research needs verified sources before writing an article.","SOURCES_REQUIRED",422);
  const reader=options.articleReader || readArticleText;
  const texts=await Promise.allSettled(sources.map(source=>reader(source,options)));
  const evidence=sources.map((source,index)=>({title:source.title,url:source.url,source:source.source,publishedAt:source.publishedAt,summary:source.summary,text:texts[index].status==="fulfilled"?texts[index].value:""}));
  const generated=await llm("Return title, caption, and articleBody. Write an original, complete news article with a lead, clear sections, context, and a closing paragraph. Aim for 400-700 words only when supported by source detail; use a shorter complete article when evidence is limited. Ground every claim in the supplied source text or summary. Attribute allegations. Do not invent facts, quotes, dates, analysis, or predictions. Do not copy source passages. Do not include URLs; the app appends verified sources. caption is a short social post accompanying the video. articleBody is Markdown for the user's website.", {topic:research.topic,headline:research.headline,sources:evidence});
  const parsed=z.object({title:z.string().trim().min(1).max(200),caption:z.string().trim().min(1).max(5000),articleBody:z.string().trim().min(120).max(50000)}).parse(generated);
  const articleUrl=link(input.linkUrl || defaults.articleWebsiteUrl);
  const label=defaults.articleLinkLabel || "Read the full article";
  return {contentType:"news",...parsed,articleBody:`${parsed.articleBody}\n\n## Sources\n${sources.map(source=>`- [${source.source || source.title}](${source.url})`).join("\n")}`,researchId,firstComment:articleUrl?`${label}: ${articleUrl}`:"",linkUrl:articleUrl,linkLabel:label,sourceUrl:sources[0].url};
}

export function mountContentRoutes(app,store,options={}) {
  const pending=new Set();
  app.post("/api/content/generate",async(req,res)=>res.json(await generateContent(store,req.body,options)));
  app.post("/api/content/from-media/:id",async(req,res)=>{
    const media=store.require("media",req.params.id);
    if (media.kind!=="video" || !media.generated) throw new StudioError("Choose a completed video from Library.","VIDEO_REQUIRED",422);
    const existing=store.state.socialPosts.find(post=>post.mediaIds?.includes(media.id));
    if(existing) return res.json(existing);
    if(pending.has(media.id)) throw new StudioError("Content is already being generated for this video.","CONTENT_BUSY",409);
    pending.add(media.id);
    try {
      const fields=await generateContent(store,{projectId:media.projectId,mediaId:media.id,contentType:media.production?.contentType || req.body.contentType || "product",researchId:req.body.researchId},options);
      const payload=socialPostSchema.parse({...fields,projectId:media.projectId,pageId:req.body.pageId || "",mediaIds:[media.id],status:"draft"});
      validatePostPayload(store,payload);
      res.status(201).json(store.add("socialPosts",{...payload,revision:1,exportRevision:null,exportedAt:null}));
    } finally {pending.delete(media.id);}
  });
}
