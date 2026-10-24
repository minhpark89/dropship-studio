import test from "node:test";
import assert from "node:assert/strict";
import { decodeFlowRpc, flowResponseError } from "../server/providers/flow-rpc.js";

function framed(...chunks) {
  return ")]}'\n\n" + chunks.map((chunk) => {
    const text = JSON.stringify(chunk);
    return `${Buffer.byteLength(text, "utf8")}\n${text}\n`;
  }).join("");
}

function result(data, errorCode = null) {
  return framed([["wrb.fr", "fixtureRpc", JSON.stringify(data), null, null, errorCode, "generic"]]);
}

test("decodes the observed 401 envelope and ignores its numeric telemetry", () => {
  const observed = ")]}'\n\n105\n[[\"er\",null,null,null,null,401,null,null,null,16],[\"di\",15],[\"af.httprm\",14,\"-9136599403888129909\",62]]\n25\n[[\"e\",4,null,null,141]]\n";
  assert.deepEqual(decodeFlowRpc(observed), [{ rpcId: null, data: null, errorCode: 401 }]);
  assert.equal(flowResponseError(401, observed).code, "NEEDS_LOGIN");
  assert.equal(flowResponseError(200, observed).code, "NEEDS_LOGIN");
});

test("handles multiple UTF-8 frames, nested JSON boundaries, and unframed pretty JSON", () => {
  const data = { media: { id: "fixture-media" }, prompt: '["Giữ nguyên chuỗi JSON"]' };
  const source = framed(
    [["wrb.fr", "firstRpc", JSON.stringify(JSON.stringify(data)), null, null, null]],
    [["di", 401], ["wrb.fr", "secondRpc", JSON.stringify(["Tiếng Việt", 3]), null, null, 0]],
  );
  assert.deepEqual(decodeFlowRpc(source), [
    { rpcId: "firstRpc", data, errorCode: null },
    { rpcId: "secondRpc", data: ["Tiếng Việt", 3], errorCode: null },
  ]);
  assert.equal(flowResponseError(200, source), null);
  assert.deepEqual(
    decodeFlowRpc(JSON.stringify([["wrb.fr", "pretty", JSON.stringify(data)]], null, 2)),
    [{ rpcId: "pretty", data, errorCode: null }],
  );
});

test("retains complete records before a truncated final chunk and never throws on malformed input", () => {
  const first = result({ done: true });
  assert.deepEqual(decodeFlowRpc(first + '900\n[["wrb.fr","partial",'), [
    { rpcId: "fixtureRpc", data: { done: true }, errorCode: null },
  ]);
  for (const value of [null, undefined, 42, "", ")]}'\n", "not json", "[["] ) {
    assert.deepEqual(decodeFlowRpc(value), []);
    assert.equal(flowResponseError(200, value), null);
  }
  assert.equal(flowResponseError(401, "non-json HTML").code, "NEEDS_LOGIN");
  assert.equal(flowResponseError(503, "non-json HTML").code, "PROVIDER_REJECTED");
});

test("does not interpret telemetry or payload-internal transport-like arrays as an RPC failure", () => {
  const telemetry = framed([["di", 401], ["af.httprm", 429, "UNUSUAL_ACTIVITY", 403], ["e", 16]]);
  assert.deepEqual(decodeFlowRpc(telemetry), []);
  assert.equal(flowResponseError(200, telemetry), null);
  const data = { example: ["er", "not-a-transport-record", null, null, null, 401] };
  assert.deepEqual(decodeFlowRpc(result(data)), [{ rpcId: "fixtureRpc", data, errorCode: null }]);
});

test("preserves HTTP/RPC status failures including gRPC unauthenticated and exhausted codes", () => {
  const cases = [
    [401, "NEEDS_LOGIN"],
    [403, "PROVIDER_REJECTED"],
    [429, "PROVIDER_REJECTED"],
    [16, "NEEDS_LOGIN"],
    [7, "PROVIDER_REJECTED"],
    [8, "PROVIDER_REJECTED"],
  ];
  for (const [status, code] of cases) {
    const body = framed([["er", "failedRpc", null, null, null, status]]);
    assert.equal(decodeFlowRpc(body)[0].errorCode, status);
    assert.equal(flowResponseError(200, body).code, code);
  }
  assert.equal(flowResponseError(200, result(null, [16])).code, "NEEDS_LOGIN");
  assert.match(flowResponseError(429, result({ error: { code: 400 } })).message, /giới hạn|hạn mức/);
});

test("recognizes structured JSON and RPC errors inside HTTP 200 responses", () => {
  const cases = [
    [{ error: { code: 401, status: "UNAUTHENTICATED" } }, "NEEDS_LOGIN"],
    [{ error: { code: 403, details: [{ reason: "UNUSUAL_ACTIVITY" }] } }, "VERIFICATION"],
    [{ error: { status: "RESOURCE_EXHAUSTED" } }, "PROVIDER_REJECTED"],
    [{ errorCode: 429 }, "PROVIDER_REJECTED"],
    [{ errors: [{ reason: "SAFETY_FILTERED" }] }, "PROVIDER_REJECTED"],
  ];
  for (const [data, code] of cases) {
    assert.equal(flowResponseError(200, JSON.stringify(data)).code, code);
    assert.equal(flowResponseError(200, result(data)).code, code);
  }
});

test("specific verification and credit reasons take precedence over generic permission errors", () => {
  const verification = result({ error: { code: 403, reason: "RECAPTCHA_FAILED" } }, 403);
  assert.equal(flowResponseError(403, verification).code, "VERIFICATION");
  const credit = result({ error: { code: 403, reason: "INSUFFICIENT_CREDITS" } }, 403);
  assert.match(flowResponseError(403, credit).message, /không đủ tín dụng/);
  assert.equal(flowResponseError(401, verification).code, "NEEDS_LOGIN");
});

test("safe errors never echo provider messages, URLs, cookies, or opaque tokens", () => {
  const secret = "fixture-private-token-do-not-display";
  const data = {
    error: {
      code: 403,
      message: `UNUSUAL_ACTIVITY token=${secret} https://private.invalid/?cookie=${secret}`,
    },
  };
  const error = flowResponseError(200, result(data));
  assert.equal(error.code, "VERIFICATION");
  assert.doesNotMatch(JSON.stringify(error), /fixture-private|private\.invalid|cookie=/);
  assert.deepEqual(Object.keys(error), ["code", "message"]);
});

test("successful prompts, generated text, and URLs containing error-like words stay successful", () => {
  const data = {
    prompt: "UNUSUAL_ACTIVITY",
    text: "Explain UNAUTHENTICATED and INSUFFICIENT_CREDITS in an animation.",
    media: { url: "https://media.invalid/UNUSUAL_ACTIVITY?signature=401" },
    status: "COMPLETE",
    count: 429,
  };
  assert.equal(flowResponseError(200, JSON.stringify(data)), null);
  assert.equal(flowResponseError(200, result(data)), null);
  assert.equal(flowResponseError(200, "UNUSUAL_ACTIVITY in an unrelated non-JSON body"), null);
});
