import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { providers } from "../../shared/contracts.js";
import { StudioError } from "../store.js";
import { parseCookies } from "./cookies.js";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export class BrowserProfiles {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();
    this.profiles = new Map();
    this.opening = new Map();
    this.monitors = new Map();
    this.profileOperations = new Set();
  }

  executable() {
    const candidates = [
      this.store.state.settings.chromePath,
      path.join(
        process.env.PROGRAMFILES || "",
        "Google/Chrome/Application/chrome.exe",
      ),
      path.join(
        process.env["PROGRAMFILES(X86)"] || "",
        "Microsoft/Edge/Application/msedge.exe",
      ),
      path.join(
        process.env.LOCALAPPDATA || "",
        "Google/Chrome/Application/chrome.exe",
      ),
      chromium.executablePath(),
    ];
    const executable = candidates.find((file) => file && fs.existsSync(file));
    if (!executable)
      throw new StudioError(
        "Chưa tìm thấy Chrome/Edge. Chọn đường dẫn trình duyệt trong Cài đặt.",
        "BROWSER_MISSING",
      );
    return executable;
  }

  profileId(account) {
    const id = account.profileId || account.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new StudioError("Hồ sơ trình duyệt không hợp lệ.");
    return id;
  }

  profileAccounts(account) {
    const id = this.profileId(account);
    return this.store.state.accounts.filter((item) => this.profileId(item) === id);
  }

  isProfileLocked(account) {
    const id = this.profileId(account);
    return this.profileOperations.has(id) || this.opening.has(id) ||
      this.profileAccounts(account).some((item) => this.monitors.has(item.id));
  }

  async withIdleProfiles(accounts, action) {
    const ids = [...new Set(accounts.map((account) => this.profileId(account)))];
    if (ids.some((id) => this.profileOperations.has(id) || this.opening.has(id)) ||
      this.store.state.accounts.some((item) => ids.includes(this.profileId(item)) &&
        ["busy", "checking"].includes(item.status)))
      throw new StudioError("Hồ sơ Google đang được sử dụng. Chờ tác vụ hoặc kiểm tra phiên hoàn tất.");
    for (const id of ids) this.profileOperations.add(id);
    try {
      return await action();
    } finally {
      for (const id of ids) this.profileOperations.delete(id);
    }
  }

  async servicePage(account, context) {
    const claimed = new Set([...this.sessions.values()].map((session) => session.page));
    const matches = (page) => {
      if (page.isClosed() || claimed.has(page)) return false;
      let host;
      try {
        host = new URL(page.url()).hostname;
      } catch {
        return false;
      }
      if (account.provider === "dola")
        return host === "www.dola.com" || host === "dola.com";
      if (account.provider === "dreamface")
        return host === "www.dreamfaceapp.com" || host === "dreamfaceapp.com";
      return host === "flow.google.com" ||
        (host === "labs.google" && /^\/fx\/(?:[a-z-]+\/)?tools\/flow(?:[/?#]|$)/i.test(new URL(page.url()).pathname));
    };
    const page = context.pages().find(matches) ||
      context.pages().find((tab) => !tab.isClosed() && !claimed.has(tab) && tab.url() === "about:blank") ||
      await context.newPage();
    page.setDefaultTimeout(12000);
    return page;
  }

  async open(account, options = {}) {
    const visible = options.visible ?? this.store.state.settings.browserVisible === true;
    const forceHidden = options.forceHidden === true;
    const id = this.profileId(account);
    const prior = this.opening.get(id) || Promise.resolve();
    const opening = prior.catch(() => {}).then(async () => {
      let profile = this.profiles.get(id);
      if (profile?.browser.isConnected() && (visible && !profile.visible || forceHidden && profile.visible)) {
        if (this.profileAccounts(account).some((item) => item.id !== account.id && item.status === "busy"))
          throw new StudioError("Chờ tác vụ dùng hồ sơ Google này hoàn tất trước khi mở cửa sổ.");
        await this.closeProfile(id);
        profile = null;
      }
      if (!profile?.browser.isConnected()) profile = await this.createSession(account, visible);
      let session = this.sessions.get(account.id);
      if (!session || session.browser !== profile.browser) {
        session = { ...profile, page: await this.servicePage(account, profile.context) };
        this.sessions.set(account.id, session);
      } else if (session.page.isClosed()) {
        session.page = await this.servicePage(account, profile.context);
      }
      if (visible) {
        const page = session.loginPage && !session.loginPage.isClosed()
          ? session.loginPage : session.page;
        await this.reveal(session, page);
      }
      return session;
    });
    this.opening.set(id, opening);
    try {
      return await opening;
    } finally {
      if (this.opening.get(id) === opening) this.opening.delete(id);
    }
  }

  async createSession(account, visible) {
    const profileId = this.profileId(account);
    const directory = path.join(this.store.root, "profiles", profileId);
    fs.mkdirSync(directory, { recursive: true });
    const port = await freePort();
    const args = [
      `--user-data-dir=${directory}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1360,940",
      "--lang=en-US",
    ];
    if (!visible) args.push("--headless=new");
    if (account.proxy) {
      const proxy = new URL(
        account.proxy.includes("://")
          ? account.proxy
          : `http://${account.proxy}`,
      );
      if (!["http:", "https:", "socks5:"].includes(proxy.protocol))
        throw new StudioError("Proxy phải dùng HTTP, HTTPS hoặc SOCKS5.");
      if (proxy.username || proxy.password)
        throw new StudioError(
          "Dùng proxy không yêu cầu mật khẩu hoặc cấu hình xác thực trong cửa sổ trình duyệt.",
        );
      args.push(`--proxy-server=${proxy.protocol}//${proxy.host}`);
    }
    args.push("about:blank");
    const child = spawn(this.executable(), args, {
      windowsHide: !visible,
      stdio: "ignore",
    });
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null)
          throw new Error("Trình duyệt đã đóng khi khởi chạy.");
        try {
          const response = await fetch(`${endpoint}/json/version`, {
            signal: AbortSignal.timeout(1000),
          });
          ready = response.ok;
        } catch {}
        if (ready) break;
        await delay(250);
      }
      if (!ready)
        throw new Error("Không kết nối được trình duyệt trong 20 giây.");
      const browser = await chromium.connectOverCDP(endpoint, {
        timeout: 15000,
      });
      const context = browser.contexts()[0];
      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(12000);
      const session = { browser, context, page, child, visible, profileId };
      this.profiles.set(profileId, session);
      browser.on("disconnected", () => {
        if (this.profiles.get(profileId) === session) this.profiles.delete(profileId);
        for (const [id, alias] of this.sessions) {
          if (alias.browser !== browser) continue;
          this.sessions.delete(id);
          clearInterval(this.monitors.get(id));
          this.monitors.delete(id);
        }
      });
      return session;
    } catch (error) {
      child.kill();
      throw new StudioError(
        `Không mở được hồ sơ trình duyệt: ${error.message}`,
        "BROWSER_FAILED",
        500,
      );
    }
  }

  async reveal(session, page = session.page) {
    if (!session.visible || page.isClosed()) return;
    const cdp = await session.context.newCDPSession(page);
    try {
      const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
      if (bounds.windowState === "minimized") {
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        });
      }
      if (
        bounds.windowState !== "maximized" &&
        bounds.windowState !== "fullscreen"
      ) {
        const screen = await page.evaluate(() => ({
          left: window.screen.availLeft || 0,
          top: window.screen.availTop || 0,
          width: window.screen.availWidth,
          height: window.screen.availHeight,
        }));
        const width = Math.min(bounds.width || 1280, screen.width || 1280);
        const height = Math.min(bounds.height || 850, screen.height || 850);
        const left = Math.max(
          screen.left,
          Math.min(
            bounds.left || screen.left,
            screen.left + screen.width - width,
          ),
        );
        const top = Math.max(
          screen.top,
          Math.min(
            bounds.top || screen.top,
            screen.top + screen.height - height,
          ),
        );
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { left, top, width, height },
        });
      }
      await page.bringToFront();
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  async inspect(account, session, { navigate = false } = {}) {
    const { context } = session;
    const otherPages = new Set([...this.sessions.entries()]
      .filter(([id]) => id !== account.id)
      .map(([, other]) => other.page));
    const onDomain = (value, domain) => {
      const hostname = value.replace(/^\./, "").toLowerCase();
      return hostname === domain || hostname.endsWith(`.${domain}`);
    };
    const claimed = new Set([...this.sessions.values()]
      .filter((other) => other !== session)
      .map((other) => other.page));
    const candidates = context.pages().filter((tab) => {
      if (tab.isClosed() || otherPages.has(tab)) return false;
      if (tab !== session.page && claimed.has(tab)) return false;
      let hostname;
      try {
        hostname = new URL(tab.url()).hostname;
      } catch {
        return false;
      }
      if (account.provider === "dola") return onDomain(hostname, "dola.com");
      if (account.provider === "dreamface") return onDomain(hostname, "dreamfaceapp.com");
      return hostname === "flow.google.com" ||
        (hostname === "labs.google" && /^\/fx\/(?:[a-z-]+\/)?tools\/flow(?:[/?#]|$)/i.test(new URL(tab.url()).pathname));
    });
    if (
      candidates.length &&
      (session.page.isClosed() || !candidates.includes(session.page))
    ) {
      session.page = candidates.at(-1);
    }
    if (account.provider === "flow") {
      const workspace = candidates.find((tab) =>
        /(?:flow\.google\.com\/(?!about)|labs\.google\/fx)/.test(tab.url()),
      );
      if (workspace) session.page = workspace;
    }
    if (session.page.isClosed()) session.page = await context.newPage();
    const { page } = session;
    if (navigate || page.url() === "about:blank") {
      await page.goto(providers[account.provider].url, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await page.waitForTimeout(1800);
    }
    const cookies = await context.cookies();
    const body = await page.locator("body").innerText({ timeout: 10000 });
    const captcha = await page
      .locator(
        'iframe[src*="captcha"]:visible, #captcha_verify_image:visible, [class*="captcha-verify"]:visible',
      )
      .count();
    if (
      captcha ||
      /verify you are human|confirm you.re not a robot|xác minh bạn là người/i.test(
        body,
      )
    ) {
      return {
        status: "verification",
        authStep: "identity",
        message:
          "Hoàn tất xác minh trong cửa sổ tài khoản rồi bấm Kiểm tra phiên.",
      };
    }
    if (account.provider === "dola") {
      const loginVisible = await page
        .getByTestId("to_login_button")
        .isVisible()
        .catch(() => false);
      const modalVisible = await page
        .getByTestId("login_content")
        .isVisible()
        .catch(() => false);
      const hasSession = cookies.some(
        (cookie) =>
          /^(sessionid|sessionid_ss|sid_tt|sid_guard)$/.test(cookie.name) &&
          cookie.value &&
          onDomain(cookie.domain, "dola.com"),
      );
      const composer = await page
        .locator('[data-testid="chat_input_input"], [contenteditable="true"]')
        .count();
      const onDola = onDomain(new URL(page.url()).hostname, "dola.com");
      if (onDola && hasSession && !loginVisible && !modalVisible && composer) {
        return {
          status: "ready",
          authStep: "ready",
          message:
            "Đã đăng nhập Dola. Quyền tạo video và số lượt được Dola kiểm tra khi gửi yêu cầu.",
        };
      }
      const identityWindow = context
        .pages()
        .some(
          (tab) =>
            !tab.isClosed() &&
            /https:\/\/(?:accounts\.google\.com|appleid\.apple\.com|account\.apple\.com)\//.test(
              tab.url(),
            ),
        );
      return {
        status: "needs_login",
        authStep: identityWindow ? "identity" : "service",
        message: identityWindow
          ? "Bước 1/2: Hoàn tất đăng nhập Google/Apple trong cửa sổ vừa mở, rồi chờ quay về Dola."
          : "Bước 2/2: Dola chưa xác nhận phiên. Nếu đã đăng nhập Google/Apple, hãy hoàn tất nút Tiếp tục và quay về Dola; không cần tạo mật khẩu Dola riêng.",
      };
    }
    if (account.provider === "dreamface") {
      const hasSession = cookies.some((cookie) =>
        cookie.value && onDomain(cookie.domain, "dreamfaceapp.com") &&
        /session|token|auth|sid/i.test(cookie.name),
      );
      const loginVisible = await page.locator('input[type="email"]:visible, input[type="password"]:visible').count();
      const onDreamFace = onDomain(new URL(page.url()).hostname, "dreamfaceapp.com");
      if (onDreamFace && hasSession && !loginVisible)
        return {
          status: "ready",
          authStep: "ready",
          message: "DreamFace đã mở phiên làm việc.",
        };
      return {
        status: "needs_login",
        authStep: "service",
        message: "Đăng nhập DreamFace trong hồ sơ trình duyệt rồi bấm Kiểm tra phiên.",
      };
    }
    const hasSession = cookies.some(
      (cookie) =>
        /^(SID|__Secure-1PSID|__Secure-3PSID)$/.test(cookie.name) &&
        cookie.value &&
        onDomain(cookie.domain, "google.com"),
    );
    if (await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count())
      return {
        status: "needs_login",
        authStep: "service",
        message: "Flow đang có hộp thoại cần xử lý trong cửa sổ tài khoản. App chưa xác nhận dịch vụ sẵn sàng.",
      };
    if (/error loading projects|failed to load projects|không thể tải dự án/i.test(body))
      return {
        status: "error",
        authStep: "service",
        message: "Flow chưa tải được danh sách dự án. Mở cửa sổ tài khoản để kiểm tra phiên Google và thông báo của dịch vụ.",
      };
    const onLanding = /\/about(?:[/?#]|$)|accounts\.google\.com/.test(
      page.url(),
    );
    const workspace =
      /new project|dự án mới|create project|tạo dự án|my projects|dự án của|new canvas|tạo mới/i.test(
        body,
      ) ||
      (await page
        .locator('div.ProseMirror[contenteditable="true"], flow-agent-panel')
        .count());
    const location = new URL(page.url());
    const onFlow = location.hostname === "flow.google.com" ||
      (location.hostname === "labs.google" && /^\/fx\/(?:[a-z-]+\/)?tools\/flow(?:[/?#]|$)/i.test(location.pathname));
    if (hasSession && onFlow && !onLanding && workspace)
      return {
        status: "ready",
        authStep: "ready",
        message: "Google Flow đã mở không gian làm việc.",
      };
    return {
      status: "needs_login",
      authStep: "service",
      message:
        "Đăng nhập Google và mở không gian làm việc của Flow trong cửa sổ tài khoản.",
    };
  }

  async check(id) {
    const account = this.store.require("accounts", id);
    return this.withIdleProfiles([account], () => this.checkAccount(account));
  }

  async checkAccount(account) {
    const id = account.id;
    this.store.patch("accounts", id, {
      status: "checking",
      message: "Đang kiểm tra trên website…",
    });
    try {
      const session = await this.open(account);
      const result = await this.inspect(account, session, { navigate: true });
      this.store.patch("accounts", id, {
        ...result,
        checkedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      this.store.patch("accounts", id, {
        status: "error",
        message: error.message,
      });
      throw error;
    }
  }

  async login(id, credentials = {}) {
    const account = this.store.require("accounts", id);
    return this.withIdleProfiles([account], () => this.loginAccount(account, credentials));
  }

  async loginAccount(account, credentials = {}) {
    const id = account.id;
    const session = await this.open(account, { visible: true });
    const { page, context } = session;
    this.store.patch("accounts", id, {
      status: "needs_login",
      authStep: "identity",
      message:
        "Bước 1/2: Đăng nhập Google/Apple trong cửa sổ vừa mở. App sẽ kiểm tra phiên dịch vụ sau khi bạn quay về.",
    });
    await page.goto(providers[account.provider].url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    if (account.provider === "dola") {
      await page.waitForTimeout(1500);
      const loggedIn = await this.inspect(account, session);
      if (loggedIn.status === "ready") {
        this.store.patch("accounts", id, loggedIn);
        return loggedIn;
      }
      if (!(await page.getByTestId("login_content").isVisible())) {
        await page.getByTestId("to_login_button").click();
      }
      const popupPromise = context
        .waitForEvent("page", { timeout: 12000 })
        .catch(() => null);
      if (account.loginMethod === "apple")
        await page.getByTestId("login_third_apple").click();
      else
        await page
          .getByRole("button", {
            name: /Continue with Google|Tiếp tục.*Google/i,
          })
          .click();
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        session.loginPage = popup;
        await this.reveal(session, popup);
        const email = credentials.email || account.email;
        if (email) {
          const field = popup
            .locator('input[type="email"], #account_name_text_field')
            .first();
          if (await field.isVisible().catch(() => false)) {
            await field.fill(email);
            if (credentials.password) {
              await field.press("Enter");
              const password = popup
                .locator('input[type="password"]:visible')
                .first();
              if (
                await password
                  .waitFor({ state: "visible", timeout: 10000 })
                  .then(() => true)
                  .catch(() => false)
              ) {
                await password.fill(credentials.password);
                await password.press("Enter");
              }
            }
          }
        }
      }
    } else if (/\/about/.test(page.url())) {
      await page
        .getByRole("button", {
          name: /Create with Google Flow|Try Google Flow/i,
        })
        .first()
        .click()
        .catch(() => {});
      const popup = context
        .pages()
        .find(
          (tab) =>
            !tab.isClosed() &&
            /^https:\/\/accounts\.google\.com\//.test(tab.url()),
        );
      if (popup) session.loginPage = popup;
      await this.reveal(session, popup || page);
    }
    this.monitor(account, session);
    return {
      status: "needs_login",
      authStep: "identity",
      message:
        "Cửa sổ đăng nhập đã mở. Hoàn tất đăng nhập và chờ quay về Dola/Flow; app tự kiểm tra phiên.",
    };
  }

  monitor(account, session) {
    clearInterval(this.monitors.get(account.id));
    const deadline = Date.now() + 15 * 60 * 1000;
    let checking = false;
    const timer = setInterval(async () => {
      if (!session.browser.isConnected() || Date.now() > deadline) {
        clearInterval(timer);
        this.monitors.delete(account.id);
        return;
      }
      if (checking || this.profileOperations.has(this.profileId(account)) ||
        this.opening.has(this.profileId(account)) ||
        this.profileAccounts(account).some((item) => item.status === "busy")) return;
      checking = true;
      try {
        const result = await this.inspect(account, session);
        if (
          result.status !== account.status ||
          result.authStep !== account.authStep ||
          result.message !== account.message
        ) {
          this.store.patch("accounts", account.id, {
            ...result,
            checkedAt: new Date().toISOString(),
          });
        }
        if (result.status === "ready") {
          clearInterval(timer);
          this.monitors.delete(account.id);
        }
      } catch {
      } finally {
        checking = false;
      }
    }, 4000);
    timer.unref();
    this.monitors.set(account.id, timer);
  }

  async importCookies(id, input) {
    const account = this.store.require("accounts", id);
    return this.withIdleProfiles([account], () => this.importAccountCookies(account, input));
  }

  async importAccountCookies(account, input) {
    const id = account.id;
    const cookies = parseCookies(input, account.provider);
    const session = await this.open(account);
    await session.context.addCookies(cookies);
    const result = await this.inspect(account, session, { navigate: true });
    this.store.patch("accounts", id, {
      ...result,
      cookieCount: cookies.length,
      checkedAt: new Date().toISOString(),
    });
    return { ...result, cookieCount: cookies.length };
  }

  async reuseGoogle(id, sourceAccountId) {
    const account = this.store.require("accounts", id);
    const source = this.store.require("accounts", sourceAccountId);
    if (account.id === source.id)
      throw new StudioError("Chọn một tài khoản Google khác đã có trong app.");
    if (account.loginMethod !== "google" || source.loginMethod !== "google")
      throw new StudioError("Chỉ tài khoản đăng nhập Google mới dùng chung hồ sơ.");
    const proxyKey = (value) => {
      if (!value) return "";
      return new URL(value.includes("://") ? value : `http://${value}`).href;
    };
    if (proxyKey(account.proxy) !== proxyKey(source.proxy))
      throw new StudioError("Hai tài khoản cần dùng cùng cấu hình proxy để dùng chung hồ sơ Google.");
    return this.withIdleProfiles([account, source], async () => {
      if (this.store.state.jobs.some((job) =>
        ["queued", "scheduled"].includes(job.status) && job.payload.accountId === account.id))
        throw new StudioError("Hủy tác vụ đang chờ của tài khoản này trước khi đổi hồ sơ Google.");
      const profileId = this.profileId(source);
      if (this.profileId(account) !== profileId) await this.close(account.id);
      this.store.patch("accounts", id, {
        profileId,
        status: "checking",
        authStep: "service",
        message: "Đang mở dịch vụ bằng hồ sơ Google đã có…",
      });
      try {
        const session = await this.open(account, { visible: true });
        const result = await this.inspect(account, session, { navigate: true });
        this.store.patch("accounts", id, { ...result, checkedAt: new Date().toISOString() });
        if (result.status !== "ready") this.monitor(account, session);
        return { ...result, profileId };
      } catch (error) {
        this.store.patch("accounts", id, { status: "error", message: error.message });
        throw error;
      }
    });
  }

  async deleteAccount(id) {
    const account = this.store.require("accounts", id);
    return this.withIdleProfiles([account], async () => {
      if (this.store.state.jobs.some((job) =>
        ["queued", "scheduled"].includes(job.status) && job.payload.accountId === id))
        throw new StudioError("Hủy tác vụ đang chờ dùng tài khoản này trước.");
      const profileId = this.profileId(account);
      await this.close(id);
      const remaining = this.store.state.accounts.filter((item) => item.id !== id);
      const retained = remaining.some((item) => this.profileId(item) === profileId);
      if (!retained) {
        const root = path.resolve(this.store.root, "profiles");
        const directory = path.resolve(root, profileId);
        if (!directory.startsWith(root + path.sep))
          throw new StudioError("Đường dẫn hồ sơ không hợp lệ.");
        fs.rmSync(directory, { recursive: true, force: true });
      }
      this.store.state.accounts = remaining;
      this.store.save();
      return { ok: true, profileRetained: retained };
    });
  }

  async close(id) {
    clearInterval(this.monitors.get(id));
    this.monitors.delete(id);
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    const shared = [...this.sessions.values()].some((alias) => alias.browser === session.browser);
    if (shared) {
      await session.page.close().catch(() => {});
      if (session.loginPage && session.loginPage !== session.page)
        await session.loginPage.close().catch(() => {});
      return;
    }
    await this.closeProfile(session.profileId);
  }

  async closeProfile(profileId) {
    const session = this.profiles.get(profileId);
    if (!session) return;
    this.profiles.delete(profileId);
    for (const [id, alias] of this.sessions) {
      if (alias.browser !== session.browser) continue;
      this.sessions.delete(id);
      clearInterval(this.monitors.get(id));
      this.monitors.delete(id);
    }
    try {
      const cdp = await session.browser.newBrowserCDPSession();
      await cdp.send("Browser.close");
    } catch {}
    if (session.child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => session.child.once("exit", resolve)),
        delay(1500),
      ]);
    }
    await session.browser.close().catch(() => {});
    if (session.child.exitCode === null) session.child.kill();
  }

  async closeAll() {
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled(
      [...this.profiles.keys()].map((id) => this.closeProfile(id)),
    );
  }
}
