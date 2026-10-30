import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCaptchaTask,
  captchaSolutionToken,
  captchaTimeoutMs,
  captchaTokenFields,
  createCaptchaClient,
  detectCaptchaSource,
  publicCaptchaSettings,
  readCaptchaSettings,
  saveCaptchaSettings,
} from "../server/captcha.js";
import { StudioError } from "../server/store.js";

const DREAMFACE_KEY = "6LcSw6QrAAAAABE8GKINfipAs_cs2ZdWFBMZLv0G";
const PAGE = "https://www.dreamfaceapp.com/video";

test("buildCaptchaTask builds a proxyless reCAPTCHA v2 task", () => {
  const task = buildCaptchaTask({ type: "recaptcha-v2", pageUrl: PAGE, sitekey: DREAMFACE_KEY });
  assert.deepEqual(task, {
    type: "RecaptchaV2TaskProxyless",
    websiteURL: PAGE,
    websiteKey: DREAMFACE_KEY,
  });
  const invisible = buildCaptchaTask({
    type: "recaptcha-v2",
    pageUrl: PAGE,
    sitekey: DREAMFACE_KEY,
    invisible: true,
    dataS: "s-value",
    userAgent: "UA",
  });
  assert.equal(invisible.isInvisible, true);
  assert.equal(invisible.recaptchaDataSValue, "s-value");
  assert.equal(invisible.userAgent, "UA");
});

test("buildCaptchaTask covers turnstile, v3 and hcaptcha", () => {
  const turnstile = buildCaptchaTask({
    type: "turnstile",
    pageUrl: PAGE,
    sitekey: "ts-key",
    action: "login",
    data: "cdata",
    pagedata: "pagedata",
  });
  assert.equal(turnstile.type, "TurnstileTaskProxyless");
  assert.equal(turnstile.action, "login");
  assert.equal(turnstile.data, "cdata");
  assert.equal(turnstile.pagedata, "pagedata");

  const v3 = buildCaptchaTask({
    type: "recaptcha-v3",
    pageUrl: PAGE,
    sitekey: DREAMFACE_KEY,
    action: "submit",
    enterprise: true,
    apiDomain: "www.google.com",
  });
  assert.equal(v3.type, "RecaptchaV3TaskProxyless");
  assert.equal(v3.minScore, 0.9);
  assert.equal(v3.pageAction, "submit");
  assert.equal(v3.isEnterprise, true);
  assert.equal(v3.apiDomain, "www.google.com");

  const hcaptcha = buildCaptchaTask({ type: "hcaptcha", pageUrl: PAGE, sitekey: "hc-key", invisible: true });
  assert.equal(hcaptcha.type, "HCaptchaTaskProxyless");
  assert.equal(hcaptcha.isInvisible, true);
});

test("buildCaptchaTask switches to proxy task variants", () => {
  const task = buildCaptchaTask({
    type: "recaptcha-v2",
    pageUrl: PAGE,
    sitekey: DREAMFACE_KEY,
    proxy: { server: "http://127.0.0.1:8080", username: "user", password: "pass" },
  });
  assert.equal(task.type, "RecaptchaV2Task");
  assert.equal(task.proxyType, "http");
  assert.equal(task.proxyAddress, "127.0.0.1");
  assert.equal(task.proxyPort, 8080);
  assert.equal(task.proxyLogin, "user");
  assert.equal(task.proxyPassword, "pass");

  const socks = buildCaptchaTask({
    type: "turnstile",
    pageUrl: PAGE,
    sitekey: "ts-key",
    proxy: { server: "socks5://10.0.0.2:1080" },
  });
  assert.equal(socks.type, "TurnstileTask");
  assert.equal(socks.proxyType, "socks5");
  assert.equal(socks.proxyPort, 1080);
});

test("buildCaptchaTask validates input", () => {
  assert.throws(
    () => buildCaptchaTask({ type: "unknown", pageUrl: PAGE, sitekey: DREAMFACE_KEY }),
    (error) => error instanceof StudioError && error.code === "CAPTCHA_TYPE_UNSUPPORTED",
  );
  assert.throws(
    () => buildCaptchaTask({ type: "recaptcha-v2", pageUrl: "not-a-url", sitekey: DREAMFACE_KEY }),
    (error) => error.code === "CAPTCHA_URL_MISSING",
  );
  assert.throws(
    () => buildCaptchaTask({ type: "recaptcha-v2", pageUrl: PAGE, sitekey: " " }),
    (error) => error.code === "CAPTCHA_SITEKEY_MISSING",
  );
  assert.throws(
    () => buildCaptchaTask({ type: "recaptcha-v2", pageUrl: PAGE, sitekey: DREAMFACE_KEY, proxy: { server: "ftp://host" } }),
    (error) => error.code === "CAPTCHA_PROXY_INVALID",
  );
  assert.throws(
    () => buildCaptchaTask({ type: "recaptcha-v2", pageUrl: PAGE, sitekey: DREAMFACE_KEY, proxy: { server: "nope" } }),
    (error) => error.code === "CAPTCHA_PROXY_INVALID",
  );
});

