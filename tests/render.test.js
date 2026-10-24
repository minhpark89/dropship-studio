import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { binary, runProcess, importMedia, probe } from '../server/media.js';
import { renderTimeline, validateTimeline } from '../server/render.js';
import { defaultTimeline } from '../shared/contracts.js';

test('FFmpeg renders trimmed mixed media, Vietnamese text, image overlay and music at the expected dimensions/duration', { timeout: 150000 }, async () => {
  const root = path.resolve('.verification', `render-${randomUUID()}`);
  const store = new Store(root);
  const project = store.createProject('Kiểm tra tiếng Việt');
  const ffmpeg = binary('ffmpeg', store.state.settings);
  const source = path.join(root, 'video có âm thanh.mp4');
  const silent = path.join(root, 'video im lặng.mp4');
  const image = path.join(root, 'logo.png');
  const music = path.join(root, 'nhạc.wav');
  await runProcess(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
  await runProcess(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=240x320:r=30:d=2', '-c:v', 'libx264', silent]);
  await runProcess(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=lime:s=80x80', '-frames:v', '1', '-update', '1', image]);
  await runProcess(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', music]);
  const media = [];
  for (const file of [source, silent, image, music]) media.push(await importMedia(store, file, { projectId: project.id }));
  const timeline = defaultTimeline();
  timeline.resolution = 480;
  timeline.quality = 'draft';
  timeline.clips = [
    { id: randomUUID(), mediaId: media[0].id, inSec: 0.5, outSec: 2.5, speed: 2, zoom: 1.2, fit: 'cover', volume: 0.5 },
    { id: randomUUID(), mediaId: media[1].id, inSec: 0, outSec: 1.5, speed: 0.5, zoom: 1, fit: 'contain', volume: 1 },
    { id: randomUUID(), mediaId: media[2].id, inSec: 0, outSec: 1, speed: 1, zoom: 1, fit: 'contain', volume: 1 },
  ];
  timeline.texts = [{ id: randomUUID(), text: "Tiếng Việt: 100% • 'đẹp' \\ :\nDòng hai", startSec: 0.2, endSec: 4.8, x: 0.5, y: 0.75, size: 28, color: '#ffffff', background: true }];
  timeline.images = [{ id: randomUUID(), mediaId: media[2].id, startSec: 0, endSec: 5, x: 0.8, y: 0.1, scale: 0.15, opacity: 0.6 }];
  timeline.music = { mediaId: media[3].id, volume: 0.3, offsetSec: 0.1, startSec: 0.2, speed: 1.25, loop: true, fadeIn: 0.3, fadeOut: 0.4 };
  const progress = [];
  const result = await renderTimeline(store, { id: randomUUID(), name: 'Bản kiểm tra', projectId: project.id, payload: { timeline } }, new AbortController().signal, (value) => progress.push(value));
  const output = await probe(result.file, store.state.settings);
  assert.equal(output.width, 480);
  assert.equal(output.height, 854);
  assert.ok(Math.abs(output.duration - 5) < 0.15, `duration ${output.duration}`);
  assert.equal(output.videoCodec, 'h264');
  assert.equal(output.audioCodec, 'aac');
  assert.ok(progress.includes(99));
  assert.equal((await fs.readdir(path.join(root, 'temp'))).length, 0);
  const first = path.join(root, 'frame-first.png');
  const middle = path.join(root, 'frame-middle.png');
  await runProcess(ffmpeg, ['-y', '-v', 'error', '-ss', '0.5', '-i', result.file, '-frames:v', '1', '-update', '1', first]);
  await runProcess(ffmpeg, ['-y', '-v', 'error', '-ss', '2', '-i', result.file, '-frames:v', '1', '-update', '1', middle]);
  await fs.writeFile(path.resolve('.verification/render-result.json'), JSON.stringify({ root, output: result.file, first, middle, metadata: output }, null, 2));
  const invalid = structuredClone(timeline);
  invalid.clips[0].outSec = 100;
  assert.throws(() => validateTimeline(store, invalid), /vượt thời lượng/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderTimeline(store, { id: randomUUID(), name: 'Cancel', projectId: project.id, payload: { timeline } }, controller.signal, () => {}));
  assert.equal((await fs.readdir(path.join(root, 'temp'))).length, 0);
});
