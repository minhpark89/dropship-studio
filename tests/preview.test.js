import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { startServer } from "../server/index.js";
import { binary, importMedia, probe, runProcess } from "../server/media.js";

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

test(
  "HEVC media gets one cached playable H264 preview while original download stays unchanged",
  { timeout: 120000 },
  async () => {
    const root = path.resolve(".verification", `preview-${randomUUID()}`);
    const studio = await startServer({ port: 0, dataDir: root });
    let browser;
    try {
      const source = path.join(root, "source-hevc.mp4");
      await runProcess(binary("ffmpeg"), [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x240:r=24:d=3",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=3",
        "-c:v",
        "libx265",
        "-preset",
        "ultrafast",
        "-x265-params",
        "log-level=error:pools=1:frame-threads=1",
        "-pix_fmt",
        "yuv420p",
        "-tag:v",
        "hvc1",
        "-c:a",
        "aac",
        "-shortest",
        source,
      ]);
      const media = await importMedia(studio.store, source, {
        projectId: studio.store.state.projects[0].id,
      });
      assert.equal(media.videoCodec, "hevc");
      const originalHash = digest(await fs.readFile(media.file));
      const url = `${studio.address}/api/media/${media.id}/file`;
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => fetch(url)),
      );
      for (const response of responses) assert.equal(response.status, 200);
      const previews = await Promise.all(
        responses.map(async (response) => Buffer.from(await response.arrayBuffer())),
      );
      const previewHash = digest(previews[0]);
      for (const preview of previews) assert.equal(digest(preview), previewHash);
      assert.notEqual(previewHash, originalHash);
      const stored = studio.store.require("media", media.id);
      assert.ok(stored.previewFile);
      const previewMetadata = await probe(stored.previewFile);
      assert.equal(previewMetadata.videoCodec, "h264");
      assert.equal(previewMetadata.audioCodec, "aac");
      assert.equal(previewMetadata.width, 320);
      assert.equal(previewMetadata.height, 240);
      assert.ok(Math.abs(previewMetadata.duration - media.duration) < 0.15);
      const previewNames = async () =>
        (await fs.readdir(path.join(root, "thumbs"))).filter((name) =>
          name.endsWith("-preview.mp4"),
        );
      assert.equal((await previewNames()).length, 1);
      const cachedStat = await fs.stat(stored.previewFile);
      const cached = await fetch(url);
      assert.equal(cached.status, 200);
      assert.equal(digest(Buffer.from(await cached.arrayBuffer())), previewHash);
      assert.equal((await fs.stat(stored.previewFile)).mtimeMs, cachedStat.mtimeMs);
      assert.equal((await previewNames()).length, 1);

      const originalDownload = await fetch(`${url}?download=1`);
      assert.equal(originalDownload.status, 200);
      assert.match(originalDownload.headers.get("content-disposition"), /^attachment;/);
      assert.equal(
        digest(Buffer.from(await originalDownload.arrayBuffer())),
        originalHash,
      );
      assert.equal(digest(await fs.readFile(media.file)), originalHash);
      const stateResponse = await fetch(`${studio.address}/api/state`);
      const state = await stateResponse.json();
      const publicMedia = state.media.find((item) => item.id === media.id);
      for (const privateField of ["file", "thumbnail", "previewFile"]) {
        assert.equal(Object.hasOwn(publicMedia, privateField), false);
      }
      assert.equal(publicMedia.url, `/api/media/${media.id}/file`);
      assert.equal(publicMedia.videoCodec, "hevc");
      assert.equal(publicMedia.previewCodec, "h264");

      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(studio.address, { waitUntil: "networkidle" });
      await page.evaluate(async (sourceUrl) => {
        const video = document.createElement("video");
        video.id = "preview-verification";
        video.muted = true;
        video.controls = true;
        video.width = 640;
        video.height = 480;
        document.body.replaceChildren(video);
        const loaded = new Promise((resolve, reject) => {
          video.addEventListener("loadeddata", resolve, { once: true });
          video.addEventListener("error", () => reject(new Error("Preview decode failed")), { once: true });
        });
        video.src = sourceUrl;
        await loaded;
        const seeked = new Promise((resolve) => {
          video.addEventListener("seeked", resolve, { once: true });
        });
        video.currentTime = 0.1;
        await seeked;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }, url);
      const frame = async () => page.evaluate(() => {
        const video = document.querySelector("#preview-verification");
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d");
        context.drawImage(video, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let checksum = 2166136261;
        for (let index = 0; index < pixels.length; index++) {
          checksum = Math.imul(checksum ^ pixels[index], 16777619) >>> 0;
        }
        return {
          time: video.currentTime,
          width: video.videoWidth,
          height: video.videoHeight,
          readyState: video.readyState,
          checksum,
          error: video.error?.message || null,
        };
      });
      const t0 = await frame();
      await page.screenshot({ path: path.join(root, "preview-t0.png") });
      await page.locator("#preview-verification").evaluate((video) => video.play());
      await page.waitForFunction(() =>
        document.querySelector("#preview-verification").currentTime > 1,
      );
      await page.locator("#preview-verification").evaluate((video) => video.pause());
      const t1 = await frame();
      await page.screenshot({ path: path.join(root, "preview-t1.png") });
      assert.equal(t0.width, 320);
      assert.equal(t0.height, 240);
      assert.equal(t1.width, 320);
      assert.equal(t1.height, 240);
      assert.ok(t1.time - t0.time > 0.7);
      assert.notEqual(t1.checksum, t0.checksum);
      assert.equal(t1.error, null);
      assert.deepEqual(errors, []);
      const report = {
        root,
        sourceCodec: media.videoCodec,
        previewMetadata,
        concurrentRequests: responses.length,
        cachedPreviewFiles: (await previewNames()).length,
        originalHash,
        previewHash,
        originalDownloadUnchanged: true,
        privatePathsRedacted: true,
        t0,
        t1,
        errors,
      };
      await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
      await fs.writeFile(path.resolve(".verification/preview-result.json"), JSON.stringify(report, null, 2));
    } finally {
      if (browser) await browser.close();
      await studio.close();
    }
  },
);
