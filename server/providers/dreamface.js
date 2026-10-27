import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { providers } from "../../shared/contracts.js";
import { importMedia, probe, binary, runProcess } from "../media.js";
import { StudioError } from "../store.js";
import { ensureNewsMcImage } from "../mc-image.js";

export const DREAMFACE_PROVIDER = "dreamface";
export const DREAMFACE_URL = providers.dreamface.url;
const DREAMFACE_HOST = "dreamfaceapp.com";
export const GOOGLE_SIGNUP_URL = "https://accounts.google.com/signup";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function domainMatches(value) {
  const host = String(value || "").replace(/^\./, "").toLowerCase();
  return host === DREAMFACE_HOST || host.endsWith(`.${DREAMFACE_HOST}`);
}

function providerError(message, code = "DREAMFACE_ERROR", status = 400) {
  return new StudioError(message, code, status);
}

export function isDreamFaceGenerateLabel(value) {
  return /^(?:\d+\s+)?Generate(?:\s+\d+)?$/i.test(String(value || "").replace(/\s+/g, " ").trim());
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

function generateButtonLocators(page) {
  // DreamFace shows the remaining free quota in the submit label, for
  // example "2 Generate".  The old exact "Generate" selector missed that
  // valid button and made a connected profile look unavailable.
  const label = /^(?:\d+\s+)?Generate(?:\s+\d+)?$/i;
  return [
    page.getByRole("button", { name: label }),
    page.locator("button:visible").filter({ hasText: label }),
    page.getByRole("button", { name: /Generate.*Avatar|Create.*Avatar/i }),
    page.getByRole("button", { name: /^(?:\d+\s+)?Free Daily$/i }),
    page.locator("button:visible").filter({ hasText: /^(?:\d+\s+)?Free Daily$/i }),
  ];
}

async function findGenerateButton(page) {
  return firstVisible(generateButtonLocators(page));
}

async function findAvailableRadio(radios, preferred, fallbackPattern = null, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const options = await radios.evaluateAll((nodes) => nodes.map((node, index) => {
      const style = getComputedStyle(node);
      return {
        index,
        label: String(node.innerText || "").trim(),
        visible: style.display !== "none" && style.visibility !== "hidden" && Boolean(node.getClientRects().length),
        disabled: Boolean(node.disabled) || node.getAttribute("aria-disabled") === "true",
      };
    }).filter((item) => item.visible && !item.disabled)).catch(() => []);
    for (const wanted of preferred) {
      const match = options.find((item) => item.label === wanted);
      if (match) return match;
    }
    if (fallbackPattern) {
      const match = options.find((item) => fallbackPattern.test(item.label));
      if (match) return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return null;
}

export function classifyGoogleSignupPage({ url = "", body = "", captcha = false, formVisible = false } = {}) {
  const text = String(body || "");
  let hostname = "";
  try { hostname = new URL(String(url || "")).hostname; } catch {}
  if (captcha || /captcha|recaptcha|verify you(?:'|’)?re human|verify you are human|confirm you(?:'|’)?re not a robot|confirm you are not a robot/i.test(text)) {
    return {
      status: "verification",
      authStep: "captcha",
      message: "Google đang yêu cầu CAPTCHA. Hãy giải trong cửa sổ Chrome đang mở, rồi bấm Kiểm tra Gmail.",
    };
  }
  if (/phone number|verify your phone|enter the code|verification code|2-step verification|xác minh số điện thoại/i.test(text)) {
    return {
      status: "verification",
      authStep: "identity",
      message: "Google đang yêu cầu số điện thoại hoặc mã xác minh. Hãy hoàn tất trong cửa sổ Chrome, rồi bấm Kiểm tra Gmail.",
    };
  }
  if (/^(?:myaccount|mail)\.google\.com$/i.test(hostname) ||
      /your google account was created|welcome to your new google account|account created successfully/i.test(text)) {
    return {
      status: "created",
      authStep: "ready",
      message: "Gmail đã được tạo và đang đăng nhập trong profile Chrome này. Hãy tiếp tục kết nối DreamFace.",
    };
  }
  if (formVisible) {
    return {
      status: "pending",
      authStep: "form",
      message: "Google signup đang mở. App đã tự điền thông tin có thể điền; hãy hoàn tất các trường còn lại rồi bấm Kiểm tra Gmail.",
    };
  }
  return {
    status: "pending",
    authStep: "review",
    message: "Google signup đang chờ thao tác trong cửa sổ Chrome. Hoàn tất rồi bấm Kiểm tra Gmail.",
  };
}

export function classifyDreamFaceSignupPage({ body = "", captcha = false, formVisible = false } = {}) {
  const text = String(body || "");
  if (captcha || /captcha|recaptcha|verify you'?re human|verify you are human|confirm you'?re not a robot|confirm you are not a robot|i'?m not a robot|not a robot|human verification|security check/i.test(text)) {
    return {
      status: "verification",
      authStep: "captcha",
      message: "DreamFace đang yêu cầu CAPTCHA. Hãy giải trong cửa sổ Chrome đang mở, rồi bấm Kiểm tra phiên.",
    };
  }
  if (formVisible) {
    return {
      status: "pending",
      authStep: "credentials",
      message: "DreamFace đã được điền email và mật khẩu. Hãy hoàn tất bước đăng nhập/đăng ký còn lại trong cửa sổ Chrome.",
    };
  }
  return {
    status: "needs_login",
    authStep: "service",
    message: "DreamFace chưa xác nhận phiên. Hãy hoàn tất đăng nhập trong cửa sổ Chrome rồi bấm Kiểm tra phiên.",
  };
}

async function fillFirstVisible(page, selectors, value) {
  if (!value) return false;
  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if (await field.isVisible().catch(() => false)) {
      await field.fill(String(value));
      return true;
    }
  }
  return false;
}

async function inspectGoogleSignupPage(page) {
  const body = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  const captcha = await page.locator([
    'iframe[src*="captcha"]:visible',
    'iframe[src*="recaptcha"]:visible',
    '[id*="captcha"]:visible',
    '[class*="captcha"]:visible',
  ].join(",")).count().catch(() => 0);
  const formVisible = await page.locator([
    'input[name="firstName"]:visible',
    'input[name="Username"]:visible',
    'input[name="Passwd"]:visible',
    'input[autocomplete="username"]:visible',
    'input[autocomplete="new-password"]:visible',
  ].join(",")).count().catch(() => 0);
  return classifyGoogleSignupPage({
    url: page.url(),
    body,
    captcha: captcha > 0,
    formVisible: formVisible > 0,
  });
}

async function clickGoogleNext(page) {
  const next = await firstVisible([
    page.locator('#accountDetailsNext:visible'),
    page.locator('#identifierNext:visible'),
    page.getByRole("button", { name: /^Next$/i }),
    page.locator('[role="button"]:visible').filter({ hasText: /^Next$/i }),
    page.locator('input[type="submit"]:visible'),
  ]);
  if (!next) return false;
  await next.click().catch(() => {});
  return true;
}

async function dismissDreamFacePromos(page) {
  const dismiss=page.getByText("Close",{exact:true}).first();
  if(await dismiss.isVisible().catch(()=>false))await dismiss.click().catch(()=>{});
  const dialogs = page.locator('[role="dialog"]:visible');
  const count = await dialogs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const dialog = dialogs.nth(index);
    if (await dialog.locator('input[type="email"]:visible, input[type="password"]:visible').count()) continue;
    const close = await firstVisible([
      dialog.getByRole("button", { name: /^Close$/i }),
      dialog.locator('button[aria-label="Close"]'),
    ]);
    if (close) await close.click().catch(() => {});
  }
}

