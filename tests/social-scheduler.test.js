import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SocialScheduler } from "../server/social-scheduler.js";
import { normalizeScheduleConfig } from "../server/social.js";

function post(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    status: "scheduled",
    scheduledAt: new Date(Date.now() - 1_000).toISOString(),
    automationAttempts: 0,
    automationNextAttemptAt: null,
    ...overrides,
  };
}

test("page group automation can be switched off explicitly", () => {
  const enabled = normalizeScheduleConfig({ times: ["09:00"], enabled: true, autoPublish: true });
  const disabled = normalizeScheduleConfig({ enabled: false, autoPublish: false }, enabled);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.autoPublish, false);
  assert.deepEqual(disabled.times, ["09:00"]);
});

test("scheduler publishes due posts and waits for in-flight work on close", async () => {
  const due = post();
  const store = { state: { socialPosts: [due] }, save() {} };
  const calls = [];
  const scheduler = new SocialScheduler(store, async (input) => {
    calls.push(input);
    store.state.socialPosts = [];
    return { status: "published" };
  }, { intervalMs: 0 });
  await scheduler.close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].postId, due.id);
  assert.equal(calls[0].idempotencyKey, `schedule:${due.id}:1`);
});

test("scheduler records a retryable Meta error without dropping the post", async () => {
  const due = post();
  const store = { state: { socialPosts: [due] }, save() {} };
  const scheduler = new SocialScheduler(store, async () => { throw new Error("Meta unavailable"); }, { intervalMs: 0 });
  await scheduler.close();
  assert.equal(due.automationStatus, "meta_error");
  assert.equal(due.automationAttempts, 1);
  assert.equal(due.automationError, "Meta unavailable");
  assert.ok(Date.parse(due.automationNextAttemptAt) > Date.now());
});
