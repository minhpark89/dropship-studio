import { z } from "zod";
import { requestJsonContent } from "./llm.js";
import { StudioError } from "./store.js";

export const NEWS_CTA="Read the full story through the link in the first comment.";
export const newsPlanSchema=z.object({
  headline:z.string().trim().min(5).max(100),
  narration:z.string().trim().min(60).max(500),
  source:z.string().max(100).default("News report"),
  sourceUrl:z.string().url().optional(),
  avatarName:z.string().min(1).max(100).default("Alex"),
  voiceName:z.string().min(1).max(100).default("Grace"),
  imageQueries:z.array(z.string().min(2).max(100)).max(6).default([]),
  imageMediaIds:z.array(z.string().uuid()).min(1).max(8),
  selectedImageIds:z.array(z.string()).max(5).default([]),
  resolution:z.union([z.literal(720),z.literal(1080)]).default(1080),
  brand:z.string().max(24).default("VIRAL NEWS"),
});

export async function writeNewsNarration(store,research,{llm=requestJsonContent}={}) {
  const output=await llm(store,
    'Write a short TV news teaser from the supplied verified report. Return JSON {headline,summary,imageQueries}. Headline: factual, maximum 70 characters. Summary: 24–32 spoken words, 2 concise sentences. Lead with the confirmed development, then attribute any allegation to its speaker. No invented facts, fake urgency, rhetorical bait, directions or branding. Do not include a CTA; it is appended by the app. Image queries: 3–5 SHORT literal noun phrases, 2–4 words each, using the actual subjects and objects in the report. Avoid generic technology, infrastructure, illustrations or flags.',
    {headline:research.headline,script:research.script,articles:research.articles.map(({title,summary,source,url})=>({title,summary,source,url}))});
  const parsed=z.object({headline:z.string().trim().min(5).max(100),summary:z.string().trim().min(30).max(350),imageQueries:z.array(z.string().min(2).max(100)).min(1).max(6)}).parse(output);
  const narration=`${parsed.summary.replace(/\s+/g," ")} ${NEWS_CTA}`;
  if(narration.length>500)throw new StudioError("The news script exceeds DreamFace's 500-character limit. Shorten the summary.","NEWS_SCRIPT_TOO_LONG",422);
  return {headline:parsed.headline,narration,imageQueries:parsed.imageQueries,source:research.articles[0]?.source||"News report",sourceUrl:research.articles[0]?.url};
}

export async function rankNewsImages(store,research,candidates,{llm=requestJsonContent}={}) {
  const source=candidates.filter(image=>image.id.startsWith("article:"));
  const others=candidates.filter(image=>!image.id.startsWith("article:"));
  if(!others.length)return source.slice(0,5);
  const selected=await llm(store,
    'Select editorial photographs for this specific news report. Return JSON {selectedImageIds:[]}. Select at most 4 IDs from the supplied candidate list, in visual story order. Reject unrelated locations/events, historical equipment, cartoons, documents, graphics and near-duplicate photos. A generic communications image is not evidence of this story. Prefer photographs of the actual named subject or relevant physical object. It is better to select fewer than to select an irrelevant image. Do not invent IDs.',
    {headline:research.headline,summary:research.articles[0]?.summary,candidates:others.map(({id,title,query})=>({id,title,query}))});
  const ids=z.array(z.string()).max(4).parse(selected.selectedImageIds);
  const chosen=ids.map(id=>others.find(image=>image.id===id)).filter(Boolean);
  return [...source,...chosen].slice(0,5);
}
