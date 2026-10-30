import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { Store } from "../server/store.js";
import { startServer } from "../server/index.js";

const root = path.resolve(".verification", `meta-retry-ui-${Date.now()}`);
await fs.mkdir(root, { recursive: true });
const store = new Store(root);
const project = store.createProject("Retry containment QA");
store.state.settings.queuePaused = true;
const channel = store.add("socialPages", { name: "Page QA", platform: "facebook", externalId: "123", archived: false, timezone: "Asia/Bangkok", revision: 1 });
store.state.settings.meta.pages = [{ id: "123", name: "Page QA", publishingHealth: { blocked: true, message: "Security restriction", details: { code: 368, subcode: 1404112 } } }];
store.add("socialPosts", {
  projectId: project.id, pageId: channel.id, title: "Kiểm tra lỗi giới hạn", caption: "Synthetic test content", firstComment: "Synthetic first comment", mediaIds: [], revision: 1,
  status: "scheduled", scheduledAt: new Date(Date.now() - 60_000).toISOString(), automationStatus: "meta_error", automationAttempts: 8,
  automationError: "Vì lý do bảo mật, tài khoản của bạn đã giới hạn quyền truy cập vào trang web trong vài ngày.",
});
const originalFetch = globalThis.fetch;
let externalRequests = 0;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) { externalRequests++; throw new Error("External request prohibited in retry UI test"); }
  return originalFetch(input, init);
};
let studio, browser, page;
const errors = [];
try {
  studio = await startServer({ port: 0, dataDir: root });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const host = new URL(route.request().url()).hostname;
    return ["127.0.0.1", "localhost"].includes(host) ? route.continue() : route.abort();
  });
  await page.goto(studio.address);
  await page.getByRole("button", { name: "Channels & Tokens", exact: true }).click();
  await page.getByRole("button", { name: "Page QA", exact: true }).click();
  const detail = page.getByRole('dialog');
  await detail.getByText('Bị hạn chế', { exact: true }).waitFor();
  await detail.getByRole('button', { name: 'Đưa về nhóm đăng', exact: true }).click();
  await page.getByRole('dialog').getByText('0 mục có thể áp dụng · 1 mục cần xử lý riêng', { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Hủy', exact: true }).click();
  assert.equal(studio.store.state.settings.meta.pages[0].publishingHealth.blocked, true);
  await page.getByRole("tab", { name: "Bài đăng & trạng thái", exact: true }).click();
  await studio.socialScheduler.tick();
  await page.getByText('8 lần thử · đã dừng tự thử', { exact: true }).waitFor();
  assert.match(await page.locator('.mg-posts tbody tr').innerText(), /8 lần thử/);
  assert.equal(studio.store.state.socialPosts[0].automationAttempts, 8);
  assert.equal(studio.store.state.socialPosts[0].automationRetryBlocked, true);
  assert.equal(externalRequests, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, "blocked-retry.png"), fullPage: true });
  const report = { passed: true, externalRequests, attemptsUnchanged: true, blockedStateVisible: true, errors, root };
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(root, "failure.png"), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify({ passed: false, failure: error.stack, errors, externalRequests }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await studio?.close();
  globalThis.fetch = originalFetch;
}
