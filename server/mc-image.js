import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { importMedia } from "./media.js";
import { StudioError } from "./store.js";

export const DEFAULT_MC_IMAGE_PROMPT =
  "Original fictional US television news presenter, professional woman in her 30s, navy blazer over a white shirt, seated at a modern newsroom desk, medium portrait shot from the waist up, clean blue and red broadcast studio background, warm key light, direct eye contact, neutral confident expression, hands below frame, realistic editorial photography, no logos, no text, no watermark, not resembling a real person.";

const DEFAULTS = {
  enabled: true,
  endpoint: "",
  apiKey: "",
  model: "",
  autoDiscover: true,
  dreamfaceFallback: true,
};

function clean(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function localConfigCandidates() {
  const candidates = [
    process.env.HIGHLIGHT_CONFIG_PATH,
    "D:\\Highlight_Studio_Video\\app\\config.json",
    "D:\\Highlight_Studio_Video\\app\\config\\config.json",
    path.join(process.env.LOCALAPPDATA || "", "HighlightVideoStudio", "config.json"),
  ];
  return [...new Set(candidates.filter(Boolean))];
}

async function readHighlightConfig() {
  for (const filename of localConfigCandidates()) {
    try {
      const value = JSON.parse(await fs.readFile(filename, "utf8"));
      const image = value?.image_provider || value?.imageProvider;
      if (!image?.generation_url || !image?.api_key || !image?.model) continue;
      if (!isHttpUrl(image.generation_url)) continue;
      return {
        endpoint: String(image.generation_url),
        apiKey: String(image.api_key),
        model: String(image.model),
        source: "highlight-config",
        path: filename,
      };
    } catch {
      // Highlight is optional. Keep looking for another local installation.
    }
  }
  return null;
}

export async function resolveMcImageConfig(store) {
  const configured = { ...DEFAULTS, ...(store.state.settings?.imageGeneration || {}) };
  if (configured.enabled === false) return { ...configured, source: "disabled" };
  if (configured.endpoint) {
    if (configured.model) return { ...configured, source: "settings" };
    if (configured.autoDiscover !== false) {
      const discovered = await readHighlightConfig();
      if (discovered) return { ...configured, model: discovered.model, source: "settings" };
    }
    return { ...configured, source: "settings" };
  }
  if (configured.autoDiscover !== false) {
    const discovered = await readHighlightConfig();
    if (discovered) return { ...configured, ...discovered };
  }
  return { ...configured, source: "unconfigured" };
}

function dataUri(value) {
  const match = String(value || "").match(/^data:image\/([a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);
  if (!match) return null;
  const extension = match[1].toLowerCase().replace("jpeg", "jpg");
  return { extension: extension === "jpg" ? ".jpg" : ".png", bytes: Buffer.from(match[2], "base64") };
}

function nestedImageValue(value) {
  if (!value || typeof value !== "object") return null;
  return value.b64_json || value.base64 || value.url || value.image_url?.url || value.imageUrl || null;
}

async function extractImageBytes(payload, fetchImpl, signal) {
  const candidates = [];
  const row = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (row) candidates.push(nestedImageValue(row));
  const message = payload?.choices?.[0]?.message;
  if (message) {
    const images = Array.isArray(message.images) ? message.images : [];
    candidates.push(...images.map(nestedImageValue));
    candidates.push(message.content);
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "string" && /^[a-z0-9+/=]{200,}$/i.test(candidate) && !candidate.includes("http")) {
      return { extension: ".png", bytes: Buffer.from(candidate, "base64") };
    }
    const inline = dataUri(candidate);
    if (inline) return inline;
    if (isHttpUrl(candidate)) {
      const response = await fetchImpl(candidate, { signal });
      if (!response.ok) continue;
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      const extension = contentType.includes("jpeg") || contentType.includes("jpg") ? ".jpg" : ".png";
      return { extension, bytes: Buffer.from(await response.arrayBuffer()) };
    }
  }
  return null;
}

function safeErrorMessage(error) {
  const message = clean(error?.message || error, 220);
  return message.replace(/https?:\/\/\S+/gi, "image endpoint");
}

export async function generateImageEndpoint({ config, prompt = DEFAULT_MC_IMAGE_PROMPT, fetchImpl = globalThis.fetch, signal }) {
  if (!config?.endpoint || !config?.model) throw new StudioError("No compatible AI image endpoint is configured.", "MC_IMAGE_ENDPOINT_MISSING", 422);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Image endpoint timed out.")), 120000);
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      signal: combinedSignal,
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        prompt: clean(prompt, 3500),
        n: 1,
        size: "1024x1536",
        quality: "auto",
        background: "auto",
        image_detail: "high",
        output_format: "png",
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof payload?.error === "string" ? payload.error : payload?.error?.message || payload?.message;
      throw new StudioError(`AI image endpoint returned HTTP ${response.status}${detail ? `: ${clean(detail, 160)}` : "."}`, "MC_IMAGE_ENDPOINT_FAILED", 502);
    }
    const output = await extractImageBytes(payload, fetchImpl, combinedSignal);
    if (!output?.bytes || output.bytes.length < 1000) throw new StudioError("AI image endpoint returned no usable image.", "MC_IMAGE_OUTPUT_INVALID", 502);
    return output;
  } finally {
    clearTimeout(timer);
  }
}

