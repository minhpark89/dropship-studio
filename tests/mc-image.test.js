import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateImageEndpoint } from "../server/mc-image.js";
import { newsPlanSchema } from "../server/news-plan.js";

test("AI MC image generation accepts the Highlight-compatible base64 response without leaking credentials", async () => {
  const bytes = Buffer.alloc(1400, 7);
  let request;
  const output = await generateImageEndpoint({
    config: { endpoint: "https://image.example/v1/images/generations", apiKey: "secret-token", model: "test-image" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: bytes.toString("base64") }] }),
      };
    },
    signal: new AbortController().signal,
  });
  assert.equal(output.extension, ".png");
  assert.equal(output.bytes.length, bytes.length);
  assert.equal(request.url, "https://image.example/v1/images/generations");
  assert.equal(request.options.headers.authorization, "Bearer secret-token");
  assert.doesNotMatch(JSON.stringify(output), /secret-token/);
  assert.equal(JSON.parse(request.options.body).model, "test-image");
});

test("news plans use BBC for the red broadcast label by default", () => {
  const plan = newsPlanSchema.parse({
    headline: "A verified news update",
    narration: "Officials confirmed a new development today as investigators review the available evidence and publish more details.",
    imageMediaIds: [randomUUID()],
  });
  assert.equal(plan.brand, "BBC");
});
