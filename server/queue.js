import { randomUUID } from "node:crypto";
import {
  generationSchema,
  defaultTimeline,
  providers,
} from "../shared/contracts.js";
import { StudioError } from "./store.js";
import { renderTimeline, validateTimeline } from "./render.js";
import { generate } from "./providers/generate.js";

export class JobQueue {
  constructor(store, browsers, options = {}) {
    this.store = store;
    this.browsers = browsers;
    this.generate = options.generate || generate;
    this.generateDreamFace = options.generateDreamFace || null;
    this.render = options.render || renderTimeline;
    this.now = options.now || Date.now;
    this.running = new Map();
    this.stopping = false;
    this.timer = options.intervalMs === 0
      ? null
      : setInterval(() => this.tick(), options.intervalMs || 1200);
    this.timer?.unref();
  }

  enqueueGeneration(input) {
    const data = generationSchema.parse(input);
    if (
      data.provider === "dola" &&
      data.kind === "video" &&
      data.model === "Seedance"
    ) {
      data.model = providers.dola.models[0];
    }
    if (data.provider === "dola" && data.kind === "image" && data.model === "Dola Image") {
      data.model = providers.dola.imageModels[0];
    }
    this.store.require("projects", data.projectId);
    const config = providers[data.provider];
    const ratios = data.kind === "image" ? config.imageRatios || config.ratios : config.ratios;
    if (!ratios.includes(data.ratio))
      throw new StudioError("Tỷ lệ này không được nhà cung cấp hỗ trợ.");
    const supportedModels =
      data.kind === "image"
        ? providers[data.provider].imageModels
        : providers[data.provider].models;
    if (!supportedModels.includes(data.model))
      throw new StudioError("Mô hình chưa được hỗ trợ.");
    if (
      data.kind === "video" &&
      !providers[data.provider].durations.includes(data.duration)
    )
      throw new StudioError("Thời lượng chưa được nhà cung cấp hỗ trợ.");
    if (data.kind === "image" && ["firstlast", "extend"].includes(data.mode))
      throw new StudioError("Tạo ảnh chỉ hỗ trợ văn bản hoặc ảnh tham chiếu.");
    if (
      data.kind === "video" &&
      data.provider === "flow" &&
      /^Veo /.test(data.model) &&
      data.duration !== 8
    )
      throw new StudioError("Veo hiện dùng thời lượng 8 giây.");
    if (
      data.accountId !== "auto" &&
      this.store.require("accounts", data.accountId).provider !== data.provider
    )
      throw new StudioError("Tài khoản không thuộc nhà cung cấp đã chọn.");
    const media = data.references.map((id) => this.store.require("media", id));
    if (data.mode === "reference" && !media.length)
      throw new StudioError("Hãy chọn ảnh tham chiếu.");
    if (
      data.mode === "firstlast" &&
      (media.length !== 2 || media.some((item) => item.kind !== "image"))
    )
      throw new StudioError("Chế độ khung hình đầu/cuối cần đúng 2 ảnh.");
    if (
      data.mode === "extend" &&
      (media.length !== 1 || media[0].kind !== "video")
    )
      throw new StudioError("Kéo dài video cần một video tham chiếu.");
    if (data.mode !== "extend" && media.some((item) => item.kind !== "image"))
      throw new StudioError("Tham chiếu phải là tệp ảnh.");
    const batchId = randomUUID();
    return data.prompts.map((prompt, index) => {
      const { prompts, ...payload } = data;
      return this.store.add("jobs", {
        type: "generate",
        projectId: data.projectId,
        batchId,
        sceneId: randomUUID(),
        batchIndex: index,
        batchSize: data.prompts.length,
        name: `${data.kind === "video" ? "Video" : "Ảnh"} ${index + 1} · ${prompt.slice(0, 60)}`,
        payload: { ...payload, prompt },
        status:
          data.scheduledAt && Date.parse(data.scheduledAt) > this.now()
            ? "scheduled"
            : "queued",
        progress: 0,
        logs: [],
        mediaId: null,
        submittedAt: null,
        error: null,
      });
    });
  }

  enqueueRender(input) {
    const project = this.store.require("projects", input.projectId);
    const timeline = validateTimeline(
      this.store,
      input.timeline || project.timeline,
    );
    return this.store.add("jobs", {
      type: "render",
      projectId: project.id,
      name: String(input.name || project.name).slice(0, 120),
      payload: { timeline },
      status: "queued",
      progress: 0,
      logs: [],
      mediaId: null,
      error: null,
    });
  }

