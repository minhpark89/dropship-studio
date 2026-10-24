import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { binary, runProcess } from "../server/media.js";
import {
  activateDolaVideo,
  dolaVideoCards,
} from "../server/providers/dola.js";

const fixture = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Dola result activation fixture</title>
  <style>
    [class^="block-video-"] { width: 300px; height: 100px; margin: 12px; background: #ddd; }
    [class^="play-icon-wrapper-"] { display: block; padding: 20px; }
  </style>
</head>
<body>
  <button data-testid="chat_input_send_button">Generate</button>
  <section data-testid="receive_message">
    <div class="block-video-old" data-card="old">
      <span class="play-icon-wrapper-old">Play old result</span>
    </div>
  </section>
  <script>
    window.fixtureState = { old: 0, fresh: 0, submissions: 0 };
    document.querySelector('[data-testid="chat_input_send_button"]').addEventListener("click", () => {
      window.fixtureState.submissions += 1;
    });
    document.addEventListener("click", (event) => {
      const card = event.target.closest("[data-card]");
      if (!card) return;
      window.fixtureState[card.dataset.card] += 1;
      if (card.dataset.card !== "fresh") return;
      const video = document.createElement("video");
      video.src = "/result.mp4";
      video.muted = true;
      video.controls = true;
      video.loop = true;
      document.body.append(video);
    });
  </script>
</body>
</html>`;

test("Dola opens only a completed new result once without submitting another generation", { timeout: 45000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dropship-dola-result-"));
  const videoPath = path.join(root, "result.mp4");
  let server;
  let browser;
  try {
    await runProcess(binary("ffmpeg"), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=12:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      videoPath,
    ], { timeout: 15000 });
    const videoBytes = await fs.readFile(videoPath);
    server = http.createServer((request, response) => {
      if (request.url === "/result.mp4") {
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": videoBytes.length,
        });
        response.end(videoBytes);
        return;
      }
      if (request.url === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(fixture);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const baselineCount = await dolaVideoCards(page).count();
    assert.equal(baselineCount, 1);
    const activated = new Set();
    assert.equal(await activateDolaVideo(page, baselineCount, activated), false);
    await page.evaluate(() => {
      const section = document.querySelector('[data-testid="receive_message"]');
      const card = document.createElement("div");
      card.className = "block-video-new";
      card.dataset.card = "fresh";
      card.textContent = "Generating...";
      section.append(card);
    });
    assert.equal(await dolaVideoCards(page).count(), 2);
    assert.equal(await activateDolaVideo(page, baselineCount, activated), false);
    assert.deepEqual(await page.evaluate(() => window.fixtureState), {
      old: 0,
      fresh: 0,
      submissions: 0,
    });
    await page.locator('[data-card="fresh"]').evaluate((card) => {
      const play = document.createElement("span");
      play.className = "play-icon-wrapper-new";
      play.textContent = "Play new result";
      card.replaceChildren(play);
    });
    assert.equal(await activateDolaVideo(page, baselineCount, activated), true);
    assert.deepEqual([...activated], [1]);
    await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0);
    const initial = await page.locator("video").evaluate(async (video) => {
      await video.play();
      return { width: video.videoWidth, height: video.videoHeight, time: video.currentTime };
    });
    assert.equal(initial.width, 160);
    assert.equal(initial.height, 90);
    await page.waitForFunction((time) => document.querySelector("video").currentTime > time + 0.2, initial.time);
    assert.equal(await activateDolaVideo(page, baselineCount, activated), false);
    assert.equal(await page.locator("video").count(), 1);
    assert.deepEqual(await page.evaluate(() => window.fixtureState), {
      old: 0,
      fresh: 1,
      submissions: 0,
    });
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (server?.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
    await fs.rm(videoPath, { force: true });
    await fs.rmdir(root);
  }
});
