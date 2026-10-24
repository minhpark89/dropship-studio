import { z } from "zod";

const id = z.string().uuid();

export const llmSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().url().default("https://api.openai.com/v1"),
  apiKey: z.string().max(2000).default(""),
  model: z.string().trim().min(1).max(200).default("gpt-4o-mini"),
  timeoutSeconds: z.number().int().min(10).max(300).default(90),
});

export const researchRequestSchema = z.object({
  projectId: id,
  topic: z.string().trim().min(2).max(200),
  niche: z.string().trim().min(2).max(120).default("Tin tức tổng hợp"),
  language: z.enum(["vi", "en"]).default("vi"),
  feeds: z.array(z.string().url()).max(12).optional(),
  maxArticles: z.number().int().min(1).max(12).default(6),
  includeImages: z.boolean().default(true),
});

export const researchArticleSchema = z.object({
  id,
  title: z.string().min(1).max(500),
  summary: z.string().max(4000).default(""),
  source: z.string().max(200).default(""),
  url: z.string().url(),
  publishedAt: z.string().datetime().nullable().default(null),
  imageUrl: z.string().url().nullable().default(null),
  imageQuery: z.string().max(300).default(""),
  relevance: z.number().min(0).max(1).default(0),
});

export const researchImageSchema = z.object({
  id: z.string().trim().min(1).max(240),
  query: z.string().max(300).default(""),
  title: z.string().max(300).default(""),
  imageUrl: z.string().url(),
  pageUrl: z.string().url().nullable().default(null),
  width: z.number().int().min(0).max(20000).default(0),
  height: z.number().int().min(0).max(20000).default(0),
  mime: z.string().max(80).default(""),
  license: z.string().max(160).default(""),
  attribution: z.string().max(500).default(""),
});

export const researchResultSchema = z.object({
  id,
  projectId: id,
  topic: z.string(),
  niche: z.string(),
  language: z.enum(["vi", "en"]),
  createdAt: z.string().datetime(),
  headline: z.string(),
  angle: z.string(),
  script: z.string(),
  articles: z.array(researchArticleSchema).max(30),
  imageQueries: z.array(z.string().max(300)).max(30),
  imageSearchResults: z.array(researchImageSchema).max(30).default([]),
  imageMediaIds: z.array(id).max(30).default([]),
  warnings: z.array(z.string()).default([]),
});

export const dreamfaceAccountSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().email().max(200).default(""),
  proxy: z.string().max(500).default(""),
  loginMethod: z.enum(["credentials", "cookie"]).default("credentials"),
});

export const dreamfaceLoginSchema = z.object({
  email: z.string().email().max(200).optional(),
  password: z.string().max(1000).optional(),
  cookies: z.string().max(2000000).optional(),
});