test("detectCaptchaSource reads DreamFace reCAPTCHA v2 from the iframe", () => {
  const detected = detectCaptchaSource({
    url: PAGE,
    frames: [`https://www.google.com/recaptcha/api2/anchor?ar=1&k=${DREAMFACE_KEY}&co=aHR0cHM6Ly93d3cuZHJlYW1mYWNlYXBwLmNvbTo0NDM.&hl=en&size=normal`],
    scripts: [],
  });
  assert.equal(detected.type, "recaptcha-v2");
  assert.equal(detected.sitekey, DREAMFACE_KEY);
  assert.equal(detected.invisible, false);
  assert.equal(detected.enterprise, false);
  assert.equal(detected.pageUrl, PAGE);
});

test("detectCaptchaSource prefers element sitekeys and flags invisible/enterprise", () => {
  const element = detectCaptchaSource({
    url: PAGE,
    elements: [{ className: "g-recaptcha", id: "", sitekey: "element-key" }],
    frames: ["https://www.google.com/recaptcha/enterprise/anchor?k=frame-key&size=invisible"],
  });
  assert.equal(element.sitekey, "element-key");
  assert.equal(element.invisible, true);
  assert.equal(element.enterprise, true);

  const turnstile = detectCaptchaSource({
    url: PAGE,
    elements: [{ className: "cf-turnstile", id: "", sitekey: "ts-key", action: "login" }],
  });
  assert.equal(turnstile.type, "turnstile");
  assert.equal(turnstile.action, "login");

  const hcaptcha = detectCaptchaSource({
    url: PAGE,
    frames: ["https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&sitekey=hc-key"],
  });
  assert.equal(hcaptcha.type, "hcaptcha");
  assert.equal(hcaptcha.sitekey, "hc-key");
});

test("detectCaptchaSource falls back to reCAPTCHA v3 render script", () => {
  const detected = detectCaptchaSource({
    url: PAGE,
    scripts: [`https://www.google.com/recaptcha/api.js?render=${DREAMFACE_KEY}`],
  });
  assert.equal(detected.type, "recaptcha-v3");
  assert.equal(detected.sitekey, DREAMFACE_KEY);
});

test("detectCaptchaSource returns null without captcha markup", () => {
  assert.equal(detectCaptchaSource({ url: PAGE }), null);
  assert.equal(detectCaptchaSource({}), null);
});

test("captchaSolutionToken and token fields match 2Captcha responses", () => {
  assert.equal(captchaSolutionToken({ gRecaptchaResponse: "abc" }), "abc");
  assert.equal(captchaSolutionToken({ token: " tok " }), "tok");
  assert.equal(captchaSolutionToken({ gRecaptchaResponseV2: "v2" }), "v2");
  assert.equal(captchaSolutionToken({ text: "text" }), "text");
  assert.equal(captchaSolutionToken(null), "");
  assert.deepEqual(captchaTokenFields("turnstile"), ["cf-turnstile-response", "g-recaptcha-response"]);
  assert.deepEqual(captchaTokenFields("hcaptcha"), ["h-captcha-response", "g-recaptcha-response"]);
  assert.deepEqual(captchaTokenFields("recaptcha-v2"), ["g-recaptcha-response"]);
  assert.equal(captchaTimeoutMs(60000), 60000);
  assert.equal(captchaTimeoutMs(1000), 180000);
  assert.equal(captchaTimeoutMs("nope"), 180000);
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("createCaptchaClient polls until the task is ready", async () => {
  const calls = [];
  const progress = [];
  const responses = [
    jsonResponse({ errorId: 0, taskId: 123 }),
    jsonResponse({ errorId: 0, status: "processing" }),
    jsonResponse({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "solved-token" }, cost: "0.001", solveCount: 1 }),
  ];
  const client = createCaptchaClient({
    apiKey: "a".repeat(32),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return responses.shift();
    },
    sleepImpl: async () => {},
    now: (() => {
      let value = 0;
      return () => (value += 1000);
    })(),
    timeoutMs: 60000,
    onProgress: (event) => progress.push(event.status),
  });
  const result = await client.solve({ type: "RecaptchaV2TaskProxyless", websiteURL: PAGE, websiteKey: DREAMFACE_KEY });
  assert.equal(result.token, "solved-token");
  assert.equal(result.taskId, 123);
  assert.equal(result.cost, "0.001");
  assert.equal(calls[0].url, "https://api.2captcha.com/createTask");
  assert.equal(calls[0].body.clientKey, "a".repeat(32));
  assert.equal(calls[0].body.task.websiteKey, DREAMFACE_KEY);
  assert.equal(calls[1].url, "https://api.2captcha.com/getTaskResult");
  assert.equal(calls[1].body.taskId, 123);
  assert.deepEqual(progress, ["submitted", "processing"]);
});

