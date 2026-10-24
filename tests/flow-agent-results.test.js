import test from "node:test";
import assert from "node:assert/strict";
import { createFlowAgentResultTracker } from "../server/providers/flow-agent-results.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const contextId = "22222222-2222-2222-2222-222222222222";
const prompt = "A matte black bottle on a green pedestal";

function request(body) {
  return {
    url: () => "https://flow.google.com/FlowCreationAgentService/StreamChat",
    postData: () => body,
  };
}

function response(text, path = "/data/batchexecute") {
  return {
    url: () => `https://flow.google.com${path}`,
    status: () => 200,
    text: async () => text,
  };
}

test("Flow Agent waits for approval and correlates a media URL to the prompt context", async () => {
  const accepted = [];
  const tracker = createFlowAgentResultTracker({
    prompt,
    projectId,
    onAccepted: (value) => accepted.push(value),
  });
  tracker.arm();
  tracker.observeRequest(request(prompt));
  await tracker.observeResponse(response(`${projectId} ${contextId} ${prompt}`));
  assert.equal(accepted.length, 0);
  assert.deepEqual(tracker.takeCandidates(), []);

  tracker.observeRequest(request('["Approve"]'));
  await tracker.observeResponse(response(`${contextId} https://flow-content.google/generated/video.mp4`));
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].providerMediaIds, []);
  assert.deepEqual(accepted[0].providerOperationIds, [contextId]);
  assert.deepEqual(tracker.takeCandidates(), ["https://flow-content.google/generated/video.mp4"]);
});

test("Flow Agent ignores unrelated hosts and contexts", async () => {
  const accepted = [];
  const tracker = createFlowAgentResultTracker({ prompt, projectId, onAccepted: (value) => accepted.push(value) });
  tracker.arm();
  tracker.observeRequest(request(prompt));
  await tracker.observeResponse(response(`${projectId} ${contextId} ${prompt}`));
  tracker.observeRequest(request('["Approve"]'));
  await tracker.observeResponse(response(`${contextId} https://example.com/video.mp4`));
  assert.equal(accepted.length, 0);
  assert.deepEqual(tracker.takeCandidates(), []);
});
