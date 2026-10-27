import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { activeStatuses, defaultTimeline } from "../shared/contracts.js";

function maskSecret(value) {
  const secret = String(value || "");
  if (!secret) return "";
  return secret.length > 12 ? `${secret.slice(0, 6)}…${secret.slice(-4)}` : "***";
}

export class StudioError extends Error {
  constructor(message, code = "INVALID_REQUEST", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class Store extends EventEmitter {
  constructor(root) {
    super();
    this.root = path.resolve(root);
    for (const name of [
      "media",
      "thumbs",
      "exports",
      "temp",
      "profiles",
      "logs",
    ]) {
      fs.mkdirSync(path.join(this.root, name), { recursive: true });
    }
    this.file = path.join(this.root, "studio.json");
    this.state = {
      version: 1,
      projects: [],
      media: [],
      accounts: [],
      jobs: [],
      socialPages: [],
      socialPosts: [],
      researchResults: [],
      productionBatches: [],
      settings: {
        concurrency: 2,
        queuePaused: false,
        pollSeconds: 5,
        maxWaitMinutes: 30,
        chromePath: "",
        ffmpegPath: "",
        ffprobePath: "",
        browserVisible: false,
        content: {
          storeName: "",
          storeUrl: "",
          storeLinkLabel: "Shop now",
          articleWebsiteName: "",
          articleWebsiteUrl: "",
          articleLinkLabel: "Read the full article",
          productFirstCommentTemplate: "",
          newsFirstCommentTemplate: "",
          autoPublishNews: true,
          autoPostNews: false,
        },
        llm: {
          enabled: false,
          endpoint: "https://api.openai.com/v1",
          apiKey: "",
          model: "gpt-4o-mini",
          timeoutSeconds: 90,
        },
        imageGeneration: {
          enabled: true,
          endpoint: "",
          apiKey: "",
          model: "",
          autoDiscover: true,
          dreamfaceFallback: true,
        },
        meta: {
          enabled: false,
          graphVersion: "v26.0",
          accessToken: "",
          activeTokenId: "",
          user: null,
          pages: [],
          boundPageId: "",
          boundPageName: "",
          boundPageToken: "",
          publications: [],
          tokens: [],
          tokenGroups: [],
          pageGroups: [],
        },
      },
    };
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (this.state.version !== 1) {
        throw new Error("Phiên bản dữ liệu chưa được hỗ trợ.");
      }
    }
    let recovered = false;
    for (const collection of ["socialPages", "socialPosts", "researchResults", "productionBatches"]) {
      if (this.state[collection] === undefined) {
        this.state[collection] = [];
        recovered = true;
      }
      if (!Array.isArray(this.state[collection])) {
        throw new Error("Dữ liệu Page/bài đăng không hợp lệ; hãy khôi phục bản sao lưu.");
      }
    }
    this.state.socialPosts = this.state.socialPosts.map((post) => ({
      contentType: "product",
      firstComment: "",
      linkUrl: "",
      linkLabel: "",
      sourceUrl: "",
      coverImageUrl: "",
      articleBody: "",
      researchId: null,
      ...post,
    }));
    if (!this.state.settings || typeof this.state.settings !== "object") {
      this.state.settings = {};
      recovered = true;
    }
    const defaults = {
      concurrency: 2,
      queuePaused: false,
      pollSeconds: 5,
      maxWaitMinutes: 30,
      chromePath: "",
      ffmpegPath: "",
      ffprobePath: "",
      browserVisible: false,
      content: {
        storeName: "",
        storeUrl: "",
        storeLinkLabel: "Shop now",
        articleWebsiteName: "",
        articleWebsiteUrl: "",
        articleLinkLabel: "Read the full article",
        productFirstCommentTemplate: "",
        newsFirstCommentTemplate: "",
        autoPublishNews: true,
        autoPostNews: false,
      },
      llm: {
        enabled: false,
        endpoint: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
        timeoutSeconds: 90,
      },
      imageGeneration: {
        enabled: true,
        endpoint: "",
        apiKey: "",
        model: "",
        autoDiscover: true,
        dreamfaceFallback: true,
      },
      meta: {
        enabled: false,
        graphVersion: "v26.0",
        accessToken: "",
        activeTokenId: "",
        user: null,
        pages: [],
        boundPageId: "",
        boundPageName: "",
        boundPageToken: "",
        publications: [],
        tokens: [],
        tokenGroups: [],
        pageGroups: [],
      },
    };
    for (const [key, value] of Object.entries(defaults)) {
      if (this.state.settings[key] === undefined) {
        this.state.settings[key] = structuredClone(value);
        recovered = true;
      }
    }
    this.state.settings.llm = {
      ...defaults.llm,
      ...(this.state.settings.llm || {}),
    };
    this.state.settings.imageGeneration = {
      ...defaults.imageGeneration,
      ...(this.state.settings.imageGeneration || {}),
    };
    this.state.settings.content = {
      ...defaults.content,
      ...(this.state.settings.content || {}),
    };
    if (this.state.settings.content.storeLinkLabel === "Xem sản phẩm") {
      this.state.settings.content.storeLinkLabel = defaults.content.storeLinkLabel;
      recovered = true;
    }
    if (this.state.settings.content.articleLinkLabel === "Đọc bài đầy đủ") {
      this.state.settings.content.articleLinkLabel = defaults.content.articleLinkLabel;
      recovered = true;
    }
    this.state.settings.meta = {
      ...defaults.meta,
      ...(this.state.settings.meta || {}),
      pages: Array.isArray(this.state.settings.meta?.pages) ? this.state.settings.meta.pages : [],
      publications: Array.isArray(this.state.settings.meta?.publications) ? this.state.settings.meta.publications : [],
      tokens: Array.isArray(this.state.settings.meta?.tokens) ? this.state.settings.meta.tokens : [],
      tokenGroups: Array.isArray(this.state.settings.meta?.tokenGroups) ? this.state.settings.meta.tokenGroups : [],
      pageGroups: Array.isArray(this.state.settings.meta?.pageGroups) ? this.state.settings.meta.pageGroups : [],
    };
    if (this.state.settings.meta.graphVersion === "v24.0") {
      this.state.settings.meta.graphVersion = defaults.meta.graphVersion;
      recovered = true;
    }
    for (const token of this.state.settings.meta.tokens) {
      if (!["USER", "SYSTEM_USER", "VIA_TOKEN"].includes(token.kind)) {
        token.kind = "USER";
        recovered = true;
      }
    }
    for (const job of this.state.jobs) {
      if (activeStatuses.includes(job.status)) {
        job.status = "interrupted";
        job.error = job.submittedAt
          ? "Ứng dụng đã đóng sau khi gửi. Mở tài khoản để kiểm tra video trước khi thử lại, tránh tốn thêm lượt."
          : "Ứng dụng đã đóng khi tác vụ đang chạy. Bạn có thể thử lại.";
        job.updatedAt = new Date().toISOString();
        recovered = true;
      }
    }
    for (const account of this.state.accounts) {
      if (account.status === "busy" || account.status === "checking") {
        account.status = "offline";
        recovered = true;
      }
    }
    if (recovered) this.save();
  }

  save() {
    const temporary = `${this.file}.tmp`;
    const fd = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.state, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.file);
    this.emit("change");
  }