test("createCaptchaClient surfaces 2Captcha API errors", async () => {
  const badKey = createCaptchaClient({
    apiKey: "b".repeat(32),
    fetchImpl: async () => jsonResponse({ errorId: 1, errorCode: "ERROR_KEY_DOES_NOT_EXIST", errorDescription: "Account does not exist" }),
  });
  await assert.rejects(
    () => badKey.createTask({}),
    (error) => error instanceof StudioError && error.status === 401 && error.captchaErrorCode === "ERROR_KEY_DOES_NOT_EXIST",
  );

  const retryable = createCaptchaClient({
    apiKey: "c".repeat(32),
    fetchImpl: async () => jsonResponse({ errorId: 1, errorCode: "ERROR_ZERO_BALANCE", errorDescription: "Zero balance" }),
  });
  await assert.rejects(
    () => retryable.balance(),
    (error) => error.status === 502 && /Zero balance/.test(error.message),
  );

  const missingTask = createCaptchaClient({
    apiKey: "d".repeat(32),
    fetchImpl: async () => jsonResponse({ errorId: 0 }),
  });
  await assert.rejects(
    () => missingTask.createTask({}),
    (error) => error.code === "CAPTCHA_NO_TASK_ID",
  );

  const network = createCaptchaClient({
    apiKey: "e".repeat(32),
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(
    () => network.createTask({}),
    (error) => error.code === "CAPTCHA_NETWORK",
  );

  const garbage = createCaptchaClient({
    apiKey: "f".repeat(32),
    fetchImpl: async () => new Response("<html>", { status: 502 }),
  });
  await assert.rejects(() => garbage.createTask({}), (error) => error.code === "CAPTCHA_BAD_RESPONSE");
});

test("createCaptchaClient returns the account balance", async () => {
  const client = createCaptchaClient({
    apiKey: "g".repeat(32),
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.2captcha.com/getBalance");
      assert.equal(JSON.parse(options.body).clientKey, "g".repeat(32));
      return jsonResponse({ errorId: 0, balance: 4.5 });
    },
  });
  assert.deepEqual(await client.balance(), { balance: 4.5, currency: "USD" });
});

test("createCaptchaClient times out while the task keeps processing", async () => {
  const client = createCaptchaClient({
    apiKey: "h".repeat(32),
    fetchImpl: async (url) => (url.endsWith("createTask")
      ? jsonResponse({ errorId: 0, taskId: 9 })
      : jsonResponse({ errorId: 0, status: "processing" })),
    sleepImpl: async () => {},
    now: (() => {
      let value = 0;
      return () => (value += 60000);
    })(),
    timeoutMs: 120000,
  });
  await assert.rejects(
    () => client.solve({}),
    (error) => error.code === "CAPTCHA_TIMEOUT" && error.status === 408,
  );
});

test("createCaptchaClient rejects a missing key", () => {
  assert.throws(() => createCaptchaClient({}), (error) => error.code === "CAPTCHA_KEY_MISSING");
});

test("captcha settings roundtrip through the encrypted secret store", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "viralstudio-captcha-"));
  try {
    const store = { root };
    assert.deepEqual(readCaptchaSettings(store), { enabled: true, autoSolveDreamFace: true, apiKey: "" });
    assert.equal(publicCaptchaSettings(store).hasKey, false);
    assert.deepEqual(publicCaptchaSettings(store).supportedTypes, ["turnstile", "recaptcha-v2", "recaptcha-v3", "hcaptcha"]);

    const saved = saveCaptchaSettings(store, { apiKey: "k".repeat(32) });
    assert.equal(saved.hasKey, true);
    assert.equal(readCaptchaSettings(store).apiKey, "k".repeat(32));

    const masked = saveCaptchaSettings(store, { apiKey: "[đã lưu]", autoSolveDreamFace: false });
    assert.equal(masked.hasKey, true);
    assert.equal(masked.autoSolveDreamFace, false);
    assert.equal(readCaptchaSettings(store).enabled, true);

    const cleared = saveCaptchaSettings(store, { clearKey: true, enabled: false });
    assert.equal(cleared.hasKey, false);
    assert.equal(cleared.enabled, false);
    assert.equal(readCaptchaSettings(store).apiKey, "");

    assert.throws(
      () => saveCaptchaSettings(store, { apiKey: "short key!" }),
      (error) => error.code === "CAPTCHA_KEY_INVALID",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
