import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store, StudioError, safeName } from "./store.js";
import { BrowserProfiles } from "./providers/browser-profiles.js";
import { JobQueue } from "./queue.js";
import {
  accountSchema,
  timelineSchema,
  activeStatuses,
  providers,
} from "../shared/contracts.js";
import { importMedia, checkTools } from "./media.js";
import { claimInstance } from "./instance.js";
import { playbackFile } from "./preview.js";
import { licenseStatus, removeLicenseToken, saveLicenseToken } from "./license.js";
import { mountSocialRoutes } from "./social.js";
import { mountResearchRoutes } from "./research.js";
import { mountMetaRoutes } from "./meta.js";
import { createDreamFaceProvider } from "./providers/dreamface.js";
import { DreamFaceSetupQueue } from "./dreamface-setup.js";
import { createDreamFaceSlots, ensureDreamFaceCredentials, parseProxy, proxySecretId, saveDreamFaceProxy, saveDreamFaceCredentials } from "./dreamface-accounts.js";
import { SecretStore } from "./secret-store.js";
import { mountProductionRoutes } from "./production.js";
import { mountContentRoutes } from "./content.js";
import { mountWebsiteRoutes } from "./website.js";
import { inspectMcImageSettings } from "./mc-image.js";
import { SocialScheduler } from "./social-scheduler.js";
import {
  createCaptchaClient,
  publicCaptchaSettings,
  readCaptchaSettings,
  saveCaptchaSettings,
} from "./captcha.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export async function startServer({
  port = Number(process.env.PORT || 4318),
  dataDir = process.env.STUDIO_DATA_DIR || path.join(here, "../.studio"),
  host = "127.0.0.1",
  desktop = null,
} = {}) {
  const instance = claimInstance(dataDir);
  try {
    return await createServer({ port, dataDir, host, desktop, instance });
  } catch (error) {
    instance.release();
    throw error;
  }
}

