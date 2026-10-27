import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { generateImageEndpoint, ensureNewsMcImage } from "../server/mc-image.js";
import { Store } from "../server/store.js";
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

test("news plans use a neutral news label by default", () => {
  const plan = newsPlanSchema.parse({
    headline: "A verified news update",
    narration: "Officials confirmed a new development today as investigators review the available evidence and publish more details.",
    imageMediaIds: [randomUUID()],
  });
  assert.equal(plan.brand, "NEWS UPDATE");
});

test("news batches reuse the saved MC still for later DreamFace videos", async (t) => {
  const root = path.resolve(".verification", `mc-reuse-${randomUUID()}`);
  const store = new Store(root);
  const image = store.add("media", { kind: "image", file: "mc.png", projectId: null });
  const account = store.add("accounts", {
    name: "DreamFace reuse",
    provider: "dreamface",
    avatarMediaId: image.id,
    avatarSource: "highlight-endpoint",
  });
  const job = { id: randomUUID(), payload: {} };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reused = await ensureNewsMcImage(store, {}, job, account, {}, new AbortController().signal);
  assert.equal(reused.id, image.id);
});
