import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { startServer } from "../server/index.js";
import { binary, probe, runProcess } from "../server/media.js";

// Only existing original files are read from production. All writes and UI
// actions run against a fresh, account-free local server owned by this test.
const production = "http://127.0.0.1:4318";
const root = path.resolve(".verification", `ai-edit-${randomUUID()}`);
const output = path.resolve(".verification/ai-edit");
const sources = [
  { id: "0b9282d7-d87e-45d4-b7db-0082d0b055d9", name: "Dola · cảnh văn bản.mp4" },
  { id: "29f6b348-ed69-4288-b4f6-9de23b21d5f1", name: "Dola · cảnh tham chiếu.mp4" },
  { id: "a69bc23d-504f-438d-bd95-da5f53d7d3de", name: "Dola · ảnh gốc 2048.png" },
];
const report = {
  at: new Date().toISOString(),
  root,
  checks: [],
  sources: [],
  errors: [],
  generationRequests: 0,
};
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const request = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.ok, true, `HTTP ${response.status} from ${new URL(url).pathname}`);
  return response;
};
const waitUntil = async (predicate, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition timed out after ${timeout}ms`);
};
await fs.mkdir(output, { recursive: true });
await fs.mkdir(path.join(root, "sources"), { recursive: true });
let studio;
let browser;
let page;
try {
  const initialInstance = await (await request(`${production}/api/instance`)).json();
  for (const source of sources) {
    const buffer = Buffer.from(await (await request(`${production}/api/media/${source.id}/file?download=1`)).arrayBuffer());
    source.file = path.join(root, "sources", source.name);
    source.hash = hash(buffer);
    await fs.writeFile(source.file, buffer);
    const metadata = await probe(source.file);
    report.sources.push({ id: source.id, name: source.name, sha256: source.hash, ...metadata });
  }
  assert.equal(report.sources[0].videoCodec, "hevc");
  assert.equal(report.sources[1].videoCodec, "hevc");
  assert.equal(report.sources[2].width, 2048);
  assert.equal(report.sources[2].height, 2048);
  report.checks.push("Downloaded two real Dola HEVC videos and one original 2048-square image using read-only HTTP");

  studio = await startServer({ port: 0, dataDir: root });
  report.url = studio.address;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(message.text());
  });
  await page.route("**/api/jobs/generate", (route) => {
    report.generationRequests += 1;
    return route.abort();
  });
  const nav = async (name) => {
    await page.locator("nav").getByRole("button", { name, exact: true }).click();
    await page.locator("nav button.active").filter({ hasText: name }).waitFor();
  };
  await page.goto(studio.address);
  await page.getByRole("heading", { name: "Bắt đầu bằng một ý tưởng." }).waitFor();
  await page.getByRole("button", { name: "Tạo dự án", exact: true }).click();
  const projectName = "QA Dola · dựng từ kết quả thật";
  await page.getByLabel("Tên dự án").fill(projectName);
  await page.getByRole("dialog").getByRole("button", { name: "Tạo dự án", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const project = studio.store.state.projects.find((item) => item.name === projectName);
  assert.ok(project);
  await nav("Thư viện");
  await page.locator(".upload-zone input").first().setInputFiles(sources.map((source) => source.file));
  for (const source of sources) {
    await page.getByRole("heading", { name: source.name, exact: true }).waitFor();
    source.mediaId = studio.store.state.media.find((item) => item.name === source.name)?.id;
    assert.ok(source.mediaId);
    await page.getByRole("checkbox", { name: `Chọn ${source.name}`, exact: true }).check();
  }
  await page.screenshot({ path: path.join(output, "library-originals.png"), fullPage: true });
  await page.getByRole("button", { name: "Thêm vào timeline", exact: true }).click();
  await page.getByRole("heading", { name: "Dựng câu chuyện của bạn." }).waitFor();
  assert.equal(await page.locator(".timeline-clip").count(), 3);
  report.checks.push("Imported original files through the browser upload control and added them to the timeline in selection order");

  const clip = (source) => page.locator(".timeline-clip").filter({ hasText: source.name });
  await clip(sources[1]).click();
  await page.getByLabel("Điểm đầu (s)", { exact: true }).fill("0.5");
  await page.getByLabel("Điểm cuối (s)", { exact: true }).fill("3.5");
  await page.getByLabel("Tốc độ", { exact: true }).selectOption("1.5");
  await page.getByTitle("Đưa clip sang trái", { exact: true }).click();
  await clip(sources[2]).click();
  await page.getByLabel("Điểm cuối (s)", { exact: true }).fill("2");
  await page.getByLabel("Cách đặt vào khung", { exact: true }).selectOption("contain");
  await page.getByTitle("Đưa clip sang trái", { exact: true }).click();
  await clip(sources[0]).click();
  await page.getByLabel("Điểm đầu (s)", { exact: true }).fill("1");
  await page.getByLabel("Điểm cuối (s)", { exact: true }).fill("3");
  await page.getByLabel("Tỷ lệ video", { exact: true }).selectOption("9:16");
  await page.getByRole("button", { name: "Thêm chữ", exact: true }).click();
  const caption = "Dola · dựng video thực tế";
  await page.getByLabel("Nội dung", { exact: true }).fill(caption);
  await page.getByLabel("Nền tối phía sau chữ", { exact: true }).check();
  await waitUntil(() => project.timeline.clips[0]?.mediaId === sources[1].mediaId && project.timeline.texts[0]?.text === caption);
  const edited = structuredClone(project.timeline);
  assert.deepEqual(edited.clips.map((item) => item.mediaId), [sources[1].mediaId, sources[2].mediaId, sources[0].mediaId]);
  assert.deepEqual(edited.clips.map(({ inSec, outSec, speed }) => ({ inSec, outSec, speed })), [
    { inSec: 0.5, outSec: 3.5, speed: 1.5 },
    { inSec: 0, outSec: 2, speed: 1 },
    { inSec: 1, outSec: 3, speed: 1 },
  ]);
  report.timeline = edited;
  report.expectedDuration = edited.clips.reduce((total, item) => total + (item.outSec - item.inSec) / item.speed, 0);
  assert.equal(report.expectedDuration, 6);
  await page.reload();
  await page.getByRole("heading", { name: "Bắt đầu bằng một ý tưởng." }).waitFor();
  await nav("Dựng video");
  assert.equal(await page.locator(".timeline-clip").count(), 3);
  const stateAfterReload = await (await request(`${studio.address}/api/state`)).json();
  assert.deepEqual(stateAfterReload.projects.find((item) => item.id === project.id).timeline, edited);
  assert.deepEqual(await page.locator(".timeline-clip > span").allTextContents(), [sources[1].name, sources[2].name, sources[0].name]);
  report.checks.push("Browser trim, speed, two reorder actions and Vietnamese caption persisted through save and reload (three 2-second scenes)");

  await page.getByRole("button", { name: "Tạm dừng xem trước", exact: true }).click();
  await page.getByRole("button", { name: "Về đầu", exact: true }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector("video.preview-source");
    return video && video.videoWidth > 0 && video.readyState >= 2;
  });
  const samplePreview = () => page.locator("video.preview-source").evaluate((video) => ({
    time: video.currentTime,
    width: video.videoWidth,
    height: video.videoHeight,
    rate: video.playbackRate,
    paused: video.paused,
  }));
  report.previewT0 = await samplePreview();
  await page.screenshot({ path: path.join(output, "editor-t0.png"), fullPage: true });
  await page.getByRole("button", { name: "Phát xem trước", exact: true }).click();
  await page.waitForTimeout(700);
  report.previewT1 = await samplePreview();
  assert.ok(report.previewT1.time > report.previewT0.time + 0.3);
  assert.equal(report.previewT1.rate, 1.5);
  await page.screenshot({ path: path.join(output, "editor-t1.png"), fullPage: true });
  await page.getByRole("button", { name: "Tạm dừng xem trước", exact: true }).click();
  report.checks.push("Real HEVC source previews as visible video with advancing media time at 1.5x playback");

  await page.getByRole("button", { name: "Xuất video", exact: true }).click();
  const exportName = "Dola · ba cảnh đã dựng";
  await page.getByLabel("Tên file", { exact: true }).fill(exportName);
  await page.getByLabel("Độ phân giải", { exact: true }).selectOption("720");
  await page.getByLabel("Khung hình / giây", { exact: true }).selectOption("30");
  await page.getByRole("button", { name: "Bắt đầu xuất", exact: true }).click();
  await page.getByRole("heading", { name: "Ý tưởng đang thành hình." }).waitFor();
  await waitUntil(() => studio.store.state.jobs.some((item) => item.name === exportName && ["completed", "failed"].includes(item.status)), 90000);
  const job = studio.store.state.jobs.find((item) => item.name === exportName);
  assert.equal(job.status, "completed", job.error);
  const rendered = studio.store.require("media", job.mediaId);
  report.export = { id: rendered.id, ...(await probe(rendered.file)) };
  assert.equal(report.export.videoCodec, "h264");
  assert.equal(report.export.audioCodec, "aac");
  assert.equal(report.export.width, 720);
  assert.equal(report.export.height, 1280);
  assert.equal(report.export.fps, 30);
  assert.ok(Math.abs(report.export.duration - report.expectedDuration) < 0.15);
  const exportedBytes = Buffer.from(await (await request(`${studio.address}/api/media/${rendered.id}/file?download=1`)).arrayBuffer());
  const exportFile = path.join(output, "Dola - ba canh da dung.mp4");
  await fs.writeFile(exportFile, exportedBytes);
  report.export.sha256 = hash(exportedBytes);
  for (const [index, position] of [0.5, 2.5, 4.5].entries()) {
    await runProcess(binary("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(position), "-i", exportFile, "-frames:v", "1", "-update", "1", path.join(output, `export-scene-${index + 1}.png`)], { timeout: 30000 });
  }
  await page.screenshot({ path: path.join(output, "export-completed.png"), fullPage: true });
  await nav("Thư viện");
  await page.getByRole("button", { name: `Xem ${rendered.name}`, exact: true }).click();
  const exportPlayer = page.getByRole("dialog").locator("video");
  await exportPlayer.waitFor();
  await exportPlayer.evaluate(async (video) => {
    video.muted = true;
    await video.play();
  });
  await page.waitForTimeout(600);
  report.exportPlayback = await exportPlayer.evaluate((video) => ({ time: video.currentTime, width: video.videoWidth, height: video.videoHeight, paused: video.paused, error: video.error?.message || null }));
  assert.ok(report.exportPlayback.time > 0.3);
  assert.equal(report.exportPlayback.width, 720);
  assert.equal(report.exportPlayback.error, null);
  await page.screenshot({ path: path.join(output, "export-playback.png"), fullPage: true });
  report.checks.push("Export through UI produced a playable six-second 720x1280 H.264/AAC MP4 at 30 fps");

  for (const source of sources) {
    const originalBytes = Buffer.from(await (await request(`${production}/api/media/${source.id}/file?download=1`)).arrayBuffer());
    const importedBytes = Buffer.from(await (await request(`${studio.address}/api/media/${source.mediaId}/file?download=1`)).arrayBuffer());
    assert.equal(hash(originalBytes), source.hash);
    assert.equal(hash(importedBytes), source.hash);
  }
  const finalInstance = await (await request(`${production}/api/instance`)).json();
  assert.deepEqual(finalInstance, initialInstance);
  assert.equal(studio.store.state.accounts.length, 0);
  assert.equal(studio.store.state.jobs.filter((item) => item.type === "generate").length, 0);
  assert.equal(report.generationRequests, 0);
  assert.deepEqual(report.errors, []);
  report.checks.push("All original/download/import SHA-256 hashes match; production instance unchanged; zero AI submissions and console errors");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.stack;
  await page?.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, export: report.export, failure: report.failure, report: path.join(output, "report.json") }, null, 2));
  await browser?.close();
  await studio?.close();
}
