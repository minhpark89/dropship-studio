import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { downloadFlowAgentMedia, flowVideoCardKeys } from "../server/providers/flow-agent-download.js";

let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

const prompt = "A glass bottle turns slowly on a pedestal.";

function fixtureHtml({ optionPrompt = prompt } = {}) {
  return `<!doctype html>
    <style>[hidden]{display:none!important}</style>
    <button role="button" aria-label="Open video in editor">
      <img alt="${optionPrompt}">
    </button>
    <section id="editor" hidden>
      <button role="button" aria-label="Download media">Download media</button>
      <div role="menu" hidden></div>
    </section>
    <script>
      const option = document.querySelector('[aria-label="Open video in editor"]');
      const editor = document.querySelector('#editor');
      const download = editor.querySelector('[aria-label="Download media"]');
      const menu = editor.querySelector('[role="menu"]');
      option.addEventListener('click', () => {
        history.pushState({}, '', '/project/fixture/edit/result');
        editor.hidden = false;
      });
      download.addEventListener('click', () => {
        menu.innerHTML = '<div role="menuitem">720p Original size</div>';
        menu.hidden = false;
        menu.firstElementChild.addEventListener('click', () => {
          const link = document.createElement('a');
          link.href = 'http://download.fixture/video.mp4';
          link.download = 'flow-result.mp4';
          link.click();
        });
      });
    </script>`;
}

async function fixture({ optionPrompt = prompt } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.route("http://fixture.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: fixtureHtml({ optionPrompt }) });
  });
  await page.route("http://download.fixture/video.mp4", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "video/mp4",
      headers: { "content-disposition": 'attachment; filename="flow-result.mp4"' },
      body: Buffer.from("fixture-video"),
    });
  });
  await page.goto("http://fixture.test/");
  return { context, page };
}

async function prependedFixture() {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.route("http://fixture.test/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <style>[hidden]{display:none!important}</style>
        <button role="button" aria-label="Open video in editor" data-id="existing">
          <img alt="${prompt}">
        </button>
        <section id="editor" hidden>
          <button role="button" aria-label="Download media">Download media</button>
          <div role="menu" hidden></div>
        </section>
        <script>
          const editor = document.querySelector('#editor');
          const download = editor.querySelector('[aria-label="Download media"]');
          const menu = editor.querySelector('[role="menu"]');
          const openEditor = () => {
            history.pushState({}, '', '/project/fixture/edit/new-result');
            editor.hidden = false;
          };
          document.querySelector('[data-id="existing"]').addEventListener('click', openEditor);
          setTimeout(() => {
            const option = document.createElement('button');
            option.setAttribute('role', 'button');
            option.setAttribute('aria-label', 'Open video in editor');
            option.dataset.id = 'new';
            option.innerHTML = '<img alt="${prompt}">';
            option.addEventListener('click', openEditor);
            document.body.insertBefore(option, document.body.firstChild);
          }, 100);
          download.addEventListener('click', () => {
            menu.innerHTML = '<div role="menuitem">720p Original size</div>';
            menu.hidden = false;
            menu.firstElementChild.addEventListener('click', () => {
              const link = document.createElement('a');
              link.href = 'http://download.fixture/video.mp4';
              link.download = 'flow-result.mp4';
              link.click();
            });
          });
        </script>`,
    });
  });
  await page.route("http://download.fixture/video.mp4", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "video/mp4",
      headers: { "content-disposition": 'attachment; filename="flow-result.mp4"' },
      body: Buffer.from("fixture-video"),
    });
  });
  await page.goto("http://fixture.test/");
  return { context, page };
}

test("downloads a new Flow result through the editor's original-size action", async () => {
  const { context, page } = await fixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dropship-flow-download-"));
  const destination = path.join(root, "result.mp4");
  try {
    const result = await downloadFlowAgentMedia(page, {
      prompt,
      destination,
      timeout: 3000,
    });
    assert.equal(result.suggestedFilename, "flow-result.mp4");
    assert.deepEqual(await fs.readFile(destination), Buffer.from("fixture-video"));
    assert.match(page.url(), /\/edit\/result$/);
  } finally {
    await context.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not open an unrelated existing Flow result", async () => {
  const { context, page } = await fixture({ optionPrompt: "A different prompt." });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dropship-flow-download-"));
  try {
    await assert.rejects(
      downloadFlowAgentMedia(page, {
        prompt,
        destination: path.join(root, "result.mp4"),
        timeout: 250,
      }),
      (error) => error.code === "PROVIDER_TIMEOUT",
    );
    assert.equal(page.url(), "http://fixture.test/");
  } finally {
    await context.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("uses a newly prepended Flow result instead of an old matching prompt", async () => {
  const { context, page } = await prependedFixture();
  const baselineKeys = await flowVideoCardKeys(page);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dropship-flow-download-"));
  const destination = path.join(root, "result.mp4");
  try {
    const result = await downloadFlowAgentMedia(page, {
      prompt,
      destination,
      baselineCount: baselineKeys.length,
      baselineKeys,
      timeout: 3000,
    });
    assert.equal(result.suggestedFilename, "flow-result.mp4");
    assert.deepEqual(await fs.readFile(destination), Buffer.from("fixture-video"));
    assert.match(page.url(), /\/edit\/new-result$/);
  } finally {
    await context.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
