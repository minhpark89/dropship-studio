import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { binary, importMedia, probe, runProcess } from "../server/media.js";
import { renderNewsBroadcast } from "../server/news-render.js";

test("news broadcast uses a narrated presenter, animated editorial images and the first-comment CTA", { timeout: 150000 }, async (t) => {
  const root = path.resolve(".verification", `news-broadcast-${randomUUID()}`);
  const store = new Store(root);
  const project = store.createProject("News broadcast QA");
  const ffmpeg = binary("ffmpeg", store.state.settings);
  const presenterFile = path.join(root, "presenter.mp4");
  await runProcess(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=540x720:r=30:d=13", "-f", "lavfi", "-i", "sine=frequency=440:duration=13", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", presenterFile]);
  const presenter = await importMedia(store, presenterFile, { projectId: project.id, name: "DreamFace presenter.mp4", generated: true });
  const images = [];
  for (const [index, color] of ["#16324f", "#8d2f3d", "#d99b2b"].entries()) {
    const imageFile = path.join(root, `editorial-${index}.png`);
    await runProcess(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=900x1400`, "-frames:v", "1", "-update", "1", imageFile]);
    images.push(await importMedia(store, imageFile, { projectId: project.id, name: `Editorial ${index}.png` }));
  }
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plan = {
    headline: "A new technology report draws attention",
    narration: "A new technology report is drawing attention today. Officials say the development is being reviewed as more details emerge. Read the full story through the link in the first comment.",
    source: "Test News",
    brand: "VIRAL NEWS",
  };
  const result = await renderNewsBroadcast(store, { id: randomUUID(), name: "News broadcast QA", projectId: project.id }, presenter, plan, images, new AbortController().signal);
  const output = await probe(result.file, store.state.settings);
  assert.equal(output.width, 1080);
  assert.equal(output.height, 1920);
  assert.equal(output.videoCodec, "h264");
  assert.equal(output.audioCodec, "aac");
  assert.equal(output.hasAudio, true);
  assert.ok(Math.abs(output.duration - presenter.duration) < 0.2);
  assert.equal((await fs.readdir(path.join(root, "temp"))).length, 0);
});