async function openDreamFaceLogin(page) {
  await page.getByText(/^Log\s*in\s*\/\s*Sign\s*up$/i).first().waitFor({state:"visible",timeout:15000}).catch(()=>{});
  await dismissDreamFacePromos(page);
  const email = page.locator('input[type="email"]:visible').first();
  const password = page.locator('input[type="password"]:visible').first();
  if (await email.isVisible().catch(() => false) && await password.isVisible().catch(() => false)) {
    return { email, password };
  }
  const login = await firstVisible([
    page.getByText(/^Log\s*in\s*\/\s*Sign\s*up$/i),
    page.getByText(/^Log\s*In\s*\/\s*Sign\s*Up$/i),
    page.getByRole("button", { name: /log\s*in.*sign\s*up/i }),
  ]);
  if (login) await login.click().catch(() => {});
  await email.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  await password.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  if (!(await email.isVisible().catch(() => false)) || !(await password.isVisible().catch(() => false))) return null;
  return { email, password };
}

async function dreamFaceComposer(page) {
  return firstVisible([
    page.locator('[contenteditable="true"][role="textbox"]'),
    page.locator('[contenteditable="true"]'),
    page.locator('textarea[placeholder="Type or paste text here"]:visible'),
    page.locator('textarea:visible'),
  ]);
}

function pageDialog(page) {
  return page.locator('[role="dialog"]:visible').last();
}

