import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { providers } from "../../shared/contracts.js";
import { importMedia, probe, binary, runProcess } from "../media.js";
import { StudioError } from "../store.js";

export const DREAMFACE_PROVIDER = "dreamface";
export const DREAMFACE_URL = providers.dreamface.url;
const DREAMFACE_HOST = "dreamfaceapp.com";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function domainMatches(value) {
  const host = String(value || "").replace(/^\./, "").toLowerCase();
  return host === DREAMFACE_HOST || host.endsWith(`.${DREAMFACE_HOST}`);
}

function providerError(message, code = "DREAMFACE_ERROR", status = 400) {
  return new StudioError(message, code, status);
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
      const existing = this.sessions.get(id);
      const existingBrowser = existing?.context?.browser?.();
      if (existingBrowser && !existingBrowser.isConnected()) this.sessions.delete(id);
      if (existing?.context && existing.visible === visible) {
        const page = existing.page.isClosed() ? await existing.context.newPage() : existing.page;
        existing.page = page;
        return existing;
      }
      if (existing) await this.close(account);
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
    if (captcha || /verify you are human|confirm you.re not a robot|captcha|xác minh bạn là người/i.test(body)) {
      return { status: "verification", authStep: "identity", message: "DreamFace yêu cầu xác minh. Hãy hoàn tất trong cửa sổ hiển thị rồi kiểm tra lại; provider không tự vượt CAPTCHA." };
    }
    const hasSession = cookies.some((cookie) => cookie.value && domainMatches(cookie.domain) && /session|token|auth|sid/i.test(cookie.name));
    const loginFields = await page.locator('input[type="email"]:visible, input[type="password"]:visible').count().catch(() => 0);
    const loginCta = await firstVisible([
      page.getByText(/^Log\s*in\s*\/\s*Sign\s*up$/i),
      page.getByText(/^Log\s*In\s*\/\s*Sign\s*Up$/i),
      page.getByRole("button", { name: /log\s*in.*sign\s*up/i }),
    ]);
    const composer = await dreamFaceComposer(page);
    if (domainMatches(new URL(page.url()).hostname) && hasSession && loginFields === 0 && !loginCta && composer) {
      return { status: "ready", authStep: "ready", message: "DreamFace đã mở phiên làm việc." };
    }
    return { status: "needs_login", authStep: "service", message: "DreamFace chưa xác nhận phiên. Hãy đăng nhập bằng tài khoản của bạn hoặc nhập cookie hợp lệ rồi kiểm tra lại." };
  }

  async check(account) {
    if(account.status==="busy")throw providerError("This profile is rendering. Wait for it to finish.","PROFILE_BUSY",409);
    const existing=this.sessions.get(account.id);
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
      pageDialog(session.page).getByRole("button", { name: /^Log\s*in$/i }),
      session.page.getByRole("button", { name: /^Log\s*in$/i }),
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
