import { z } from "zod";

const uuid = z.string().uuid();
const text = (max) => z.string().trim().max(max);
const webLink = z.string().trim().max(2000).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}, "Liên kết phải là URL http hoặc https hợp lệ.");
export const socialStatusLabels = {
  draft: "Bản nháp",
  ready: "Đã duyệt",
  scheduled: "Có lịch dự kiến",
  published: "Đã ghi nhận đăng",
};

export function validTimezone(value) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export const facebookUrl = z.string().trim().max(2000).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && ["facebook.com", "www.facebook.com", "m.facebook.com"].includes(url.hostname)
      && !url.searchParams.has("access_token");
  } catch {
    return false;
  }
}, "Nhập liên kết HTTPS thuộc facebook.com, không chứa token.");

export const socialPageSchema = z.object({
  name: text(120).min(1),
  platform: z.literal("facebook").default("facebook"),
  externalId: z.string().trim().regex(/^\d{1,40}$|^$/, "Page ID chỉ gồm chữ số.").default(""),
  url: facebookUrl.default(""),
  timezone: z.string().refine(validTimezone, "Múi giờ IANA không hợp lệ.").default("Asia/Bangkok"),
  notes: text(5000).default(""),
  archived: z.boolean().default(false),
}).strict();

export const socialPagePatchSchema = socialPageSchema.partial().extend({
  revision: z.number().int().positive(),
}).strict();

export const socialPostSchema = z.object({
  projectId: uuid,
  pageId: uuid,
  pageGroupId: z.string().trim().max(120).default(""),
  tokenGroupId: z.string().trim().max(120).default(""),
  contentType: z.enum(["product", "news"]).default("product"),
  title: text(200).min(1),
  caption: text(20000).default(""),
  firstComment: text(10000).default(""),
  linkUrl: webLink.default(""),
  linkLabel: text(160).default(""),
  sourceUrl: webLink.default(""),
  mediaIds: z.array(uuid).max(1).default([]),
  scheduledAt: z.string().datetime({ offset: true }).nullable().default(null),
  status: z.enum(["draft", "ready", "scheduled"]).default("draft"),
  notes: text(5000).default(""),
}).strict();

export const socialPostPatchSchema = socialPostSchema.partial().extend({
  revision: z.number().int().positive(),
}).strict();

export const socialPublicationSchema = z.object({
  revision: z.number().int().positive(),
  externalPostId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,200}$/),
  permalink: facebookUrl.refine((value) => value.length > 0, "Cần liên kết bài đã đăng."),
  publishedAt: z.string().datetime({ offset: true }),
}).strict();

export const socialRevisionSchema = z.object({
  revision: z.number().int().positive(),
}).strict();
