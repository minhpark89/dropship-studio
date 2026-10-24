import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserProfiles } from "../server/providers/browser-profiles.js";
import { Store } from "../server/store.js";
import { JobQueue } from "../server/queue.js";
import { startServer } from "../server/index.js";
import { providers } from "../shared/contracts.js";

function addAccount(store, provider = "dola", extra = {}) {
  return store.add("accounts", {
    name: provider,
    provider,
    loginMethod: "google",
    proxy: "",
    status: "ready",
    ...extra,
  });
}

function fixture() {
  const root = path.resolve(".verification", `google-profile-${randomUUID()}`);
  return new Store(root);
}

// Only the Chrome process boundary is replaced. Profile locks, aliases,
// account mutation, persistence, and queue scheduling use production methods.
class LocalProfiles extends BrowserProfiles {
  launches = 0;
  reveals = 0;

  async createSession(account, visible) {
    this.launches += 1;
    await delay(5);
    const pages = [];
    const context = {
      pages: () => pages,
      newPage: async () => {
        const page = {
          closed: false,
          address: "about:blank",
          isClosed() { return this.closed; },
          url() { return this.address; },
          setDefaultTimeout() {},
          async close() { this.closed = true; },
          async goto(url) { this.address = url; },
        };
        pages.push(page);
        return page;
      },
    };
    const child = { exitCode: 0 };
    const browser = {
      connected: true,
      isConnected() { return this.connected; },
      async newBrowserCDPSession() {
        return { send: async () => {
          browser.connected = false;
          for (const page of pages) await page.close();
        } };
      },
      async close() { this.connected = false; },
    };
    const session = {
      browser,
      context,
      child,
      visible,
      profileId: this.profileId(account),
      page: await context.newPage(),
    };
    this.profiles.set(session.profileId, session);
    return session;
  }

  async reveal() {
    this.reveals += 1;
  }

  async inspect() {
    return { status: "ready", authStep: "ready", message: "Fixture workspace ready" };
  }
}

test("linked accounts share one browser, retain service tabs, and rebuild aliases when made visible", async (t) => {
  const store = fixture();
  const dola = addAccount(store);
  const flow = addAccount(store, "flow", { profileId: dola.id });
  const profiles = new LocalProfiles(store);
  t.after(() => profiles.closeAll());
  const [a, b] = await Promise.all([profiles.open(dola), profiles.open(flow)]);
  assert.equal(profiles.launches, 1);
  assert.equal(a.context, b.context);
  assert.notEqual(a.page, b.page);
  await a.page.goto("https://www.dola.com/chat/");
  await b.page.goto("https://flow.google.com/");
  await profiles.close(dola.id);
  assert.equal(a.page.isClosed(), true);
  assert.equal(b.page.isClosed(), false);
  assert.equal(b.browser.isConnected(), true);
  const reopened = await profiles.open(dola);
  assert.notEqual(reopened.page, b.page);
  assert.equal(profiles.launches, 1);
  const visible = await profiles.open(flow, { visible: true });
  assert.equal(profiles.launches, 2);
  assert.equal(b.browser.isConnected(), false);
  assert.equal(profiles.sessions.size, 1);
  assert.equal(profiles.sessions.has(dola.id), false);
  assert.equal(visible.visible, true);
  const rebuilt = await profiles.open(dola);
  assert.equal(rebuilt.context, visible.context);
  assert.notEqual(rebuilt.page, visible.page);
  await rebuilt.page.close();
  const repaired = await profiles.open(dola);
  assert.notEqual(repaired.page, visible.page);
  assert.equal(repaired.page.isClosed(), false);
});

test("shared busy sessions cannot be restarted or changed and profile paths are UUID-only", async (t) => {
  const store = fixture();
  const dola = addAccount(store);
  const flow = addAccount(store, "flow", { profileId: dola.id });
  const profiles = new LocalProfiles(store);
  t.after(() => profiles.closeAll());
  const active = await profiles.open(dola);
  dola.status = "busy";
  await assert.rejects(profiles.open(flow, { visible: true }), /Chờ tác vụ/);
  await assert.rejects(profiles.check(flow.id), /đang được sử dụng/);
  await assert.rejects(profiles.importCookies(flow.id, "SID=fixture"), /đang được sử dụng/);
  await assert.rejects(profiles.deleteAccount(flow.id), /đang được sử dụng/);
  assert.equal(active.browser.isConnected(), true);
  assert.equal(profiles.launches, 1);
  await assert.rejects(profiles.open({ ...flow, profileId: "../../outside" }), /không hợp lệ/);
});

test("the queue's own account can promote its idle headless profile when generation starts", async (t) => {
  const store = fixture();
  const account = addAccount(store);
  const profiles = new LocalProfiles(store);
  t.after(() => profiles.closeAll());
  const checked = await profiles.open(account);
  account.status = "busy";
  const generating = await profiles.open(account, { visible: true });
  assert.equal(generating.visible, true);
  assert.equal(profiles.launches, 2);
  assert.equal(checked.browser.isConnected(), false);
  assert.equal(generating.browser.isConnected(), true);
});

