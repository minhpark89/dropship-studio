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

test("security failure is attempted once, kept visible, and stays blocked after restart", async () => {
  const due = post();
  const store = { state: { socialPosts: [due] }, save() {} };
  let calls = 0;
  let now = Date.now();
  const publish = async () => {
    calls++;
    const error = new Error("Vì lý do bảo mật, tài khoản của bạn đã giới hạn quyền truy cập vào trang web trong vài ngày.");
    error.metaError = { code: 368, subcode: 1390008, isTransient: false, httpStatus: 400 };
    throw error;
  };
  const scheduler = new SocialScheduler(store, publish, { intervalMs: 0, now: () => now });
  await Promise.all([...scheduler.pending]);
  now += 7 * 86_400_000;
  await scheduler.tick();
  await scheduler.close();
  assert.equal(calls, 1);
  assert.equal(due.automationRetryBlocked, true);
  assert.equal(due.automationAttempts, 1);
  assert.equal(due.automationNextAttemptAt, null);
  assert.equal(due.automationErrorDetails.code, 368);
  assert.equal(store.state.socialPosts.length, 1);
  const restored = { state: JSON.parse(JSON.stringify(store.state)), save() {} };
  const restarted = new SocialScheduler(restored, publish, { intervalMs: 0, now: () => now });
  await restarted.close();
  assert.equal(calls, 1);
});

test("upgrading an old restricted scheduled post makes no additional Meta call", async () => {
  const due = post({ automationAttempts: 9, automationStatus: "meta_error", automationError: "Vì lý do bảo mật, tài khoản của bạn đã giới hạn quyền truy cập vào trang web trong vài ngày." });
  let calls = 0;
  const scheduler = new SocialScheduler({ state: { socialPosts: [due] }, save() {} }, async () => { calls++; }, { intervalMs: 0 });
  await scheduler.close();
  assert.equal(calls, 0);
  assert.equal(due.automationRetryBlocked, true);
  assert.equal(due.automationAttempts, 9);
  assert.equal(due.automationNextAttemptAt, null);
});

test("automatic temporary-error retries stop at three and respect the next-attempt time", async () => {
  const due = post();
  const store = { state: { socialPosts: [due] }, save() {} };
  let now = Date.now(), calls = 0;
  const scheduler = new SocialScheduler(store, async () => { calls++; throw new Error("Network unavailable"); }, { intervalMs: 0, now: () => now });
  await Promise.all([...scheduler.pending]);
  await scheduler.tick();
  assert.equal(calls, 1);
  now = Date.parse(due.automationNextAttemptAt);
  await scheduler.tick();
  assert.equal(calls, 2);
  now = Date.parse(due.automationNextAttemptAt);
  await scheduler.tick();
  now += 86_400_000;
  await scheduler.tick();
  await scheduler.close();
  assert.equal(calls, 3);
  assert.equal(due.automationRetryBlocked, true);
  assert.equal(due.automationBlockedReason, "retry_exhausted");
  assert.equal(due.automationNextAttemptAt, null);
});

test("first-comment security failure is held without resubmitting the video", async () => {
  const due = post();
  let calls = 0;
  const scheduler = new SocialScheduler({ state: { socialPosts: [due] }, save() {} }, async () => {
    calls++;
    return { status: "published_comment_error", externalPostId: "already-published", firstCommentError: "Comment restricted", firstCommentErrorDetails: { code: 368, isTransient: false } };
  }, { intervalMs: 0 });
  await Promise.all([...scheduler.pending]);
  await scheduler.tick();
  await scheduler.close();
  assert.equal(calls, 1);
  assert.equal(due.automationRetryBlocked, true);
  assert.equal(due.automationBlockedReason, "security_restriction");
});