  tick() {
    if (this.stopping || this.store.state.settings.queuePaused) return;
    // Recover the gap between saving the last generated asset and scheduling
    // its export. Persisted assemblyBatchId prevents duplicate render jobs.
    const batches = new Set();
    for (const job of this.store.state.jobs) {
      if (job.type !== "generate" || !job.payload.autoAssemble || !job.batchId) continue;
      if (batches.has(job.batchId)) continue;
      batches.add(job.batchId);
      this.assemble(job);
    }
    for (const job of this.store.state.jobs) {
      if (!["queued", "scheduled"].includes(job.status)) continue;
      if (
        job.payload.scheduledAt &&
        Date.parse(job.payload.scheduledAt) > this.now()
      )
        continue;
      if (job.type === "render") {
        if ([...this.running.values()].some((entry) => entry.type === "render"))
          continue;
        this.start(job, null);
        continue;
      }
      const generating = [...this.running.values()].filter(
        (entry) => entry.type === "generate",
      );
      if (generating.length >= this.store.state.settings.concurrency) continue;
      const accounts = this.store.state.accounts.filter(
        (account) =>
          account.provider === job.payload.provider &&
          account.status === "ready" &&
          !this.browsers?.isProfileLocked?.(account) &&
          !this.store.state.accounts.some((other) =>
            (other.profileId || other.id) === (account.profileId || account.id) &&
            ["busy", "checking"].includes(other.status)),
      );
      const account = accounts.find(
        (item) =>
          (job.payload.accountId === "auto" ||
            item.id === job.payload.accountId) &&
          !generating.some((entry) => entry.profileId === (item.profileId || item.id)),
      );
      if (!account) continue;
      this.start(job, account);
    }
  }

  start(job, account) {
    const controller = new AbortController();
    const entry = {
      controller,
      type: job.type,
      accountId: account?.id,
      profileId: account?.profileId || account?.id,
    };
    this.running.set(job.id, entry);
    this.store.patch("jobs", job.id, {
      status: "preparing",
      startedAt: new Date().toISOString(),
      accountId: account?.id || null,
    });
    if (account) this.store.patch("accounts", account.id, { status: "busy" });
    entry.promise = this.execute(job, account, controller).finally(() => {
      this.running.delete(job.id);
      this.tick();
    });
  }

