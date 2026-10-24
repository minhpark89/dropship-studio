import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { prepareFlow } from "../server/providers/flow-prepare.js";

const task = {
  kind: "video",
  mode: "text",
  model: "Veo 3.1 Fast",
  ratio: "9:16",
  duration: 4,
  prompt: "One sneaker on a green pedestal.",
};

async function fixture(run, flags = {}) {
  const browser = await chromium.launch({ headless: true });
  let submissions = 0;
  let requests = 0;
  try {
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      requests += 1;
      if (new URL(route.request().url()).pathname === "/generate") {
        submissions += 1;
        return route.fulfill({ body: "{}" });
      }
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>
        <button id="new">New project</button>
        <main hidden>
          ${flags.missingKind ? "" : '<select aria-label="Content type" id="kind"><option>Image</option><option>Video</option></select>'}
          <select aria-label="Mode"><option>Frames to Video</option><option>Text to Video</option><option>Ingredients to Video</option></select>
          ${flags.imageMenu ? '<button id="model-trigger" aria-label="Model" aria-haspopup="listbox" aria-expanded="false">Veo 3.1 Quality</button><div id="model-menu" role="listbox" hidden><button role="option" id="image-model">Nano Banana Pro 2</button></div>' : '<select aria-label="Model" id="model"><option>Veo 3.1 Quality</option><option>Veo 3.1 Fast</option></select>'}
          <select aria-label="Aspect ratio"><option>Landscape</option><option>Portrait</option></select>
          ${flags.unscopedCount ? '<button aria-pressed="true">1</button>' : '<select aria-label="Outputs per prompt"><option>2</option><option>1</option></select>'}
          <select aria-label="Duration"><option>8s</option><option>4s</option></select>
          <div class="ProseMirror" contenteditable="true"></div>
          <button id="generate">Generate</button>
        </main>
        <script>
          const flags = ${JSON.stringify(flags)};
          document.querySelector('#new').onclick = () => {
            document.querySelector('main').hidden = false;
            document.querySelector('#new').hidden = true;
          };
          document.querySelector('#generate').onclick = () => fetch('/generate', {method:'POST'});
          const model = document.querySelector('#model');
          if (model) model.onchange = () => {
            if (flags.staleModel) model.value = 'Veo 3.1 Quality';
            if (flags.resetKind) document.querySelector('#kind').value = 'Image';
            if (flags.consent) {
              const dialog = document.createElement('div');
              dialog.setAttribute('role', 'dialog');
              dialog.innerHTML = 'Your data and privacy <button id="consent">I agree</button>';
              document.body.append(dialog);
              document.querySelector('#consent').onclick = () => { window.consentClicked = true; dialog.remove(); };
            }
          };
          if (flags.imageMenu) {
            const trigger = document.querySelector('#model-trigger');
            const menu = document.querySelector('#model-menu');
            trigger.onclick = () => { menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); };
            document.querySelector('#image-model').onclick = () => {
              trigger.textContent = 'Nano Banana Pro 2';
              trigger.setAttribute('aria-expanded', 'false');
              menu.hidden = true;
            };
          }
        </script>
      </body></html>` });
    });
    await run(page);
    assert.equal(submissions, 0, "Preparation must never click Generate");
    return { requests, submissions };
  } finally {
    await browser.close();
  }
}

test("Flow preparation establishes all settings and returns Send without submitting", async () => {
  await fixture(async (page) => {
    const send = await prepareFlow(page, task, []);
    assert.equal(await send.innerText(), "Generate");
    assert.equal(await page.getByRole("combobox", { name: "Content type", exact: true }).inputValue(), "Video");
    assert.equal(await page.getByRole("combobox", { name: "Mode", exact: true }).inputValue(), "Text to Video");
    assert.equal(await page.getByRole("combobox", { name: "Model", exact: true }).inputValue(), "Veo 3.1 Fast");
    assert.equal(await page.getByRole("combobox", { name: "Outputs per prompt" }).inputValue(), "1");
    assert.equal(await page.locator(".ProseMirror").innerText(), task.prompt);
  });
});

test("Flow preparation does not silently skip unavailable content kind", async () => {
  await fixture(async (page) => {
    await assert.rejects(prepareFlow(page, task, []), (error) => error.code === "PROVIDER_SETTING_UNAVAILABLE");
    assert.equal(await page.locator(".ProseMirror").innerText(), "");
  }, { missingKind: true });
});

test("Flow rejects a model selector that ignores the requested selection", async () => {
  await fixture(async (page) => {
    await assert.rejects(prepareFlow(page, task, []), (error) => error.code === "PROVIDER_SETTING_UNAVAILABLE" && error.message.includes("Model"));
  }, { staleModel: true });
});

test("Flow catches a model change resetting an earlier content-type selection", async () => {
  await fixture(async (page) => {
    await assert.rejects(prepareFlow(page, task, []), (error) => error.code === "PROVIDER_SETTING_UNAVAILABLE" && error.message.includes("Content type"));
  }, { resetKind: true });
});

test("Flow supports Nano Banana model trigger and reads its selected label", async () => {
  await fixture(async (page) => {
    const send = await prepareFlow(page, { ...task, kind: "image", model: "Nano Banana Pro 2" }, []);
    assert.equal(await send.isEnabled(), true);
    assert.equal(await page.locator('#model-trigger').innerText(), "Nano Banana Pro 2");
  }, { imageMenu: true });
});

test("An unrelated selected numeric button cannot establish one output", async () => {
  await fixture(async (page) => {
    await assert.rejects(prepareFlow(page, task, []), (error) => error.code === "PROVIDER_SETTING_UNAVAILABLE" && error.message.includes("Outputs per prompt"));
  }, { unscopedCount: true });
});

test("Flow preparation leaves provider consent for the user", async () => {
  await fixture(async (page) => {
    await assert.rejects(prepareFlow(page, task, []), (error) => error.code === "PROVIDER_NOT_READY");
    assert.equal(await page.getByRole('dialog').isVisible(), true);
    assert.equal(await page.evaluate(() => Boolean(window.consentClicked)), false);
  }, { consent: true });
});

test("Unverified first/last and extension modes stop before navigation or upload", async () => {
  const result = await fixture(async (page) => {
    for (const mode of ["firstlast", "extend"]) {
      await assert.rejects(prepareFlow(page, { ...task, mode }, ["never-read.png"]), (error) => error.code === "PROVIDER_SETTING_UNAVAILABLE");
    }
    assert.equal(page.url(), "about:blank");
  });
  assert.equal(result.requests, 0);
});
