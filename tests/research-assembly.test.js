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
  assert.equal(result.overlays[1].text, "Nguồn: Daily Wire");
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
