import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { dolaImageCards, downloadDolaImageUrl } from "../server/providers/dola-images.js";

const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1kAAAAASUVORK5CYII=", "base64");
const html = `<!doctype html><html><body>
<button id="send">Generate</button>
<section data-testid="receive_message">
  <div data-testid="message_image_content" data-finished="true" id="old"></div>
</section>
<script>
window.counts = { submissions: 0, downloads: 0 };
document.querySelector('#send').onclick = () => window.counts.submissions++;
window.addResult = () => {
  const card = document.createElement('div');
  card.id = 'new';
  card.dataset.testid = 'message_image_content';
  card.dataset.finished = 'false';
  card.innerHTML = '<div data-testid="mdbox_image"><img width="80" height="80" data-track-key="reply_asset/new.png" src="/new.png~thumbnail"></div><button data-testid="edit_image_hover_tag_download_btn">Download</button>';
  card.querySelector('button').onclick = async () => {
    window.counts.downloads++;
    const response = await fetch('/new.png~official?signature=fixture');
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'Dola official image.png';
    document.body.append(link);
    link.click();
    link.remove();
  };
  document.querySelector('section').append(card);
};
</script></body></html>`;

test("Dola uses the new completed image's official download request and never its inline thumbnail", { timeout: 30000 }, async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url.startsWith("/new.png")) {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(imageBytes);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const baseline = await dolaImageCards(page).count();
    assert.equal(baseline, 1);
    const done = new Set();
    assert.equal(await downloadDolaImageUrl(page, baseline, done), null);
    await page.evaluate(() => window.addResult());
    assert.equal(await downloadDolaImageUrl(page, baseline, done), null);
    assert.equal(await page.evaluate(() => window.counts.downloads), 0);
    await page.locator("#new").evaluate((card) => card.dataset.finished = "true");
    const result = await downloadDolaImageUrl(page, baseline, done);
    assert.equal(new URL(result.url).pathname, "/new.png~official");
    assert.equal(new URL(result.url).search, "?signature=fixture");
    assert.equal(result.filename, "Dola official image.png");
    assert.equal(result.index, 1);
    assert.equal(await downloadDolaImageUrl(page, baseline, done), null);
    assert.deepEqual(await page.evaluate(() => window.counts), { submissions: 0, downloads: 1 });
    assert.equal(requests.filter((url) => url.startsWith("/new.png~official")).length, 1);
    const response = await page.request.get(result.url);
    assert.equal(Buffer.compare(await response.body(), imageBytes), 0);
  } finally {
    await browser.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
});
