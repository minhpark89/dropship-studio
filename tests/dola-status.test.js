import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../server/store.js";
import { JobQueue } from "../server/queue.js";
import { dolaQuotaError } from "../server/providers/dola-status.js";

const actualDailyMessage = "You've reached the daily free usage limit for Video generation. You can still chat in Fast Mode.";

test("Dola's actual daily-limit response stops monitoring with a quota reason", () => {
  assert.equal(dolaQuotaError(actualDailyMessage).code, "PROVIDER_QUOTA");
  assert.equal(dolaQuotaError("You have reached the daily free usage limit for Image generation.").code, "PROVIDER_QUOTA");
  assert.equal(dolaQuotaError("Not enough video credits").code, "PROVIDER_QUOTA");
  assert.equal(dolaQuotaError("Your video is generating. You can still chat in Fast Mode."), null);
});

test("A quota-rejected account does not submit the next queued scene automatically", async () => {
  const store = new Store(path.resolve(".verification", `quota-${randomUUID()}`));
  const project = store.createProject("Quota regression");
  const account = store.add("accounts", { name: "Fixture", provider: "dola", status: "ready" });
  let calls = 0;
  const queue = new JobQueue(store, null, {
    intervalMs: 0,
    generate: async () => {
      calls += 1;
      throw dolaQuotaError(actualDailyMessage);
    },
  });
  try {
    const jobs = queue.enqueueGeneration({
      projectId: project.id,
      provider: "dola",
      accountId: account.id,
      model: "Dreamina Seedance 2.0 Fast",
      duration: 4,
      ratio: "9:16",
      prompts: ["First scene", "Second scene"],
    });
    queue.tick();
    const deadline = Date.now() + 2000;
    while (queue.running.size && Date.now() < deadline) await delay(10);
    assert.equal(jobs[0].status, "failed");
    assert.equal(jobs[0].errorCode, "PROVIDER_QUOTA");
    assert.equal(account.status, "error");
    queue.tick();
    assert.equal(calls, 1);
    assert.equal(jobs[1].status, "queued");
  } finally {
    await queue.close();
  }
});
