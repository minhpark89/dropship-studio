import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
import { DreamFaceSetupQueue } from "../server/dreamface-setup.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vs-setup-"));
  const store = new Store(root);
  const accounts = ["Alpha", "Beta"].map((name) => store.add("accounts", {
    name,
    provider: "dreamface",
    loginMethod: "credentials",
    status: "needs_login",
    gmailStatus: "idle",
  }));
  const calls = [];
  const closed = [];
  const provider = {
    captchaSettings: () => ({ enabled: true, autoSolveDreamFace: true, apiKey: "a".repeat(32) }),
    login: async (account, credentials, options = {}) => {
      calls.push({ name: account.name, visible: options.visible === true, hasCredentials: Boolean(credentials.email) });
      return { status: "ready", authStep: "ready", message: `${account.name} ready` };
    },
    close: async (account) => { closed.push(account.name); },
    sessions: new Map(),
  };
  return { root, store, accounts, calls, closed, provider };
}

async function waitForIdle(queue, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (queue.running || queue.pending.length) {
    if (Date.now() > deadline) throw new Error("setup queue did not finish");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("setup queue signs profiles in hidden, one at a time, closes them and marks ready", async () => {
  const { root, store, accounts, calls, closed, provider } = fixture();
  const queue = new DreamFaceSetupQueue({ store, dreamface: provider });
  const status = queue.enqueue(accounts);
  assert.equal(status.queued, 2);
  await waitForIdle(queue);

  assert.deepEqual(calls.map((call) => call.name), ["Alpha", "Beta"]);
  assert.equal(calls.every((call) => call.visible === false), true);
  assert.equal(calls.every((call) => call.hasCredentials), true);
  assert.deepEqual(closed, ["Alpha", "Beta"]);
  assert.deepEqual(store.state.accounts.map((account) => account.status), ["ready", "ready"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("setup queue waits for a hidden profile to become ready instead of opening a window", async () => {
  const { root, store, accounts, calls, closed, provider } = fixture();
  provider.login = async (account, credentials, options = {}) => {
    calls.push({ name: account.name, visible: options.visible === true });
    if (account.name === "Alpha") {
      provider.sessions.set(account.id, { page: { isClosed: () => false } });
      return { status: "verification", authStep: "captcha", message: "CAPTCHA" };
    }
    return { status: "ready", authStep: "ready", message: "ready" };
  };
  provider.inspect = async (account) => ({ status: "ready", authStep: "ready", message: `${account.name} verified` });
  const queue = new DreamFaceSetupQueue({ store, dreamface: provider, manualWaitMs: 1000, pollMs: 5 });
  queue.enqueue(accounts);
  await waitForIdle(queue);

  assert.deepEqual(calls, [
    { name: "Alpha", visible: false },
    { name: "Beta", visible: false },
  ]);
  assert.deepEqual(closed, ["Alpha", "Beta"]);
  assert.deepEqual(store.state.accounts.map((account) => account.status), ["ready", "ready"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("setup queue runs as many hidden Chrome lanes as requested", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vs-setup-"));
  const store = new Store(root);
  const accounts = ["One", "Two", "Three", "Four"].map((name) => store.add("accounts", {
    name,
    provider: "dreamface",
    loginMethod: "credentials",
    status: "needs_login",
    gmailStatus: "idle",
  }));
  let active = 0;
  let peak = 0;
  const provider = {
    captchaSettings: () => ({ enabled: true, autoSolveDreamFace: true, apiKey: "a".repeat(32) }),
    login: async (account) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { status: "ready", authStep: "ready", message: `${account.name} ready` };
    },
    close: async () => {},
    sessions: new Map(),
  };
  const queue = new DreamFaceSetupQueue({ store, dreamface: provider });
  const status = queue.enqueue(accounts, { concurrency: 2 });
  assert.equal(status.concurrency, 2);
  await waitForIdle(queue);

  assert.equal(peak, 2);
  assert.equal(store.state.accounts.every((account) => account.status === "ready"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("setup queue skips a profile that is already busy", () => {
  const { root, store, accounts, provider } = fixture();
  store.patch("accounts", accounts[0].id, { status: "busy" });
  const queue = new DreamFaceSetupQueue({ store, dreamface: provider });
  const status = queue.enqueue([accounts[0]]);
  assert.equal(status.queued, 0);
  assert.equal(queue.running, false);
  fs.rmSync(root, { recursive: true, force: true });
});
