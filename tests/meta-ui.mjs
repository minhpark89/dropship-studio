import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { startServer } from "../server/index.js";
import { Store } from "../server/store.js";

const root = path.resolve(".verification", `meta-ui-${randomUUID()}`);
await fs.mkdir(root, { recursive: true });
const store = new Store(root);
store.createProject("Meta UI QA");
const studio = await startServer({ port: 0, dataDir: root });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const report = { checks: [], errors, root, url: studio.address };
try {
  await page.goto(studio.address);
  await page.locator("nav button").filter({ hasText: "Page" }).click();
  await page.locator(".meta-management").waitFor();
  assert.equal(await page.locator(".meta-management").getByText("Vault token & nhóm phân phối").count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  report.checks.push("Meta vault panel renders with token/page metrics and no desktop overflow");
  await page.getByRole("button", { name: /Nhóm token/ }).click();
  await page.locator('[role="dialog"]').waitFor();
  assert.equal(await page.locator('[role="dialog"]').getByText("Chưa có dữ liệu để thêm vào nhóm.").count(), 1);
  await page.locator('[role="dialog"]').getByRole("button", { name: "Hủy" }).click();
  await page.getByRole("button", { name: /Thêm token/ }).click();
  assert.equal(await page.locator('[role="dialog"] input[type="password"]').count(), 1);
  const tokenType = page.locator('[role="dialog"] select').first();
  assert.equal(await tokenType.locator('option').count(), 2);
  assert.equal(await tokenType.locator('option[value="TEAM"]').count(), 0);
  assert.equal(await page.locator('[role="dialog"]').getByText(/User access token dùng để xác minh/).count(), 1);
  await page.locator('[role="dialog"]').getByRole("button", { name: "Hủy" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  report.checks.push("Token and group dialogs open safely; mobile layout has no overflow or console errors");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.stack;
  await page.screenshot({ path: path.join(root, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  await studio.close();
}
