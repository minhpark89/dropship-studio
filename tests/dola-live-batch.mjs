// Explicit live verification. --submit spends service credits; observation never resubmits.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { probe } from "../server/media.js";

const base = "http://127.0.0.1:4318";
const output = path.resolve(".verification/dola-batch-live");
const manifestPath = path.join(output, "manifest.json");
const accountId = "9fa44123-eccc-471f-bd18-fc768404722b";
const sourceId = "a69bc23d-504f-438d-bd95-da5f53d7d3de";
const submit = process.argv.includes("--submit");
const cdp = process.argv.find((argument) => argument.startsWith("--cdp="))?.slice(6);
const terminal = ["completed", "failed", "cancelled", "interrupted"];
fs.mkdirSync(output, { recursive: true });
const existed = fs.existsSync(manifestPath);
const report = existed ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {
  startedAt: new Date().toISOString(),
  purpose: "Two real Dola reference-video prompts followed by automatic FFmpeg assembly.",
  submissionRequests: [],
};
const save = () => fs.writeFileSync(manifestPath, JSON.stringify(report, null, 2));
const api = async (route, body) => {
  const response = await fetch(base + route, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : undefined);
  if (!response.ok) throw new Error(`App HTTP ${response.status} on ${route}`);
  return response.json();
};
let browser;
let context;
const onRequest = (request) => {
  const url = new URL(request.url());
  if (url.hostname === "www.dola.com" && url.pathname === "/chat/completion" && request.method() === "POST") {
    report.submissionRequests.push({ at: new Date().toISOString(), method: "POST", path: url.pathname });
    save();
  }
};
try {
  if (submit && existed) throw new Error("Manifest already exists. Use --observe; do not submit again.");
  if (!submit && !existed) throw new Error("No recorded batch exists to observe.");
  if (submit) {
    assert.ok(cdp, "Pass the verified owned Chrome CDP endpoint with --cdp=");
    const state = await api("/api/state");
    assert.equal(state.accounts.find((account) => account.id === accountId)?.status, "ready");
    assert.equal(state.jobs.some((job) => ["queued", "scheduled", "preparing", "submitting", "rendering", "downloading"].includes(job.status)), false);
    assert.equal(state.settings.queuePaused, false);
    browser = await chromium.connectOverCDP(cdp);
    context = browser.contexts()[0];
    context.on("request", onRequest);
    save();
    const project = await api("/api/projects", { name: "Kiểm chứng Dola · lô 2 cảnh thật" });
    report.projectId = project.id;
    report.originalTimeline = project.timeline;
    save();
    const original = await fetch(`${base}/api/media/${sourceId}/file?download=1`);
    assert.equal(original.ok, true);
    const form = new FormData();
    form.set("projectId", project.id);
    form.append("files", new Blob([await original.arrayBuffer()], { type: "image/png" }), "Dola-original-sneaker-reference.png");
    const upload = await fetch(base + "/api/media/upload", { method: "POST", body: form });
    assert.equal(upload.ok, true);
    const result = (await upload.json()).results[0];
    assert.equal(result.ok, true);
    report.referenceId = result.id;
    report.submissionAttemptedAt = new Date().toISOString();
    save();
    const jobs = await api("/api/jobs/generate", {
      projectId: project.id,
      provider: "dola",
      accountId,
      kind: "video",
      mode: "reference",
      references: [result.id],
      model: "Dreamina Seedance 2.0 Fast",
      duration: 4,
      ratio: "9:16",
      autoAssemble: true,
      prompts: [
        "Keep the white unbranded sneaker and pale green pedestal from the attached image. Wide product shot, camera slowly orbits from left to right, soft studio lighting. Keep the complete shoe visible. No text or logos.",
        "Keep the same white unbranded sneaker and pale green pedestal from the attached image. Close product detail shot, camera slowly pushes toward the laces and fabric texture, soft studio lighting. No text or logos.",
      ],
    });
    report.jobIds = jobs.map((job) => job.id);
    report.batchId = jobs[0].batchId;
    save();
    console.log(JSON.stringify({ projectId: report.projectId, jobIds: report.jobIds }));
  }
  const deadline = Date.now() + 35 * 60000;
  let previous = "";
  while (Date.now() < deadline) {
    const state = await api("/api/state");
    const jobs = state.jobs.filter((job) => job.projectId === report.projectId && job.type === "generate").sort((a, b) => a.batchIndex - b.batchIndex);
    const render = state.jobs.find((job) => job.projectId === report.projectId && job.type === "render");
    report.jobs = jobs;
    report.render = render || null;
    report.observedAt = new Date().toISOString();
    save();
    const status = JSON.stringify({ jobs: jobs.map((job) => ({ id: job.id, status: job.status, elapsed: job.elapsedSeconds, error: job.error })), render: render?.status });
    if (status !== previous) console.log(status);
    previous = status;
    if (jobs.length === 2 && jobs.every((job) => terminal.includes(job.status))) {
      if (jobs.some((job) => job.status !== "completed")) {
        report.passed = false;
        report.reason = "At least one real generation did not complete. No retry was submitted.";
        break;
      }
      if (render && terminal.includes(render.status)) {
        assert.equal(render.status, "completed", render.error || "Assembly failed");
        assert.deepEqual(render.sourceJobIds, jobs.map((job) => job.id));
        assert.deepEqual(render.payload.timeline.clips.map((clip) => clip.mediaId), jobs.map((job) => job.mediaId));
        assert.deepEqual(state.projects.find((project) => project.id === report.projectId).timeline, report.originalTimeline);
        report.outputs = [];
        for (const [index, job] of [...jobs, render].entries()) {
          const response = await fetch(`${base}/api/media/${job.mediaId}/file?download=1`);
          assert.equal(response.ok, true);
          const bytes = Buffer.from(await response.arrayBuffer());
          const file = path.join(output, index === 2 ? "Dola-two-scenes.mp4" : `scene-${index + 1}.mp4`);
          fs.writeFileSync(file, bytes);
          const metadata = await probe(file, state.settings);
          report.outputs.push({ jobId: job.id, mediaId: job.mediaId, file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), ...metadata });
        }
        assert.ok(Math.abs(report.outputs[2].duration - report.outputs[0].duration - report.outputs[1].duration) < 0.15);
        report.passed = true;
        break;
      }
    }
    await delay(5000);
  }
  if (report.passed === undefined) report.reason = "Observation window ended; use --observe on these same job IDs. Do not resubmit.";
  save();
  console.log(JSON.stringify({ passed: report.passed, reason: report.reason, submissionsObserved: report.submissionRequests.length, report: manifestPath }));
} catch (error) {
  if (!existed || !submit) {
    report.observationError = error.message;
    save();
  }
  throw error;
} finally {
  context?.off("request", onRequest);
  await browser?.close();
}
