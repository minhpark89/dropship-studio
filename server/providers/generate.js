import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { StudioError } from "../store.js";
import { importMedia, probe } from "../media.js";
import { prepareDola, dolaVideoCards, activateDolaVideo } from "./dola.js";
import { dolaImageCards, downloadDolaImageUrl } from "./dola-images.js";
import { prepareFlow } from "./flow-prepare.js";
import { prepareFlowAgent, runFlowAgent } from "./flow-agent.js";
import { downloadFlowAgentMedia, flowVideoCardKeys } from "./flow-agent-download.js";
import { createFlowResultTracker } from "./flow-results.js";
import { createFlowAgentResultTracker } from "./flow-agent-results.js";
import { dolaQuotaError } from "./dola-status.js";

async function mediaUrls(page, kind) {
  return page.evaluate((type) => {
    const selector =
      type === "video"
        ? "video, video source"
        : '[data-testid*="message"] img, [data-testid*="result"] img, [data-message-id] img';
    return [...document.querySelectorAll(selector)]
      .map((element) => element.currentSrc || element.src)
      .filter(Boolean);
  }, kind);
}

function responseUrls(value, kind, result = [], depth = 0, context = "") {
  if (depth > 20 || !value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) {
    const branch = `${context} ${key}`.slice(-160);
    if (typeof item === "string" && /^https:\/\//.test(item)) {
      const relevant =
        kind === "video"
          ? /video|play|download/i.test(branch)
          : /generated_image|image_url|imageurl|download/i.test(branch);
      if (
        relevant &&
        /url|address|src/i.test(key) &&
        !/thumb|cover|avatar|poster|preview/i.test(branch)
      )
        result.push(item);
    } else if (typeof item === "object")
      responseUrls(item, kind, result, depth + 1, branch);
    else if (
      typeof item === "string" &&
      /^[\[{]/.test(item) &&
      /content|data/i.test(key)
    ) {
      try {
        responseUrls(JSON.parse(item), kind, result, depth + 1, branch);
      } catch {}
    }
  }
  return result;
}

async function download(store, session, job, url, signal) {
  signal.throwIfAborted();
  const extension = job.payload.kind === "video" ? ".mp4" : ".png";
  const temporary = path.join(
    store.root,
    "temp",
    `${randomUUID()}${extension}`,
  );
  try {
    let body;
    if (url.startsWith("blob:")) {
      const encoded = await session.page.evaluate(async (source) => {
        const blob = await (await fetch(source)).blob();
        if (blob.size > 500 * 1024 * 1024)
          throw new Error("Tệp vượt quá 500 MB.");
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
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
      if (!response.ok())
        throw new StudioError(
          `Tải video thất bại: HTTP ${response.status()}.`,
          "DOWNLOAD_FAILED",
        );
      if (Number(response.headers()["content-length"]) > 500 * 1024 * 1024)
        throw new StudioError("Tệp vượt quá 500 MB.");
      body = await response.body();
      await response.dispose();
    }
    signal.throwIfAborted();
    await fs.writeFile(temporary, body);
    const metadata = await probe(temporary, store.state.settings);
    if (
      job.payload.kind === "image" &&
      !["png", "mjpeg", "webp", "gif", "bmp"].includes(metadata.videoCodec)
    ) {
      throw new StudioError(
        "Dịch vụ chưa trả về tệp ảnh hợp lệ.",
        "INVALID_PROVIDER_RESULT",
      );
    }
    const media = await importMedia(store, temporary, {
      name: `${job.name}${extension}`,
      projectId: job.projectId,
      generated: true,
      move: true,
      jobId: job.id,
    });
    if (media.kind !== job.payload.kind)
      throw new StudioError(
        "Nhà cung cấp trả về sai loại media.",
        "INVALID_PROVIDER_RESULT",
      );
    return media;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function downloadFlowAgentResult(store, session, job, prompt, baselineCount, baselineKeys, signal, timeout) {
  const temporary = path.join(store.root, "temp", `${randomUUID()}.mp4`);
  try {
    await downloadFlowAgentMedia(session.page, {
      prompt,
      destination: temporary,
      baselineCount,
      baselineKeys,
      signal,
      timeout,
    });
    signal.throwIfAborted();
    const metadata = await probe(temporary, store.state.settings);
    const media = await importMedia(store, temporary, {
      name: `${job.name}.mp4`,
      projectId: job.projectId,
      generated: true,
      move: true,
      jobId: job.id,
    });
    if (media.kind !== job.payload.kind)
      throw new StudioError("Flow trả về sai loại media.", "INVALID_PROVIDER_RESULT");
    store.log(
      job,
      `Đã tải video Flow qua editor: ${metadata.width}×${metadata.height}, ${metadata.duration.toFixed(2)} giây.`,
    );
    return media;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function generate(store, browsers, job, account, signal, update) {
  const session = await browsers.open(account, {
    visible: store.state.settings.browserVisible === true,
    forceHidden: store.state.settings.browserVisible !== true,
  });
  const state = await browsers.inspect(account, session, { navigate: true });
  if (state.status !== "ready")
    throw new StudioError(
      state.message,
      state.status === "verification" ? "VERIFICATION" : "NEEDS_LOGIN",
    );
  signal.throwIfAborted();
  const task = job.payload;
  const isDolaImage = task.provider === "dola" && task.kind === "image";
  const files = task.references.map((id) => store.require("media", id).file);
  store.log(job, "Chuẩn bị cuộc hội thoại/dự án mới và tùy chọn trên website.");
  let flowAgent = null;
  let send;
  if (task.provider === "dola") {
    send = await prepareDola(session.page, task, files, (message) =>
      store.log(job, message),
    );
  } else {
    const agentPanel = session.page.locator("flow-agent-panel:visible");
    if (await agentPanel.count()) {
      flowAgent = await prepareFlowAgent(session.page, task, files);
      send = flowAgent.send;
    } else {
      send = await prepareFlow(session.page, task, files);
    }
  }
  if (!(await send.isVisible()) || !(await send.isEnabled()))
    throw new StudioError(
      "Nút gửi chưa sẵn sàng. Kiểm tra việc tải ảnh hoặc hạn mức trong cửa sổ tài khoản.",
      "PROVIDER_NOT_READY",
    );
  signal.throwIfAborted();
  const baseline = new Set(await mediaUrls(session.page, task.kind));
  const baselineImageCards = isDolaImage ? await dolaImageCards(session.page).count() : 0;
  const downloadedImages = new Set();
  const baselineDolaCards =
    task.provider === "dola" && task.kind === "video"
      ? await dolaVideoCards(session.page).count()
      : 0;
  const flowAgentBaselineKeys = flowAgent ? await flowVideoCardKeys(session.page) : [];
  const flowAgentBaselineCount = flowAgentBaselineKeys.length;
  const activatedDolaCards = new Set();
  const pending = new Set();
  const downloadAttempts = new Map();
  let accepted = false;
  let requestError = null;
  const flowTracker = task.provider === "flow" && !flowAgent
    ? createFlowResultTracker({ prompt: task.prompt, kind: task.kind, onAccepted: update })
    : null;
  const flowAgentTracker = flowAgent
    ? createFlowAgentResultTracker({
        prompt: task.prompt,
        projectId: session.page.url().match(/\/project\/([^/?#]+)/)?.[1] || "",
        onAccepted: update,
      })
    : null;
  const requestListener = (request) => {
    flowTracker?.observeRequest(request);
    flowAgentTracker?.observeRequest(request);
  };
  const listener = async (response) => {
    const url = response.url();
    if (flowTracker) {
      await flowTracker.observeResponse(response);
    }
    if (flowAgentTracker) await flowAgentTracker.observeResponse(response);
    if (flowTracker || flowAgentTracker) return;
    const submission =
      task.provider === "dola"
        ? /\/chat\/completion/.test(url)
        : /batchGenerate|generateVideo|generateImage|createVideo|media:generate/i.test(
            url,
          );
    if (submission) {
      if (response.ok()) accepted = true;
      else
        requestError = new StudioError(
          `Dịch vụ từ chối yêu cầu (HTTP ${response.status()}).`,
          response.status() === 401 ? "NEEDS_LOGIN" : "PROVIDER_REJECTED",
        );
    }
    const resultEndpoint =
      task.provider === "dola"
        ? /\/samantha\/video\/get_play_info|\/im\/chain\/single/.test(url)
        : /check.*status|batchCheck|operations|media.*get|generateVideo|batchGenerate/i.test(
            url,
          );
    if (isDolaImage || !accepted || !resultEndpoint || !response.ok()) return;
    try {
      const data = await response.json();
      for (const candidate of responseUrls(data, task.kind))
        if (!baseline.has(candidate)) pending.add(candidate);
    } catch {}
  };
  session.page.on("request", requestListener);
  session.page.on("response", listener);
  try {
    // Persist before the click: a timeout may occur after the service accepted it.
    update({
      status: "submitting",
      submittedAt: new Date().toISOString(),
      providerPage: session.page.url(),
      progress: 5,
    });
    flowTracker?.arm();
    flowAgentTracker?.arm();
    if (flowAgent) {
      await runFlowAgent(session.page, task, flowAgent, {
        beforeAction: async (phase) => {
          if (phase === "confirmation") update({ flowConfirmationAttemptedAt: new Date().toISOString() });
          if (phase === "approval") update({ flowApprovalAttemptedAt: new Date().toISOString() });
        },
        log: (message) => store.log(job, message),
      });
      if (task.kind === "video") {
        update({ status: "rendering", progress: 35, elapsedSeconds: 0 });
        store.log(job, "Đang chờ thẻ video Flow mở editor để tải bản gốc.");
        return await downloadFlowAgentResult(
          store,
          session,
          job,
          task.prompt,
          flowAgentBaselineCount,
          flowAgentBaselineKeys,
          signal,
          store.state.settings.maxWaitMinutes * 60000,
        );
      }
    } else {
      await send.click({ timeout: 15000 });
      store.log(job, "Đã bấm gửi một lần. Đang chờ kết quả từ dịch vụ.");
    }
    update({ status: "rendering", progress: 10, elapsedSeconds: 0 });
    const deadline = Date.now() + store.state.settings.maxWaitMinutes * 60000;
    const start = Date.now();
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (requestError) throw requestError;
      if (flowTracker?.error) throw flowTracker.error;
      if (flowAgentTracker?.error) throw flowAgentTracker.error;
      const body = await session.page.locator("body").innerText();
      const quotaError = task.provider === "dola" ? dolaQuotaError(body) : null;
      if (quotaError) throw quotaError;
      if (
        task.provider === "dola" &&
        (await session.page
          .getByTestId("login_content")
          .isVisible()
          .catch(() => false))
      )
        throw new StudioError(
          "Phiên đăng nhập hết hạn sau khi gửi. Đăng nhập và kiểm tra kết quả trên tài khoản trước khi thử lại.",
          "NEEDS_LOGIN",
        );
      if (/verify you are human|confirm you.re not a robot/i.test(body))
        throw new StudioError(
          "Dịch vụ yêu cầu xác minh. Hoàn tất trong cửa sổ tài khoản, sau đó kiểm tra kết quả đã gửi.",
          "VERIFICATION",
        );
      if (
        /not enough credits|insufficient credits|không đủ tín dụng|failed to generate|không tạo được video/i.test(
          body,
        )
      )
        throw new StudioError(
          "Dịch vụ báo lỗi tạo nội dung hoặc không đủ lượt. Xem thông báo trong cửa sổ tài khoản.",
          "PROVIDER_REJECTED",
        );
      if (task.provider === "dola" && task.kind === "video") {
        if (
          await activateDolaVideo(
            session.page,
            baselineDolaCards,
            activatedDolaCards,
          )
        ) {
          store.log(job, "Đã mở kết quả video Dola để lấy tệp hoàn chỉnh.");
        }
      }
      const imageResult = isDolaImage
        ? await downloadDolaImageUrl(session.page, baselineImageCards, downloadedImages, { signal })
        : null;
      const candidates = flowTracker
        ? flowTracker.takeCandidates()
        : flowAgentTracker
          ? flowAgentTracker.takeCandidates()
        : isDolaImage
          ? (imageResult ? [imageResult.url] : [])
          : await mediaUrls(session.page, task.kind);
      for (const candidate of candidates)
        if (!baseline.has(candidate)) pending.add(candidate);
      for (const url of pending) {
        const previousAttempt = downloadAttempts.get(url);
        if (previousAttempt && Date.now() < previousAttempt.retryAt) continue;
        pending.delete(url);
        update({ status: "downloading", progress: 90 });
        try {
          const media = await download(store, session, job, url, signal);
          store.log(
            job,
            `Đã tải và kiểm tra media: ${media.width}×${media.height}, ${media.duration.toFixed(2)} giây.`,
          );
          const warnings = [];
          const [width, height] = task.ratio.split(":").map(Number);
          if (
            media.width &&
            Math.abs(media.width / media.height - width / height) > 0.03
          )
            warnings.push(
              `Dịch vụ trả tỷ lệ ${media.width}×${media.height}, khác tỷ lệ yêu cầu ${task.ratio}.`,
            );
          if (
            task.kind === "video" &&
            Math.abs(media.duration - task.duration) > 0.5
          )
            warnings.push(
              `Dịch vụ trả ${media.duration.toFixed(2)} giây, khác ${task.duration} giây yêu cầu.`,
            );
          if (warnings.length) {
            update({ warnings });
            for (const warning of warnings) store.log(job, warning);
          }
          return media;
        } catch (error) {
          if (signal.aborted) throw error;
          const count = (previousAttempt?.count || 0) + 1;
          downloadAttempts.set(url, {
            count,
            retryAt: Date.now() + Math.min(60000, count * 10000),
          });
          if (count >= 3) baseline.add(url);
          else pending.add(url);
          store.log(
            job,
            count >= 3
              ? "Chưa tải được tệp sau 3 lần; tiếp tục chờ liên kết kết quả mới. Không gửi lại yêu cầu tạo."
              : `Tệp kết quả chưa tải được; sẽ thử tải lại (${count}/3). Không gửi lại yêu cầu tạo.`,
          );
          update({ status: "rendering" });
        }
      }
      update({ elapsedSeconds: Math.floor((Date.now() - start) / 1000) });
      await delay(store.state.settings.pollSeconds * 1000, undefined, {
        signal,
      });
    }
    throw new StudioError(
      "Hết thời gian theo dõi. Yêu cầu đã gửi có thể vẫn đang chạy; kiểm tra trong cửa sổ tài khoản trước khi tạo lại.",
      "PROVIDER_TIMEOUT",
    );
  } finally {
    session.page.off("request", requestListener);
    session.page.off("response", listener);
  }
}
