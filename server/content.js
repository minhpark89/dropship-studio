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

export function mediaContentType(media) {
  const type = String(media?.production?.contentType || media?.mediaType || "").toLowerCase();
  if (type === "news" || type === "news-video") return "news";
  return /^news(?:\s|[·-])/i.test(String(media?.name || "")) ? "news" : "product";
}

function words(value) {
  return new Set(String(value || "").toLowerCase().replace(/[^a-z0-9À-ỹ]+/gi, " ").split(/\s+/).filter((word) => word.length > 2));
}

export function inferResearchId(store, media) {
  if (media?.production?.researchId) return media.production.researchId;
  if (mediaContentType(media) !== "news") return null;
  const target = words(media?.name);
  let best = { id: null, score: 0 };
  for (const research of store.state.researchResults || []) {
    if (media.projectId && research.projectId && research.projectId !== media.projectId) continue;
    const source = [research.headline, research.topic, ...(research.articles || []).slice(0, 5).map((article) => article.title)].join(" ");
    const score = [...words(source)].filter((word) => target.has(word)).length;
    if (score > best.score) best = { id: research.id, score };
  }
  return best.score >= 2 ? best.id : null;
}

function publicImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function researchArticleImages(store, research, max = 5) {
  const candidates = [];
  const seen = new Set();
  const add = (value, label = "News illustration") => {
    const url = publicImageUrl(value);
    if (!url || seen.has(url) || candidates.length >= max) return;
    seen.add(url);
    candidates.push({ url, label: String(label || "News illustration").replace(/[\[\]\r\n]+/g, " ").trim().slice(0, 180) || "News illustration" });
  };
  for (const article of research?.articles || []) add(article.imageUrl, "News illustration");
  for (const image of research?.imageSearchResults || []) add(image.imageUrl, image.title || image.query || "News image");
  for (const id of research?.imageMediaIds || []) {
    const media = store.state.media.find((item) => item.id === id);
    const url = publicImageUrl(media?.sourceUrl);
    if (url && (/\.(?:jpe?g|png|webp|gif|bmp)(?:[?#]|$)/i.test(new URL(url).pathname) || /(?:wikimedia|wikipedia|ichef\.bbci)/i.test(new URL(url).hostname))) {
      add(url, media?.name || "News image");
    }
  }
  return candidates;
}

function articleWithImages(markdown, images) {
  const source = String(markdown || "").trim();
  if (!images.length) return source;
  const blocks = source ? source.split(/\n\s*\n/) : [];
  const sourceIndex = blocks.findIndex((block) => /^#{1,3}\s+Sources\b/i.test(block.trim()));
  const body = sourceIndex >= 0 ? blocks.slice(0, sourceIndex) : blocks;
  const tail = sourceIndex >= 0 ? blocks.slice(sourceIndex) : [];
  if (!body.length) body.push("");
  const inserts = new Map();
  images.forEach((image, index) => {
    const position = Math.min(body.length - 1, Math.max(0, Math.floor(((index + 1) * body.length) / (images.length + 1)) - 1));
    const list = inserts.get(position) || [];
    list.push(`![${index === 0 ? "News illustration" : image.label}](${image.url})`);
    inserts.set(position, list);
  });
  const output = [];
  body.forEach((block, index) => {
    if (block) output.push(block);
    if (inserts.has(index)) output.push(...inserts.get(index));
  });
  return [...output, ...tail].join("\n\n").trim();
}

export function repairNewsArticleImages(store, post) {
  const research = post?.researchId
    ? store.state.researchResults.find((item) => item.id === post.researchId)
    : null;
  const images = researchArticleImages(store, research);
  const currentBody = String(post?.articleBody || "").trim();
  const currentCount = (currentBody.match(/!\[[^\]]*\]\(https?:\/\//g) || []).length;
  if (!images.length || currentCount >= images.length) {
    return { changed: false, imageCount: currentCount, articleBody: currentBody, coverImageUrl: post?.coverImageUrl || "" };
  }
  const withoutImages = currentBody
    .replace(/!\[[^\]]*\]\(https?:\/\/[^\s)]+\)\s*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const articleBody = articleWithImages(withoutImages, images);
  return { changed: true, imageCount: images.length, articleBody, coverImageUrl: post?.coverImageUrl || images[0].url };
}

function researchCoverImage(store, research) {
  return researchArticleImages(store, research, 1)[0]?.url || "";
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
  const evidence=sources.map((source,index)=>({title:source.title,url:source.url,source:source.source,publishedAt:source.publishedAt,summary:source.summary,imageUrl:source.imageUrl || null,text:texts[index].status==="fulfilled"?texts[index].value:""}));
  const generated=await llm("Return title, caption, and articleBody. Write an original, complete news article with a strong factual lead, clear sections, verified context, and a closing paragraph. Aim for 500-800 words when the supplied source text supports it; when evidence is limited, write at least 350 words without padding, and clearly label what the report confirms and what remains unknown. Build the article as a restrained news narrative: open with the unresolved development or tension, explain what happened, attribute every allegation, explain why the location or decision matters only when supported, and close with the next confirmed detail readers should watch. Do not invent facts, quotes, dates, attendance, motives, predictions or background. Do not copy source passages. Do not include URLs; the app appends verified sources. Caption is a short social post accompanying the video. Ground every claim in the supplied source text or summary. Attribute allegations. Do not invent facts, quotes, dates, analysis, or predictions. Do not copy source passages. Do not include URLs; the app appends verified sources. caption is a short social post accompanying the video. articleBody is Markdown for the user's website.", {topic:research.topic,headline:research.headline,sources:evidence});
  const parsed=z.object({title:z.string().trim().min(1).max(200),caption:z.string().trim().min(1).max(5000),articleBody:z.string().trim().min(120).max(50000)}).parse(generated);
  const articleUrl=link(input.linkUrl || defaults.articleWebsiteUrl);
  const label=defaults.articleLinkLabel || "Read the full article";
  const articleImages = researchArticleImages(store, research);
  const coverImageUrl = articleImages[0]?.url || "";
  const articleBody = articleWithImages(parsed.articleBody, articleImages);
  return {contentType:"news",...parsed,coverImageUrl,articleBody:`${articleBody}\n\n## Sources\n${sources.map(source=>`- [${source.source || source.title}](${source.url})`).join("\n")}`,researchId,firstComment:articleUrl?`${label}: ${articleUrl}`:"",linkUrl:articleUrl,linkLabel:label,sourceUrl:sources[0].url};
}

function fallbackNewsContent(store, media) {
  const meta = media.production || {};
  const researchId = meta.researchId || null;
  const research = researchId ? store.state.researchResults.find(item => item.id === researchId) : null;
  const source = research?.articles?.[0] || {};
  const title = String(meta.title || research?.headline || media.name || "News update").slice(0, 200);
  const summary = String(research?.script || research?.angle || source.summary || "The latest verified update is available in the full article.").trim();
  const articleImages = researchArticleImages(store, research);
  const articleBody = research
    ? articleWithImages(`# ${title}\n\n${summary}\n\nThis draft is based on the saved research sources. Regenerate it after the LLM connection is restored to expand the article with verified context.`, articleImages)
    : "";
  const defaults = store.state.settings.content || {};
  const linkUrl = defaults.articleWebsiteUrl || "";
  const coverImageUrl = articleImages[0]?.url || "";
  const label = defaults.articleLinkLabel || "Read the full article";
  const template = defaults.newsFirstCommentTemplate || `${label}: {{link}}`;
  return {
    contentType: "news",
    title,
    caption: summary.slice(0, 5000),
    articleBody,
    researchId,
    firstComment: linkUrl ? template.replaceAll("{{link}}", linkUrl) : "",
    linkUrl,
    linkLabel: label,
    coverImageUrl,
    sourceUrl: source.url || "",
  };
}

function fallbackProductContent(store, media) {
  const meta = media.production || {};
  const defaults = store.state.settings.content || {};
  const title = String(meta.title || media.name || "Product video").replace(/\.[a-z0-9]+$/i, "").slice(0, 200);
  const linkUrl = meta.productUrl || defaults.storeUrl || "";
  const label = defaults.storeLinkLabel || "Shop now";
  const template = defaults.productFirstCommentTemplate || `${label}: {{link}}`;
  const firstComment = linkUrl
    ? template.replaceAll("{{link}}", linkUrl)
    : "Video đã sẵn sàng để gắn Page và lên lịch đăng.";
  return {
    contentType: "product",
    title,
    caption: "",
    articleBody: "",
    researchId: null,
    firstComment,
    linkUrl,
    linkLabel: label,
    coverImageUrl: "",
    sourceUrl: "",
  };
}

export async function createContentFromMedia(store, mediaId, { pageId = "", source = "", force = false, contentType: requestedContentType = "", researchId: requestedResearchId = "", options = {} } = {}) {
  const media = store.require("media", mediaId);
  if (media.kind !== "video" || !media.generated) throw new StudioError("Choose a completed video from Library.", "VIDEO_REQUIRED", 422);
  const existing = store.state.socialPosts.find(post => post.mediaIds?.includes(media.id));
  if (existing && !force) return existing;
  const contentType = requestedContentType || mediaContentType(media);
  const researchId = requestedResearchId || inferResearchId(store, media);
  let fields;
  let generationError = null;
  try {
    fields = await generateContent(store, {
      projectId: media.projectId,
      mediaId: media.id,
      contentType,
      researchId,
      title: media.production?.title || "",
    }, options);
  } catch (error) {
    if (!source) throw error;
    generationError = error;
    fields = contentType === "news"
      ? fallbackNewsContent(store, media)
      : fallbackProductContent(store, media);
  }
  const payload = socialPostSchema.parse({
    ...fields,
    projectId: media.projectId,
    pageId: pageId || existing?.pageId || "",
    mediaIds: [media.id],
    status: "draft",
    scheduledAt: null,
  });
  validatePostPayload(store, payload);
  const metadata = {
    ...(source ? { automationSource: source } : {}),
    automationStatus: generationError ? "error" : source ? "generated" : null,
    automationError: generationError?.message || null,
    website: null,
  };
  if (existing) return store.patch("socialPosts", existing.id, { ...payload, ...metadata, revision: existing.revision + 1 });
  return store.add("socialPosts", { ...payload, ...metadata, revision: 1, exportRevision: null, exportedAt: null });
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
    try { res.status(201).json(await createContentFromMedia(store, media.id, { pageId: req.body.pageId || "", source: req.body.source || "", contentType: req.body.contentType || "", researchId: req.body.researchId || "", options })); }
    finally { pending.delete(media.id); }
  });
  app.post("/api/content/posts/:id/regenerate", async (req, res) => {
    const post = store.require("socialPosts", req.params.id);
    if (post.website?.status === "published") throw new StudioError("Published article cannot be regenerated from this draft.", "ARTICLE_ALREADY_PUBLISHED", 409);
    const mediaId = post.mediaIds?.[0];
    if (!mediaId) throw new StudioError("Attach the completed news video before regenerating content.", "VIDEO_REQUIRED", 422);
    res.json(await createContentFromMedia(store, mediaId, { pageId: post.pageId, source: post.automationSource || "content", contentType: post.contentType, force: true, options }));
  });
  app.post("/api/content/posts/:id/repair-images", async (req, res) => {
    const post = store.require("socialPosts", req.params.id);
    const revision = z.number().int().positive().parse(req.body?.revision);
    if (post.revision !== revision) throw new StudioError("Content changed. Reload it before repairing images.", "STALE_REVISION", 409);
    if (post.contentType !== "news") throw new StudioError("Chỉ sửa ảnh inline cho Content News.", "NEWS_ARTICLE_REQUIRED", 422);
    const repaired = repairNewsArticleImages(store, post);
    if (!repaired.changed) return res.json(post);
    const website = post.website?.status === "published"
      ? { ...post.website, contentChanged: true }
      : post.website;
    res.json(store.patch("socialPosts", post.id, {
      articleBody: repaired.articleBody,
      coverImageUrl: repaired.coverImageUrl,
      website,
      revision: post.revision + 1,
    }));
  });
  app.post("/api/content/posts/:id/sync-first-comment", async (req, res) => {
    const post = store.require("socialPosts", req.params.id);
    const revision = z.number().int().positive().parse(req.body?.revision);
    if (post.revision !== revision) throw new StudioError("Content changed. Reload it before syncing the first comment.", "STALE_REVISION", 409);
    if (post.contentType !== "news" || post.website?.status !== "published" || !post.website.url) throw new StudioError("Publish the news article first so its verified URL can be used in the first comment.", "WEBSITE_ARTICLE_REQUIRED", 422);
    const label = store.state.settings.content?.articleLinkLabel || "Read the full article";
    return res.json(store.patch("socialPosts", post.id, {
      linkUrl: post.website.url,
      linkLabel: label,
      firstComment: `${label}: ${post.website.url}`,
      revision: post.revision + 1,
    }));
  });
  return { createContentFromMedia: (mediaId, input = {}) => createContentFromMedia(store, mediaId, { ...input, options }) };
}
