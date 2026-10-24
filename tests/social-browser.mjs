import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { startServer } from "../server/index.js";
import { Store } from "../server/store.js";

const root = path.resolve(".verification", `social-ui-${randomUUID()}`);
const output = path.resolve(".verification/social-ui");
await fs.mkdir(output, { recursive: true });
const store = new Store(root);
const project = store.createProject("QA Page Social");
const mediaFile = path.join(root, "media", "ảnh sản phẩm.png");
await fs.writeFile(mediaFile, Buffer.from("qa-social-media", "utf8"));
const media = store.add("media", {
  projectId: project.id,
  name: "ảnh sản phẩm.png",
  kind: "image",
  file: mediaFile,
  thumbnail: null,
  previewFile: null,
  bytes: 16,
  width: 1200,
  height: 1200,
  duration: 0,
  generated: false,
});
const studio = await startServer({ port: 0, dataDir: root });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const report = { checks: [], errors, root, url: studio.address };
const socialTab = page.locator("nav button").filter({ hasText: "Page" });
const libraryTab = page.locator("nav button").filter({ hasText: "Th" }).first();
try {
  await page.goto(studio.address);
  await page.locator(".page").first().waitFor();
  await socialTab.click();
  await page.locator(".social-page").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  report.checks.push("Page quản lý mở được và không tràn ngang ở desktop");

  await page.locator(".social-heading-actions button").first().click();
  const pageDialog = page.locator('[role="dialog"]');
  await pageDialog.locator('input[name="name"]').fill("Vira Home QA");
  await pageDialog.locator('input[name="externalId"]').fill("123456789");
  await pageDialog.locator('input[name="url"]').fill("https://www.facebook.com/vira.home.qa");
  await pageDialog.locator("form button").last().click();
  await pageDialog.waitFor({ state: "hidden" });
  await page.locator(".social-page-item").filter({ hasText: "Vira Home QA" }).waitFor();
  report.checks.push("Tạo Facebook Page local với URL HTTPS hợp lệ");

  await page.locator(".social-heading-actions button").nth(1).click();
  const postDialog = page.locator('[role="dialog"]');
  await postDialog.locator('input[name="title"]').fill("Bộ sưu tập mùa mới");
  await postDialog.locator('textarea[name="caption"]').fill("Nội dung QA tiếng Việt cho bài đăng.");
  await postDialog.locator('select[name="mediaId"]').selectOption(media.id);
  await postDialog.locator("form button").last().click();
  await postDialog.waitFor({ state: "hidden" });
  const card = page.locator(".social-post-card").filter({ hasText: "Bộ sưu tập mùa mới" });
  await card.waitFor();
  assert.equal((await page.locator(".social-post-media-name").first().innerText()), "ảnh sản phẩm.png");
  report.checks.push("Tạo bản nháp, gắn media từ Thư viện và lưu đúng project");

  await card.locator("button").filter({ hasText: "Duy" }).click();
  await card.locator(".badge.ready").waitFor();
  await card.locator("button").filter({ hasText: "Xu" }).click();
  await page.locator('[role="dialog"]').filter({ hasText: "manifest" }).waitFor();
  const snapshot = await page.evaluate(async () => (await fetch("/api/social")).json());
  const post = snapshot.posts.find((item) => item.title === "Bộ sưu tập mùa mới");
  assert.equal(post.status, "ready");
  assert.equal(post.mediaIds[0], media.id);
  assert.ok(post.exportRevision);
  const manifestResponse = await page.request.get(`${studio.address}/api/social/posts/${post.id}/package/${post.exportRevision}/manifest.json`);
  assert.equal(manifestResponse.status(), 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.files.some((file) => file.name === "caption.txt"), true);
  report.checks.push("Duyệt bài và tạo handoff package atomic có manifest/caption/media");

  await page.locator('[role="dialog"]').getByRole("button").filter({ hasText: "Đóng" }).click().catch(() => {});
  await libraryTab.click();
  await page.locator(".media-card").first().waitFor();
  await page.locator(".media-card").first().getByRole("button", { name: /So/ }).click();
  await page.locator(".social-page").waitFor();
  await page.locator('[role="dialog"]').filter({ hasText: "Tạo bài" }).waitFor();
  assert.equal(await page.locator('[role="dialog"] select[name="mediaId"]').inputValue(), media.id);
  report.checks.push("Library → Soạn bài handoff mở đúng Page và media");

  await page.locator('[role="dialog"]').getByRole("button").filter({ hasText: "Hủy" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  report.checks.push("Không có console/page error và không tràn ngang ở mobile");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.stack;
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  await studio.close();
}
