// One guarded agent planning request. This script never clicks a media confirmation.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { decodeFlowRpc } from "../server/providers/flow-rpc.js";

const directory = path.resolve(".verification/flow-agent-live");
const manifest = path.join(directory, "plan.json");
await fs.mkdir(directory, { recursive: true });
assert.equal(await fs.stat(manifest).then(() => true, () => false), false, "A planning request is already recorded. Observe it; do not submit again.");
const report = { at: new Date().toISOString(), events: [], mediaConfirmationClicked: false };
const save = () => fs.writeFile(manifest, JSON.stringify(report, null, 2));
const prompt = "Create exactly one video using Veo 3.1 Fast. Duration 8 seconds, portrait 9:16. A matte black unbranded water bottle on a pale green pedestal, slow camera orbit, soft studio lighting, no text or logos. Show the generation proposal for confirmation before generating.";
const safe = (value, depth = 0) => {
  if (depth > 24) return "<depth>";
  if (Array.isArray(value)) return value.map(item => safe(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|cookie|password|credential/i.test(key) ? "<redacted>" : safe(item, depth + 1)]));
  if (typeof value !== "string") return value;
  if (value === prompt) return "<current-prompt>";
  if (/^https?:\/\//.test(value)) return `<url:${new URL(value).hostname}>`;
  if (/@/.test(value)) return "<redacted>";
  if (value.length > 160) return `<string:${value.length}>`;
  return value;
};
const browser = await chromium.connectOverCDP("http://127.0.0.1:64478");
const page = browser.contexts()[0].pages().find(item => new URL(item.url()).hostname === "flow.google.com");
const pending = new Set();
const listener = response => {
  if (!/\/data\/batchexecute(?:\?|$)/.test(response.url())) return;
  const operation = (async () => {
    const request = response.request();
    const encoded = new URLSearchParams(request.postData() || "").get("f.req");
    let requestData;
    try {
      requestData = JSON.parse(encoded);
      const unpack = value => Array.isArray(value) ? value.map(unpack) : typeof value === "string" && /^[\[{]/.test(value) ? unpack(JSON.parse(value)) : value;
      requestData = unpack(requestData);
    } catch { requestData = null; }
    report.events.push({ status: response.status(), request: safe(requestData), response: safe(decodeFlowRpc(await response.text())) });
  })().catch(() => {});
  pending.add(operation);
  operation.finally(() => pending.delete(operation));
};
try {
  const settings = page.locator("flow-settings-view");
  await settings.waitFor({ timeout: 5000 });
  const always = settings.getByRole("radio", { name: /^Always/ });
  assert.equal(await always.isChecked(), true, "Do not submit with automatic media generation enabled");
  const groups = settings.getByRole("radiogroup");
  const toggles = settings.locator("mat-button-toggle-group");
  assert.equal(await toggles.count(), 4);
  await toggles.nth(2).getByRole("radio", { name: "9:16", exact: true }).click();
  await toggles.nth(3).getByRole("radio", { name: "x1", exact: true }).click();
  await settings.getByRole("button", { name: "Video generation default model", exact: true }).click();
  await page.getByRole("menuitem", { name: "Veo 3.1 - Fast", exact: true }).click();
  await page.getByRole("menu").waitFor({ state: "hidden" });
  assert.match(await settings.getByRole("button", { name: "Video generation default model" }).innerText(), /Veo 3\.1 - Fast/);
  assert.equal(await toggles.nth(2).getByRole("radio", { name: "9:16", exact: true }).getAttribute("aria-checked"), "true");
  assert.equal(await toggles.nth(3).getByRole("radio", { name: "x1", exact: true }).getAttribute("aria-checked"), "true");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  const panel = page.locator("flow-agent-panel");
  const composer = panel.locator('div.ProseMirror[contenteditable="true"]');
  await composer.fill(prompt);
  report.projectUrl = page.url();
  report.prompt = prompt;
  report.planningAttemptedAt = new Date().toISOString();
  await save();
  page.on("response", listener);
  await panel.getByRole("button", { name: "Start generation", exact: true }).click();
  await page.waitForTimeout(20000);
  report.panelText = await panel.innerText();
  report.controls = await panel.locator("button,input,select").evaluateAll(elements => elements.map(element => ({ tag: element.tagName, label: element.getAttribute("aria-label"), text: (element.innerText || "").trim(), class: element.className })));
  await page.screenshot({ path: path.join(directory, "proposal.png") });
  await Promise.allSettled([...pending]);
  await save();
  console.log(JSON.stringify({ panelText: report.panelText, controls: report.controls, events: report.events.length }));
} finally {
  page.off("response", listener);
  await browser.close();
}
