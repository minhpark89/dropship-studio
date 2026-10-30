import { SecretStore } from "./secret-store.js";
import { StudioError } from "./store.js";

export const CAPTCHA_SECRET_ID = "captcha";
export const CAPTCHA_API_URL = "https://api.2captcha.com";
export const CAPTCHA_SITE_URL = "https://2captcha.com";

const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_POLL_MS = 5000;

const SUPPORTED_TYPES = ["turnstile", "recaptcha-v2", "recaptcha-v3", "hcaptcha"];

export function readCaptchaSettings(store) {
  const saved = new SecretStore(store.root).get(CAPTCHA_SECRET_ID) || {};
  return {
    enabled: saved.enabled !== false,
    autoSolveDreamFace: saved.autoSolveDreamFace !== false,
    apiKey: String(saved.apiKey || ""),
  };
}

export function publicCaptchaSettings(store) {
  const settings = readCaptchaSettings(store);
  return {
    enabled: settings.enabled,
    autoSolveDreamFace: settings.autoSolveDreamFace,
    hasKey: Boolean(settings.apiKey),
    supportedTypes: SUPPORTED_TYPES,
    provider: "2captcha",
  };
}

export function saveCaptchaSettings(store, input = {}) {
  const current = readCaptchaSettings(store);
  const next = {
    enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
    autoSolveDreamFace: input.autoSolveDreamFace === undefined
      ? current.autoSolveDreamFace
      : Boolean(input.autoSolveDreamFace),
    apiKey: input.clearKey
      ? ""
      : input.apiKey === undefined || input.apiKey === "[đã lưu]"
        ? current.apiKey
        : String(input.apiKey || "").trim(),
  };
  if (next.apiKey && !/^[A-Za-z0-9]{20,80}$/.test(next.apiKey))
    throw new StudioError("API key 2Captcha không hợp lệ. Key thường dài 32 ký tự chữ và số.", "CAPTCHA_KEY_INVALID");
  new SecretStore(store.root).set(CAPTCHA_SECRET_ID, next);
  return publicCaptchaSettings(store);
}

