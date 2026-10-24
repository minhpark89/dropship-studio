import fs from "node:fs/promises";
import path from "node:path";
import { StudioError } from "../store.js";

function unavailable(message, code = "PROVIDER_RESULT_UNRECOGNIZED") {
  return new StudioError(message, code);
}

function normalize(value) {
  return String(value || "")
    .replace(/[–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function matchesPrompt(value, prompt) {
  const actual = normalize(value);
  const expected = normalize(prompt);
  return Boolean(actual && expected && (actual === expected || actual.includes(expected) || expected.includes(actual)));
}

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

export async function flowVideoCardKeys(page) {
  const options = page.locator('[role="button"][aria-label="Open video in editor"]:visible');
  return options.evaluateAll((elements) => elements.map((element) => {
    const image = element.querySelector("img[alt]");
    const anchor = element.closest("a");
    return [
      element.getAttribute("data-id"),
      element.getAttribute("id"),
      element.getAttribute("aria-label"),
      anchor?.getAttribute("href"),
      image?.getAttribute("alt"),
      element.textContent,
    ]
      .map((value) => String(value || "").replace(/\s+/g, " ").trim())
      .join("|");
  }));
}

async function waitForVideoOption(
  page,
  prompt,
  { baselineCount = 0, baselineKeys = [], signal, timeout = 120000 } = {},
) {
  const deadline = Date.now() + timeout;
  const options = page.locator('[role="button"][aria-label="Open video in editor"]:visible');
  const baselineSet = new Set(baselineKeys);
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const count = await options.count();
    const keys = baselineSet.size ? await flowVideoCardKeys(page) : [];
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      const alt = await option.locator("img[alt]").first().getAttribute("alt").catch(() => null);
      const isNew = baselineSet.size
        ? !baselineSet.has(keys[index] || "")
        : index >= baselineCount;
      if (!isNew) continue;
      if (matchesPrompt(alt, prompt)) return option;
    }
    await page.waitForTimeout(Math.min(1000, Math.max(100, deadline - Date.now())));
  }
  throw unavailable("Flow chưa hiển thị video mới đúng prompt sau khi đã nhận tác vụ.", "PROVIDER_TIMEOUT");
}

async function waitForEditor(page, signal, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (/\/edit\//.test(page.url())) return;
    await page.waitForTimeout(Math.min(500, Math.max(100, deadline - Date.now())));
  }
  throw unavailable("Flow không mở được editor của video vừa tạo.");
}

async function waitForDownloadButton(page, signal, timeout) {
  const deadline = Date.now() + timeout;
  const button = page.getByRole("button", { name: "Download media", exact: true });
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (await button.count() === 1 && await button.isVisible().catch(() => false)) return button;
    await page.waitForTimeout(Math.min(500, Math.max(100, deadline - Date.now())));
  }
  throw unavailable("Flow editor chưa có nút tải media.");
}

/**
 * Downloads the current Flow agent result through the provider's visible editor.
 * This deliberately chooses the original-size menu entry and never accepts a
 * thumbnail or a URL scraped from arbitrary DOM markup as the generated video.
 */
export async function downloadFlowAgentMedia(
  page,
  { prompt, destination, baselineCount = 0, baselineKeys = [], signal, timeout = 120000 } = {},
) {
  if (!page || typeof page.locator !== "function") throw new TypeError("A Flow page is required.");
  if (!prompt || typeof prompt !== "string") throw new TypeError("A Flow prompt is required.");
  if (!destination || typeof destination !== "string") throw new TypeError("A destination path is required.");
  const deadline = Date.now() + timeout;
  const option = await waitForVideoOption(page, prompt, {
    baselineCount,
    baselineKeys,
    signal,
    timeout,
  });
  throwIfAborted(signal);
  await option.click({ timeout: Math.max(1000, deadline - Date.now()) });
  await waitForEditor(page, signal, Math.max(1000, deadline - Date.now()));
  const downloadButton = await waitForDownloadButton(page, signal, Math.max(1000, deadline - Date.now()));
  await downloadButton.click({ timeout: Math.max(1000, deadline - Date.now()) });
  const original = page.getByRole("menuitem").filter({ hasText: /Original size/i }).first();
  await original.waitFor({ state: "visible", timeout: Math.max(1000, deadline - Date.now()) }).catch(() => {
    throw unavailable("Flow không cung cấp lựa chọn Original size cho video này.");
  });
  throwIfAborted(signal);
  const downloadPromise = page.waitForEvent("download", {
    timeout: Math.max(1000, deadline - Date.now()),
  });
  await original.click({ timeout: Math.max(1000, deadline - Date.now()) });
  const download = await downloadPromise;
  throwIfAborted(signal);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await download.saveAs(destination);
  const stat = await fs.stat(destination);
  if (!stat.isFile() || stat.size === 0) throw unavailable("Flow trả về tệp video rỗng.");
  return { destination, suggestedFilename: download.suggestedFilename() };
}
