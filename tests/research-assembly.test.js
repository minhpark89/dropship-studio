import test from "node:test";
import assert from "node:assert/strict";
import { buildResearchAssemblyTimeline } from "../shared/research-assembly.js";

test("research assembly appends image clips and timed headline/source overlays", () => {
  let sequence = 0;
  const timeline = {
    clips: [{ id: "clip-existing", mediaId: "video-1", inSec: 0, outSec: 12, speed: 1 }],
    texts: [],
    ratio: "9:16",
  };
  const result = buildResearchAssemblyTimeline(
    timeline,
    [
      { id: "image-1", kind: "image", duration: 5 },
      { id: "image-2", kind: "image", duration: 7 },
      { id: "video-1", kind: "video", duration: 20 },
    ],
    {
      headline: "  Một  headline  dễ đọc  ",
      articles: [{ source: "Daily Wire", url: "https://example.test/story" }],
    },
    () => `generated-${++sequence}`,
  );

  assert.equal(result.additions.length, 2);
  assert.deepEqual(result.additions.map((clip) => clip.mediaId), ["image-1", "image-2"]);
  assert.equal(result.timeline.clips.length, 3);
  assert.equal(result.overlays.length, 2);
  assert.equal(result.overlays[0].startSec, 12);
  assert.equal(result.overlays[0].endSec, 17);
  assert.equal(result.overlays[0].text, "Một headline dễ đọc");
  assert.equal(result.overlays[1].startSec, 19);
  assert.equal(result.overlays[1].endSec, 24);
  assert.equal(result.overlays[1].text, "Source: Daily Wire");
});

test("research assembly is idempotent for already placed images", () => {
  const timeline = {
    clips: [{ id: "clip-1", mediaId: "image-1", inSec: 0, outSec: 5, speed: 1 }],
    texts: [],
  };
  const result = buildResearchAssemblyTimeline(
    timeline,
    [{ id: "image-1", kind: "image", duration: 5 }],
    { headline: "Headline" },
    () => "unused",
  );
  assert.equal(result.additions.length, 0);
  assert.deepEqual(result.timeline, timeline);
  assert.equal(result.overlays.length, 0);
});

test("news short keeps captions readable and close to the reference duration", () => {
  const result = buildResearchAssemblyTimeline(
    { clips: [], texts: [] },
    [
      { id: "image-1", kind: "image", duration: 5 },
      { id: "image-2", kind: "image", duration: 5 },
    ],
    {
      headline: "Ukraine and Starlink: can Europe close the gap?",
      script: "[HOOK - 0:00] A long caption that must fit safely inside the vertical frame.",
      articles: [{ source: "BBC News" }],
    },
    () => "generated",
    { template: "news-short" },
  );

  assert.deepEqual(result.additions.map((clip) => clip.outSec), [3, 3]);
  assert.match(result.overlays[0].text, /\n/);
  assert.equal(result.overlays[2].size, 24);
  assert.doesNotMatch(result.overlays[2].text, /^\[/);
});

test("news captions extract narration without leaking production directions", () => {
  const result = buildResearchAssemblyTimeline(
    { clips: [], texts: [] },
    Array.from({ length: 3 }, (_, index) => ({ id: `image-${index}`, kind: "image", duration: 5 })),
    {
      script: "[0:00] Visual: A satellite dish. VO: Starlink connects Ukraine.\n[0:05] Visual: A map. VO: Europe is seeking alternatives.\n[0:10] End card: Learn more.\n[0:12] Voiceover: Access remains uncertain.",
    },
    () => "generated",
    { template: "news-short" },
  );
  assert.deepEqual(result.overlays.map(item => item.text.replace(/\n/g, " ")), [
    "Starlink connects Ukraine.",
    "Europe is seeking alternatives.",
    "Access remains uncertain.",
  ]);
});