test("reuse API flattens profile IDs, validates inputs, and deletion preserves another account's data", async (t) => {
  const server = await startServer({ port: 0, dataDir: fixture().root });
  t.after(() => server.close());
  const { store, browsers } = server;
  browsers.createSession = LocalProfiles.prototype.createSession;
  browsers.inspect = LocalProfiles.prototype.inspect;
  browsers.reveal = LocalProfiles.prototype.reveal;
  browsers.launches = 0;
  browsers.reveals = 0;
  const physicalId = randomUUID();
  const source = addAccount(store, "dola", { profileId: physicalId, proxy: "127.0.0.1:8000" });
  const target = addAccount(store, "flow", { proxy: "http://127.0.0.1:8000/" });
  const original = path.join(store.root, "profiles", target.id);
  const shared = path.join(store.root, "profiles", physicalId);
  fs.mkdirSync(original, { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(original, "preserved.txt"), "prior profile");
  fs.writeFileSync(path.join(shared, "preserved.txt"), "shared profile");
  const post = (body) => fetch(`${server.address}/api/accounts/${target.id}/reuse-google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal((await post({ sourceAccountId: "../../outside" })).status, 400);
  const apple = addAccount(store, "dola", { loginMethod: "apple" });
  assert.equal((await post({ sourceAccountId: apple.id })).status, 400);
  const proxy = addAccount(store, "dola", { proxy: "http://127.0.0.1:9000" });
  assert.equal((await post({ sourceAccountId: proxy.id })).status, 400);
  source.status = "busy";
  assert.equal((await post({ sourceAccountId: source.id })).status, 400);
  source.status = "ready";
  const response = await post({ sourceAccountId: source.id });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profileId, physicalId);
  assert.equal(target.profileId, physicalId);
  assert.equal(target.status, "ready");
  const capabilities = await (await fetch(`${server.address}/api/state`)).json();
  assert.equal(capabilities.capabilities.googleProfileReuse, true);
  const opened = browsers.sessions.get(target.id);
  target.status = "busy";
  const reveal = await fetch(`${server.address}/api/accounts/${target.id}/open`, { method: "POST" });
  assert.equal(reveal.status, 200);
  assert.equal(browsers.sessions.get(target.id), opened);
  assert.equal(opened.browser.isConnected(), true);
  target.status = "ready";
  assert.equal(fs.existsSync(path.join(original, "preserved.txt")), true);
  const persisted = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.equal(persisted.accounts.find((item) => item.id === target.id).profileId, physicalId);
  const ownerDelete = await fetch(`${server.address}/api/accounts/${source.id}`, { method: "DELETE" });
  assert.equal(ownerDelete.status, 200);
  assert.equal((await ownerDelete.json()).profileRetained, true);
  assert.equal(fs.readFileSync(path.join(shared, "preserved.txt"), "utf8"), "shared profile");
  assert.equal(browsers.sessions.get(target.id).browser.isConnected(), true);
  const finalDelete = await fetch(`${server.address}/api/accounts/${target.id}`, { method: "DELETE" });
  assert.equal(finalDelete.status, 200);
  assert.equal((await finalDelete.json()).profileRetained, false);
  assert.equal(fs.existsSync(shared), false);
  assert.equal(fs.existsSync(original), true);
});

async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < end, "Queue transition timed out");
    await delay(10);
  }
}

test("queue serializes Dola and Flow sharing Google while another profile runs independently", async (t) => {
  const store = fixture();
  store.state.settings.concurrency = 3;
  const dola = addAccount(store);
  const flow = addAccount(store, "flow", { profileId: dola.id });
  const independent = addAccount(store);
  const project = store.createProject("Shared profile queue");
  const profiles = new LocalProfiles(store);
  const calls = [];
  const pending = new Map();
  const queue = new JobQueue(store, profiles, {
    intervalMs: 0,
    generate: async (_store, _browsers, job, _account, signal) => {
      calls.push(job.id);
      return new Promise((resolve, reject) => {
        pending.set(job.id, resolve);
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    },
  });
  t.after(() => queue.close());
  const enqueue = (account) => queue.enqueueGeneration({
    projectId: project.id,
    provider: account.provider,
    accountId: account.id,
    model: providers[account.provider].models[0],
    prompts: ["Profile serialization fixture"],
    duration: 8,
    ratio: "16:9",
  })[0];
  const first = enqueue(dola);
  const second = enqueue(flow);
  const third = enqueue(independent);
  profiles.profileOperations.add(dola.id);
  queue.tick();
  assert.deepEqual(calls, [third.id]);
  profiles.profileOperations.delete(dola.id);
  flow.status = "checking";
  queue.tick();
  assert.deepEqual(calls, [third.id]);
  flow.status = "ready";
  queue.tick();
  assert.deepEqual(calls, [third.id, first.id]);
  assert.equal(second.status, "queued");
  pending.get(first.id)({ id: "first-result" });
  await until(() => pending.has(second.id));
  assert.deepEqual(calls, [third.id, first.id, second.id]);
  pending.get(second.id)({ id: "second-result" });
  pending.get(third.id)({ id: "third-result" });
  await until(() => queue.running.size === 0);
  assert.equal(second.status, "completed");
});