function collectUrls(value, result = [], depth = 0) {
  if (depth > 18 || value === null || value === undefined) return result;
  if (typeof value === "string") {
    if (/^(?:https?:|blob:)/i.test(value)) result.push(value);
    else if (/^[\[{]/.test(value)) {
      try { collectUrls(JSON.parse(value), result, depth + 1); } catch {}
    }
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, result, depth + 1);
    return result;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectUrls(item, result, depth + 1);
  }
  return result;
}

function isLikelyVideoResultUrl(value) {
  const url = String(value || "");
  if (!/^(?:https?:|blob:)/i.test(url)) return false;
  // Creations exposes poster/thumbnail images under the same /work/ path as
  // the video. Never send those image URLs to ffprobe as presenter videos.
  if (/(?:_image|thumbnail|poster)\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(url)) return false;
  return /(?:\.mp4|\.webm|\.mov)(?:[?#]|$)|blob:|download|video|media|\/work(?:\/|[?#]|$)/i.test(url);
}

async function importBrowserDownload(store, job, download, signal) {
  signal.throwIfAborted();
  const temporary = path.join(store.root, "temp", `${randomUUID()}.mp4`);
  try {
    await download.saveAs(temporary);
    signal.throwIfAborted();
    const metadata = await probe(temporary, store.state.settings);
    if (!metadata.duration || metadata.duration <= 0) throw providerError("DreamFace returned an invalid video.", "INVALID_PROVIDER_RESULT");
    return await importMedia(store, temporary, {
      name: `${job.name}.mp4`,
      projectId: job.projectId,
      generated: true,
      move: true,
      jobId: job.id,
    });
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function downloadResult(store, session, job, url, signal) {
  signal.throwIfAborted();
  const temporary = path.join(store.root, "temp", `${randomUUID()}.mp4`);
  try {
    let body;
    if (url.startsWith("blob:")) {
      const encoded = await session.page.evaluate(async (source) => {
        const blob = await (await fetch(source)).blob();
        if (blob.size > 500 * 1024 * 1024) throw new Error("Tệp DreamFace vượt quá 500 MB.");
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }, url);
      body = Buffer.from(encoded, "base64");
    } else {
      const response = await session.context.request.get(url, {
        timeout: 120000,
        headers: { Referer: session.page.url() },
      });
      if (!response.ok()) throw providerError(`Tải video DreamFace thất bại: HTTP ${response.status()}.`, "DOWNLOAD_FAILED");
      if (Number(response.headers()["content-length"]) > 500 * 1024 * 1024) throw providerError("Tệp DreamFace vượt quá 500 MB.", "DOWNLOAD_FAILED");
      body = await response.body();
      await response.dispose();
    }
    signal.throwIfAborted();
    await fs.writeFile(temporary, body);
    const metadata = await probe(temporary, store.state.settings);
    if (!metadata.duration || metadata.duration <= 0) throw providerError("DreamFace không trả về video hợp lệ.", "INVALID_PROVIDER_RESULT");
    return await importMedia(store, temporary, {
      name: `${job.name}.mp4`,
      projectId: job.projectId,
      generated: true,
      move: true,
      jobId: job.id,
    });
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function configureDreamFace(page, task) {
  await dismissDreamFacePromos(page);
  const settingButton = await firstVisible([
    page.getByRole("button", { name: /^(?:Setting|Settings|Preferences)$/i }),
    page.locator('button[aria-label="Settings"]'),
  ]);
  if (!settingButton) throw providerError("DreamFace video settings are unavailable. Open the profile and check the Video tool.","PROVIDER_NOT_READY");
  await settingButton.click();
  const dialog = page.locator('[role="dialog"]:visible').last();
  if (!(await dialog.isVisible().catch(() => false))) throw providerError("Không mở được cài đặt DreamFace.", "PROVIDER_NOT_READY");
  const duration = dialog.getByText(new RegExp(`^\\s*${Number(task.duration)}s\\s*$`, "i")).first();
  if (!(await duration.isVisible().catch(() => false))) {
    await settingButton.click().catch(() => {});
    throw providerError(`DreamFace không có lựa chọn ${task.duration} giây trong tài khoản này.`, "UNSUPPORTED_DURATION");
  }
  await duration.click();
  const ratioLabel = task.ratio === "16:9" ? "Landscape" : task.ratio === "9:16" ? "Portrait" : "";
  if (!ratioLabel) {
    await settingButton.click().catch(() => {});
    throw providerError("DreamFace hiện chỉ hỗ trợ tỷ lệ 16:9 hoặc 9:16.", "UNSUPPORTED_RATIO");
  }
  const ratio = dialog.getByText(ratioLabel, { exact: true }).first();
  if (!(await ratio.isVisible().catch(() => false))) {
    await settingButton.click().catch(() => {});
    throw providerError(`DreamFace không có lựa chọn tỷ lệ ${task.ratio}.`, "UNSUPPORTED_RATIO");
  }
  await ratio.click();
  const selected=await ratio.locator("..").getAttribute("class");
  if(!/active|selected|checked/i.test(selected||""))throw providerError("DreamFace did not confirm the selected video ratio.","PROVIDER_NOT_READY");
  await settingButton.click().catch(() => {});
}

export async function prepareDreamFaceReferences(store,page,task) {
  const references=(task.references||[]).map(id=>store.require("media",id));
  if(references.some(media=>media.kind!=="image"||media.projectId&&media.projectId!==task.projectId))throw providerError("Choose reference images from this project.","INVALID_REFERENCE");
  const mode=references.length>1?"References to Video":"Image or Text";
  const tab=page.getByText(mode,{exact:true}).first();
  if(!await tab.isVisible())throw providerError("The DreamFace reference mode is unavailable.","PROVIDER_NOT_READY");
  await tab.click();
  if(!references.length)return [];
  const temporary=[];
  try {
    const files=[];
    for(const media of references) {
      if(/\.(png|jpe?g)$/i.test(media.file))files.push(media.file);
      else {
        const file=path.join(store.root,"temp",`${randomUUID()}.png`);
        temporary.push(file);
        await runProcess(binary("ffmpeg",store.state.settings),["-y","-i",media.file,"-frames:v","1",file]);
        files.push(file);
      }
    }
    const inputs=page.locator('input[type="file"]');let selected;
    for(let i=0;i<await inputs.count();i++) {
      const candidate=inputs.nth(i);
      if(await candidate.locator("..").isVisible()&&(files.length===1||await candidate.getAttribute("multiple")!==null)){selected=candidate;break;}
    }
    if(!selected)throw providerError("DreamFace's image upload control is unavailable.","PROVIDER_NOT_READY");
    await selected.setInputFiles(files);
    await selected.locator("..").locator("..").locator("img").first().waitFor({state:"visible",timeout:30000});
    return temporary;
  } catch(error) {await Promise.all(temporary.map(file=>fs.rm(file,{force:true})));throw error;}
}

function validateProxy(value) {
  if (!value) return undefined;
  let proxy;
  try {
    proxy = new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    throw providerError("Proxy DreamFace không hợp lệ.", "INVALID_PROXY");
  }
  if (!["http:", "https:", "socks5:"].includes(proxy.protocol)) {
    throw providerError("Proxy DreamFace phải dùng HTTP, HTTPS hoặc SOCKS5.", "INVALID_PROXY");
  }
  if (proxy.username || proxy.password) {
    throw providerError("Proxy DreamFace không nhận thông tin xác thực trong profile.", "INVALID_PROXY");
  }
  return `${proxy.protocol}//${proxy.host}`;
}

function normaliseCookie(item) {
  if (!item || typeof item.name !== "string" || typeof item.value !== "string") return null;
  if (!item.name || /[\s;=]/.test(item.name)) throw providerError("Tên cookie DreamFace không hợp lệ.", "INVALID_COOKIE");
  const domain = item.domain || `.${DREAMFACE_HOST}`;
  if (!domainMatches(domain)) return null;
  const expires = Number(item.expires ?? item.expirationDate ?? -1);
  return {
    name: item.name,
    value: item.value,
    domain,
    path: item.path || "/",
    expires: Number.isFinite(expires) && expires > 100000000000 ? expires / 1000 : (Number.isFinite(expires) ? expires : -1),
    httpOnly: Boolean(item.httpOnly),
    secure: item.secure !== false,
    sameSite: ["Strict", "Lax", "None"].includes(item.sameSite) ? item.sameSite : "Lax",
  };
}

/** Parse Cookie-Editor JSON, Netscape export, or a Cookie header for DreamFace only. */
export function parseDreamFaceCookies(input) {
  const source = String(input || "").trim();
  if (!source || source.length > 2 * 1024 * 1024) {
    throw providerError("Dữ liệu cookie DreamFace trống hoặc quá lớn.", "INVALID_COOKIE");
  }
  let entries;
  if (source.startsWith("[") || source.startsWith("{")) {
    try {
      const parsed = JSON.parse(source);
      entries = Array.isArray(parsed) ? parsed : parsed.cookies;
    } catch {
      throw providerError("JSON cookie DreamFace không hợp lệ.", "INVALID_COOKIE");
    }
  } else if (source.split(/\r?\n/).some((line) => line.split("\t").length >= 7)) {
    entries = source.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#") || line.startsWith("#HttpOnly_")).map((line) => {
      const httpOnly = line.startsWith("#HttpOnly_");
      const [domain, , cookiePath, secure, expiry, name, ...values] = line.replace(/^#HttpOnly_/, "").split("\t");
      return { domain, path: cookiePath, secure: secure === "TRUE", expires: Number(expiry) || -1, name, value: values.join("\t"), httpOnly };
    });
  } else {
    entries = source.replace(/^cookie\s*:\s*/i, "").split(/[;\r\n]+/).map((part) => {
      const separator = part.indexOf("=");
      return separator > 0 ? { name: part.slice(0, separator).trim(), value: part.slice(separator + 1).trim(), domain: `.${DREAMFACE_HOST}`, secure: true } : null;
    });
  }
  if (!Array.isArray(entries)) throw providerError("Cookie DreamFace phải là mảng JSON hoặc Cookie-Editor.", "INVALID_COOKIE");
  const cookies = [];
  const seen = new Set();
  for (const item of entries) {
    const cookie = normaliseCookie(item);
    if (!cookie || (cookie.expires !== -1 && cookie.expires <= Date.now() / 1000)) continue;
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      cookies.push(cookie);
    }
  }
  if (!cookies.length) throw providerError("Không có cookie DreamFace còn hạn trong dữ liệu đã nhập.", "INVALID_COOKIE");
  return cookies;
}

function accountId(account) {
  const id = account?.profileId || account?.id;
  if (!UUID_PATTERN.test(String(id || ""))) throw providerError("Profile DreamFace cần một account UUID hợp lệ.", "INVALID_ACCOUNT");
  return id;
}

function executableFrom(store, explicit) {
  const candidate = explicit || store?.state?.settings?.chromePath || chromium.executablePath();
  return candidate || undefined;
}

/**
 * Playwright-owned DreamFace profile. Automation is headless by default. Login
 * opens a visible window for sign-in and registration. Verification remains
 * in the service's own UI; only a verified session can enter the render queue.
 */
export class DreamFaceProvider {
  constructor({ store, browserType = chromium, executablePath } = {}) {
    if (!store?.root) throw providerError("DreamFace provider cần Store có thư mục dữ liệu.", "INVALID_PROVIDER");
    this.store = store;
    this.browserType = browserType;
    this.executablePath = executablePath;
    this.sessions = new Map();
    this.opening = new Map();
  }

  profileDirectory(account) {
    const id = accountId(account);
    const root = path.resolve(this.store.root, "profiles");
    const directory = path.resolve(root, id);
    if (directory !== path.join(root, id)) throw providerError("Đường dẫn profile DreamFace không hợp lệ.", "INVALID_PROFILE");
    return directory;
  }

  async open(account, { visible = false } = {}) {
    const id = accountId(account);
    const prior = this.opening.get(id) || Promise.resolve();
    const pending = prior.catch(() => {}).then(async () => {
      let existing = this.sessions.get(id);
      let existingBrowser = null;
      try { existingBrowser = existing?.context?.browser?.(); } catch { existingBrowser = null; }
      if (existingBrowser && !existingBrowser.isConnected()) {
        this.sessions.delete(id);
        existing = null;
      }
      if (existing?.context && existing.visible === visible) {
        let closed = true;
        try { closed = existing.page.isClosed(); } catch { closed = true; }
        const page = closed ? await existing.context.newPage() : existing.page;
        existing.page = page;
        return existing;
      }
      if (existing) {
        try { await this.close(account); } catch { this.sessions.delete(id); }
      }
      const directory = this.profileDirectory(account);
      await fs.mkdir(directory, { recursive: true });
      const proxy = validateProxy(account.proxy);
      const context = await this.browserType.launchPersistentContext(directory, {
        headless: !visible,
        executablePath: executableFrom(this.store, this.executablePath),
        viewport: { width: 1360, height: 940 },
        locale: "en-US",
        proxy: proxy ? { server: proxy } : undefined,
      });
      const page = context.pages()[0] || await context.newPage();
      page.setDefaultTimeout(12000);
      const session = { context, browser: context.browser?.(), page, visible, profileId: id };
      this.sessions.set(id, session);
      return session;
    });
    this.opening.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.opening.get(id) === pending) this.opening.delete(id);
    }
  }

  async inspect(account, session, { navigate = false } = {}) {
    const page = session.page.isClosed() ? await session.context.newPage() : session.page;
    session.page = page;
    if (navigate || page.url() === "about:blank") {
      await page.goto(DREAMFACE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.locator('[contenteditable="true"],textarea,input[type="email"],a[href*="login"]').first().waitFor({state:"visible",timeout:10000}).catch(()=>{});
    }
    await dismissDreamFacePromos(page);
    const body = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
    const cookies = await session.context.cookies();
    const captcha = await page.locator('iframe[src*="captcha"]:visible, [class*="captcha"]:visible, [id*="captcha"]:visible').count().catch(() => 0);
    if (captcha || /verify you are human|confirm you.re not a robot|captcha|i'?m not a robot|not a robot|human verification|security check|xác minh bạn là người/i.test(body)) {
      return { status: "verification", authStep: "identity", message: "DreamFace yêu cầu xác minh. Hãy hoàn tất trong cửa sổ hiển thị rồi kiểm tra lại; provider không tự vượt CAPTCHA." };
    }
    // DreamFace's current web client stores the authenticated identity and
    // bearer token in a protected localStorage record. It does not set an
    // auth cookie, so a cookie-only check incorrectly reported this valid
    // session as needs_login after the user completed sign-in/CAPTCHA.
    const localStorageSession = await page.evaluate(() => {
      let found = false;
      for (const key of Object.keys(localStorage)) {
        try {
          const value = JSON.parse(localStorage.getItem(key));
          if (value && typeof value === "object" && value.userId && value.accountId && value.token) {
            found = true;
            break;
          }
        } catch {}
      }
      return found;
    }).catch(() => false);
    const cookieSession = cookies.some((cookie) => cookie.value && domainMatches(cookie.domain) && /session|token|auth|sid/i.test(cookie.name));
    const loginFields = await page.locator('input[type="email"]:visible, input[type="password"]:visible').count().catch(() => 0);
    const loginCta = await firstVisible([
      page.getByText(/^Log\s*in\s*\/\s*Sign\s*up$/i),
      page.getByText(/^Log\s*In\s*\/\s*Sign\s*Up$/i),
      page.getByRole("button", { name: /log\s*in.*sign\s*up/i }),
    ]);
    const composer = await dreamFaceComposer(page);
    const hasSession = localStorageSession || cookieSession;
    if (domainMatches(new URL(page.url()).hostname) && hasSession && loginFields === 0 && !loginCta && (composer || /Generate avatar videos|Want Avatar to Say|Generate video/i.test(body))) {
      return { status: "ready", authStep: "ready", renderReady: true, message: "Sẵn sàng render DreamFace News." };
    }
    return { status: "needs_login", authStep: "service", message: "DreamFace chưa xác nhận phiên. Hãy đăng nhập bằng tài khoản của bạn hoặc nhập cookie hợp lệ rồi kiểm tra lại." };
  }

  async check(account) {
    if(account.status==="busy")throw providerError("This profile is rendering. Wait for it to finish.","PROFILE_BUSY",409);
    const existing=this.sessions.get(account.id);
    // A hidden session can retain an in-memory DreamFace login after the
    // browser profile has expired. Reopen it for a real check so the badge
    // reflects what the next queue run can actually use. Keep a visible
    // session intact because it may contain a CAPTCHA the user is solving.
    if (existing && !existing.visible) {
      await this.close(account).catch(() => {});
    }
    const session = existing?.visible&&!existing.page.isClosed()?existing:await this.open(account, { visible: false });
    const result = await this.inspect(account, session, { navigate: !existing?.visible });
    return { ...result, checkedAt: new Date().toISOString() };
  }

  async login(account, input = {}) {
    const cookies = input.cookies ? parseDreamFaceCookies(input.cookies) : null;
    const hasCredentials = Boolean(input.email && input.password);
    if (!cookies && !hasCredentials) throw providerError("Enter DreamFace email and password, or create a profile with saved sign-in details.", "CREDENTIALS_REQUIRED");
    if (input.email && !/^\S+@\S+\.\S+$/.test(input.email)) throw providerError("Email DreamFace không hợp lệ.", "INVALID_CREDENTIALS");
    const session = await this.open(account, { visible: true });
    if (cookies) {
      await session.context.addCookies(cookies);
      return this.inspect(account, session, { navigate: true });
    }
    await session.page.goto(DREAMFACE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    const fields = await openDreamFaceLogin(session.page);
    if (!fields) {
      return { status: "needs_login", authStep: "service", message: "DreamFace is open. Complete sign-in or registration in its window, then check the session." };
    }
    const { email: emailField, password: passwordField } = fields;
    await emailField.fill(input.email);
    await passwordField.fill(input.password);
    const submit = await firstVisible([
      pageDialog(session.page).getByRole("button", { name: /^(?:Sign\s*up|Create\s*account|Register|Continue|Next)$/i }),
      pageDialog(session.page).getByRole("button", { name: /^Log\s*in$/i }),
      session.page.getByRole("button", { name: /^(?:Sign\s*up|Create\s*account|Register|Continue|Next)$/i }),
      session.page.getByRole("button", { name: /^Log\s*in$/i }),
      session.page.locator('button[type="submit"]:visible'),
      session.page.locator('input[type="submit"]:visible'),
    ]);
    if (submit) await submit.click().catch(() => passwordField.press("Enter"));
    else await passwordField.press("Enter");
    await Promise.race([
      passwordField.waitFor({state:"hidden",timeout:12000}),
      session.page.locator('iframe[src*="captcha"]:visible').first().waitFor({state:"visible",timeout:12000}),
    ]).catch(()=>{});
    const result=await this.inspect(account,session);
    return {...result,message:result.status==="ready"?"DreamFace is connected. This saved profile can render videos.":result.status==="verification"?"DreamFace needs CAPTCHA verification. Complete it in the open window, then click Check session.":"Sign-in details are saved. Complete registration in the DreamFace window, then click Check session."};
  }

  async startDreamFaceSignup(account, credentials) {
    if (!credentials?.email || !credentials?.password)
      throw providerError("DreamFace email and password are required.", "CREDENTIALS_REQUIRED");
    const result = await this.login(account, credentials);
    if (result.status === "verification") {
      return {
        ...result,
        authStep: "captcha",
        message: "DreamFace requires CAPTCHA verification. Solve it in the open Chrome window, then click Check session.",
      };
    }
    if (result.status === "ready") return result;
    const session = this.sessions.get(account.id);
    const page = session?.page;
    if (page && !page.isClosed()) {
      const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const formVisible = await page.locator('input[type="email"]:visible, input[type="password"]:visible').count().catch(() => 0);
      const hint = classifyDreamFaceSignupPage({ body, formVisible: formVisible > 0 });
      return { ...result, authStep: hint.authStep, message: hint.message };
    }
    return result;
  }

  async checkDreamFaceSignup(account) {
    const existing = this.sessions.get(account.id);
    const session = existing?.visible && !existing.page.isClosed()
      ? existing
      : await this.open(account, { visible: true });
    return this.inspect(account, session, { navigate: !existing?.visible });
  }

  // Compatibility aliases for older saved UI actions. These actions now stay
  // on DreamFace and never open a Google signup page.
  async startGmailSignup(account, credentials) {
    return this.startDreamFaceSignup(account, credentials);
  }

  async checkGmailSignup(account) {
    return this.checkDreamFaceSignup(account);
  }

  async importCookies(account, input) {
    const cookies = parseDreamFaceCookies(input);
    const session = await this.open(account, { visible: false });
    await session.context.addCookies(cookies);
    const result = await this.inspect(account, session, { navigate: true });
    return { ...result, cookieCount: cookies.length };
  }

  async withAuthenticatedSession(account, action) {
    const session = await this.open(account, { visible: false });
    const state = await this.inspect(account, session, { navigate: true });
    if (state.status !== "ready") throw providerError(state.message, state.status === "verification" ? "VERIFICATION" : "NEEDS_LOGIN", 401);
    return action(session);
  }

  /** Create a narrated presenter clip in DreamFace's Avatar tool. */
  async generateNewsAvatar(store, job, account, signal, update) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.generateNewsAvatarOnce(store, job, account, signal, update);
      } catch (error) {
        const closed = /target page|context.*closed|browser.*closed|page has been closed|page\.goto/i.test(String(error?.message || ""));
        if (!closed || attempt > 0) throw error;
        const id = accountId(account);
        const priorSession = this.sessions.get(id);
        this.sessions.delete(id);
        try { await priorSession?.context?.close?.(); } catch {}
        update({ status: "retrying", workflow: "avatar-news", retry: 1, progress: 1 });
        store.log(job, "DreamFace browser session closed unexpectedly; reopened the profile and retried once.");
      }
    }
    throw providerError("DreamFace presenter could not be reopened.", "PROVIDER_NOT_READY");
  }

  async recoverExistingNewsAvatar(store, job, account, signal, update) {
    const session = await this.open(account, { visible: false });
    const state = await this.inspect(account, session, { navigate: true });
    if (state.status !== "ready") {
      throw providerError(state.message, state.status === "verification" ? "VERIFICATION" : "NEEDS_LOGIN", 401);
    }
    const { page } = session;
    const plan = job.payload.newsPlan || {};
    const terms = [...new Set(`${plan.headline || ""} ${plan.narration || ""}`
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .match(/[a-z0-9]{5,}/g) || [])];
    await page.goto("https://www.dreamfaceapp.com/creation", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);
    const cards = page.locator('div[class*="_card_"]');
    for (let index = 0; index < await cards.count().catch(() => 0); index += 1) {
      signal.throwIfAborted();
      const card = cards.nth(index);
      const text = `${await card.innerText().catch(() => "")} ${await card.locator("img").first().getAttribute("alt").catch(() => "")}`
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "");
      if (!terms.some((term) => text.includes(term))) continue;
      const downloadButton = card.locator("button").first();
      if (!await downloadButton.count()) continue;
      await card.hover().catch(() => {});
      const downloadPromise = page.waitForEvent("download", { timeout: 12000 }).catch(() => null);
      await downloadButton.click({ timeout: 8000 }).catch(() => {});
      const download = await downloadPromise;
      if (!download) continue;
      update({ status: "recovering", workflow: "avatar-news", progress: 82 });
      const media = await importBrowserDownload(store, job, download, signal);
      if (!media.hasAudio) throw providerError("DreamFace Avatar result has no audio track.", "NEWS_PRESENTER_AUDIO_REQUIRED", 422);
      store.log(job, `Recovered the submitted DreamFace Avatar result from Creations: ${media.width}x${media.height}, ${media.duration.toFixed(2)} seconds.`);
      return media;
    }
    throw providerError("No completed DreamFace Avatar result matching this submitted News job was found in Creations.", "PROVIDER_RESULT_NOT_FOUND", 404);
  }

  async generateNewsAvatarOnce(store, job, account, signal, update) {
    if (job.payload.recoverSubmitted) return this.recoverExistingNewsAvatar(store, job, account, signal, update);
    const session = await this.open(account, { visible: false });
    const state = await this.inspect(account, session, { navigate: true });
    if (state.status !== "ready") {
      throw providerError(state.message, state.status === "verification" ? "VERIFICATION" : "NEEDS_LOGIN", 401);
    }
    const { page } = session;
    const plan = job.payload.newsPlan || {};
    const oldCreationImages = new Set();
    // Snapshot existing creation thumbnails before submitting so polling never
    // downloads an older work when a profile already has history.
    await page.goto("https://www.dreamfaceapp.com/creation", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(700);
    for (const url of await page.locator("img").evaluateAll((nodes) => nodes.map((node) => node.currentSrc || node.src).filter(Boolean)).catch(() => [])) oldCreationImages.add(url);

    // Avatar 3.0 Fast needs a processed still. Generate one original AI MC
    // automatically, reuse it for this DreamFace profile, and fall back to the
    // DreamFace Image tool only when the configured Highlight-compatible image
    // endpoint is unavailable.
    const avatarMedia = await ensureNewsMcImage(store, session, job, account, plan, signal, update);
    if (avatarMedia.kind !== "image") throw providerError("The generated MC still is not a valid image.", "INVALID_AVATAR_IMAGE", 422);

    await page.goto("https://www.dreamfaceapp.com/avatar", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.getByText("More", { exact: true }).first().waitFor({ state: "visible", timeout: 30000 });
    await page.waitForTimeout(1800);
    await page.getByPlaceholder("Type or paste text here").waitFor({ state: "visible", timeout: 30000 });
    // Upload the saved still first. This unlocks the Avatar 3.0 family in the
    // current DreamFace UI and makes the selected effect explicit and testable.
    const imageInput = page.locator('input[type="file"]').first();
    if (!await imageInput.count()) throw providerError("DreamFace Avatar image upload is unavailable.", "PROVIDER_NOT_READY");
    await imageInput.setInputFiles(avatarMedia.file);
    await page.waitForTimeout(1800);

    const prompt = page.getByPlaceholder("Type or paste text here");
    await prompt.fill(String(plan.narration || "").slice(0, 500));
    const effect = page.getByRole("button", { name: /Animate Effect/i }).first();
    if (!await effect.isVisible().catch(() => false)) throw providerError("DreamFace Animate Effect is unavailable.", "PROVIDER_NOT_READY");
    await effect.click();
    // The uploaded still is processed asynchronously. Open the effect menu and
    // wait for DreamFace to enable the Avatar 3.0 family instead of relying on
    // a short fixed delay, which can race the image-processing request.
    // The provider can keep the composer visible while the uploaded image is
    // still processing, so allow the motion options to settle before reading them.
    await page.waitForTimeout(6500);
    const radios = page.getByRole("radio");
    const effectChoice = await findAvailableRadio(radios, ["Avatar 3.0 Fast", "Avatar 3.0", "Avatar 2.0", "Avatar"], /avatar/i);
    const selectedRadio = effectChoice ? radios.nth(effectChoice.index) : null;
    const selectedEffect = effectChoice?.label || "";
    if (!selectedRadio) throw providerError("DreamFace chưa có Avatar effect khả dụng cho ảnh MC này. Hãy đổi ảnh MC hoặc kiểm tra quota profile.", "PROVIDER_NOT_READY");
    await selectedRadio.click();
    if (await selectedRadio.getAttribute("aria-checked") === "false") throw providerError("DreamFace không xác nhận Avatar effect.", "PROVIDER_NOT_READY");
    if (selectedEffect !== "Avatar 3.0 Fast") store.log(job, `Avatar 3.0 Fast unavailable; using ${selectedEffect}.`);

    const resolution = page.getByRole("button", { name: /Resolution/i }).first();
    if (!await resolution.isVisible().catch(() => false)) throw providerError("DreamFace resolution selector is unavailable.", "PROVIDER_NOT_READY");
    await resolution.click();
    const resolutionRadios = page.getByRole("radio");
    const resolutionChoice = await findAvailableRadio(resolutionRadios, ["720p", "480p", "1080p"]);
    const selectedResolutionRadio = resolutionChoice ? resolutionRadios.nth(resolutionChoice.index) : null;
    const selectedResolution = resolutionChoice?.label || "";
    if (!selectedResolutionRadio) throw providerError("DreamFace không có độ phân giải khả dụng cho profile này.", "PROVIDER_NOT_READY");
    await selectedResolutionRadio.click();
    update({ status: "configured", workflow: "avatar-news", effect: selectedEffect, resolution: selectedResolution, quota: "Free Daily", progress: 3 });
    const baseline = new Set(await page.locator("video, video source").evaluateAll((nodes) => nodes.map((node) => node.currentSrc || node.src).filter(Boolean)));
    for (const url of oldCreationImages) baseline.add(url);
    let generate = null;
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => /generate|free\s+daily/i.test(button.innerText.trim())), null, { timeout: 30000 }).catch(() => {});
    generate = await findGenerateButton(page);
    if (!generate) throw providerError("DreamFace Avatar chưa có nút Generate khả dụng. Hãy kiểm tra effect, quota và ảnh MC.", "PROVIDER_NOT_READY");
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => /generate|free\s+daily/i.test(button.innerText.trim()) && !button.disabled), null, { timeout: 30000 }).catch(() => {
      const body = document.body?.innerText || "";
      if (/\b0\s+Free\b|not enough credits|insufficient credits|daily free.*limit/i.test(body)) {
        throw providerError("DreamFace has no free generation credit left on this profile today.", "PROVIDER_QUOTA");
      }
      throw providerError("DreamFace Avatar vẫn đang tải presenter. Hãy thử lại profile sau ít giây.", "PROVIDER_NOT_READY");
    });
    generate = await findGenerateButton(page);
    if (!generate || await generate.isDisabled().catch(() => true)) throw providerError("DreamFace Avatar chưa mở nút Generate khả dụng.", "PROVIDER_NOT_READY");
    update({ status: "submitting", submittedAt: new Date().toISOString(), workflow: "avatar-news", progress: 5 });
    const downloadCandidates = new Set();
    const responseListener = async (response) => {
      // Register before clicking Generate.  DreamFace can return the work
      // result in the submit response and that response is otherwise lost
      // before the old listener was attached.
      if (!/task|work|creation|result|video|download/i.test(response.url())) return;
      try {
        const type = String(response.headers()["content-type"] || "");
        if (type.includes("json")) for (const url of collectUrls(await response.json())) if (isLikelyVideoResultUrl(url)) downloadCandidates.add(url);
      } catch {}
    };
    page.on("response", responseListener);
    const browserDownloads = [];
    const downloadListener = (download) => browserDownloads.push(download);
    page.on("download", downloadListener);
    await Promise.allSettled([
      page.waitForURL(/\/creation/, { waitUntil: "domcontentloaded", timeout: 20000 }),
      generate.click(),
    ]);
    store.log(job, "DreamFace Avatar submitted; waiting for the new Creations result.");
    update({ status: "rendering", workflow: "avatar-news", progress: 18, elapsedSeconds: 0 });
    // The Avatar composer sometimes keeps the same route after submission.
    // Explicitly open Creations so polling observes the server-side result in
    // both route behaviours.
    await page.goto("https://www.dreamfaceapp.com/creation", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const deadline = Date.now() + Math.max(2, Number(store.state.settings.maxWaitMinutes || 30)) * 60000;
    const started = Date.now();
    let nextRefresh = 0;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      for (const download of browserDownloads.splice(0)) {
        update({ status: "downloading", workflow: "avatar-news", progress: 82 });
        try {
          const media = await importBrowserDownload(store, job, download, signal);
          if (!media.hasAudio) throw providerError("DreamFace Avatar result has no audio track.", "NEWS_PRESENTER_AUDIO_REQUIRED", 422);
          store.log(job, `DreamFace Avatar browser download received: ${media.width}x${media.height}, ${media.duration.toFixed(2)} seconds.`);
          page.off("response", responseListener);
          page.off("download", downloadListener);
          return media;
        } catch (error) {
          store.log(job, `DreamFace browser download is not a valid presenter yet (${error.message}).`);
        }
      }
      if (Date.now() >= nextRefresh) {
        // Creations is a client-rendered list and does not always subscribe to
        // the generation stream. Refreshing it periodically is what makes a
        // completed card visible after a long provider render.
        await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        nextRefresh = Date.now() + Math.max(8000, Number(store.state.settings.pollSeconds || 5) * 2000);
      }
      const body = await page.locator("body").innerText().catch(() => "");
      if (/verify you are human|confirm you.re not a robot|captcha/i.test(body)) throw providerError("DreamFace requires verification. Complete it in the open account, then check the profile.", "VERIFICATION", 401);
      if (/not enough credits|insufficient credits|failed to generate|daily free.*limit/i.test(body)) throw providerError("DreamFace reported that this profile has no available generation credit.", "PROVIDER_QUOTA");
      // The Creations page has changed its hashed card class several times.
      // Look for fresh media elements and their nearest action container rather
      // than depending on one private CSS class. The response listener also
      // catches the official download URL returned by the site.
      const mediaNodes = page.locator("img, video, video source");
      for (let mediaIndex = 0; mediaIndex < await mediaNodes.count().catch(() => 0); mediaIndex += 1) {
        const mediaNode = mediaNodes.nth(mediaIndex);
        const imageUrl = await mediaNode.evaluate((node) => node.currentSrc || node.src || node.getAttribute("poster") || "").catch(() => "");
        if (!imageUrl || baseline.has(imageUrl)) continue;
        const isVideoNode = await mediaNode.evaluate((node) => node.tagName === "VIDEO" || node.tagName === "SOURCE").catch(() => false);
        if (isVideoNode && /^(?:blob:|https?:)/i.test(imageUrl)) downloadCandidates.add(imageUrl);
        let container = mediaNode;
        let buttons = null;
        for (let level = 0; level < 6; level += 1) {
          const candidate = container.locator("xpath=..");
          const candidateButtons = candidate.locator('button, [role="button"], a');
          if (await candidateButtons.count().catch(() => 0)) {
            container = candidate;
            buttons = candidateButtons;
            break;
          }
          container = candidate;
        }
        if (!buttons) continue;
        // DreamFace keeps card actions hidden until hover. Hover the nearest
        // action container before clicking its official Download control.
        await container.scrollIntoViewIfNeeded().catch(() => {});
        await container.hover({ timeout: 5000 }).catch(() => {});
        const downloadButton = await firstVisible([
          buttons.filter({ hasText: /download|save|export/i }),
          buttons.filter({ has: container.locator('[aria-label*="download" i], [title*="download" i]') }),
          container.getByRole("button", { name: /download|save|export/i }),
          container.locator('[aria-label*="download" i], [title*="download" i]'),
          // The current Creations card renders the official download action
          // as an icon-only first button; the second button is delete.
          buttons.first(),
        ]);
        if (downloadButton) {
          await downloadButton.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(1200);
        }
      }
      for (const href of await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => node.href).filter(Boolean)).catch(() => [])) {
        if (isLikelyVideoResultUrl(href) && !baseline.has(href)) downloadCandidates.add(href);
      }
      for (const url of [...downloadCandidates]) {
        downloadCandidates.delete(url);
        update({ status: "downloading", workflow: "avatar-news", progress: 82 });
        try {
          const media = await downloadResult(store, session, job, url, signal);
          if (!media.hasAudio) throw providerError("DreamFace Avatar result has no audio track.", "NEWS_PRESENTER_AUDIO_REQUIRED", 422);
          store.log(job, `DreamFace Avatar presenter ready: ${media.width}×${media.height}, ${media.duration.toFixed(2)} seconds.`);
          page.off("response", responseListener);
          return media;
        } catch (error) {
          store.log(job, `DreamFace Avatar result is not downloadable yet (${error.message}).`);
        }
      }
      update({ elapsedSeconds: Math.floor((Date.now() - started) / 1000), progress: 20 + Math.min(55, Math.floor((Date.now() - started) / 1000)) });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, Math.max(3000, Number(store.state.settings.pollSeconds || 5) * 1000));
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); }, { once: true });
      });
    }
    page.off("response", responseListener);
    page.off("download", downloadListener);
    throw providerError("Timed out waiting for the DreamFace Avatar presenter. Check Creations before retrying.", "PROVIDER_TIMEOUT", 408);
  }

  /**
   * Submit a text-to-video task through DreamFace's authenticated web UI.
   * The provider intentionally waits for a new media URL rendered by the site
   * (or returned by its task response) instead of relying on private API
   * endpoints that can change without notice.
   */
  async generate(store, job, account, signal, update) {
    if (job.payload.kind !== "video") throw providerError("DreamFace hiện chỉ hỗ trợ tạo video.", "UNSUPPORTED_KIND");
    if (!["text","reference"].includes(job.payload.mode)) {
      throw providerError("DreamFace supports text and reference images for this workflow.", "UNSUPPORTED_MODE");
    }
    const session = await this.open(account, { visible: false });
    const state = await this.inspect(account, session, { navigate: true });
    if (state.status !== "ready") {
      throw providerError(state.message, state.status === "verification" ? "VERIFICATION" : "NEEDS_LOGIN", 401);
    }
    const { page } = session;
    const temporaryReferences=await prepareDreamFaceReferences(store,page,{...job.payload,projectId:job.projectId});
    const prompt = await dreamFaceComposer(page);
    if (!prompt) {
      await Promise.all(temporaryReferences.map(file=>fs.rm(file,{force:true})));
      throw providerError("Không tìm thấy ô prompt DreamFace. Giao diện dịch vụ có thể đã thay đổi.", "PROVIDER_NOT_READY");
    }
    const baseline = new Set(await page.locator("video:visible, video source:visible").evaluateAll((nodes) => nodes.map((node) => node.currentSrc || node.src).filter(Boolean)));
    const candidates = new Set();
    const responseListener = async (response) => {
      if (!/task|work|generate|status|download/i.test(response.url())) return;
      try {
        const contentType = String(response.headers()["content-type"] || "");
        if (!contentType.includes("json")) return;
        for (const url of collectUrls(await response.json())) {
          if (/\.mp4(?:[?#]|$)|video|download|source/i.test(url)) candidates.add(url);
        }
      } catch {}
    };
    page.on("response", responseListener);
    try {
      await configureDreamFace(page, job.payload);
      await prompt.fill(String(job.payload.prompt || "").slice(0, 1500));
      const send = await firstVisible([
        page.getByRole("button", { name: /^Send$/i }),
        page.getByRole("button", { name: /^\d+\s+Free\s+Daily$/i }),
        page.locator('button[aria-label="Send"]'),
        prompt.locator("xpath=ancestor::*[contains(@class, 'generator')][1]").locator('button[aria-label="Send"]:visible'),
      ]);
      if (!send) throw providerError("Không tìm thấy nút tạo video DreamFace.", "PROVIDER_NOT_READY");
      update({ status: "submitting", submittedAt: new Date().toISOString(), providerPage: page.url(), progress: 5 });
      await send.click({ timeout: 15000 });
      update({ status: "rendering", progress: 15, elapsedSeconds: 0 });
      const deadline = Date.now() + Math.max(2, Number(store.state.settings.maxWaitMinutes || 20)) * 60000;
      const started = Date.now();
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const body = await page.locator("body").innerText().catch(() => "");
        if (/verify you are human|confirm you.re not a robot|captcha/i.test(body)) throw providerError("DreamFace yêu cầu xác minh. Hoàn tất trong cửa sổ tài khoản rồi kiểm tra lại.", "VERIFICATION", 401);
        if (/not enough credits|insufficient credits|failed to generate|daily free.*limit/i.test(body)) throw providerError("DreamFace báo thiếu lượt hoặc không thể tạo video. Kiểm tra hạn mức trong tài khoản.", "PROVIDER_QUOTA");
        const rendered = await page.locator("video:visible, video source:visible").evaluateAll((nodes) => nodes.map((node) => node.currentSrc || node.src).filter(Boolean)).catch(() => []);
        for (const url of rendered) if (!baseline.has(url)) candidates.add(url);
        for (const url of candidates) {
          candidates.delete(url);
          update({ status: "downloading", progress: 90 });
          try {
            const media = await downloadResult(store, session, job, url, signal);
            store.log(job, `Đã tải video DreamFace: ${media.width}×${media.height}, ${media.duration.toFixed(2)} giây.`);
            return media;
          } catch (error) {
            store.log(job, `Video DreamFace chưa tải được (${error.message}); tiếp tục chờ kết quả mới.`);
          }
        }
        update({ elapsedSeconds: Math.floor((Date.now() - started) / 1000) });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, Math.max(3000, Number(store.state.settings.pollSeconds || 5) * 1000));
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); }, { once: true });
        });
      }
      throw providerError("Hết thời gian theo dõi DreamFace. Yêu cầu có thể vẫn đang chạy; kiểm tra trong tài khoản trước khi tạo lại.", "PROVIDER_TIMEOUT", 408);
    } finally {
      page.off("response", responseListener);
      await Promise.all(temporaryReferences.map(file=>fs.rm(file,{force:true})));
    }
  }

  async close(account) {
    const id = accountId(account);
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.context.close().catch(() => {});
  }
}

export function createDreamFaceProvider(options) {
  return new DreamFaceProvider(options);
}
