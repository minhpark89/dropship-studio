import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { binary, importMedia, probe, runProcess } from "../server/media.js";
import { renderTimeline } from "../server/render.js";
import { defaultTimeline, dimensions } from "../shared/contracts.js";

const sample = path.resolve("D:/DROPSHIP/Video+ảnh gốc_7_BN.mp4");
const root = path.resolve(".verification", `sample-render-${randomUUID()}`);
await fs.mkdir(root, { recursive: true });
const store = new Store(root);
const project = store.createProject("News sample render QA");
const source = await importMedia(store, sample, { projectId: project.id, name: "news-reference.mp4" });
const timeline = defaultTimeline();
timeline.resolution = 720;
timeline.quality = "draft";
timeline.clips = [{ id: randomUUID(), mediaId: source.id, inSec: 0, outSec: source.duration, speed: 1, zoom: 1, fit: "cover", volume: 1 }];
const progress = [];
const result = await renderTimeline(store, { id: randomUUID(), name: "News sample 9x16", projectId: project.id, payload: { timeline } }, new AbortController().signal, (value, stage) => progress.push({ value, stage }));
const output = await probe(result.file, store.state.settings);
const frame = path.join(root, "sample-frame.png");
await runProcess(binary("ffmpeg", store.state.settings), ["-y", "-v", "error", "-ss", "7", "-i", result.file, "-frames:v", "1", "-update", "1", frame]);
const report = {
  sample,
  input: { duration: source.duration, width: source.width, height: source.height, videoCodec: source.videoCodec, audioCodec: source.audioCodec },
  output: { file: result.file, frame, dimensions: dimensions(timeline), ...output },
  progress: { last: progress.at(-1), samples: progress.length },
  tempFilesAfterRender: await fs.readdir(path.join(root, "temp")),
  passed: true,
};
assert.equal(output.width, 720);
assert.equal(output.height, 1280);
assert.ok(Math.abs(output.duration - source.duration) < 0.25, `duration ${output.duration} vs ${source.duration}`);
assert.equal(output.videoCodec, "h264");
assert.equal(output.audioCodec, "aac");
assert.equal(report.tempFilesAfterRender.length, 0);
await fs.writeFile(path.resolve(".verification/sample-render-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
