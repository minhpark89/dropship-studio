import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { startServer } from "../server/index.js";
import { Store } from "../server/store.js";

const root = path.resolve(".verification", `workspaces-ui-${Date.now()}`);
await fs.mkdir(root, { recursive: true });
const store = new Store(root);
const project = store.createProject("Workspace split QA");
store.add("researchResults", {
  projectId: project.id,
  topic: "Research screen smoke test",
  niche: "General news",
  language: "en",
  headline: "Research screen smoke test",
  angle: "A saved result must keep the workspace visible.",
  script: "The saved result keeps the Research workspace available.",
  articles: [{
    id: "00000000-0000-4000-8000-000000000001",
    title: "A verified source readers can open",
    summary: "The source provides the evidence used by the saved research record.",
    source: "QA News",
    url: "https://example.com/qa-news",
    publishedAt: "2026-10-28T08:00:00.000Z",
    imageUrl: null,
    imageQuery: "",
    relevance: 1,
  }],
  imageQueries: [],
  imageSearchResults: [],
  imageMediaIds: [],
  warnings: [],
});
store.state.settings.llm = {
  ...store.state.settings.llm,
  enabled: true,
  endpoint: "http://127.0.0.1:9/v1",
  model: "qa-model",
};
store.save();
store.add("socialPages", { name: "News & Product QA", platform: "facebook", externalId: "987654321", url: "https://www.facebook.com/qa", timezone: "Asia/Bangkok", notes: "", archived: false, revision: 1 });
const studio = await startServer({ port: 0, dataDir: root });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const report = { checks: [], errors, url: studio.address };
try {
  await page.goto(studio.address);
  await page.locator(".page").first().waitFor();
  await page.getByRole("button", { name: "Research & News", exact: true }).click();
  await page.locator(".research-page").waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  await page.locator("details.research-articles > summary").click();
  const sourceLink = page.getByRole("link", { name: /Mở nguồn: A verified source readers can open/ });
  assert.equal(await sourceLink.getAttribute("href"), "https://example.com/qa-news");
  assert.equal(await sourceLink.locator(".research-open-source").innerText(), "Mở nguồn");
  assert.equal(await page.locator(".research-batch-toolbar").count(), 1);
  assert.equal(await page.locator(".research-batch-toolbar select").count(), 3);
  await page.getByLabel("Lọc Research").selectOption("needs-llm");
  assert.equal(await page.locator(".research-result-card").count(), 1);
  await page.getByLabel("Lọc Research").selectOption("all");
  assert.equal(await page.getByText("Render tất cả 1 tin", { exact: true }).count(), 1);
  report.checks.push("Research & News stays visible with an existing result and has no blank-screen error");
  let testLlmPayload = null;
  await page.route("**/api/settings/llm/models", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: ["qa-model"] }) });
  });
  await page.route("**/api/settings/llm/test", async (route) => {
    testLlmPayload = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, model: testLlmPayload.model, latencyMs: 2, preview: "ok" }) });
  });
  await page.getByRole("button", { name: "Cài đặt", exact: true }).click();
  await page.locator(".settings-llm-panel").waitFor();
  await page.getByLabel("Endpoint OpenAI-compatible").fill("https://new.example/v1/chat/completions");
  await page.getByRole("textbox", { name: "API key", exact: true }).fill("unsaved-form-key");
  await page.getByRole("button", { name: "Test LLM", exact: true }).click();
  await page.locator(".settings-llm-result").waitFor();
  assert.equal(testLlmPayload.endpoint, "https://new.example/v1/chat/completions");
  assert.equal(testLlmPayload.apiKey, "unsaved-form-key");
  assert.equal(testLlmPayload.model, "qa-model");
  await page.unroute("**/api/settings/llm/models");
  await page.unroute("**/api/settings/llm/test");
  report.checks.push("Settings Test LLM sends the current unsaved endpoint and API key");
  await page.getByRole("button", { name: "Research & News", exact: true }).click();
  await page.locator(".research-page").waitFor();
  await page.getByRole("button", { name: "Render 1 News video", exact: true }).last().click();
  await page.locator(".render-hub").waitFor();
  await page.getByTestId("render-record").waitFor();
  assert.match(await page.getByTestId("render-record").innerText(), /Research screen smoke test/);
  assert.equal(await page.locator(".render-editor-note").count(), 1);
  report.checks.push("Research render keeps the selected article attached to a visible render record and explains Queue versus manual timeline");
  await page.setViewportSize({ width: 1440, height: 500 });
  const sidebarScroll = await page.locator(".sidebar > nav").evaluate((element) => {
    const before = element.scrollTop;
    element.scrollTop = element.scrollHeight;
    return { overflowY: getComputedStyle(element).overflowY, scrollable: element.scrollHeight > element.clientHeight, moved: element.scrollTop > before };
  });
  assert.equal(sidebarScroll.overflowY, "auto");
  assert.equal(sidebarScroll.scrollable, true);
  assert.equal(sidebarScroll.moved, true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  report.checks.push("Left navigation has an independent mouse-scroll region on short windows");
  await page.getByRole("button", { name: "Channels & Tokens", exact: true }).click();
  await page.locator(".pages-hub").waitFor();
  await page.getByRole("button", { name: "Thêm Page", exact: true }).first().click();
  const pageDialog = page.locator('[role="dialog"]');
  await pageDialog.getByLabel("Tên Page").fill("Product & News QA");
  await pageDialog.getByRole("button", { name: "Lưu Page", exact: true }).click();
  await pageDialog.waitFor({ state: "hidden" });
  await page.locator(".hub-list-row").filter({ hasText: "Product & News QA" }).waitFor();
  report.checks.push("Channels workspace opens separately and creates local Page records");
  const localPanel = await page.locator(".pages-local-panel").boundingBox();
  assert.ok(localPanel && localPanel.y + localPanel.height <= 1000, `Page local panel is clipped: ${JSON.stringify(localPanel)}`);
  await page.locator(".pages-tabs button").nth(3).click();
  await page.locator(".pages-distribution-view").waitFor();
  assert.equal(await page.locator(".pages-post-toolbar").count(), 1);
  assert.equal(await page.locator(".pages-warehouse-list").count(), 0);
  report.checks.push("Page local panel fits the viewport and the post control tab hides duplicate video rows");
  await page.getByRole("button", { name: "Content Studio", exact: true }).click();
  await page.locator(".content-hub").waitFor();
  await page.getByRole("button", { name: "Content News", exact: true }).click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByLabel("Tiêu đề").fill("Tin nóng QA");
  await dialog.getByLabel("Caption").fill("Caption tin tức kiểm thử.");
  await dialog.getByLabel("First comment").fill("Đọc bài đầy đủ tại đây.");
  await dialog.getByLabel("Store / article link").fill("https://example.com/news");
  await dialog.getByRole("button", { name: "Tạo bản nháp" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.locator(".content-card").filter({ hasText: "Tin nóng QA" }).waitFor();
  const socialSnapshot = await page.evaluate(async () => (await fetch("/api/social")).json());
  assert.equal(socialSnapshot.posts[0].firstComment, "Đọc bài đầy đủ tại đây.");
  assert.equal(socialSnapshot.posts[0].contentType, "news");
  report.checks.push("News Content stores first comment and source link");
  await page.getByRole("button", { name: "Product Studio", exact: true }).click();
  await page.locator(".product-hub").waitFor();
  await page.getByLabel("Tên sản phẩm").fill("Bình giữ nhiệt QA");
  await page.getByRole("button", { name: "Gửi DreamFace" }).click();
  await page.waitForTimeout(500);
  const queuedState = await page.evaluate(async () => (await fetch("/api/state")).json());
  assert.equal(queuedState.jobs.some((job) => job.payload?.provider === "dreamface"), true);
  report.checks.push("Product Studio queues a DreamFace video request");
  await page.getByRole("button", { name: "Dựng video", exact: true }).click();
  await page.locator(".render-hub").waitFor();
  assert.equal(await page.locator(".render-mode-tabs button").count(), 2);
  await page.locator(".render-mode-tabs button").nth(1).click();
  assert.equal(await page.locator(".production-panel").count(), 1);
  assert.equal(await page.locator(".editor-heading .eyebrow").innerText(), "PRODUCT RENDER");
  await page.locator(".render-mode-tabs button").nth(0).click();
  assert.equal(await page.locator(".production-panel").count(), 1);
  assert.equal(await page.locator(".editor-heading .eyebrow").innerText(), "NEWS RENDER");
  assert.equal(await page.getByLabel("Font / style").count(), 1);
  assert.equal(await page.getByLabel("Link bài news (tuỳ chọn)").count(), 1);
  assert.deepEqual(await page.getByLabel("Font / style").locator("option").allTextContents(), ["News chuẩn · Barlow Condensed", "Viral mạnh · Anton + Barlow", "Viral sạch · Be Vietnam Pro"]);
  report.checks.push("Render workspace switches between News and Product and exposes the direct-link and three style presets");
  await page.getByRole("button", { name: "Tài khoản", exact: true }).click();
  await page.getByRole("button", { name: "Tạo profile xoay vòng" }).click();
  const slots = page.locator('[role="dialog"]');
  await slots.locator('input[type="number"]').fill("3");
  await slots.getByRole("checkbox", { name: "Start registration now" }).uncheck();
  await slots.getByRole("button", { name: "Create 3 profiles" }).click();
  await slots.waitFor({ state: "hidden" });
  const slotState = await page.evaluate(async () => (await fetch("/api/state")).json());
  assert.equal(slotState.accounts.filter((account) => account.provider === "dreamface").length, 3);
  report.checks.push("Bulk DreamFace slots create local rotation profiles without external email creation");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  report.checks.push("Separated workspaces have no console errors or horizontal overflow");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.stack;
  await page.screenshot({ path: path.join(root, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.resolve(".verification/workspaces-ui-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  await studio.close();
}