async function importGeneratedImage(store, job, account, output, label) {
  const extension = output.extension === ".jpg" ? ".jpg" : ".png";
  const temporary = path.join(store.root, "temp", `${randomUUID()}${extension}`);
  await fs.writeFile(temporary, output.bytes);
  try {
    const media = await importMedia(store, temporary, {
      projectId: null,
      name: `${label}${extension}`,
      generated: true,
      move: true,
      jobId: job.id,
    });
    store.patch("accounts", account.id, {
      avatarMediaId: media.id,
      avatarName: "AI News Host",
      avatarSource: label.toLowerCase().includes("dreamface") ? "dreamface-image" : "highlight-endpoint",
      avatarGeneratedAt: new Date().toISOString(),
    });
    job.payload = { ...job.payload, avatarMediaId: media.id, avatarImageProvider: label };
    store.patch("jobs", job.id, { payload: job.payload });
    return media;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function dreamFaceImageStill(store, session, job, account, plan, signal, update) {
  const page = session.page;
  await page.goto("https://www.dreamfaceapp.com/image", { waitUntil: "domcontentloaded", timeout: 45000 });
  const prompt = page.getByPlaceholder("Type or paste text here");
  await prompt.waitFor({ state: "visible", timeout: 30000 });
  const before = new Set(await page.locator("img").evaluateAll((nodes) => nodes.map((node) => node.currentSrc || node.src).filter((url) => /dreamfaceapp\.com\/server\/common\/work/i.test(url))).catch(() => []));
  const body = await page.locator("body").innerText().catch(() => "");
  if (/no free|0\s+free\s+daily|insufficient credits|not enough credits/i.test(body)) {
    throw new StudioError("DreamFace Image has no free generation available on this profile today.", "MC_IMAGE_QUOTA", 402);
  }
  await prompt.fill(String(plan?.mcImagePrompt || DEFAULT_MC_IMAGE_PROMPT).slice(0, 1500));
  const create = page.getByRole("button", { name: "Create", exact: true }).first();
  if (!await create.isVisible().catch(() => false)) throw new StudioError("DreamFace Image is unavailable.", "MC_IMAGE_NOT_READY", 422);
  if (await create.isDisabled().catch(() => true)) throw new StudioError("DreamFace Image is not ready.", "MC_IMAGE_NOT_READY", 422);
  update({ status: "generating_mc_image", provider: "dreamface-image", progress: 2 });
  await create.click();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const currentBody = await page.locator("body").innerText().catch(() => "");
    if (/insufficient credits|not enough credits|daily free.*limit|failed to generate/i.test(currentBody)) {
      throw new StudioError("DreamFace Image has no available generation credit on this profile.", "MC_IMAGE_QUOTA", 402);
    }
    const urls = await page.locator("img").evaluateAll((nodes) => nodes.map((node) => node.currentSrc || node.src).filter((url) => /dreamfaceapp\.com\/server\/common\/work/i.test(url))).catch(() => []);
    const fresh = urls.find((url) => !before.has(url));
    if (fresh) {
      const response = await session.context.request.get(fresh, { timeout: 60000, headers: { Referer: page.url() } });
      if (response.ok()) {
        const contentType = String(response.headers()["content-type"] || "").toLowerCase();
        const extension = contentType.includes("jpeg") ? ".jpg" : ".png";
        const bytes = await response.body();
        await response.dispose();
        if (bytes.length > 1000) return importGeneratedImage(store, job, account, { extension, bytes }, "DreamFace AI MC");
      } else await response.dispose();
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 2500);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); }, { once: true });
    });
  }
  throw new StudioError("Timed out waiting for DreamFace Image.", "MC_IMAGE_TIMEOUT", 408);
}

export async function ensureNewsMcImage(store, session, job, account, plan, signal, update = () => {}) {
  const existingId = job.payload.avatarMediaId || account.avatarMediaId;
  const existing = existingId ? store.state.media.find((media) => media.id === existingId && media.kind === "image") : null;
  const reusable = existing && ["highlight-endpoint", "dreamface-image"].includes(account.avatarSource);
  if (reusable) return existing;

  const config = await resolveMcImageConfig(store);
  const failures = [];
  if (config.source !== "unconfigured" && config.source !== "disabled") {
    try {
      update({ status: "generating_mc_image", provider: "highlight-endpoint", progress: 1 });
      const output = await generateImageEndpoint({ config, prompt: plan?.mcImagePrompt || DEFAULT_MC_IMAGE_PROMPT, signal });
      const media = await importGeneratedImage(store, job, account, output, "AI News Host · Highlight");
      store.log(job, `AI MC still generated with ${config.source === "highlight-config" ? "Highlight" : "the configured image endpoint"}.`);
      return media;
    } catch (error) {
      failures.push(`Highlight image: ${safeErrorMessage(error)}`);
      store.log(job, failures.at(-1));
    }
  }
  if (config.dreamfaceFallback !== false) {
    try {
      const media = await dreamFaceImageStill(store, session, job, account, plan, signal, update);
      store.log(job, "AI MC still generated with DreamFace Image fallback.");
      return media;
    } catch (error) {
      failures.push(`DreamFace Image: ${safeErrorMessage(error)}`);
      store.log(job, failures.at(-1));
    }
  }
  throw new StudioError(`Could not create an AI MC still. ${failures.join(" ")}`, "MC_IMAGE_REQUIRED", 422);
}

export async function inspectMcImageSettings(store) {
  const config = await resolveMcImageConfig(store);
  return {
    enabled: config.enabled !== false,
    source: config.source,
    endpoint: config.endpoint || "",
    model: config.model || "",
    autoDiscover: config.autoDiscover !== false,
    dreamfaceFallback: config.dreamfaceFallback !== false,
    hasApiKey: Boolean(config.apiKey),
  };
}
