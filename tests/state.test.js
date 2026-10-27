import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { parseCookies } from "../server/providers/cookies.js";
import { JobQueue } from "../server/queue.js";
import { binary, runProcess } from "../server/media.js";
import { startServer } from "../server/index.js";
import { findInstance } from "../server/instance.js";

test("Cookie imports preserve session fields and reject unrelated/expired or malformed credentials", () => {
  const cookies = parseCookies(
    JSON.stringify([
      {
        name: "sessionid",
        value: "test-session-value",
        domain: ".dola.com",
        httpOnly: true,
        secure: true,
        sameSite: "no_restriction",
        expirationDate: Date.now() / 1000 + 600,
      },
      { name: "sessionid", value: "irrelevant", domain: ".evil-dola.com" },
      { name: "expired", value: "old", domain: ".dola.com", expires: 10 },
    ]),
    "dola",
  );
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].httpOnly, true);
  assert.equal(cookies[0].sameSite, "None");
  assert.equal(
    parseCookies(
      "#HttpOnly_.dola.com\tTRUE\t/\tTRUE\t0\tsessionid\tvalue",
      "dola",
    )[0].expires,
    -1,
  );
  assert.equal(
    parseCookies("Cookie: SID=abc==; __Secure-1PSID=xyz; Path=/", "flow")
      .length,
    2,
  );
  assert.throws(() => parseCookies("not-a-cookie", "dola"));
  assert.throws(() => parseCookies("[broken", "dola"));
  assert.throws(() =>
    parseCookies('[{"name":"SID","value":"x","domain":".google.com"}]', "dola"),
  );
});

test("Flow cookie imports retain the exact legacy service domain and reject lookalike domains", () => {
  const cookies = parseCookies(JSON.stringify({ cookies: [
    { name: "SID", value: "fixture", domain: ".google.com", secure: true },
    { name: "__Secure-next-auth.session-token", value: "fixture", domain: ".labs.google", httpOnly: true, secure: true },
    { name: "session", value: "unrelated", domain: ".evil-labs.google" },
    { name: "session", value: "unrelated", domain: ".labs.google.example.com" },
    { name: "session", value: "unrelated", domain: ".other.labs.google" },
  ] }), "flow");
  assert.deepEqual(cookies.map((cookie) => cookie.domain), [".google.com", ".labs.google"]);
  assert.equal(cookies[1].httpOnly, true);
  assert.throws(() => parseCookies(JSON.stringify([
    { name: "session", value: "fixture", domain: ".labs.google" },
  ]), "dola"));
});

test("Queues wait for authentication, recover interrupted submission without resending, and require explicit retry", async () => {
  const root = path.resolve(".verification", `state-${randomUUID()}`);
  const store = new Store(root);
  const project = store.createProject("Queue test");
  const queue = new JobQueue(store, null);
  const [job] = queue.enqueueGeneration({
    projectId: project.id,
    provider: "dola",
    model: "Seedance",
    duration: 10,
    ratio: "9:16",
    prompts: ["A white sneaker on a studio pedestal."],
  });
  queue.tick();
  assert.equal(job.status, "queued");
  assert.equal(job.submittedAt, null);
  assert.equal(queue.running.size, 0);
  store.patch("jobs", job.id, {
    status: "rendering",
    submittedAt: new Date().toISOString(),
  });
  await queue.close();
  const restored = new Store(root);
  assert.equal(restored.state.jobs[0].status, "interrupted");
  const second = new JobQueue(restored, null);
  second.tick();
  assert.equal(second.running.size, 0);
  assert.throws(
    () => second.retry(job.id, false),
    (error) => error.code === "CONFIRM_RESUBMIT",
  );
  const retried = second.retry(job.id, true);
  assert.notEqual(retried.id, job.id);
  assert.equal(retried.submittedAt, null);
  second.cancel(retried.id);
  assert.equal(retried.status, "cancelled");
  await second.close();
});

test(
  "Cancellation terminates a running FFmpeg process promptly",
  { timeout: 10000 },
  async () => {
    const controller = new AbortController();
    const start = Date.now();
    const process = runProcess(
      binary("ffmpeg"),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "color=s=320x240:r=30",
        "-t",
        "60",
        "-f",
        "null",
        "-",
      ],
      { signal: controller.signal },
    );
    const timer = setTimeout(() => controller.abort(), 250);
    await assert.rejects(process, (error) => error.code === "CANCELLED");
    clearTimeout(timer);
    assert.ok(Date.now() - start < 4000);
  },
);

