import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../server/store.js";
import { JobQueue } from "../server/queue.js";
import { binary, runProcess, importMedia, probe } from "../server/media.js";

function fixture() {
  const store = new Store(path.resolve(".verification", `queue-${randomUUID()}`));
  const project = store.createProject("Queue verification");
  const accounts = ["A", "B"].map((name) => store.add("accounts", {
    name,
    provider: "dola",
    status: "ready",
  }));
  return { store, project, accounts };
}

function enqueue(queue, project, prompts, extra = {}) {
  return queue.enqueueGeneration({
    projectId: project.id,
    provider: "dola",
    model: "Dreamina Seedance 2.0 Fast",
    duration: 4,
    ratio: "16:9",
    prompts,
    ...extra,
  });
}

async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Queue did not reach the expected state");
    await delay(10);
  }
}

test("DreamFace generation is routed through its authenticated provider runner", async (t) => {
  const store = new Store(path.resolve(".verification", `queue-dreamface-${randomUUID()}`));
  const project = store.createProject("DreamFace queue verification");
  const account = store.add("accounts", { name: "DreamFace", provider: "dreamface", status: "ready" });
  let called = 0;
  const queue = new JobQueue(store, null, {
    intervalMs: 0,
    generateDreamFace: async (_store, job, selected, _signal, update) => {
      called += 1;
      assert.equal(job.payload.provider, "dreamface");
      assert.equal(selected.id, account.id);
      update({ submittedAt: new Date().toISOString() });
      return { id: "dreamface-media" };
    },
  });
  t.after(() => queue.close());
  const [job] = queue.enqueueGeneration({
    projectId: project.id,
    provider: "dreamface",
    accountId: account.id,
    model: "DreamFace video",
    duration: 5,
    ratio: "9:16",
    prompts: ["A calm product reveal"],
  });
  queue.tick();
  await until(() => queue.running.size === 0);
  assert.equal(called, 1);
  assert.equal(job.status, "completed");
  assert.equal(job.mediaId, "dreamface-media");
});

test("automatic DreamFace selection rotates by least recently used profile", async (t) => {
  const store = new Store(path.resolve(".verification", `queue-dreamface-rotation-${randomUUID()}`));
  const project = store.createProject("DreamFace rotation verification");
  const older = store.add("accounts", {
    name: "DreamFace older",
    provider: "dreamface",
    status: "ready",
    rotationIndex: 2,
    lastUsedAt: "2020-01-01T00:00:00.000Z",
  });
  const newer = store.add("accounts", {
    name: "DreamFace newer",
    provider: "dreamface",
    status: "ready",
    rotationIndex: 1,
    lastUsedAt: "2021-01-01T01:00:00.000Z",
  });
  const calls = [];
  const queue = new JobQueue(store, null, {
    intervalMs: 0,
    generateDreamFace: async (_store, _job, account) => {
      calls.push(account.id);
      return { id: `media-${account.id}` };
    },
  });
  t.after(() => queue.close());
  const [first] = queue.enqueueGeneration({
    projectId: project.id,
    provider: "dreamface",
    accountId: "auto",
    model: "DreamFace video",
    duration: 5,
    ratio: "9:16",
    prompts: ["First rotation"],
  });
  queue.tick();
  await until(() => queue.running.size === 0);
  const [second] = queue.enqueueGeneration({
    projectId: project.id,
    provider: "dreamface",
    accountId: "auto",
    model: "DreamFace video",
    duration: 5,
    ratio: "9:16",
    prompts: ["Second rotation"],
  });
  queue.tick();
  await until(() => queue.running.size === 0);
  assert.deepEqual(calls, [older.id, newer.id]);
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.ok(store.require("accounts", older.id).lastUsedAt);
});