/** Turn a detected captcha into the 2Captcha createTask payload. */
export function buildCaptchaTask(input = {}) {
  const type = String(input.type || "");
  const websiteURL = String(input.pageUrl || "").trim();
  const websiteKey = String(input.sitekey || "").trim();
  if (!SUPPORTED_TYPES.includes(type))
    throw new StudioError(`Loại CAPTCHA không được hỗ trợ: ${type || "không rõ"}.`, "CAPTCHA_TYPE_UNSUPPORTED");
  if (!/^https?:\/\//i.test(websiteURL))
    throw new StudioError("Cần URL trang có CAPTCHA để gửi 2Captcha.", "CAPTCHA_URL_MISSING");
  if (!websiteKey)
    throw new StudioError("Không đọc được sitekey của CAPTCHA trên trang.", "CAPTCHA_SITEKEY_MISSING");

  const proxy = input.proxy?.server ? parseProxyServer(input.proxy.server, input.proxy) : null;
  const proxySuffix = proxy ? "" : "Proxyless";
  const task = { type: `${taskTypeName(type, proxySuffix)}`, websiteURL, websiteKey };

  if (type === "turnstile") {
    if (input.action) task.action = String(input.action);
    if (input.data) task.data = String(input.data);
    if (input.pagedata) task.pagedata = String(input.pagedata);
    if (input.userAgent) task.userAgent = String(input.userAgent);
  }
  if (type === "recaptcha-v2") {
    if (input.invisible) task.isInvisible = true;
    if (input.dataS) task.recaptchaDataSValue = String(input.dataS);
    if (input.userAgent) task.userAgent = String(input.userAgent);
  }
  if (type === "recaptcha-v3") {
    task.minScore = Number(input.minScore) > 0 ? Number(input.minScore) : 0.9;
    if (input.action) task.pageAction = String(input.action);
    if (input.enterprise) task.isEnterprise = true;
    if (input.apiDomain) task.apiDomain = String(input.apiDomain);
  }
  if (type === "hcaptcha" && input.invisible) task.isInvisible = true;

  if (proxy) {
    task.proxyType = proxy.type;
    task.proxyAddress = proxy.host;
    task.proxyPort = proxy.port;
    if (proxy.username) task.proxyLogin = proxy.username;
    if (proxy.password) task.proxyPassword = proxy.password;
  }
  return task;
}

function taskTypeName(type, suffix) {
  const base = {
    turnstile: "TurnstileTask",
    "recaptcha-v2": "RecaptchaV2Task",
    "recaptcha-v3": "RecaptchaV3Task",
    hcaptcha: "HCaptchaTask",
  }[type];
  return `${base}${suffix}`;
}

function parseProxyServer(server, credentials = {}) {
  let url;
  try {
    url = new URL(server);
  } catch {
    throw new StudioError("Proxy gửi 2Captcha không hợp lệ.", "CAPTCHA_PROXY_INVALID");
  }
  const type = url.protocol.replace(":", "").toLowerCase();
  if (!["http", "https", "socks4", "socks5"].includes(type))
    throw new StudioError("2Captcha chỉ nhận proxy http, socks4 hoặc socks5.", "CAPTCHA_PROXY_INVALID");
  return {
    type,
    host: url.hostname,
    port: Number(url.port || (type === "https" ? 443 : 80)),
    username: credentials.username || "",
    password: credentials.password || "",
  };
}

/** The solution shape is the same for every token-based task type. */
export function captchaSolutionToken(solution) {
  const value = solution || {};
  return String(
    value.token || value.gRecaptchaResponse || value.gRecaptchaResponseV2 || value.text || "",
  ).trim();
}

/** Hidden fields a page uses to receive the solved token. */
export function captchaTokenFields(type) {
  if (type === "turnstile") return ["cf-turnstile-response", "g-recaptcha-response"];
  if (type === "hcaptcha") return ["h-captcha-response", "g-recaptcha-response"];
  return ["g-recaptcha-response"];
}

export function captchaTimeoutMs(input = {}) {
  const value = Number(input);
  return Number.isFinite(value) && value >= 30000 ? value : DEFAULT_TIMEOUT_MS;
}

/**
 * Read the captcha markup from the page. Kept separate from the DOM probe so
 * detection rules can be unit-tested without a browser.
 */
export function detectCaptchaSource({ elements = [], frames = [], scripts = [], url = "" } = {}) {
  const elementList = Array.isArray(elements) ? elements : [];
  const frameList = (Array.isArray(frames) ? frames : []).filter(Boolean);
  const scriptList = (Array.isArray(scripts) ? scripts : []).filter(Boolean);
  const findElement = (pattern) => elementList.find((el) => pattern.test(`${el.className || ""} ${el.id || ""}`));
  const findFrame = (pattern) => frameList.find((src) => pattern.test(src));
  const sitekeyFromElement = (el) => String(el?.sitekey || "").trim();

  const turnstileElement = findElement(/cf-turnstile|turnstile/i);
  const turnstileFrame = findFrame(/challenges\.cloudflare\.com/i);
  if ((turnstileElement && sitekeyFromElement(turnstileElement)) || turnstileFrame) {
    return {
      type: "turnstile",
      sitekey: sitekeyFromElement(turnstileElement) || sitekeyFromFrame(turnstileFrame, "sitekey"),
      action: String(turnstileElement?.action || ""),
      pageUrl: url,
    };
  }

  const recaptchaElement = findElement(/g-recaptcha|recaptcha/i);
  const recaptchaFrame = findFrame(/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)/i);
  const recaptchaScript = scriptList.find((src) => /recaptcha\/api\.js|recaptcha\/enterprise\.js/i.test(src));
  if ((recaptchaElement && sitekeyFromElement(recaptchaElement)) || recaptchaFrame) {
    const frameSrc = recaptchaFrame || "";
    return {
      type: "recaptcha-v2",
      sitekey: sitekeyFromElement(recaptchaElement) || sitekeyFromFrame(frameSrc, "k"),
      invisible: /size=invisible/i.test(frameSrc),
      action: String(recaptchaElement?.action || ""),
      enterprise: /enterprise/i.test(frameSrc) || /enterprise\.js/i.test(recaptchaScript || ""),
      pageUrl: url,
    };
  }
  if (recaptchaScript && /[?&]render=/i.test(recaptchaScript)) {
    return {
      type: "recaptcha-v3",
      sitekey: sitekeyFromFrame(recaptchaScript, "render"),
      action: String(recaptchaElement?.action || ""),
      enterprise: /enterprise\.js/i.test(recaptchaScript),
      pageUrl: url,
    };
  }

  const hcaptchaElement = findElement(/h-captcha|hcaptcha/i);
  const hcaptchaFrame = findFrame(/hcaptcha\.com/i);
  if ((hcaptchaElement && sitekeyFromElement(hcaptchaElement)) || hcaptchaFrame) {
    return {
      type: "hcaptcha",
      sitekey: sitekeyFromElement(hcaptchaElement) || sitekeyFromFrame(hcaptchaFrame, "sitekey"),
      pageUrl: url,
    };
  }
  return null;
}