test("Local server rejects cross-site and Host spoofing requests; cookie/password data never appears in public state", async () => {
  const studio = await startServer({
    port: 0,
    dataDir: path.resolve(".verification", `http-${randomUUID()}`),
  });
  try {
    const blocked = await fetch(`${studio.address}/api/projects`, {
      method: "POST",
      headers: {
        Origin: "https://example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "invalid" }),
    });
    assert.equal(blocked.status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      http
        .get(
          `${studio.address}/api/state`,
          { headers: { Host: "evil.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        )
        .on("error", reject);
    });
    assert.equal(hostStatus, 403);
    const created = await fetch(`${studio.address}/api/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Cookie test",
        provider: "dola",
        loginMethod: "cookie",
        password: "never-store-this",
        cookies: "never-store-this-either",
      }),
    });
    assert.equal(created.status, 201);
    const state = await (await fetch(`${studio.address}/api/state`)).text();
    assert.equal(state.includes("never-store-this"), false);
    assert.equal(studio.store.state.projects.length, 1);
  } finally {
    await studio.close();
  }
});

test("DreamFace bulk account setup accepts quantity and per-profile proxies, and proxy edits persist", async () => {
  const studio = await startServer({
    port: 0,
    dataDir: path.resolve(".verification", `dreamface-accounts-${randomUUID()}`),
  });
  try {
    const response = await fetch(`${studio.address}/api/accounts/bulk-slots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "dreamface",
        count: 2,
        namePrefix: "Proxy slot",
        proxies: ["127.0.0.1:8080", "socks5://127.0.0.1:1080"],
      }),
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.created, 2);
    assert.deepEqual(created.accounts.map((account) => account.proxy), [
      "http://127.0.0.1:8080",
      "socks5://127.0.0.1:1080",
    ]);
    assert.ok(created.accounts.every((account) => account.status === "needs_login"));
    const noProxyResponse = await fetch(`${studio.address}/api/accounts/bulk-slots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "dreamface", count: 1, namePrefix: "No proxy" }),
    });
    assert.equal(noProxyResponse.status, 201);
    assert.equal((await noProxyResponse.json()).accounts[0].proxy, "");
    const changed = await fetch(`${studio.address}/api/accounts/${created.accounts[0].id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxy: "https://proxy.example:9443" }),
    });
    assert.equal(changed.status, 200);
    const account = await changed.json();
    assert.equal(account.proxy, "https://proxy.example:9443");
    const publicState = await (await fetch(`${studio.address}/api/state`)).json();
    assert.equal(publicState.accounts.find((item) => item.id === account.id).proxy, "https://proxy.example:9443");
    assert.doesNotMatch(JSON.stringify(publicState), /viralstudio\.[a-f0-9]+@gmail\.com.*Aa7!/i);
  } finally {
    await studio.close();
  }
});

test("Gmail signup route is limited to DreamFace profiles", async () => {
  const studio = await startServer({
    port: 0,
    dataDir: path.resolve(".verification", `gmail-route-${randomUUID()}`),
  });
  try {
    const created = await fetch(`${studio.address}/api/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Dola account",
        provider: "dola",
        loginMethod: "google",
        email: "owner@example.com",
      }),
    });
    const account = await created.json();
    const response = await fetch(`${studio.address}/api/accounts/${account.id}/gmail-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "GMAIL_DREAMFACE_ONLY");
  } finally {
    await studio.close();
  }
});

test("Research image hosts are allowed by the local UI content policy", async () => {
  const studio = await startServer({
    port: 0,
    dataDir: path.resolve(".verification", `csp-${randomUUID()}`),
  });
  try {
    const response = await fetch(`${studio.address}/api/state`);
    const policy = response.headers.get("content-security-policy") || "";
    assert.match(policy, /https:\/\/thumb\.wikimedia\.org/);
    assert.match(policy, /https:\/\/ichef\.bbci\.co\.uk/);
  } finally {
    await studio.close();
  }
});

test("Web and desktop discover the same server and cannot overwrite each other with a second store", async () => {
  const directory = path.resolve(".verification", `instance-${randomUUID()}`);
  const first = await startServer({ port: 0, dataDir: directory });
  let second;
  try {
    const live = await findInstance(directory);
    assert.equal(live.address, first.address);
    const project = first.store.createProject(
      "Project survives another window",
    );
    await assert.rejects(
      startServer({ port: 0, dataDir: directory }),
      (error) => error.code === "INSTANCE_RUNNING",
    );
    assert.equal(
      first.store.require("projects", project.id).name,
      "Project survives another window",
    );
    await first.close();
    assert.equal(await findInstance(directory), null);
    second = await startServer({ port: 0, dataDir: directory });
    assert.equal(
      second.store.require("projects", project.id).name,
      "Project survives another window",
    );
  } finally {
    if (first.server.listening) await first.close();
    if (second) await second.close();
  }
});