  snapshot() {
    return structuredClone(this.state);
  }

  require(collection, id) {
    const entity = this.state[collection].find((item) => item.id === id);
    if (!entity)
      throw new StudioError("Không tìm thấy dữ liệu.", "NOT_FOUND", 404);
    return entity;
  }

  patch(collection, id, patch) {
    const entity = this.require(collection, id);
    Object.assign(entity, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return entity;
  }

  add(collection, data) {
    const entity = {
      ...data,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.state[collection].push(entity);
    this.save();
    return entity;
  }

  createProject(name) {
    return this.add("projects", {
      name,
      timeline: defaultTimeline(),
      storyboard: [],
    });
  }

  publicSnapshot() {
    const snapshot = this.snapshot();
    if (snapshot.settings?.llm) {
      snapshot.settings.llm = {
        ...snapshot.settings.llm,
        apiKey: snapshot.settings.llm.apiKey ? "[đã lưu]" : "",
      };
    }
    if (snapshot.settings?.imageGeneration) {
      snapshot.settings.imageGeneration = {
        ...snapshot.settings.imageGeneration,
        apiKey: snapshot.settings.imageGeneration.apiKey ? "[đã lưu]" : "",
      };
    }
    if (snapshot.settings?.meta) {
      snapshot.settings.meta = {
        ...snapshot.settings.meta,
        accessToken: snapshot.settings.meta.accessToken ? "[đã lưu]" : "",
        boundPageToken: snapshot.settings.meta.boundPageToken ? "[đã lưu]" : "",
        pages: (snapshot.settings.meta.pages || []).map(({ accessToken, tokenBindings, ...page }) => ({
          ...page,
          hasToken: Boolean(accessToken),
          tokenBindings: Object.fromEntries(Object.entries(tokenBindings || {}).map(([id, binding]) => {
            const { pageToken, ...publicBinding } = binding || {};
            return [id, { ...publicBinding, hasToken: Boolean(pageToken) }];
          })),
        })),
        tokens: (snapshot.settings.meta.tokens || []).map(({ token, appSecret, ...entry }) => ({
          ...entry,
          tokenMasked: token ? maskSecret(token) : "",
          hasToken: Boolean(token),
          hasAppSecret: Boolean(appSecret),
        })),
      };
    }
    snapshot.media = snapshot.media.map(({ file, thumbnail, previewFile, ...media }) => ({
      ...media,
      url: `/api/media/${media.id}/file`,
      thumbnailUrl: thumbnail ? `/api/media/${media.id}/thumbnail` : null,
    }));
    return snapshot;
  }

  log(job, message) {
    job.logs ??= [];
    job.logs.push({ time: new Date().toISOString(), message });
    if (job.logs.length > 200) job.logs.shift();
    job.updatedAt = new Date().toISOString();
    this.save();
  }
}

export function safeName(value, fallback = "video") {
  const name = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  return name || fallback;
}