test("pause, persisted schedules, concurrency and per-account serialization", async (t) => {
  const { store, project, accounts } = fixture();
  let now = Date.parse("2030-01-01T00:00:00Z");
  const calls = [];
  const pending = new Map();
  const queue = new JobQueue(store, null, {
    intervalMs: 0,
    now: () => now,
    generate: async (_store, _browsers, job, account, signal) => {
      calls.push({ id: job.id, account: account.id });
      return new Promise((resolve, reject) => {
        pending.set(job.id, resolve);
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    },
  });
  t.after(() => queue.close());
  const [a1, a2] = enqueue(queue, project, ["A1", "A2"], { accountId: accounts[0].id });
  const [b1] = enqueue(queue, project, ["B1"], { accountId: accounts[1].id });
  const [future] = enqueue(queue, project, ["Future"], {
    accountId: accounts[0].id,
    scheduledAt: new Date(now + 60000).toISOString(),
  });
  const [cancelled] = enqueue(queue, project, ["Cancelled"]);
  queue.cancel(cancelled.id);
  store.state.settings.queuePaused = true;
  queue.tick();
  assert.equal(calls.length, 0);
  store.state.settings.queuePaused = false;
  queue.tick();
  assert.deepEqual(calls.map((call) => call.id), [a1.id, b1.id]);
  assert.equal(a2.status, "queued");
  store.state.settings.queuePaused = true;
  pending.get(a1.id)({ id: "asset-a1" });
  await until(() => !queue.running.has(a1.id));
  assert.equal(calls.length, 2);
  store.state.settings.queuePaused = false;
  queue.tick();
  assert.equal(calls[2].id, a2.id);
  pending.get(a2.id)({ id: "asset-a2" });
  pending.get(b1.id)({ id: "asset-b1" });
  await until(() => queue.running.size === 0);
  assert.equal(future.status, "scheduled");
  assert.equal(cancelled.status, "cancelled");
  await queue.close();
  const restored = new Store(store.root);
  let resumedCalls = 0;
  const resumed = new JobQueue(restored, null, {
    intervalMs: 0,
    now: () => now,
    generate: async () => {
      resumedCalls += 1;
      return { id: "future-asset" };
    },
  });
  t.after(() => resumed.close());
  resumed.tick();
  assert.equal(resumedCalls, 0);
  now += 60000;
  resumed.tick();
  await until(() => resumed.running.size === 0);
  resumed.tick();
  assert.equal(resumedCalls, 1);
  assert.equal(restored.require("jobs", future.id).status, "completed");
});

test("assembly validation and export failures never retry completed AI work", async (t) => {
  const { store, project } = fixture();
  const asset = store.add("media", { kind: "audio", duration: 1 });
  let generated = 0;
  let rendered = 0;
  const queue = new JobQueue(store, null, {
    intervalMs: 0,
    generate: async () => {
      generated += 1;
      return asset;
    },
    render: async () => {
      rendered += 1;
      if (rendered === 1) throw new Error("disk export failure");
      return { id: "rendered-media" };
    },
  });
  t.after(() => queue.close());
  const [scene] = enqueue(queue, project, ["Scene"], { autoAssemble: true });
  queue.tick();
  await until(() => queue.running.size === 0);
  const failed = store.state.jobs.find((job) => job.type === "render");
  assert.equal(scene.status, "completed");
  assert.equal(scene.mediaId, asset.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "ASSEMBLY_FAILED");
  assert.throws(() => queue.retry(scene.id, true));
  store.patch("media", asset.id, { kind: "image" });
  const retry = queue.retry(failed.id, false);
  assert.throws(() => queue.retry(failed.id, false), { code: "ALREADY_RETRIED" });
  queue.tick();
  await until(() => queue.running.size === 0);
  assert.equal(retry.status, "failed");
  assert.equal(scene.status, "completed");
  const success = queue.retry(retry.id, false);
  queue.tick();
  await until(() => queue.running.size === 0);
  assert.equal(success.status, "completed");
  assert.equal(scene.assembled, success.id);
  assert.equal(generated, 1);
  assert.equal(rendered, 2);
});

test("retry replaces the failed middle scene and FFmpeg preserves batch order", { timeout: 120000 }, async (t) => {
  const { store, project } = fixture();
  const ffmpeg = binary("ffmpeg", store.state.settings);
  const colors = ["red", "lime", "blue"];
  const assets = [];
  for (const color of colors) {
    const file = path.join(store.root, `${color}.mp4`);
    await runProcess(ffmpeg, [
      "-y", "-v", "error", "-f", "lavfi", "-i",
      `color=c=${color}:s=160x90:r=30:d=0.5`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
    ]);
    assets.push(await importMedia(store, file, { projectId: project.id }));
  }
  const calls = [0, 0, 0];
  const queue = new JobQueue(store, null, {
    intervalMs: 0,
    generate: async (_store, _browsers, job, _account, _signal, update) => {
      const index = colors.indexOf(job.payload.prompt);
      calls[index] += 1;
      update({ submittedAt: new Date().toISOString() });
      if (index === 1 && calls[index] === 1) throw new Error("middle scene failed");
      return assets[index];
    },
  });
  t.after(() => queue.close());
  const originalTimeline = structuredClone(project.timeline);
  const scenes = enqueue(queue, project, colors, { autoAssemble: true });
  queue.tick();
  await until(() => queue.running.size === 0);
  assert.deepEqual(scenes.map((scene) => scene.status), ["completed", "failed", "completed"]);
  assert.equal(store.state.jobs.filter((job) => job.type === "render").length, 0);
  assert.throws(() => queue.retry(scenes[1].id, false), { code: "CONFIRM_RESUBMIT" });
  const replacement = queue.retry(scenes[1].id, true);
  assert.equal(replacement.batchId, scenes[1].batchId);
  assert.equal(replacement.batchIndex, 1);
  assert.equal(replacement.payload.autoAssemble, true);
  assert.throws(() => queue.retry(scenes[1].id, true), { code: "ALREADY_RETRIED" });
  queue.tick();
  await until(() => queue.running.size === 0, 90000);
  const renders = store.state.jobs.filter((job) => job.type === "render");
  assert.equal(renders.length, 1);
  const render = renders[0];
  assert.equal(render.status, "completed", render.error);
  assert.deepEqual(calls, [1, 2, 1]);
  assert.deepEqual(render.sourceJobIds, [scenes[0].id, replacement.id, scenes[2].id]);
  assert.deepEqual(render.payload.timeline.clips.map((clip) => clip.mediaId), assets.map((asset) => asset.id));
  assert.deepEqual(project.timeline, originalTimeline);
  const output = store.require("media", render.mediaId);
  const metadata = await probe(output.file, store.state.settings);
  assert.ok(Math.abs(metadata.duration - 1.5) < 0.15, `duration ${metadata.duration}`);
  for (let index = 0; index < colors.length; index += 1) {
    const frame = path.join(store.root, `frame-${index}.rgb`);
    await runProcess(ffmpeg, [
      "-y", "-v", "error", "-ss", String(index * 0.5 + 0.25),
      "-i", output.file, "-vf", "scale=1:1", "-frames:v", "1",
      "-pix_fmt", "rgb24", "-f", "rawvideo", frame,
    ]);
    const pixel = await fs.readFile(frame);
    assert.ok(pixel[index] > 180, `${colors[index]} channel ${[...pixel]}`);
    assert.ok([...pixel].every((value, channel) => channel === index || value < 70));
  }
  // Simulate a crash after the render was persisted but before source markers.
  for (const scene of store.state.jobs.filter((job) => job.type === "generate")) {
    delete scene.assembled;
  }
  store.save();
  await queue.close();
  const restored = new Store(store.root);
  const resumed = new JobQueue(restored, null, {
    intervalMs: 0,
    generate: async () => assert.fail("Completed paid work was resubmitted"),
    render: async () => assert.fail("Completed assembly was duplicated"),
  });
  t.after(() => resumed.close());
  resumed.tick();
  resumed.tick();
  assert.equal(restored.state.jobs.filter((job) => job.type === "render").length, 1);
  assert.ok(restored.state.jobs.filter((job) => job.type === "generate").every((job) => job.assembled === render.id));
});

test("restart recovers the pre-assembly gap once and rejects partial persisted batches", async (t) => {
  const { store, project } = fixture();
  const queue = new JobQueue(store, null, { intervalMs: 0 });
  const asset = store.add("media", { kind: "image", duration: 1 });
  const scenes = enqueue(queue, project, ["First", "Second"], { autoAssemble: true });
  for (const scene of scenes) {
    store.patch("jobs", scene.id, { status: "completed", mediaId: asset.id });
  }
  const partial = enqueue(queue, project, ["Persisted prefix", "Missing suffix"], { autoAssemble: true });
  store.state.jobs = store.state.jobs.filter((job) => job.id !== partial[1].id);
  store.patch("jobs", partial[0].id, { status: "completed", mediaId: asset.id });
  await queue.close();
  const restored = new Store(store.root);
  let renderCount = 0;
  const resumed = new JobQueue(restored, null, {
    intervalMs: 0,
    generate: async () => assert.fail("Completed work was resubmitted"),
    render: async () => {
      renderCount += 1;
      return { id: "recovered-output" };
    },
  });
  t.after(() => resumed.close());
  resumed.tick();
  await until(() => resumed.running.size === 0);
  resumed.tick();
  assert.equal(renderCount, 1);
  const renders = restored.state.jobs.filter((job) => job.type === "render");
  assert.equal(renders.length, 1);
  assert.equal(renders[0].assemblyBatchId, scenes[0].batchId);
  assert.equal(restored.require("jobs", partial[0].id).assembled, undefined);
});

test("retry rejects deleted projects before queuing or calling an AI worker", async (t) => {
  const { store, project } = fixture();
  let generated = 0;
  const queue = new JobQueue(store, null, {
    intervalMs: 0,
    generate: async () => {
      generated += 1;
      return { id: "unexpected" };
    },
  });
  t.after(() => queue.close());
  const [job] = enqueue(queue, project, ["Deleted project"]);
  store.patch("jobs", job.id, { status: "failed" });
  store.state.projects = store.state.projects.filter((item) => item.id !== project.id);
  store.save();
  const count = store.state.jobs.length;
  assert.throws(() => queue.retry(job.id, true));
  assert.equal(store.state.jobs.length, count);
  queue.tick();
  await until(() => queue.running.size === 0);
  assert.equal(generated, 0);
});

test("legacy retries without batch metadata recover assembly without resubmitting AI", async (t) => {
  const { store, project } = fixture();
  const queue = new JobQueue(store, null, { intervalMs: 0 });
  const firstAsset = store.add("media", { kind: "image", duration: 1 });
  const secondAsset = store.add("media", { kind: "image", duration: 2 });
  const scenes = enqueue(queue, project, ["First", "Second"], { autoAssemble: true });
  for (const scene of scenes) {
    delete scene.sceneId;
    delete scene.batchSize;
    delete scene.batchIndex;
  }
  store.patch("jobs", scenes[0].id, { status: "completed", mediaId: firstAsset.id });
  store.patch("jobs", scenes[1].id, { status: "failed" });
  const failedRetry = store.add("jobs", {
    type: "generate",
    projectId: project.id,
    payload: { ...scenes[1].payload, autoAssemble: false },
    retryOf: scenes[1].id,
    status: "failed",
  });
  const successfulRetry = store.add("jobs", {
    type: "generate",
    projectId: project.id,
    payload: { ...failedRetry.payload },
    retryOf: failedRetry.id,
    status: "completed",
    mediaId: secondAsset.id,
  });
  await queue.close();
  const restored = new Store(store.root);
  let rendered = 0;
  const resumed = new JobQueue(restored, null, {
    intervalMs: 0,
    generate: async () => assert.fail("Legacy paid work was resubmitted"),
    render: async () => {
      rendered += 1;
      return { id: "legacy-assembly" };
    },
  });
  t.after(() => resumed.close());
  resumed.tick();
  await until(() => resumed.running.size === 0);
  resumed.tick();
  const renders = restored.state.jobs.filter((item) => item.type === "render");
  assert.equal(rendered, 1);
  assert.equal(renders.length, 1);
  assert.deepEqual(renders[0].sourceJobIds, [scenes[0].id, successfulRetry.id]);
  assert.deepEqual(renders[0].payload.timeline.clips.map((clip) => clip.mediaId), [firstAsset.id, secondAsset.id]);
  assert.ok(restored.state.jobs.filter((item) => item.type === "generate").every((item) => item.assembled === renders[0].id));
});
