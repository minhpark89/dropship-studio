export function isNewsPresenterMedia(media, jobs = []) {
  const type = String(media?.mediaType || "").toLowerCase();
  if (["news-presenter", "news-mc", "presenter", "mc"].includes(type)) return true;
  return jobs.some((job) => job?.type === "news" && job?.payload?.presenterMediaId === media?.id);
}

export function isPublishableVideo(media, jobs = []) {
  return media?.kind === "video" && media?.generated && !isNewsPresenterMedia(media, jobs);
}

export function mediaOutputType(media, jobs = []) {
  if (isNewsPresenterMedia(media, jobs)) return "other";
  const explicit = String(media?.production?.contentType || media?.mediaType || "").toLowerCase();
  if (explicit === "news" || explicit === "news-video") return "news";
  if (explicit === "product" || explicit === "product-video") return "product";
  if (!explicit && /^news(?:\s|[·-])/i.test(String(media?.name || ""))) return "news";
  return "other";
}