function sitekeyFromFrame(value, param) {
  if (!value) return "";
  try {
    const url = new URL(value, "https://placeholder.invalid");
    const fromQuery = url.searchParams.get(param);
    if (fromQuery) return fromQuery;
    // hCaptcha and Turnstile frames often carry the sitekey in the fragment.
    return new URLSearchParams(url.hash.replace(/^#/, "")).get(param) || "";
  } catch {
    return "";
  }
}

/** Detect the captcha currently rendered in the page (token-based types only). */
export async function detectCaptcha(page) {
  const source = await page.evaluate(() => ({
    url: location.href,
    elements: [...document.querySelectorAll("[data-sitekey]")].map((el) => ({
      tag: el.tagName,
      className: String(el.className || ""),
      id: el.id || "",
      sitekey: el.getAttribute("data-sitekey") || "",
      action: el.getAttribute("data-action") || "",
    })),
    frames: [...document.querySelectorAll("iframe")].map((frame) => frame.src || ""),
    scripts: [...document.querySelectorAll("script[src]")].map((script) => script.src || ""),
  })).catch(() => null);
  return source ? detectCaptchaSource(source) : null;
}

/**
 * Put the solved token where the page expects it and fire the widget callback
 * so single-page apps pick it up without a manual checkbox click.
 */
export async function applyCaptchaToken(page, { type, token }) {
  const fields = captchaTokenFields(type);
  return page.evaluate(({ fields, token, type }) => {
    let applied = 0;
    for (const name of fields) {
      let field = document.querySelector(`textarea[name="${name}"], input[name="${name}"], #${name}`);
      if (!field) {
        field = document.createElement("textarea");
        field.name = name;
        field.id = name;
        field.style.display = "none";
        (document.querySelector("form") || document.body).appendChild(field);
      }
      const prototype = field.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(field, token);
      else field.value = token;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      applied += 1;
    }

    const called = [];
    const seen = new Set();
    const visit = (node, path, depth) => {
      if (!node || typeof node !== "object" || depth > 6 || seen.has(node)) return;
      seen.add(node);
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === "function") {
          if (/callback/i.test(key)) {
            try {
              value(token);
              called.push(`${path}.${key}`);
            } catch {}
          }
        } else if (value && typeof value === "object") {
          visit(value, `${path}.${key}`, depth + 1);
        }
      }
    };
    if (type === "recaptcha-v2" || type === "recaptcha-v3") {
      try { visit(window.___grecaptcha_cfg?.clients || {}, "grecaptcha", 0); } catch {}
    }
    if (type === "turnstile") {
      try { (window.__viralStudioTurnstileCallbacks || []).forEach((callback) => callback(token)); } catch {}
    }
    if (type === "hcaptcha") {
      try { (window.__viralStudioHcaptchaCallbacks || []).forEach((callback) => callback(token)); } catch {}
    }
    return { applied, called };
  }, { fields, token, type });
}

/**
 * Installed before each navigation so Turnstile/hCaptcha callbacks created by
 * the site are remembered and can be invoked after the token is solved.
 */
