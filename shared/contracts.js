import { z } from "zod";

export const providers = {
  dola: {
    name: "Dola · Seedance",
    url: "https://www.dola.com/chat/",
    models: ["Dreamina Seedance 2.0 Fast", "Dreamina Seedance 1.0"],
    imageModels: ["Seedream 4.5", "Seedream 5.0 Pro"],
    imageRatios: ["9:16", "16:9", "1:1", "4:3", "3:4"],
    durations: [4, 5, 6, 7, 8, 9, 10],
    ratios: ["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"],
  },
  flow: {
    name: "Google Flow · Veo",
    url: "https://flow.google.com/",
    models: [
      "Veo 3.1 Fast",
      "Veo 3.1 Quality",
      "Veo 3.1 Lite",
      "Omni 1.1 Flash",
    ],
    imageModels: ["Nano Banana 2.1"],
    durations: [4, 6, 8, 10],
    ratios: ["9:16", "16:9", "1:1"],
  },
  dreamface: {
    name: "DreamFace",
    url: "https://www.dreamfaceapp.com/video",
    hidden: false,
    models: ["DreamFace video"],
    imageModels: [],
    durations: [5, 10],
    ratios: ["9:16", "16:9"],
  },
};

export const statusLabels = {
  queued: "Đang chờ",
  scheduled: "Đã hẹn giờ",
  preparing: "Chuẩn bị",
  submitting: "Đang gửi",
  rendering: "Đang tạo",
  downloading: "Đang tải",
  completed: "Hoàn tất",
  failed: "Có lỗi",
  cancelled: "Đã hủy",
  interrupted: "Bị gián đoạn",
  needs_login: "Cần đăng nhập",
  verification: "Cần xác minh",
  ready: "Sẵn sàng",
  offline: "Chưa kiểm tra",
  checking: "Đang kiểm tra",
  busy: "Đang dùng",
  error: "Có lỗi",
};

export const activeStatuses = [
  "preparing",
  "submitting",
  "rendering",
  "downloading",
];
export const terminalStatuses = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];
const id = z.string().uuid();
const number = z.number().finite();
const unit = number.min(0).max(1);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);

export const clipSchema = z
  .object({
    id,
    mediaId: id,
    inSec: number.min(0).default(0),
    outSec: number.positive(),
    speed: number.min(0.25).max(4).default(1),
    zoom: number.min(1).max(3).default(1),
    fit: z.enum(["contain", "cover"]).default("cover"),
    volume: number.min(0).max(2).default(1),
  })
  .refine(
    (clip) => clip.outSec > clip.inSec,
    "Điểm cuối phải lớn hơn điểm đầu.",
  );

export const textSchema = z.object({
  id,
  text: z.string().max(3000),
  startSec: number.min(0),
  endSec: number.positive(),
  x: unit,
  y: unit,
  size: number.min(12).max(240),
  color: color.default("#ffffff"),
  background: z.boolean().default(false),
});

export const imageSchema = z.object({
  id,
  mediaId: id,
  startSec: number.min(0),
  endSec: number.positive(),
  x: unit,
  y: unit,
  scale: number.min(0.02).max(1),
  opacity: unit.default(1),
});

export const musicSchema = z.object({
  mediaId: id,
  volume: number.min(0).max(2).default(0.35),
  startSec: number.min(0).default(0),
  offsetSec: number.min(0).default(0),
  speed: number.min(0.5).max(2).default(1),
  loop: z.boolean().default(true),
  fadeIn: number.min(0).max(30).default(0.5),
  fadeOut: number.min(0).max(30).default(1),
});

export const timelineSchema = z.object({
  clips: z.array(clipSchema).max(200),
  texts: z.array(textSchema).max(100).default([]),
  images: z.array(imageSchema).max(30).default([]),
  music: musicSchema.nullable().default(null),
  ratio: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
  resolution: z
    .union([z.literal(480), z.literal(720), z.literal(1080)])
    .default(720),
  fps: z
    .union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)])
    .default(30),
  quality: z.enum(["draft", "standard", "high"]).default("standard"),
  originalAudio: z.enum(["keep", "lower", "boost", "mute"]).default("keep"),
});

export const defaultTimeline = () => timelineSchema.parse({ clips: [] });
export const durationOf = (timeline) =>
  timeline.clips.reduce(
    (sum, clip) => sum + (clip.outSec - clip.inSec) / clip.speed,
    0,
  );
export function dimensions(timeline) {
  const short = timeline.resolution;
  const long = Math.round((short * 16) / 9 / 2) * 2;
  if (timeline.ratio === "9:16") return { width: short, height: long };
  if (timeline.ratio === "16:9") return { width: long, height: short };
  return { width: short, height: short };
}

export const generationSchema = z.object({
  projectId: id,
  provider: z.enum(["dola", "flow", "dreamface"]),
  accountId: z.union([id, z.literal("auto")]).default("auto"),
  kind: z.enum(["video", "image"]).default("video"),
  mode: z.enum(["text", "reference", "firstlast", "extend"]).default("text"),
  prompts: z.array(z.string().trim().min(1).max(20000)).min(1).max(200),
  references: z.array(id).max(10).default([]),
  model: z.string().min(1).max(100),
  duration: z.union([
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
    z.literal(8),
    z.literal(9),
    z.literal(10),
    z.literal(15),
    z.literal(30),
  ]),
  ratio: z.enum(["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"]),
  scheduledAt: z.string().datetime().nullable().default(null),
  autoAssemble: z.boolean().default(false),
  contentContext: z.object({
    contentType: z.enum(["news", "product"]),
    researchId: id.nullable().optional(),
    title: z.string().max(200).default(""),
    productBrief: z.string().max(4000).default(""),
  }).optional(),
});

export const accountSchema = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z.enum(["dola", "flow", "dreamface"]),
  loginMethod: z.enum(["google", "apple", "credentials", "cookie"]).default("google"),
  email: z.string().max(200).default(""),
  proxy: z.string().max(500).default(""),
});
