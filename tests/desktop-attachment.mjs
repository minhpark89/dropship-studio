import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../server/index.js";
import { binary, importMedia, runProcess } from "../server/media.js";

const output = path.resolve(".verification/desktop-attachment");
const root = path.join(output, `data-${randomUUID()}`);
await fs.mkdir(output, { recursive: true });
const studio = await startServer({ port: 0, dataDir: root });
const errors = [];
const report = { passed: false, root, errors, checks: [], limitations: [] };
let application;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  const project = studio.store.createProject("Dự án có sẵn · desktop attachment");
  const source = path.join(root, "source.mp4");
  await runProcess(binary("ffmpeg"), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24:d=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", source,
  ]);
  const media = await importMedia(studio.store, source, {
    projectId: project.id,
    name: "Tệp có sẵn.mp4",
  });
  const originalHash = hash(await fs.readFile(media.file));
  const identityBefore = await (await fetch(`${studio.address}/api/instance`)).json();
  const env = { ...process.env, STUDIO_DATA_DIR: root };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: path.resolve("release/win-unpacked/Dropship Studio.exe"),
    args: [`--user-data-dir=${path.join(root, "electron-profile")}`],
    env,
    timeout: 60000,
  });
  let page = await application.firstWindow();
  if (!page.url().startsWith(studio.address)) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      page = application.windows().find((candidate) =>
        candidate.url().startsWith(studio.address),
      );
      if (page) break;
      await delay(100);
    }
    if (!page) throw new Error("Main Dropship Studio window did not open after the startup splash.");
  }
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.getByRole("heading", { name: "Bắt đầu bằng một ý tưởng." }).waitFor();
  assert.equal(new URL(page.url()).origin, studio.address);
  const identityInside = await page.evaluate(async () => (await fetch("/api/instance")).json());
  assert.deepEqual(identityInside, identityBefore);
  assert.equal(identityInside.pid, process.pid);
  assert.equal(identityInside.root, root);
  report.identity = identityInside;
  report.packaged = await application.evaluate(({ app }) => app.isPackaged);
  assert.equal(report.packaged, true);
  report.checks.push("Packaged Electron uses the already running server ID, PID, address and data root");

  await page.getByLabel("Dự án hiện tại").selectOption(project.id);
  await page.locator("nav").getByRole("button", { name: "Thư viện", exact: true }).click();
  await page.getByRole("heading", { name: media.name, exact: true }).waitFor();
  await page.getByRole("button", { name: `Xem ${media.name}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".preview-modal video")?.videoWidth === 320);
  report.preview = await page.locator(".preview-modal video").evaluate((video) => ({
    width: video.videoWidth,
    height: video.videoHeight,
    error: video.error?.message || null,
  }));
  assert.equal(report.preview.height, 240);
  assert.equal(report.preview.error, null);
  await page.screenshot({ path: path.join(output, "existing-media.png"), fullPage: true });
  report.checks.push("Existing project and real video appear and decode in the packaged window");

  const downloadedFile = path.join(root, "downloaded-original.mp4");
  await application.evaluate(({ BrowserWindow }, target) => {
    globalThis.attachmentDownload = null;
    BrowserWindow.getAllWindows()[0].webContents.session.once("will-download", (event, item) => {
      item.setSavePath(target);
      item.once("done", (downloadEvent, state) => {
        globalThis.attachmentDownload = { state, path: item.getSavePath(), filename: item.getFilename() };
      });
    });
  }, downloadedFile);
  await page.getByRole("dialog").getByRole("link", { name: "Tải về", exact: true }).click();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    report.download = await application.evaluate(() => globalThis.attachmentDownload);
    if (report.download) break;
    await delay(100);
  }
  assert.equal(report.download?.state, "completed");
  assert.equal(report.download.filename, media.name);
  assert.equal(hash(await fs.readFile(downloadedFile)), originalHash);
  report.originalHash = originalHash;
  report.checks.push("Actual download link saves original bytes with the Unicode filename");

  report.menu = await application.evaluate(async ({ Menu, shell }, expected) => {
    const menu = Menu.getApplicationMenu();
    const command = menu.items.find((item) => item.label === "Ứng dụng")?.submenu.items
      .find((item) => item.label === "Mở thư mục dữ liệu");
    if (!command) throw new Error("Missing data folder menu");
    const original = shell.openPath;
    let target = null;
    shell.openPath = async (value) => {
      target = value;
      return "";
    };
    try {
      await command.click();
    } finally {
      shell.openPath = original;
    }
    return { present: true, target, matches: target === expected, scope: "Menu dispatch target; native Explorer launch not exercised" };
  }, root);
  assert.equal(report.menu.matches, true);
  report.checks.push("Data-folder menu dispatches the shared server data directory");

  await page.getByRole("dialog").getByRole("button", { name: "Đóng", exact: true }).click();
  await page.locator("nav").getByRole("button", { name: "Cài đặt", exact: true }).click();
  await page.getByRole("heading", { name: "Không gian theo cách bạn làm." }).waitFor();
  const capabilities = await page.evaluate(async () => (await fetch("/api/state")).json().then((state) => state.capabilities));
  const folderButton = await page.getByRole("button", { name: "Mở thư mục", exact: true }).count();
  report.reveal = { capabilities, settingsButtonPresent: folderButton > 0 };
  assert.equal(folderButton, 1);
  assert.deepEqual(await page.evaluate(() => ({
    bridge: typeof window.studioDesktop?.openDataFolder,
    require: typeof window.require,
    process: typeof window.process,
  })), { bridge: "function", require: "undefined", process: "undefined" });
  await application.evaluate(({ shell }) => {
    globalThis.attachmentOriginalOpenPath = shell.openPath;
    globalThis.attachmentFolder = null;
    shell.openPath = async (target) => {
      globalThis.attachmentFolder = target;
      return "";
    };
  });
  try {
    await page.getByRole("button", { name: "Mở thư mục", exact: true }).click();
    const folderDeadline = Date.now() + 5000;
    while (Date.now() < folderDeadline) {
      report.reveal.bridgeTarget = await application.evaluate(() => globalThis.attachmentFolder);
      if (report.reveal.bridgeTarget) break;
      await delay(100);
    }
    assert.equal(report.reveal.bridgeTarget, root);
    report.checks.push("Settings opens the shared data directory through the desktop bridge while Node remains unavailable in the page");
  } finally {
    await application.evaluate(({ shell }) => {
      shell.openPath = globalThis.attachmentOriginalOpenPath;
      delete globalThis.attachmentOriginalOpenPath;
    });
  }
  if (!capabilities.desktop) {
    const response = await fetch(`${studio.address}/api/desktop/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    report.reveal.apiStatus = response.status;
    report.reveal.apiResponse = await response.json();
    assert.equal(response.status, 400);
    report.checks.push("The web backend keeps native access unavailable; attached desktop uses its restricted preload bridge");
  }
  report.limitations.push("Folder tests verify menu and Settings dispatch to shell.openPath; native Explorer presentation is not asserted.");
  await page.screenshot({ path: path.join(output, "attached-settings.png"), fullPage: true });

  const added = studio.store.createProject("Đồng bộ sau khi desktop mở");
  await page.getByLabel("Dự án hiện tại").locator(`option[value="${added.id}"]`).waitFor({ state: "attached" });
  report.checks.push("Store changes reach the attached desktop through the existing server stream");
  assert.deepEqual(errors, []);
  await application.close();
  application = null;
  assert.equal(studio.server.listening, true);
  const identityAfter = await (await fetch(`${studio.address}/api/instance`)).json();
  assert.deepEqual(identityAfter, identityBefore);
  const savedState = JSON.parse(await fs.readFile(studio.store.file, "utf8"));
  assert.ok(savedState.projects.some((item) => item.id === added.id));
  assert.ok(savedState.media.some((item) => item.id === media.id));
  report.checks.push("Closing the desktop leaves the original server running and its saved data intact");
  const launcher = await fs.readFile(path.resolve("../Mo Dropship Studio.cmd"), "utf8");
  assert.ok(launcher.includes('set "STUDIO_DATA_DIR=%~dp0studio\\.studio"'));
  assert.ok(launcher.includes('release\\Dropship Studio 0.1.2.exe'));
  report.launcher = { sourceContractChecked: true, executed: false, reason: "Actual launcher targets production data; equivalent STUDIO_DATA_DIR attachment tested on isolated data" };
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  if (application) await application.close();
  await studio.close();
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
