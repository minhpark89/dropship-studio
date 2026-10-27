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

function wrapOverlayText(value, { maxChars = 32, maxLines = 2 } = {}) {
  const source = cleanText(value, 500);
  if (!source) return "";
  const words = source.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  const visible = lines.slice(0, maxLines);
  const shown = visible.join(" ");
  if (shown.length < source.length && visible.length) {
    visible[visible.length - 1] = `${visible[visible.length - 1].replace(/[.…]+$/u, "")}…`;
  }
  return visible.join("\n");
}

function narrationSentences(value) {
  // Extract narration before splitting sentences. Otherwise a Visual sentence
  // becomes a caption and a following VO sentence loses its scene context.
  return String(value || "").slice(0, 12000).split(/\r?\n/)
    .flatMap((line) => {
      const normalized = line.replace(/^\s*\[[^\]]+\]\s*/u, "").trim();
      const voiceover = normalized.match(/(?:^|\s)(?:VO|Voiceover|Narration):\s*(.+)$/iu)?.[1];
      if (!voiceover && /^(?:Visual|End card|Scene|SFX|Music):/iu.test(normalized)) return [];
      return (voiceover || normalized).split(/(?<=[.!?])\s+/u).map((sentence) => cleanText(sentence, 400));
    })
    .filter((sentence) => sentence.length > 8);
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
      outSec: Number(media.duration) > 0
        ? Math.min(Number(media.duration), options.template === "news-short" ? 3 : Number(media.duration))
        : options.template === "news-short" ? 3 : 5,
      speed: 1,
      // News images are placed in a portrait composition. Keep the source
      // completely visible; the broadcast renderer supplies the moving
      // background treatment separately.
      zoom: 1,
      fit: options.template === "news-short" ? "contain" : "cover",
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
      text: options.template === "news-short"
        ? wrapOverlayText(headline, { maxChars: 28, maxLines: 2 })
        : headline,
      startSec,
      endSec: Math.min(endSec, startSec + 5),
      x: 0.5,
      y: options.template === "news-short" ? 0.12 : 0.14,
      size: options.template === "news-short" ? 32 : 42,
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
      text: `Source: ${source}`,
      startSec: Math.max(startSec, endSec - 5),
      endSec,
      x: 0.5,
      y: 0.92,
      size: 18,
      color: "#ffffff",
      background: true,
    });
  }

  if (options.template === "news-short") {
    const sentences = narrationSentences(result?.script || result?.angle).slice(0, additions.length);
    let cursor = startSec;
    for (let index = 0; index < additions.length; index += 1) {
      const duration = clipDuration(additions[index]);
      const caption = sentences[index] || (index === 0 ? cleanText(result?.angle, 220) : "");
      if (caption) {
        overlays.push({
          id: idFactory(),
          text: wrapOverlayText(caption, { maxChars: 32, maxLines: 2 }),
          startSec: cursor,
          endSec: cursor + duration,
          x: 0.5,
          y: 0.78,
          size: 24,
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
