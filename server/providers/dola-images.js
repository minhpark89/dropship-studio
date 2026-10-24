import { StudioError } from "../store.js";

export const dolaImageCards = (page) =>
  page.locator('[data-testid="receive_message"] [data-testid="message_image_content"]');

/**
 * Poll only completed results created after the submission baseline.
 * Dola's inline picture is a 384px thumbnail. Its official download action
 * requests a separate full-resolution file, including the service watermark.
 * Observe that request unchanged; never synthesize CDN URLs from thumbnails.
 */
export async function downloadDolaImageUrl(
  page,
  baselineCount,
  downloaded,
  { timeout = 15000, signal } = {},
) {
  signal?.throwIfAborted();
  const cards = dolaImageCards(page);
  for (let index = baselineCount; index < (await cards.count()); index++) {
    if (downloaded.has(index)) continue;
    const card = cards.nth(index);
    if ((await card.getAttribute("data-finished")) !== "true") continue;
    const thumbnail = card.locator('[data-testid="mdbox_image"]').first();
    const button = card.getByTestId("edit_image_hover_tag_download_btn").first();
    if (!(await thumbnail.isVisible()) || !(await button.count())) continue;
    const trackingKey = await thumbnail.locator("img[data-track-key]").first()
      .getAttribute("data-track-key").catch(() => null);
    const assetName = trackingKey?.split("/").at(-1);
    if (!assetName) continue;
    await thumbnail.hover({ timeout: 2000 });
    signal?.throwIfAborted();
    let originalUrl = null;
    const observe = (request) => {
      if (!["fetch", "xhr"].includes(request.resourceType())) return;
      try {
        const url = new URL(request.url());
        const filename = url.pathname.split("/").at(-1);
        if (filename === assetName || filename.startsWith(`${assetName}~`)) {
          originalUrl = request.url();
        }
      } catch {}
    };
    page.on("request", observe);
    // Attach the rejection handler immediately, including when click fails.
    const received = page.waitForEvent("download", { timeout })
      .then((download) => ({ download }), (error) => ({ error }));
    try {
      await button.click({ timeout: Math.min(timeout, 5000) });
      const outcome = await received;
      signal?.throwIfAborted();
      if (outcome.error || !originalUrl) {
        throw new StudioError(
          "Chưa lấy được tệp ảnh từ nút tải chính thức của Dola. Không dùng ảnh thu nhỏ thay thế.",
          "PROVIDER_DOWNLOAD_UNAVAILABLE",
        );
      }
      downloaded.add(index);
      return {
        url: originalUrl,
        filename: outcome.download.suggestedFilename(),
        index,
      };
    } finally {
      page.off("request", observe);
    }
  }
  return null;
}
