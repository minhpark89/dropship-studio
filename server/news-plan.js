import { z } from "zod";
import { requestJsonContent } from "./llm.js";
import { StudioError } from "./store.js";

export const NEWS_CTA="Read the full story through the link in the first comment.";
function sourceLabel(value) {
  const cleaned = String(value || "News report")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&amp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "News report").slice(0, 100);
}

export const newsPlanSchema=z.object({
  headline:z.string().trim().min(5).max(100),
  narration:z.string().trim().min(60).max(500),
  source:z.string().max(100).default("News report"),
  sourceUrl:z.string().url().optional(),
  fontStyle:z.enum(["news","viral","minimal"]).default("news"),
  avatarName:z.string().min(1).max(100).default("Alex"),
  voiceName:z.string().min(1).max(100).default("Grace"),
  imageQueries:z.array(z.string().min(2).max(100)).max(6).default([]),
  imageMediaIds:z.array(z.string().uuid()).min(1).max(8),
  selectedImageIds:z.array(z.string()).max(5).default([]),
  resolution:z.union([z.literal(720),z.literal(1080)]).default(1080),
  brand:z.string().max(24).default("NEWS UPDATE"),
  variation:z.number().int().min(1).max(50).default(1),
  visualVariant:z.number().int().min(1).max(50).default(1),
});

export async function writeNewsNarration(store,research,{llm=requestJsonContent,variation=1,total=1}={}) {
  const output=await llm(store,
    "Use a four-sentence progression: fact-based curiosity hook, confirmed development with attribution, verified context or stakes, then what remains unknown or what to watch next. Target 55-78 spoken words. Keep every claim grounded in the supplied report; never add urgency, predictions, quotes or invented detail. " +
    `Write a short American TV news teaser from the supplied verified report. Return JSON {headline,summary,imageQueries}. Headline: factual, maximum 70 characters. Summary: 45-65 spoken words in 3-4 short sentences. Build a clear progression: sentence one is a fact-based curiosity hook; sentence two states what happened; sentence three gives verified context or a response; sentence four explains what remains unknown or why viewers should follow the full report. The hook may create tension through an unresolved fact, but use no exaggeration, rhetorical question, fake urgency or unverified claim. Attribute allegations to the person or outlet making them. No invented facts, quotes, dates, predictions, directions or branding. Do not include a CTA; it is appended by the app. Image queries: 3–5 SHORT literal noun phrases, 2–4 words each, using the actual named subjects, places and objects in the report. Avoid generic technology, infrastructure, illustrations, flags or unrelated stock imagery.${total > 1 ? ` This is variation ${variation} of ${total}; change the opening wording and pacing while keeping every fact and image subject consistent.` : ""}`,
    {variation,total,headline:research.headline,script:research.script,articles:research.articles.map(({title,summary,source,url})=>({title,summary,source,url}))});
  const parsed=z.object({headline:z.string().trim().min(5).max(100),summary:z.string().trim().min(45).max(400),imageQueries:z.array(z.string().min(2).max(100)).min(1).max(6)}).parse(output);
  let summary = parsed.summary.replace(/\s+/g," ");
  const firstSentence = summary.split(/(?<=[.!?])\s+/u)[0] || summary;
  if (!/\b(?:but|however|unclear|unknown|not included|remains|leaves|what|why|still|yet)\b/i.test(firstSentence)) {
    summary = `The report puts ${parsed.headline.replace(/[.!?]+$/g, "")} in focus, but leaves the key details unanswered. ${summary}`;
  }
  // Some local models ignore the requested sentence count. Add a factual
  // close when the response is too short so the presenter has a real hook,
  // development, context and an open question instead of two flat sentences.
  if (summary.split(/\s+/).filter(Boolean).length < 38) {
    summary = `${summary} The available report leaves important details open, so the next confirmed update will matter.`;
  }
  const maxSummaryLength = 500 - NEWS_CTA.length - 1;
  if (summary.length > maxSummaryLength) summary = summary.slice(0, maxSummaryLength).replace(/\s+\S*$/u, "").trim();
  const narration=`${summary} ${NEWS_CTA}`;
  if(narration.length>500)throw new StudioError("The news script exceeds DreamFace's 500-character limit. Shorten the summary.","NEWS_SCRIPT_TOO_LONG",422);
  return {
    headline: parsed.headline,
    narration,
    imageQueries: parsed.imageQueries,
    source: sourceLabel(research.articles[0]?.source),
    sourceUrl: research.articles[0]?.url,
    variation: Math.max(1, Number(variation) || 1),
    visualVariant: Math.max(1, Number(variation) || 1),
  };
}

export async function rankNewsImages(store,research,candidates,{llm=requestJsonContent}={}) {
  const source=candidates.filter(image=>image.id.startsWith("article:"));
  const others=candidates.filter(image=>!image.id.startsWith("article:"));
  const fallback=[...source,...others].slice(0,5);
  if(!others.length)return fallback;
  try {
    const selected=await llm(store,
      'Select editorial photographs for this specific news report. Return JSON {selectedImageIds:[]}. Select at most 4 IDs from the supplied candidate list, in visual story order. Reject unrelated locations/events, historical equipment, cartoons, documents, graphics and near-duplicate photos. A generic communications image is not evidence of this story. Prefer photographs of the actual named subject or relevant physical object. It is better to select fewer than to select an irrelevant image. Do not invent IDs.',
      {headline:research.headline,summary:research.articles[0]?.summary,candidates:others.map(({id,title,query})=>({id,title,query}))});
    const ids=z.array(z.string()).max(4).parse(selected?.selectedImageIds || []);
    const chosen=ids.map(id=>others.find(image=>image.id===id)).filter(Boolean);
    const remainder=others.filter(image=>!ids.includes(image.id));
    return chosen.length ? [...source,...chosen,...remainder].slice(0,5) : fallback;
  } catch {
    // Image ranking is a quality pass. A malformed/empty LLM response must
    // never block a verified Wikimedia/article image from reaching render.
    return fallback;
  }
}
