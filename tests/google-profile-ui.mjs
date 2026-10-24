import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { startServer } from "../server/index.js";

const output = path.resolve(".verification/google-profile-ui");
await fs.mkdir(output, { recursive: true });
const studio = await startServer({ port: 0, dataDir: path.join(output, `data-${randomUUID()}`) });
const report = { passed: false, scope: "Real local HTTP app and owned Chrome process; Dola/Flow responses are fixtures, no live AI request.", errors: [], checks: [] };
const launches = [];
const createSession = studio.browsers.createSession.bind(studio.browsers);
studio.browsers.createSession = async (account, visible) => {
  const profile = await createSession(account, visible);
  launches.push({ profileId: profile.profileId, visible });
  await profile.context.route("**/*", (route) => route.fulfill({
    contentType: "text/html",
    body: new URL(route.request().url()).hostname.endsWith("dola.com")
      ? '<h1>Dola fixture</h1><div contenteditable="true" data-testid="chat_input_input"></div>'
      : '<h1>New project</h1><div class="ProseMirror" contenteditable="true"></div>',
  }));
  return profile;
};
const api = async (url, body) => {
  const response = await fetch(studio.address + url, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(response.ok, true, `HTTP ${response.status} on ${url}`);
  return response.json();
};
let browser;
try {
  const dola = await api("/api/accounts", { name: "Google Dola thử nghiệm", provider: "dola", loginMethod: "google" });
  const flow = await api("/api/accounts", { name: "Google Flow thử nghiệm", provider: "flow", loginMethod: "google" });
  const source = await studio.browsers.open(studio.store.require("accounts", dola.id));
  await source.context.addCookies([
    { name: "SID", value: "fixture-google", domain: ".google.com", path: "/", secure: true, expires: Date.now() / 1000 + 3600 },
    { name: "sessionid", value: "fixture-dola", domain: ".dola.com", path: "/", secure: true, expires: Date.now() / 1000 + 3600 },
  ]);
  assert.equal((await api(`/api/accounts/${dola.id}/check`, {})).status, "ready");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(message.text());
  });
  await page.route(studio.address + "/api/state", async (route) => {
    const state = await api("/api/state");
    delete state.capabilities.googleProfileReuse;
    await route.fulfill({ json: state });
  });
  await page.goto(studio.address);
  await page.getByRole("button", { name: "Tài khoản", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Dùng phiên Google có sẵn", exact: true }).count(), 0);
  report.checks.push("The new control is hidden when attached to an older backend.");
  await page.unroute(studio.address + "/api/state");
  await page.reload();
  await page.getByRole("button", { name: "Tài khoản", exact: true }).click();
  const flowCard = page.locator(".account-card").filter({ has: page.getByRole("heading", { name: flow.name, exact: true }) });
  await flowCard.getByRole("button", { name: "Dùng phiên Google có sẵn", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByRole("combobox").selectOption(dola.id);
  await page.screenshot({ path: path.join(output, "choose-profile.png"), fullPage: true });
  await modal.getByRole("button", { name: "Dùng hồ sơ & kiểm tra", exact: true }).click();
  await modal.waitFor({ state: "hidden", timeout: 30000 });
  await flowCard.getByText("Google Flow đã mở không gian làm việc.", { exact: true }).waitFor();
  await api(`/api/accounts/${dola.id}/check`, {});
  const first = studio.browsers.sessions.get(dola.id);
  const second = studio.browsers.sessions.get(flow.id);
  assert.equal(first.context, second.context);
  assert.notEqual(first.page, second.page);
  assert.equal(launches.length, 2);
  assert.deepEqual(launches.map((entry) => entry.visible), [false, true]);
  assert.equal(studio.browsers.profiles.size, 1);
  assert.equal(studio.store.require("accounts", flow.id).profileId, dola.id);
  assert.equal((await second.context.cookies()).some((cookie) => cookie.name === "SID"), true);
  report.checks.push("Actual Chrome persists the fixture Google session across headless-to-visible promotion and shares one context with separate Dola/Flow tabs.");
  await page.screenshot({ path: path.join(output, "accounts-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, "accounts-mobile.png"), fullPage: true });
  report.checks.push("Profile selection and linked account status work at desktop/mobile widths without horizontal overflow.");
  assert.deepEqual(report.errors, []);
  report.passed = true;
  report.launches = launches;
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  await browser?.close();
  await studio.close();
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
