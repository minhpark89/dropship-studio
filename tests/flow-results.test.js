import test from "node:test";
import assert from "node:assert/strict";
import { createFlowResultTracker } from "../server/providers/flow-results.js";

const prompt = "A white shoe turns slowly on a pedestal.";
const generateUrl = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText";
const pollUrl = "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus";
const rpcUrl = "https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute";
const correct = "https://media.invalid/current-video.mp4?signature=fixture";
const unrelated = "https://media.invalid/unrelated-video.mp4";

function request(url = generateUrl, payload = { requests: [{ textInput: { prompt } }] }, method = "POST") {
  return {
    url: () => url,
    method: () => method,
    postData: () => typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

function response(source, data, status = 200) {
  return {
    request: () => source,
    status: () => status,
    text: async () => typeof data === "string" ? data : JSON.stringify(data),
  };
}

function rpcRequest(...calls) {
  return request(rpcUrl, new URLSearchParams({
    "f.req": JSON.stringify([calls.map(([id, payload]) => [id, JSON.stringify(payload), null, "generic"])]),
  }).toString());
}

function rpcResponse(source, ...calls) {
  return response(source, ")]}'\n\n" + JSON.stringify(calls.map(([id, data]) => ["wrb.fr", id, JSON.stringify(data), null, null, null])));
}

function harness(kind = "video", callback) {
  const accepted = [];
  const tracker = createFlowResultTracker({
    prompt,
    kind,
    onAccepted: callback || ((metadata) => accepted.push(metadata)),
  });
  return { tracker, accepted };
}

async function acknowledge(tracker, source = request()) {
  tracker.observeRequest(source);
  await tracker.observeResponse(response(source, { operations: [{ operation: { name: "operations/current" } }] }));
  return source;
}

test("binds an armed exact-prompt request, persists IDs, then only downloads its operation", async () => {
  const { tracker, accepted } = harness();
  tracker.arm();
  await acknowledge(tracker);
  assert.deepEqual(accepted, [{ providerMediaIds: [], providerOperationIds: ["operations/current"] }]);
  const poll = request(pollUrl, { operations: [{ name: "operations/current" }, { name: "operations/other" }] });
  tracker.observeRequest(poll);
  await tracker.observeResponse(response(poll, { operations: [
    { operation: { name: "operations/other" }, mediaId: "other-media", video: { fifeUrl: unrelated } },
    { operation: { name: "operations/current" }, mediaId: "current-media", video: { fifeUrl: correct } },
  ] }));
  assert.deepEqual(tracker.takeCandidates(), [correct]);
  assert.deepEqual(tracker.takeCandidates(), []);
  assert.deepEqual(accepted.at(-1), { providerMediaIds: ["current-media"], providerOperationIds: ["operations/current"] });
  assert.equal(tracker.error, null);
});

test("ignores delayed responses to requests observed before arming and responses never observed", async () => {
  const { tracker, accepted } = harness();
  const old = request();
  tracker.observeRequest(old);
  tracker.arm();
  await tracker.observeResponse(response(old, { media: [{ mediaId: "old", video: { url: unrelated } }] }));
  await tracker.observeResponse(response(request(), { media: [{ mediaId: "unknown", video: { url: unrelated } }] }));
  assert.deepEqual(accepted, []);
  assert.deepEqual(tracker.takeCandidates(), []);
  assert.equal(tracker.error, null);
});

test("ignores another prompt, substring matches, upload requests and lookalike hosts", async () => {
  const { tracker, accepted } = harness();
  tracker.arm();
  const bad = [
    request(generateUrl, { prompt: prompt + " Different ending." }),
    request(generateUrl, { prompt: "Different prompt", note: prompt }),
    request("https://flow.google.com/upload", { prompt }),
    request(generateUrl.replace("aisandbox-pa.googleapis.com", "aisandbox-pa.googleapis.com.attacker.invalid")),
    request(generateUrl.replace("https:", "http:")),
  ];
  for (const source of bad) {
    tracker.observeRequest(source);
    await tracker.observeResponse(response(source, { media: [{ mediaId: "wrong", video: { url: unrelated } }] }));
  }
  assert.deepEqual(accepted, []);
  await acknowledge(tracker);
  assert.equal(accepted.length, 1);
});

test("matching media ID is required within the same project; uploaded references and previews are excluded", async () => {
  const { tracker, accepted } = harness();
  tracker.arm();
  const source = request();
  tracker.observeRequest(source);
  await tracker.observeResponse(response(source, {
    mediaIds: ["current-media"],
    projectId: "same-project",
    references: [{ mediaId: "uploaded-reference", videoUrl: unrelated }],
  }));
  const poll = request(pollUrl, { mediaIds: ["current-media", "other-media"] });
  tracker.observeRequest(poll);
  await tracker.observeResponse(response(poll, {
    projectId: "same-project",
    media: [
      { mediaId: "other-media", video: { url: unrelated } },
      { mediaId: "uploaded-reference", video: { url: unrelated } },
      { mediaId: "current-media", thumbnail: { videoUrl: unrelated }, preview: { videoUrl: unrelated }, video: { url: correct } },
    ],
  }));
  assert.deepEqual(tracker.takeCandidates(), [correct]);
  assert.deepEqual(accepted.at(-1).providerMediaIds, ["current-media"]);
});

test("same media ID under another operation cannot escape the operation boundary", async () => {
  const { tracker } = harness();
  tracker.arm();
  const source = request();
  tracker.observeRequest(source);
  await tracker.observeResponse(response(source, { operations: [{ operationId: "operation-current", mediaId: "current-media" }] }));
  const poll = request(pollUrl, { operationIds: ["operation-current"] });
  tracker.observeRequest(poll);
  await tracker.observeResponse(response(poll, { operations: [
    { operationId: "operation-other", mediaId: "current-media", videoUrl: unrelated },
    { operationId: "operation-current", mediaId: "current-media", videoUrl: correct },
  ] }));
  assert.deepEqual(tracker.takeCandidates(), [correct]);
});

test("decodes named RPC envelopes and ignores other RPC records in the same batch", async () => {
  const { tracker, accepted } = harness();
  tracker.arm();
  const source = rpcRequest(
    ["generate-fixture", { action: "generateVideo", requests: [{ textInput: { prompt } }] }],
    ["unrelated-rpc", { action: "getProject", projectId: "project" }],
  );
  tracker.observeRequest(source);
  await tracker.observeResponse(rpcResponse(source,
    ["unrelated-rpc", { media: [{ mediaId: "other", videoUrl: unrelated }] }],
    ["generate-fixture", { operationIds: ["operation-current"] }],
  ));
  const poll = rpcRequest(["poll-fixture", { action: "checkStatus", operationIds: ["operation-current"] }]);
  tracker.observeRequest(poll);
  await tracker.observeResponse(rpcResponse(poll, ["poll-fixture", { operations: [
    { operationId: "operation-current", video: { url: correct }, mediaId: "current-media" },
    { operationId: "operation-other", video: { url: unrelated } },
  ] }]));
  assert.deepEqual(tracker.takeCandidates(), [correct]);
  assert.deepEqual(accepted.at(-1), { providerMediaIds: ["current-media"], providerOperationIds: ["operation-current"] });
});

test("unknown positional RPC requests and UUID/URL arrays cannot become ownership evidence", async () => {
  const { tracker, accepted } = harness();
  tracker.arm();
  const opaque = rpcRequest(["unknown-positional", [prompt, null, "uuid-like-project"]]);
  tracker.observeRequest(opaque);
  await tracker.observeResponse(rpcResponse(opaque, ["unknown-positional", ["f0562bd5-ea9b-4f2d-9975-cb0091ec9310", correct]]));
  assert.deepEqual(accepted, []);
  assert.deepEqual(tracker.takeCandidates(), []);
  const source = request();
  tracker.observeRequest(source);
  await tracker.observeResponse(response(source, ["f0562bd5-ea9b-4f2d-9975-cb0091ec9310", correct]));
  assert.equal(tracker.error.code, "PROVIDER_RESULT_UNRECOGNIZED");
  assert.deepEqual(tracker.takeCandidates(), []);
});

test("HTTP/RPC authentication failures are scoped to this submission and never echo provider secrets", async () => {
  for (const rpc of [false, true]) {
    const { tracker } = harness();
    tracker.arm();
    const source = rpc ? rpcRequest(["generate-fixture", { action: "generateVideo", prompt }]) : request();
    tracker.observeRequest(source);
    const body = rpc ? ")]}'\n[[\"er\",null,null,null,null,401]]" : { error: { code: 401, message: "secret-cookie=fixture" } };
    await tracker.observeResponse(response(source, body, rpc ? 200 : 401));
    assert.equal(tracker.error.code, "NEEDS_LOGIN");
    assert.doesNotMatch(tracker.error.message, /secret-cookie/);
    assert.deepEqual(tracker.takeCandidates(), []);
  }
});

test("an unrelated poll failure cannot fail the current operation", async () => {
  const { tracker } = harness();
  tracker.arm();
  await acknowledge(tracker);
  const unrelatedPoll = request(pollUrl, { operations: [{ name: "operations/other" }] });
  tracker.observeRequest(unrelatedPoll);
  await tracker.observeResponse(response(unrelatedPoll, { error: { code: 401 } }, 401));
  assert.equal(tracker.error, null);
  const ownPoll = request(pollUrl, { operations: [{ name: "operations/current" }] });
  tracker.observeRequest(ownPoll);
  await tracker.observeResponse(response(ownPoll, { error: { code: 401 } }, 401));
  assert.equal(tracker.error.code, "NEEDS_LOGIN");
});

test("persists correlation before publishing a candidate, and blocks downloads on persistence failure", async () => {
  let release;
  const persisted = new Promise((resolve) => { release = resolve; });
  const { tracker } = harness("video", () => persisted);
  tracker.arm();
  const source = request();
  tracker.observeRequest(source);
  const pending = tracker.observeResponse(response(source, { media: [{ mediaId: "current-media", videoUrl: correct }] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tracker.takeCandidates(), []);
  release();
  await pending;
  assert.deepEqual(tracker.takeCandidates(), [correct]);

  const failed = harness("video", () => { throw new Error("secret write path"); }).tracker;
  failed.arm();
  const failedSource = request();
  failed.observeRequest(failedSource);
  await failed.observeResponse(response(failedSource, { media: [{ mediaId: "current-media", videoUrl: correct }] }));
  assert.equal(failed.error.code, "PROVIDER_RESULT_UNRECOGNIZED");
  assert.doesNotMatch(failed.error.message, /secret write path/);
  assert.deepEqual(failed.takeCandidates(), []);
});

test("image results exclude videos, thumbnails, unsafe URLs and duplicate responses", async () => {
  const { tracker, accepted } = harness("image");
  tracker.arm();
  const source = request("https://aisandbox-pa.googleapis.com/v1/images:batchGenerateImages");
  tracker.observeRequest(source);
  const output = response(source, { media: [{
    mediaId: "image-current",
    image: { generatedImage: { fifeUrl: "https://media.invalid/original.png" } },
    video: { url: unrelated },
    thumbnail: { imageUrl: unrelated },
    imageUrl: "javascript:alert(1)",
  }] });
  await tracker.observeResponse(output);
  await tracker.observeResponse(output);
  assert.deepEqual(tracker.takeCandidates(), ["https://media.invalid/original.png"]);
  assert.equal(accepted.length, 1);
  assert.throws(() => tracker.arm(), /cannot be rearmed/);
});