export const CAPTCHA_BROWSER_HOOK = `(() => {
  let attempts = 0;
  const hook = () => {
    try {
      if (window.turnstile && !window.turnstile.__viralStudioHooked) {
        const original = window.turnstile.render && window.turnstile.render.bind(window.turnstile);
        window.turnstile.render = (element, options) => {
          if (options && typeof options.callback === "function")
            (window.__viralStudioTurnstileCallbacks ||= []).push(options.callback);
          return original ? original(element, options) : "";
        };
        window.turnstile.__viralStudioHooked = true;
      }
      if (window.hcaptcha && !window.hcaptcha.__viralStudioHooked) {
        const original = window.hcaptcha.render && window.hcaptcha.render.bind(window.hcaptcha);
        window.hcaptcha.render = (element, options) => {
          if (options && typeof options.callback === "function")
            (window.__viralStudioHcaptchaCallbacks ||= []).push(options.callback);
          return original ? original(element, options) : "";
        };
        window.hcaptcha.__viralStudioHooked = true;
      }
    } catch {}
    if (++attempts < 300) setTimeout(hook, 100);
  };
  hook();
})();`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createCaptchaClient({
  apiKey,
  baseUrl = CAPTCHA_API_URL,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleepImpl = sleep,
  now = () => Date.now(),
  onProgress = null,
} = {}) {
  if (!apiKey) throw new StudioError("Chưa lưu API key 2Captcha trong Settings.", "CAPTCHA_KEY_MISSING");
  const key = String(apiKey).trim();

  async function post(method, payload) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(40000),
      });
    } catch (error) {
      throw new StudioError(`Không kết nối được 2Captcha: ${error.message}`, "CAPTCHA_NETWORK", 502);
    }
    const text = await response.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {
      throw new StudioError(`2Captcha trả về dữ liệu không đọc được (HTTP ${response.status}).`, "CAPTCHA_BAD_RESPONSE", 502);
    }
    if (!response.ok && !data?.errorCode) {
      throw new StudioError(`2Captcha trả về HTTP ${response.status}.`, "CAPTCHA_BAD_RESPONSE", 502);
    }
    if (data?.errorId) {
      const error = new StudioError(
        `2Captcha: ${data.errorDescription || data.errorCode || "lỗi không rõ"}.`,
        data.errorCode || "CAPTCHA_API_ERROR",
        data.errorCode === "ERROR_KEY_DOES_NOT_EXIST" || data.errorCode === "ERROR_IP_NOT_ALLOWED" ? 401 : 502,
      );
      error.captchaErrorCode = data.errorCode;
      throw error;
    }
    return data;
  }

  return {
    async createTask(task) {
      const data = await post("createTask", { clientKey: key, task });
      if (!data?.taskId)
        throw new StudioError("2Captcha không trả về mã tác vụ.", "CAPTCHA_NO_TASK_ID", 502);
      return data.taskId;
    },

    async getTaskResult(taskId) {
      return post("getTaskResult", { clientKey: key, taskId });
    },

    async balance() {
      const data = await post("getBalance", { clientKey: key });
      const balance = Number(data?.balance);
      if (!Number.isFinite(balance))
        throw new StudioError("2Captcha không trả về số dư.", "CAPTCHA_BAD_RESPONSE", 502);
      return { balance, currency: "USD" };
    },

    async solve(task) {
      const taskId = await this.createTask(task);
      onProgress?.({ status: "submitted", taskId });
      const deadline = now() + timeoutMs;
      while (now() < deadline) {
        await sleepImpl(pollIntervalMs);
        const result = await this.getTaskResult(taskId);
        if (result?.status === "ready") {
          const token = captchaSolutionToken(result.solution);
          if (!token)
            throw new StudioError("2Captcha trả về token rỗng.", "CAPTCHA_EMPTY_SOLUTION", 502);
          return { token, taskId, cost: result.cost || "", solveCount: result.solveCount };
        }
        onProgress?.({ status: "processing", taskId });
      }
      throw new StudioError("Hết thời gian chờ 2Captcha giải CAPTCHA.", "CAPTCHA_TIMEOUT", 408);
    },
  };
}
