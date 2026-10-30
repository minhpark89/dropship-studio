import { setTimeout as delay } from "node:timers/promises";
import { ensureDreamFaceCredentials } from "./dreamface-accounts.js";

const MANUAL_WAIT_MS = 3 * 60 * 1000;
const POLL_MS = 2000;
const MAX_CONCURRENCY = 4;

function clampConcurrency(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return 1;
  return Math.min(MAX_CONCURRENCY, number);
}

/**
 * Prepares newly created DreamFace profiles in hidden Chrome windows only. The
 * queue runs a configurable number of profiles at once (Chrome lanes), waits for
 * CAPTCHA/2Captcha to finish, closes each window as soon as the profile is
 * ready, and never pops a visible window for verification.
 */
export class DreamFaceSetupQueue {
  constructor({ store, dreamface, manualWaitMs = MANUAL_WAIT_MS, pollMs = POLL_MS, concurrency } = {}) {
    this.store = store;
    this.dreamface = dreamface;
    this.manualWaitMs = manualWaitMs;
    this.pollMs = pollMs;
    this.limit = clampConcurrency(concurrency ?? store?.state?.settings?.dreamfaceConcurrency);
    this.pending = [];
    this.active = new Set();
    this.running = false;
    this.stopped = false;
    this.total = 0;
    this.done = 0;
  }

  enqueue(accounts, { concurrency } = {}) {
    this.limit = concurrency === undefined
      ? clampConcurrency(this.store.state.settings?.dreamfaceConcurrency)
      : clampConcurrency(concurrency);
    const ids = [...new Set(accounts.map((account) => account.id))];
    let queued = 0;
    for (const id of ids) {
      if (this.active.has(id) || this.pending.includes(id)) continue;
      const account = this.store.state.accounts.find((item) => item.id === id);
      if (!account || account.provider !== "dreamface") continue;
      if (["busy", "checking"].includes(account.status)) continue;
      this.pending.push(id);
      queued += 1;
    }
    this.total += queued;
    if (queued) this.run();
    return this.status(queued);
  }

  status(queued = 0) {
    const active = [...this.active];
    return {
      running: this.running,
      queued,
      total: this.total,
      done: this.done,
      concurrency: this.limit,
      active,
      current: active[0] || null,
      remaining: this.pending.length + active.length,
    };
  }

  stop() {
    this.stopped = true;
    this.pending = [];
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const workers = Math.max(1, Math.min(this.limit, this.pending.length));
      await Promise.all(Array.from({ length: workers }, () => this.worker()));
    } finally {
      this.running = false;
      // An account enqueued in the gap between the last loop check and this
      // block would otherwise wait forever.
      if (!this.stopped && this.pending.length) {
        this.run();
      } else {
        this.total = 0;
        this.done = 0;
      }
    }
  }

  async worker() {
    while (!this.stopped) {
      const id = this.pending.shift();
      if (!id) break;
      this.active.add(id);
      try {
        await this.setupAccount(id);
      } catch {
        // setupAccount already records the failure on the account.
      } finally {
        this.active.delete(id);
        this.done += 1;
      }
      // Give Chrome a moment to release the profile directory on Windows.
      await delay(300);
    }
  }

  patch(accountId, patch) {
    const account = this.store.state.accounts.find((item) => item.id === accountId);
    if (!account) return null;
    return this.store.patch("accounts", accountId, patch);
  }

  progressMessage(account, position, total) {
    return `Đang đăng nhập ẩn ${position}/${total}: ${account.name}…`;
  }

  async setupAccount(id) {
    const account = this.store.require("accounts", id);
    const settings = this.dreamface.captchaSettings();
    const canAutoSolve = settings.enabled && settings.autoSolveDreamFace && Boolean(settings.apiKey);
    const total = this.total || 1;
    const position = Math.min(this.done + 1, total);
    const credentials = ensureDreamFaceCredentials(this.store, account);
    this.patch(id, {
      status: "checking",
      gmailStatus: "opening",
      gmailAuthStep: "browser",
      message: this.progressMessage(account, position, total),
    });

    let result;
    try {
      result = await this.dreamface.login(account, credentials, { visible: false });
    } catch (error) {
      await this.dreamface.close(account).catch(() => {});
      this.patch(id, {
        status: "needs_login",
        gmailStatus: "failed",
        gmailAuthStep: "error",
        message: error.message,
      });
      return;
    }

    if (result.status === "ready") {
      await this.dreamface.close(account).catch(() => {});
      this.patch(id, {
        status: "ready",
        gmailStatus: "ready",
        gmailAuthStep: "ready",
        gmailCheckedAt: new Date().toISOString(),
        message: result.message || "DreamFace đã sẵn sàng.",
      });
      return;
    }

    await this.waitForReady(account, result, canAutoSolve);
  }

  async waitForReady(account, initial, canAutoSolve) {
    const id = account.id;
    const deadline = Date.now() + this.manualWaitMs;
    this.patch(id, {
      status: "checking",
      gmailStatus: initial.status,
      gmailAuthStep: initial.authStep || "identity",
      message: "Đang chờ DreamFace xác minh trong nền. Cửa sổ không mở ra; app tự chuyển sang profile kế tiếp khi profile sẵn sàng.",
    });
    while (Date.now() < deadline && !this.stopped) {
      await delay(this.pollMs);
      const session = this.dreamface.sessions.get(id);
      if (!session || session.page.isClosed()) break;
      let state;
      try {
        state = await this.dreamface.inspect(account, session);
      } catch {
        continue;
      }
      if (state.status === "ready") {
        await this.dreamface.close(account).catch(() => {});
        this.patch(id, {
          status: "ready",
          gmailStatus: "ready",
          gmailAuthStep: "ready",
          gmailCheckedAt: new Date().toISOString(),
          message: state.message || "DreamFace đã sẵn sàng.",
        });
        return;
      }
      const seconds = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      this.patch(id, {
        status: "checking",
        gmailStatus: state.status,
        gmailAuthStep: state.authStep || "identity",
        message: `Đang chờ DreamFace sẵn sàng trong nền (còn ${seconds}s)…`,
      });
    }
    await this.dreamface.close(account).catch(() => {});
    this.patch(id, {
      status: "needs_login",
      gmailStatus: "verification",
      gmailAuthStep: "captcha",
      message: canAutoSolve
        ? "2Captcha chưa hoàn tất profile này nên app đóng cửa sổ ẩn và đi tiếp. Bấm Giải CAPTCHA hoặc Đăng nhập để thử lại."
        : "DreamFace cần xác minh nhưng chưa có API key 2Captcha. Lưu key trong Cài đặt để app tự giải ẩn, rồi bấm Giải CAPTCHA.",
    });
  }
}
