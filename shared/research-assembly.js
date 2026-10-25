const fallbackId = () =>
  globalThis.crypto?.randomUUID?.() ||
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function clipDuration(clip) {
  return Math.max(0, (Number(clip.outSec) || 0) - (Number(clip.inSec) || 0)) /
    (Number(clip.speed) || 1);
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Build an editorial image segment with short, time-bound overlays. */
export function buildResearchAssemblyTimeline(
  timeline,
  assets,
  result,
  idFactory = fallbackId,
  options = {},
) {
  const baseTimeline = {
    ...timeline,
    clips: Array.isArray(timeline?.clips) ? timeline.clips : [],
    texts: Array.isArray(timeline?.texts) ? timeline.texts : [],
  };
  const existing = new Set(baseTimeline.clips.map((clip) => clip.mediaId));
  const additions = (Array.isArray(assets) ? assets : [])
    .filter((media) => media?.id && media.kind === "image" && !existing.has(media.id))
    .map((media) => ({
      id: idFactory(),
      mediaId: media.id,
      inSec: 0,
      outSec: Number(media.duration) > 0 ? Number(media.duration) : 5,
      speed: 1,
      zoom: options.template === "news-short" ? 1.06 : 1,
      fit: "cover",
      volume: 1,
    }));

  if (!additions.length) return { timeline: baseTimeline, additions, overlays: [] };

  const startSec = baseTimeline.clips.reduce((sum, clip) => sum + clipDuration(clip), 0);
  const endSec = startSec + additions.reduce((sum, clip) => sum + clipDuration(clip), 0);
  const overlays = [];
  const headline = cleanText(result?.headline || result?.topic, 180);
  if (headline) {
    overlays.push({
      id: idFactory(),
      text: headline,
      startSec,
      endSec: Math.min(endSec, startSec + 5),
      x: 0.5,
      y: 0.14,
      size: 42,
      color: "#ffffff",
      background: true,
    });
  }

  const sourceArticle = Array.isArray(result?.articles)
    ? result.articles.find((article) => article?.source || article?.url)
    : null;
  const source = cleanText(sourceArticle?.source || sourceArticle?.url || "", 180);
  if (source) {
    overlays.push({
      id: idFactory(),
      text: `Nguồn: ${source}`,
      startSec: Math.max(startSec, endSec - 5),
      endSec,
      x: 0.04,
      y: 0.92,
      size: 18,
      color: "#ffffff",
      background: true,
    });
  }

  if (options.template === "news-short") {
    const sentences = cleanText(result?.script || result?.angle, 4000)
      .split(/(?<=[.!?])\s+|\r?\n/)
      .map((value) => cleanText(value, 220))
      .filter((value) => value.length > 8)
      .slice(0, additions.length);
    let cursor = startSec;
    for (let index = 0; index < additions.length; index += 1) {
      const duration = clipDuration(additions[index]);
      const caption = sentences[index] || (index === 0 ? cleanText(result?.angle, 220) : "");
      if (caption) {
        overlays.push({
          id: idFactory(),
          text: caption,
          startSec: cursor,
          endSec: cursor + duration,
          x: 0.5,
          y: 0.78,
          size: 29,
          color: "#ffffff",
          background: true,
        });
      }
      cursor += duration;
    }
  }

  return {
    timeline: {
      ...baseTimeline,
      clips: [...baseTimeline.clips, ...additions],
      texts: [...baseTimeline.texts, ...overlays],
    },
    additions,
    overlays,
  };
}
