import test from "node:test";
import assert from "node:assert/strict";
import { createMetaClient } from "../server/meta.js";
import { classifyMetaFailure, automaticPostRetry } from "../server/meta-errors.js";

test("Graph security diagnostics survive error handling without retaining tokens or the raw body", async () => {
  const token = "private-token-not-for-logs";
  const client = createMetaClient({ fetchImpl: async () => new Response(JSON.stringify({ error: {
    message: `Temporarily blocked ${token}`, code: 368, error_subcode: 1390008, is_transient: false, access_token: token,
  } }), { status: 400, headers: { "retry-after": "300" } }) });
  await assert.rejects(client.startReel({ token, pageId: "123", fileSize: 1 }), error => {
    assert.equal(error.metaError.code, 368);
    assert.equal(error.metaError.subcode, 1390008);
    assert.equal(error.metaError.httpStatus, 400);
    assert.equal(error.metaError.retryAfterSeconds, 300);
    assert.equal(error.message.includes(token), false);
    assert.equal(JSON.stringify(error).includes(token), false);
    assert.equal(classifyMetaFailure(error).retryable, false);
    return true;
  });
});

test("security, expired token and permission errors are not retried even if marked transient", () => {
  for (const [code, kind] of [[368, "security_restriction"], [190, "authentication"], [200, "permission"]]) {
    const result = automaticPostRetry({ message: "Graph rejected request", metaError: { code, isTransient: true } }, 1, Date.now());
    assert.equal(result.blocked, true);
    assert.equal(result.reason, kind);
    assert.equal(result.nextAttemptAt, null);
  }
});

test("legacy Vietnamese security restriction is terminal even without the discarded Graph code", () => {
  const result = classifyMetaFailure({ message: "Vì lý do bảo mật, tài khoản của bạn đã giới hạn quyền truy cập vào trang web trong vài ngày." });
  assert.equal(result.kind, "security_restriction");
  assert.equal(result.retryable, false);
});

test("rate limits honor Retry-After and use a fifteen-minute minimum cooldown", () => {
  const now = Date.parse("2026-10-30T00:00:00Z");
  for (const [retryAfterSeconds, delay] of [[30, 900], [1800, 1800]]) {
    const result = automaticPostRetry({ message: "Too many requests", metaError: { code: 4, httpStatus: 429, retryAfterSeconds } }, 1, now);
    assert.equal(result.blocked, false);
    assert.equal(Date.parse(result.nextAttemptAt) - now, delay * 1000);
  }
});

test("temporary failures back off and stop after three failed calls", () => {
  const now = Date.now();
  const error = { message: "Meta temporarily unavailable", metaError: { code: 2, isTransient: true, httpStatus: 503 } };
  assert.equal(Date.parse(automaticPostRetry(error, 1, now).nextAttemptAt) - now, 60_000);
  assert.equal(Date.parse(automaticPostRetry(error, 2, now).nextAttemptAt) - now, 120_000);
  assert.equal(automaticPostRetry(error, 3, now).reason, "retry_exhausted");
  assert.equal(automaticPostRetry(error, 3, now).nextAttemptAt, null);
});

test("local preflight rejection requires user correction rather than repeated publication", () => {
  assert.equal(classifyMetaFailure({ code: "META_PREFLIGHT_FAILED", message: "Missing media" }).retryable, false);
});