async function createServer({ port, dataDir, host, desktop, instance }) {
  const store = new Store(dataDir);
  // Mirror only the public flags; the API key itself lives in SecretStore.
  store.state.settings.captcha = publicCaptchaSettings(store);
  const browsers = new BrowserProfiles(store);
  const dreamface = createDreamFaceProvider({ store });
  const dreamfaceSetup = new DreamFaceSetupQueue({ store, dreamface });
  const queue = new JobQueue(store, browsers, {
    generateDreamFace: (currentStore, job, account, signal, update) =>
      job.payload.workflow === "avatar-news"
        ? dreamface.generateNewsAvatar(currentStore, job, account, signal, update)
        : dreamface.generate(currentStore, job, account, signal, update),
  });
  if (!store.state.projects.length) store.createProject("Dự án đầu tiên");
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const hostname = req.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname))
      return res
        .status(403)
        .json({ error: "Chỉ cho phép truy cập trên máy này." });
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
      return res.status(403).json({ error: "Nguồn yêu cầu không hợp lệ." });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res
        .status(403)
        .json({ error: "Yêu cầu chéo website bị từ chối." });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://upload.wikimedia.org https://thumb.wikimedia.org https://commons.wikimedia.org https://ichef.bbci.co.uk https://*.fbcdn.net https://*.facebook.com data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(express.json({ limit: "3mb" }));
  const upload = multer({
    dest: path.join(store.root, "temp"),
    limits: { fileSize: 2 * 1024 ** 3, files: 30 },
  });
  const streams = new Set();
  let changeTimer;
  store.on("change", () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      const event = `data: ${JSON.stringify(store.publicSnapshot())}\n\n`;
      for (const response of streams) response.write(event);
    }, 100);
  });

  app.get("/api/instance", (req, res) => res.json(instance.identity));

  app.get("/api/state", (req, res) =>
    res.json({
      ...store.publicSnapshot(),
      capabilities: { desktop: Boolean(desktop), googleProfileReuse: true },
      providers,
    }),
  );
  app.get("/api/license", (req, res) => res.json(licenseStatus(store.root)));
  app.post("/api/license", (req, res) => {
    const token = z.string().trim().min(1).max(200000).parse(req.body?.token);
    res.json(saveLicenseToken(store.root, token));
  });
  app.delete("/api/license", (req, res) => {
    removeLicenseToken(store.root);
    res.json(licenseStatus(store.root));
  });
  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(store.publicSnapshot())}\n\n`);
    streams.add(res);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20000);
    req.on("close", () => {
      clearInterval(heartbeat);
      streams.delete(res);
    });
  });
  app.get("/api/health", async (req, res) => {
    let browser;
    try {
      browser = { available: true, path: browsers.executable() };
    } catch (error) {
      browser = { available: false, error: error.message };
    }
    res.json({
      tools: await checkTools(store.state.settings),
      browser,
      dataDir: store.root,
      version: APP_VERSION,
    });
  });
  app.get("/api/settings/mc-image", async (req, res) => {
    res.json(await inspectMcImageSettings(store));
  });
  app.get("/api/captcha", (req, res) => {
    res.json({ ...publicCaptchaSettings(store), balance: store.state.settings.captcha?.balance ?? null });
  });
  app.patch("/api/captcha", (req, res) => {
    const input = z.object({
      enabled: z.boolean().optional(),
      autoSolveDreamFace: z.boolean().optional(),
      apiKey: z.string().max(200).optional(),
      clearKey: z.boolean().optional(),
    }).parse(req.body || {});
    const saved = saveCaptchaSettings(store, input);
    store.state.settings.captcha = saved;
    store.save();
    res.json(saved);
  });
  app.post("/api/captcha/balance", async (req, res) => {
    const settings = readCaptchaSettings(store);
    if (!settings.apiKey) throw new StudioError("Chưa lưu API key 2Captcha.", "CAPTCHA_KEY_MISSING", 400);
    const result = await createCaptchaClient({ apiKey: settings.apiKey }).balance();
    store.state.settings.captcha = {
      ...publicCaptchaSettings(store),
      balance: result.balance,
      checkedAt: new Date().toISOString(),
    };
    store.save();
    res.json(store.state.settings.captcha);
  });

  const websiteService = mountWebsiteRoutes(app, store);
  mountSocialRoutes(app, store);
  const contentService = mountContentRoutes(app, store, {
    websiteConfigured: () => {
      websiteService.selected();
      return true;
    },
    websitePublisher: (postId, input) => websiteService.publish(postId, input),
  });
  const metaService = mountMetaRoutes(app, store);
  queue.setNewsAutomation(async ({ job, media }) => {
    const existing = store.state.socialPosts.find(post => post.mediaIds?.includes(media.id));
    const post = await contentService.createContentFromMedia(media.id, {
      source: "news-render",
      force: Boolean(existing?.automationSource === "news-render" && existing?.automationError),
    });
    if (post.contentType !== "news") return { postId: post.id, status: "generated" };
    if (post.automationError) return { postId: post.id, status: "error", error: post.automationError };
    let websiteConfigured = false;
    try {
      websiteService.selected();
      websiteConfigured = true;
    } catch {
      // A website is optional for Meta queueing. The generated article and
      // first comment can go straight to a Page group when no site is set.
    }
    if (store.state.settings.content?.autoPublishNews === false || !websiteConfigured) return { postId: post.id, status: "generated" };
    try {
      const published = await websiteService.publish(post.id, { revision: post.revision });
      // Meta publishing is owned by the Page-group scheduler. This keeps a
      // completed render in the local queue until its configured time instead
      // of sending it immediately to the currently bound Page.
      store.patch("socialPosts", published.id, { automationStatus: "published", automationError: null });
      return { postId: published.id, status: "generated" };
    } catch (error) {
      store.patch("socialPosts", post.id, { automationStatus: "website_error", automationError: error.message });
      return { postId: post.id, status: "website_error", error: error.message };
    }
  });
  queue.setVideoAutomation(async ({ media }) => {
    const existing = store.state.socialPosts.find((post) => post.mediaIds?.includes(media.id));
    const post = await contentService.createContentFromMedia(media.id, {
      source: "render-warehouse",
      force: Boolean(existing?.automationSource === "render-warehouse" && existing?.automationError),
    });
    return {
      postId: post.id,
      status: post.automationError ? "warehouse_error" : "warehouse_ready",
      error: post.automationError || null,
    };
  });
  const socialScheduler = new SocialScheduler(store, metaService.publishReel);
  mountResearchRoutes(app, store, { queue });
  const production = mountProductionRoutes(app, store, queue);

  const checkAccount = async (id) => {
    const account = store.require("accounts", id);
    if (account.provider !== "dreamface") return browsers.check(id);
    const result = await dreamface.check(account);
    store.patch("accounts", id, result);
    return result;
  };
  const loginAccount = async (id, credentials) => {
    const account = store.require("accounts", id);
    if (account.provider !== "dreamface") return browsers.login(id, credentials);
    if(["busy","checking"].includes(account.status))throw new StudioError("This profile is in use. Wait for its current task to finish.","PROFILE_BUSY",409);
    const saved=saveDreamFaceCredentials(store,account,credentials);
    store.patch("accounts",id,{status:"checking",message:"Connecting to DreamFace…"});
    try {
      const result = await dreamface.login(account, saved);
      store.patch("accounts", id, result);
      return result;
    } catch(error) {
      store.patch("accounts",id,{status:"needs_login",message:"DreamFace connection failed. Reconnect this saved profile."});
      throw error;
    }
  };
  const importAccountCookies = async (id, input) => {
    const account = store.require("accounts", id);
    if (account.provider !== "dreamface") return browsers.importCookies(id, input);
    const result = await dreamface.importCookies(account, input);
    store.patch("accounts", id, result);
    return result;
  };

  app.post("/api/projects", (req, res) =>
    res
      .status(201)
      .json(
        store.createProject(
          z.string().trim().min(1).max(120).parse(req.body.name),
        ),
      ),
  );
  app.patch("/api/projects/:id", (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        timeline: timelineSchema.optional(),
        storyboard: z
          .array(
            z.object({
              id: z.string().uuid(),
              title: z.string().max(200),
              prompt: z.string().max(20000),
              duration: z.number().min(1).max(60),
              notes: z.string().max(5000).default(""),
            }),
          )
          .max(200)
          .optional(),
      })
      .parse(req.body);
    res.json(store.patch("projects", req.params.id, input));
  });
  app.delete("/api/projects/:id", (req, res) => {
    store.require("projects", req.params.id);
    if (store.state.projects.length === 1)
      throw new StudioError("Giữ ít nhất một dự án.");
    if (
      store.state.jobs.some(
        (job) =>
          job.projectId === req.params.id &&
          [...activeStatuses, "queued", "scheduled"].includes(job.status),
      )
    )
      throw new StudioError("Hãy dừng các tác vụ của dự án trước.");
    if (store.state.socialPosts.some((post) => post.projectId === req.params.id))
      throw new StudioError("Hãy xóa hoặc chuyển các bài đăng của dự án trước.");
    store.state.projects = store.state.projects.filter(
      (project) => project.id !== req.params.id,
    );
    for (const media of store.state.media)
      if (media.projectId === req.params.id) media.projectId = null;
    store.save();
    res.json({ ok: true });
  });

  app.post("/api/media/upload", upload.array("files", 30), async (req, res) => {
    const results = [];
    try {
      for (const file of req.files || []) {
        const name = Buffer.from(file.originalname, "latin1").toString("utf8");
        const extension = path.extname(name);
        const temporary = `${file.path}${extension}`;
        fs.renameSync(file.path, temporary);
        file.path = temporary;
        try {
          const media = await importMedia(store, temporary, {
            projectId: req.body.projectId || undefined,
            name,
            move: true,
            mediaType: "product",
          });
          results.push({ ok: true, id: media.id, name: media.name });
        } catch (error) {
          results.push({ ok: false, name, error: error.message });
        }
      }
      res.status(201).json({ results });
    } finally {
      for (const file of req.files || []) fs.rmSync(file.path, { force: true });
    }
  });
  app.get("/api/media/:id/file", async (req, res) => {
    const media = store.require("media", req.params.id);
    if (req.query.download)
      return res.download(media.file, safeName(media.name), {
        dotfiles: "allow",
      });
    res.sendFile(await playbackFile(store, media), { dotfiles: "allow" });
  });
  app.get("/api/media/:id/thumbnail", (req, res) => {
    const media = store.require("media", req.params.id);
    if (!media.thumbnail) return res.sendStatus(404);
    res.sendFile(media.thumbnail, { dotfiles: "allow" });
  });
  app.get("/api/media/:id/location", (req, res) => {
    const media = store.require("media", req.params.id);
    res.json({ file: media.file, directory: path.dirname(media.file), name: media.name });
  });
  app.delete("/api/media/:id", (req, res) => {
    const media = store.require("media", req.params.id);
    const inTimeline = store.state.projects.some(
      (project) =>
        project.timeline.clips.some((clip) => clip.mediaId === media.id) ||
        project.timeline.images.some((image) => image.mediaId === media.id) ||
        project.timeline.music?.mediaId === media.id,
    );
    const inJob = store.state.jobs.some(
      (job) =>
        [...activeStatuses, "queued", "scheduled"].includes(job.status) &&
        JSON.stringify(job.payload).includes(media.id),
    );
    const inSocialPost = store.state.socialPosts.some((post) =>
      post.mediaIds?.includes(media.id),
    );
    if (inTimeline || inJob || inSocialPost)
      throw new StudioError(
        "Tệp đang được dùng trong timeline, bài đăng hoặc tác vụ đang chờ. Gỡ khỏi đó trước khi xóa.",
      );
    fs.rmSync(media.file, { force: true });
    if (media.thumbnail) fs.rmSync(media.thumbnail, { force: true });
    if (media.previewFile) fs.rmSync(media.previewFile, { force: true });
    store.state.media = store.state.media.filter(
      (item) => item.id !== media.id,
    );
    store.save();
    res.json({ ok: true });
  });

  app.post("/api/accounts", (req, res) => {
    const data = accountSchema.parse(req.body);
    if (data.provider === "flow" && data.loginMethod === "apple")
      throw new StudioError("Google Flow dùng tài khoản Google hoặc cookie.");
    const parsedProxy = parseProxy(data.proxy);
    if ((parsedProxy.username || parsedProxy.password) && data.provider !== "dreamface")
      throw new StudioError("Proxy có user/password hiện chỉ dùng được với profile DreamFace.", "PROXY_AUTH_UNSUPPORTED", 422);
    const account = store.add("accounts", {
        ...data,
        proxy: parsedProxy.server,
        proxyAuth: Boolean(parsedProxy.username),
        status: "offline",
        message: "Chưa kiểm tra phiên đăng nhập.",
      });
    if (data.provider === "dreamface") saveDreamFaceProxy(store, account, data.proxy);
    res.status(201).json(account);
  });
  app.post("/api/accounts/bulk-slots", (req, res) => {
    const input = z.object({
      provider: z.literal("dreamface").default("dreamface"),
      count: z.number().int().min(1).max(100),
      namePrefix: z.string().trim().min(1).max(80).default("DreamFace slot"),
      proxy: z.string().trim().max(500).default(""),
      proxies: z.array(z.string().trim().max(500)).max(100).default([]),
    }).parse(req.body || {});
    const accounts = createDreamFaceSlots(store,input);
    res.status(201).json({ accounts, created: accounts.length });
  });
  app.post("/api/accounts/bulk-login", (req, res) => {
    const input = z.object({
      ids: z.array(z.string().uuid()).max(100).default([]),
      concurrency: z.number().int().min(1).max(4).optional(),
    }).parse(req.body || {});
    const accounts = input.ids.length
      ? input.ids.map((id) => store.require("accounts", id))
      : store.state.accounts.filter((account) =>
        account.provider === "dreamface" &&
        !["ready", "busy", "checking"].includes(account.status));
    res.status(202).json(dreamfaceSetup.enqueue(accounts, { concurrency: input.concurrency }));
  });
  app.get("/api/accounts/setup-status", (req, res) => {
    res.json(dreamfaceSetup.status());
  });
  app.patch("/api/accounts/:id", async (req, res) => {
    const account = store.require("accounts", req.params.id);
    const input = z.object({ proxy: z.string().trim().max(500).default("") }).parse(req.body || {});
    if (["busy", "checking"].includes(account.status))
      throw new StudioError("Hồ sơ đang được sử dụng. Chờ tác vụ hiện tại kết thúc trước khi đổi proxy.", "PROFILE_BUSY", 409);
    if (account.provider !== "dreamface" && browsers.profileAccounts(account).length > 1)
      throw new StudioError("Hồ sơ Google đang dùng chung. Đổi proxy riêng sẽ làm lệch các tài khoản liên kết.", "SHARED_PROFILE", 409);
    const parsedProxy = parseProxy(input.proxy);
    if ((parsedProxy.username || parsedProxy.password) && account.provider !== "dreamface")
      throw new StudioError("Proxy có user/password hiện chỉ dùng được với profile DreamFace.", "PROXY_AUTH_UNSUPPORTED", 422);
    if (parsedProxy.server === (account.proxy || "") && Boolean(parsedProxy.username) === Boolean(account.proxyAuth)) return res.json(account);
    if (account.provider === "dreamface") await dreamface.close(account);
    else await browsers.close(account.id);
    if (account.provider === "dreamface") saveDreamFaceProxy(store, account, input.proxy);
    res.json(store.patch("accounts", account.id, {
      proxy: parsedProxy.server,
      proxyAuth: Boolean(parsedProxy.username),
      status: account.status === "ready" ? "offline" : account.status,
      message: parsedProxy.server ? "Proxy đã lưu. Hãy kiểm tra proxy trước khi render." : "Đã bỏ proxy. Hãy kiểm tra phiên trước khi render.",
    }));
  });
  app.post("/api/accounts/:id/proxy-check", async (req, res) => {
    const account = store.require("accounts", req.params.id);
    if (account.provider !== "dreamface") throw new StudioError("Kiểm tra proxy có user/password hiện chỉ dành cho profile DreamFace.", "PROXY_CHECK_UNSUPPORTED", 422);
    const result = await dreamface.checkProxy(account);
    res.json(store.patch("accounts", account.id, {
      proxyStatus: result.status,
      proxyIp: result.ip || "",
      proxyCheckedAt: new Date().toISOString(),
      proxyMessage: result.message,
    }));
  });
  app.post("/api/accounts/:id/gmail-signup", async (req, res) => {
    const account = store.require("accounts", req.params.id);
    if (account.provider !== "dreamface")
      throw new StudioError("Luồng tự điền email chỉ dành cho profile DreamFace.", "GMAIL_DREAMFACE_ONLY", 409);
    if (["busy", "checking"].includes(account.status))
      throw new StudioError("Profile đang được sử dụng. Chờ tác vụ hiện tại kết thúc trước khi mở DreamFace.", "PROFILE_BUSY", 409);
    const input = z.object({
      action: z.enum(["start", "check"]).default("start"),
      firstName: z.string().trim().max(80).default(""),
      lastName: z.string().trim().max(80).default(""),
    }).parse(req.body || {});
    const credentials = ensureDreamFaceCredentials(store, account);
    store.patch("accounts", account.id, {
      gmailStatus: input.action === "start" ? "opening" : (account.gmailStatus || "pending"),
      gmailAuthStep: "browser",
      message: "Opening DreamFace in this profile Chrome window...",
    });
    try {
      const result = input.action === "check"
        ? await dreamface.checkDreamFaceSignup(account)
        : await dreamface.startDreamFaceSignup(account, credentials);
      const updated = store.patch("accounts", account.id, {
        status: ["ready", "verification", "needs_login"].includes(result.status) ? result.status : account.status,
        gmailStatus: result.status,
        gmailAuthStep: result.authStep || "",
        gmailCheckedAt: new Date().toISOString(),
        message: result.message,
      });
      res.json({ ...result, email: credentials.email, account: updated });
    } catch (error) {
      store.patch("accounts", account.id, {
        status: "needs_login",
        gmailStatus: "failed",
        gmailAuthStep: "error",
        message: error.message,
      });
      throw error;
    }
  });
  app.post("/api/accounts/:id/check", async (req, res) =>
    res.json(await checkAccount(req.params.id)),
  );
  app.post("/api/accounts/:id/captcha", async (req, res) => {
    const account = store.require("accounts", req.params.id);
    if (account.provider !== "dreamface")
      throw new StudioError("Giải CAPTCHA bằng 2Captcha chỉ dành cho profile DreamFace.", "CAPTCHA_DREAMFACE_ONLY", 409);
    if (["busy", "checking"].includes(account.status))
      throw new StudioError("Profile đang được sử dụng. Chờ tác vụ hiện tại kết thúc.", "PROFILE_BUSY", 409);
    store.patch("accounts", account.id, {
      gmailAuthStep: "captcha",
      message: "Đang giải CAPTCHA DreamFace bằng 2Captcha...",
    });
    try {
      const result = await dreamface.solveAccountCaptcha(account);
      const updated = store.patch("accounts", account.id, {
        status: ["ready", "verification", "needs_login"].includes(result.status) ? result.status : account.status,
        gmailStatus: result.status,
        gmailAuthStep: result.authStep || "captcha",
        gmailCheckedAt: new Date().toISOString(),
        message: result.message,
      });
      res.json({ ...result, account: updated });
    } catch (error) {
      store.patch("accounts", account.id, {
        gmailStatus: "verification",
        gmailAuthStep: "captcha",
        message: error.message,
      });
      throw error;
    }
  });
  app.post("/api/accounts/:id/login", async (req, res) => {
    const credentials = z
      .object({
        email: z.string().max(200).optional(),
        password: z.string().max(1000).optional(),
      })
      .parse(req.body || {});
    res.json(await loginAccount(req.params.id, credentials));
  });
  app.post("/api/accounts/:id/cookies", async (req, res) =>
    res.json(
      await importAccountCookies(
        req.params.id,
        z.string().min(1).max(2000000).parse(req.body.cookies),
      ),
    ),
  );
  app.post("/api/accounts/:id/reuse-google", async (req, res) => {
    const { sourceAccountId } = z.object({ sourceAccountId: z.string().uuid() }).parse(req.body);
    res.json(await browsers.reuseGoogle(req.params.id, sourceAccountId));
  });
  app.post("/api/accounts/:id/open", async (req, res) => {
    const account = store.require("accounts", req.params.id);
    if (account.provider === "dreamface") {
      const session = await dreamface.open(account, { visible: true });
      if (session.page.url() === "about:blank") await session.page.goto(providers.dreamface.url);
      res.json({ ok: true });
      return;
    }
    if (browsers.profileAccounts(account).some((item) => item.status === "busy")) {
      const session = browsers.sessions.get(account.id);
      if (!session?.visible || session.page.isClosed())
        throw new StudioError("Hồ sơ đang chạy tác vụ. Chờ hoàn tất trước khi mở một cửa sổ mới.");
      await browsers.reveal(session, session.page);
      return res.json({ ok: true });
    }
    await browsers.withIdleProfiles([account], async () => {
      const session = await browsers.open(account, { visible: true });
      if (session.page.url() === "about:blank")
        await session.page.goto(providers[account.provider].url);
      browsers.monitor(account, session);
    });
    res.json({ ok: true });
  });
  app.delete("/api/accounts/:id", async (req, res) => {
    const account = store.require("accounts", req.params.id);
    if (account.provider === "dreamface") await dreamface.close(account);
    const result=await browsers.deleteAccount(req.params.id);
    if(account.provider==="dreamface") {
      const secrets = new SecretStore(store.root);
      secrets.delete(`dreamface-${account.id}`);
      secrets.delete(proxySecretId(account.id));
    }
    res.json(result);
  });

  app.post("/api/jobs/generate", (req, res) => {
    const jobs = queue.enqueueGeneration(req.body);
    res.status(201).json(jobs);
    queue.tick();
  });
  app.post("/api/jobs/render", (req, res) => {
    const { production, ...input } = req.body || {};
    const job = queue.enqueueRender(input, { production });
    res.status(201).json(job);
    queue.tick();
  });
  app.post("/api/jobs/:id/cancel", (req, res) =>
    res.json(queue.cancel(req.params.id)),
  );
  app.post("/api/jobs/:id/retry", (req, res) =>
    res.json(queue.retry(req.params.id, req.body.confirmResubmit === true)),
  );
  app.post("/api/jobs/:id/recover", async (req, res) => {
    const job = store.require("jobs", req.params.id);
    const accounts = store.state.accounts.filter((account) =>
      account.provider === "dreamface" && ["ready", "offline"].includes(account.status),
    );
    // A restart intentionally marks a busy profile offline. Re-check the
    // saved DreamFace profiles before recovery so the queue can use the same
    // authenticated session without creating another provider task.
    await Promise.allSettled(accounts.map(async (account) => {
      if (account.status === "ready") return;
      try {
        const result = await dreamface.check(account);
        store.patch("accounts", account.id, result);
      } catch {}
    }));
    res.json(queue.recoverSubmitted(job.id));
  });
  app.patch("/api/settings", (req, res) => {
    const httpUrl = (value) => String(value || "").trim() === "" || /^https?:\/\/[^\s]+$/i.test(String(value));
    const input = z
      .object({
        concurrency: z.number().int().min(1).max(5).optional(),
        renderConcurrency: z.number().int().min(1).max(4).optional(),
        renderThreads: z.number().int().min(1).max(32).optional(),
        dreamfaceConcurrency: z.number().int().min(1).max(4).optional(),
        queuePaused: z.boolean().optional(),
        pollSeconds: z.number().int().min(3).max(60).optional(),
        maxWaitMinutes: z.number().int().min(2).max(120).optional(),
        chromePath: z.string().max(1000).optional(),
        ffmpegPath: z.string().max(1000).optional(),
        ffprobePath: z.string().max(1000).optional(),
        browserVisible: z.boolean().optional(),
        imageGeneration: z.object({
          enabled: z.boolean().optional(),
          endpoint: z.string().trim().max(2000).refine((value) => value === "" || httpUrl(value), "Image endpoint must be an HTTP or HTTPS URL.").optional(),
          apiKey: z.string().max(2000).optional(),
          model: z.string().trim().max(200).optional(),
          autoDiscover: z.boolean().optional(),
          dreamfaceFallback: z.boolean().optional(),
        }).optional(),
        content: z.object({
          storeName: z.string().trim().max(160).optional(),
          storeUrl: z.string().trim().max(2000).refine(httpUrl, "URL Store phải bắt đầu bằng http:// hoặc https://.").optional(),
          storeLinkLabel: z.string().trim().max(160).optional(),
          articleWebsiteName: z.string().trim().max(160).optional(),
          articleWebsiteUrl: z.string().trim().max(2000).refine(httpUrl, "URL website bài viết phải bắt đầu bằng http:// hoặc https://.").optional(),
          articleLinkLabel: z.string().trim().max(160).optional(),
          productFirstCommentTemplate: z.string().max(10000).optional(),
          newsFirstCommentTemplate: z.string().max(10000).optional(),
          autoPublishNews: z.boolean().optional(),
          autoPostNews: z.boolean().optional(),
        }).optional(),
      })
      .parse(req.body);
    const { content, imageGeneration, ...generalSettings } = input;
    Object.assign(store.state.settings, generalSettings);
    if (content) store.state.settings.content = { ...(store.state.settings.content || {}), ...content };
    if (imageGeneration) {
      const current = store.state.settings.imageGeneration || {};
      store.state.settings.imageGeneration = {
        ...current,
        ...imageGeneration,
        apiKey: imageGeneration.apiKey === "[đã lưu]" ? current.apiKey : imageGeneration.apiKey ?? current.apiKey,
      };
    }
    store.save();
    res.json(store.publicSnapshot().settings);
  });
  app.post("/api/desktop/reveal", async (req, res) => {
    if (!desktop)
      throw new StudioError("Mở thư mục khả dụng trong bản desktop.");
    const target = req.body.mediaId
      ? store.require("media", req.body.mediaId).file
      : store.root;
    await desktop.reveal(target);
    res.json({ ok: true });
  });

  const dist = path.join(here, "../dist");
  app.use(express.static(dist));
  app.get("/{*path}", (req, res) => {
    if (req.path.startsWith("/api/"))
      return res.status(404).json({ error: "API không tồn tại." });
    if (fs.existsSync(path.join(dist, "index.html")))
      res.sendFile(path.join(dist, "index.html"));
    else res.status(503).send("Chạy npm run build trước khi mở ứng dụng.");
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let message =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("\n")
        : error.message;
    for (const secret of [req.body?.password, req.body?.cookies, req.body?.accessToken, req.body?.token, req.body?.appSecret]) {
      if (typeof secret === "string" && secret.length > 3)
        message = message?.replaceAll(secret, "[đã ẩn]");
    }
    res.status(error.status || 400).json({
      error: message || "Không thể xử lý yêu cầu.",
      code: error.code || "INVALID_REQUEST",
    });
  });
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const listening = app.listen(port, host, () => resolve(listening));
      listening.once("error", reject);
    });
  } catch (error) {
    await socialScheduler.close();
    await queue.close();
    throw error;
  }
  const address = `http://${host}:${server.address().port}`;
  instance.setAddress(address);
  const close = async () => {
    try {
      for (const stream of streams) stream.end();
      clearTimeout(changeTimer);
      await socialScheduler.close();
      await production.close();
      await queue.close();
      dreamfaceSetup.stop();
      await browsers.closeAll();
      await Promise.allSettled(
        store.state.accounts
          .filter((account) => account.provider === "dreamface")
          .map((account) => dreamface.close(account)),
      );
      await new Promise((resolve) => server.close(resolve));
    } finally {
      instance.release();
    }
  };
  return { app, server, store, browsers, queue, socialScheduler, address, close };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const studio = await startServer();
  console.log(`Viral Studio: ${studio.address}`);
  let stopping = false;
  const close = async () => {
    if (stopping) return;
    stopping = true;
    await studio.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