  async execute(job, account, controller) {
    const update = (patch) => this.store.patch("jobs", job.id, patch);
    try {
      const media =
        job.type === "render"
          ? await this.render(
              this.store,
              job,
              controller.signal,
              (progress, stage) =>
                update({ status: "rendering", progress, stage }),
            )
          : job.payload.provider === "dreamface" && this.generateDreamFace
            ? await this.generateDreamFace(
                this.store,
                job,
                account,
                controller.signal,
                update,
              )
            : await this.generate(
                this.store,
                this.browsers,
                job,
                account,
                controller.signal,
                update,
              );
      update({
        status: "completed",
        progress: 100,
        stage: "Hoàn tất",
        mediaId: media.id,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      update({
        status: cancelled ? "cancelled" : "failed",
        error: cancelled
          ? "Đã dừng theo dõi. Yêu cầu đã gửi trên dịch vụ có thể vẫn tiếp tục."
          : error.message,
        errorCode: error.code || "JOB_FAILED",
        finishedAt: new Date().toISOString(),
      });
      this.store.log(job, job.error);
      if (account && ["NEEDS_LOGIN", "VERIFICATION"].includes(error.code)) {
        this.store.patch("accounts", account.id, {
          status: error.code === "NEEDS_LOGIN" ? "needs_login" : "verification",
          message: error.message,
        });
      }
      if (account && error.code === "PROVIDER_QUOTA") {
        this.store.patch("accounts", account.id, {
          status: "error",
          message: error.message,
        });
      }
    } finally {
      if (account?.status === "busy")
        this.store.patch("accounts", account.id, { status: "ready" });
    }
    // Assembly has its own failed render job. A downloaded AI asset remains
    // completed even when validation or export subsequently fails.
    if (job.status === "completed" && job.type === "generate" && job.payload.autoAssemble) {
      this.assemble(job);
    }
  }

  originalAttempt(job) {
    let current = job;
    const visited = new Set();
    while (current.retryOf && !visited.has(current.id)) {
      visited.add(current.id);
      const previous = this.store.state.jobs.find((item) => item.id === current.retryOf);
      if (!previous || previous.type !== current.type) break;
      current = previous;
    }
    return current;
  }

  batchEntries(batchId) {
    const scenes = new Map();
    for (const item of this.store.state.jobs) {
      if (item.type !== "generate") continue;
      const original = this.originalAttempt(item);
      if ((item.batchId || original.batchId) !== batchId) continue;
      const key = item.sceneId || original.sceneId || original.id;
      const position = original.batchIndex ?? this.store.state.jobs.indexOf(original);
      // Retries are appended. The newest attempt replaces only its own scene.
      scenes.set(key, { job: item, position });
    }
    return [...scenes.values()]
      .sort((left, right) => left.position - right.position)
      .map((entry) => entry.job);
  }

  assemblyTimeline(batch) {
    const timeline = defaultTimeline();
    const job = batch[0];
    timeline.ratio = ["9:16", "16:9", "1:1"].includes(job.payload.ratio)
      ? job.payload.ratio
      : "9:16";
    timeline.clips = batch.map((item) => {
      const media = this.store.require("media", item.mediaId);
      return {
        id: randomUUID(),
        mediaId: media.id,
        inSec: 0,
        outSec: media.duration,
        speed: 1,
        zoom: 1,
        fit: "cover",
        volume: 1,
      };
    });
    return validateTimeline(this.store, timeline);
  }

  linkAssembly(batchId, renderId) {
    let changed = false;
    for (const item of this.store.state.jobs) {
      if (item.type !== "generate" || item.assembled === renderId) continue;
      const original = this.originalAttempt(item);
      if ((item.batchId || original.batchId) !== batchId) continue;
      item.assembled = renderId;
      changed = true;
    }
    if (changed) this.store.save();
  }

  assemble(job) {
    if (!job.batchId) return;
    const batch = this.batchEntries(job.batchId);
    const previous = this.store.state.jobs.filter((item) =>
      item.type === "render" && (
        item.assemblyBatchId === job.batchId ||
        batch.some((scene) => scene.assembled === item.id)
      ),
    ).at(-1);
    if (previous) {
      this.linkAssembly(job.batchId, previous.id);
      return previous;
    }
    const expected = Math.max(...batch.map((item) => item.batchSize || batch.length));
    if (!batch.length || batch.length !== expected || batch.some((item) => item.status !== "completed")) return;
    let timeline = null;
    let failure = null;
    try {
      timeline = this.assemblyTimeline(batch);
    } catch (error) {
      failure = error;
    }
    const project = this.store.state.projects.find((item) => item.id === job.projectId);
    const render = this.store.add("jobs", {
      type: "render",
      projectId: job.projectId,
      assemblyBatchId: job.batchId,
      sourceJobIds: batch.map((item) => item.id),
      name: `${project?.name || "Dự án"} - ghép AI`,
      payload: { timeline },
      status: failure ? "failed" : "queued",
      progress: 0,
      logs: failure ? [{ time: new Date().toISOString(), message: failure.message }] : [],
      mediaId: null,
      error: failure?.message || null,
      errorCode: failure ? "ASSEMBLY_FAILED" : null,
      finishedAt: failure ? new Date().toISOString() : null,
    });
    this.linkAssembly(job.batchId, render.id);
    return render;
  }

  cancel(id) {
    const job = this.store.require("jobs", id);
    if (this.running.has(id)) {
      this.running.get(id).controller.abort();
      return { message: "Đang dừng tác vụ…" };
    }
    if (!["queued", "scheduled"].includes(job.status))
      throw new StudioError("Tác vụ này đã kết thúc.");
    return this.store.patch("jobs", id, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
    });
  }

  retry(id, confirmResubmit) {
    const job = this.store.require("jobs", id);
    if (!["failed", "cancelled", "interrupted"].includes(job.status))
      throw new StudioError("Chỉ thử lại tác vụ đã dừng hoặc có lỗi.");
    this.store.require("projects", job.projectId);
    if (this.store.state.jobs.some((item) => item.retryOf === job.id)) {
      throw new StudioError("Tác vụ này đã có lần thử lại. Hãy mở lần thử mới nhất.", "ALREADY_RETRIED", 409);
    }
    if (job.submittedAt && !confirmResubmit)
      throw new StudioError(
        "Yêu cầu trước đã gửi. Kiểm tra kết quả trong tài khoản trước; tạo lại có thể tốn thêm lượt.",
        "CONFIRM_RESUBMIT",
        409,
      );
    const original = this.originalAttempt(job);
    const payload = {
      ...structuredClone(job.payload),
      scheduledAt: null,
    };
    if (job.type === "generate") payload.autoAssemble = original.payload.autoAssemble;
    if (job.type === "render" && job.assemblyBatchId) {
      const batch = this.batchEntries(job.assemblyBatchId);
      if (!batch.length || batch.some((item) => item.status !== "completed")) {
        throw new StudioError("Các cảnh trong lô chưa hoàn tất.");
      }
      payload.timeline = this.assemblyTimeline(batch);
    }
    const retried = this.store.add("jobs", {
      type: job.type,
      projectId: job.projectId,
      name: job.name,
      payload,
      ...(job.type === "generate" ? {
        batchId: job.batchId || original.batchId,
        sceneId: job.sceneId || original.sceneId || original.id,
        batchIndex: original.batchIndex,
        batchSize: original.batchSize,
      } : {}),
      ...(job.assemblyBatchId ? {
        assemblyBatchId: job.assemblyBatchId,
        sourceJobIds: job.sourceJobIds,
      } : {}),
      retryOf: job.id,
      status: "queued",
      progress: 0,
      logs: [],
      mediaId: null,
      submittedAt: null,
      error: null,
    });
    if (retried.assemblyBatchId) this.linkAssembly(retried.assemblyBatchId, retried.id);
    return retried;
  }

  async close() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const entry of this.running.values()) entry.controller.abort();
    await Promise.allSettled(
      [...this.running.values()].map((entry) => entry.promise),
    );
  }
}
