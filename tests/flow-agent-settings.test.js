import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { prepareFlowAgentSettings } from "../server/providers/flow-agent-settings.js";

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

const task = { kind: "video", mode: "text", model: "Veo 3.1 Fast", ratio: "9:16", duration: 8 };
const rejectedSetting = (error) => error.code === "PROVIDER_SETTING_UNAVAILABLE";

function toggleGroup(names, selected) {
  return `<mat-button-toggle-group>${names.map((name) => `<button role="radio" aria-checked="${name === selected}"><span aria-hidden="true">icon</span>${name}</button>`).join("")}</mat-button-toggle-group>`;
}

async function fixture(run, flags = {}) {
  const page = await browser.newPage();
  let submissions = 0;
  const groups = [
    toggleGroup(["16:9", "4:3", "1:1", "3:4", "9:16"], "16:9"),
    toggleGroup(["x1", "x2", "x3", "x4"], "x2"),
    toggleGroup(["16:9", "9:16"], "16:9"),
    toggleGroup(["x1", "x2", "x3", "x4"], "x2"),
  ];
  if (flags.reorderedGroups) groups.reverse();
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/generate") {
      submissions += 1;
      return route.fulfill({ body: "{}" });
    }
    return route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <html><head><meta charset="utf-8"><style>
        [hidden] { display: none !important; }
        flow-agent-panel, flow-settings-view, mat-button-toggle-group { display: block; }
        .ProseMirror { min-height: 40px; }
      </style></head><body>
        <button id="global-settings" aria-label="Settings">Project settings</button>
        <flow-agent-panel ${flags.preopened ? "hidden" : ""}>
          <button id="agent-settings" aria-label="Settings">Agent settings</button>
          <div class="ProseMirror" contenteditable="true"></div>
          <button id="generate" aria-label="Start generation" disabled>Send</button>
        </flow-agent-panel>
        <flow-settings-view ${flags.preopened ? "" : "hidden"}>
          <div role="radiogroup" aria-label="Confirm before generating">
            ${flags.missingAlways ? "" : '<button role="radio" id="always" aria-checked="false">Always Agent will ask for confirmation before generating media.</button>'}
            <button role="radio" id="never" aria-checked="true">Never Agent will generate media and spend credits automatically.</button>
          </div>
          ${groups.join("\n")}
          <button id="image-model" aria-label="Image generation default model">🍌 Nano Banana 2.1<mat-icon aria-hidden="true">arrow_drop_down</mat-icon></button>
          <button id="video-model" aria-label="Video generation default model">Veo 3.1 - Quality<mat-icon aria-hidden="true">arrow_drop_down</mat-icon></button>
          <button id="save">Save</button>
        </flow-settings-view>
        <div role="menu" hidden></div>
        <script>
          const flags = ${JSON.stringify(flags)};
          const panel = document.querySelector('flow-agent-panel');
          const settings = document.querySelector('flow-settings-view');
          const menu = document.querySelector('[role="menu"]');
          window.actions = { global: 0, settings: 0, save: 0, never: 0, generated: 0 };
          document.querySelector('#global-settings').onclick = () => window.actions.global += 1;
          document.querySelector('#agent-settings').onclick = () => {
            window.actions.settings += 1;
            panel.hidden = true;
            settings.hidden = false;
          };
          for (const radio of document.querySelectorAll('[role="radio"]')) {
            radio.onclick = () => {
              for (const sibling of radio.parentElement.querySelectorAll('[role="radio"]')) sibling.setAttribute('aria-checked', 'false');
              radio.setAttribute('aria-checked', 'true');
              if (radio.id === 'never') window.actions.never += 1;
              if (flags.resetConfirmationOnCount && radio.textContent === 'iconx1') {
                document.querySelector('#always').setAttribute('aria-checked', 'false');
                document.querySelector('#never').setAttribute('aria-checked', 'true');
              }
            };
          }
          for (const kind of ['image', 'video']) {
            const trigger = document.querySelector('#' + kind + '-model');
            trigger.onclick = () => {
              const names = kind === 'image' ? ['🍌 Nano Banana 2.1'] : ['Omni 1.1 Flash', 'Veo 3.1 - Lite', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality'];
              if (flags.duplicateModel) names.push('Veo 3.1 Fast');
              menu.replaceChildren();
              for (const name of names) {
                const option = document.createElement('button');
                option.setAttribute('role', 'menuitem');
                option.textContent = name;
                option.onclick = () => {
                  if (!flags.staleModel) trigger.textContent = name;
                  menu.hidden = true;
                };
                menu.append(option);
              }
              menu.hidden = false;
            };
          }
          document.querySelector('#save').onclick = () => {
            window.actions.save += 1;
            window.saved = {
              always: document.querySelector('#always')?.getAttribute('aria-checked'),
              groups: Array.from(settings.querySelectorAll('mat-button-toggle-group'), (group) => group.querySelector('[aria-checked="true"]').textContent.replace('icon', '')),
              image: document.querySelector('#image-model').textContent,
              video: document.querySelector('#video-model').textContent,
            };
            settings.hidden = true;
            panel.hidden = false;
          };
          document.querySelector('#generate').onclick = () => {
            window.actions.generated += 1;
            fetch('/generate', { method: 'POST' });
          };
          if (flags.consent) {
            const dialog = document.createElement('div');
            dialog.setAttribute('role', 'dialog');
            dialog.innerHTML = 'Your data and privacy <button id="consent">I agree</button>';
            document.body.append(dialog);
            document.querySelector('#consent').onclick = () => window.consentClicked = true;
          }
        </script>
      </body></html>` });
  });
  try {
    await page.goto("http://flow-fixture.test/project/test");
    await run(page);
    const actions = await page.evaluate(() => window.actions);
    assert.equal(actions.global, 0, "Use agent settings, not project settings");
    assert.equal(actions.never, 0, "Never enable automatic spending");
    assert.equal(actions.generated, 0, "Settings preparation must never send");
    assert.equal(submissions, 0);
  } finally {
    await page.close();
  }
}

test("Agent settings configure video model, portrait and one output without altering image defaults or submitting", async () => {
  await fixture(async (page) => {
    const { composer, send } = await prepareFlowAgentSettings(page, task);
    assert.equal(await composer.innerText(), "");
    assert.equal(await send.isDisabled(), true);
    const { saved, actions } = await page.evaluate(() => ({ saved: window.saved, actions: window.actions }));
    assert.equal(saved.always, "true");
    assert.equal(saved.video, "Veo 3.1 - Fast");
    assert.deepEqual(saved.groups, ["16:9", "x2", "9:16", "x1"]);
    assert.equal(actions.settings, 1);
    assert.equal(actions.save, 1);
  });
});

test("Agent settings use image controls and recognize the Nano Banana emoji without changing video defaults", async () => {
  await fixture(async (page) => {
    await prepareFlowAgentSettings(page, { ...task, kind: "image", mode: "reference", model: "Nano Banana 2.1", ratio: "3:4" });
    const saved = await page.evaluate(() => window.saved);
    assert.deepEqual(saved.groups, ["3:4", "x1", "16:9", "x2"]);
    assert.match(saved.video, /Veo 3\.1 - Quality/);
    assert.match(saved.image, /Nano Banana 2\.1/);
  }, { preopened: true });
});

test("Agent settings select Omni by exact model label", async () => {
  await fixture(async (page) => {
    await prepareFlowAgentSettings(page, { ...task, model: "Omni 1.1 Flash" });
    assert.equal(await page.evaluate(() => window.saved.video), "Omni 1.1 Flash");
  });
});

test("Missing and ambiguous models never fall back to another choice or save", async () => {
  for (const variant of [{ model: "Veo 99", flags: {} }, { model: task.model, flags: { duplicateModel: true } }]) {
    await fixture(async (page) => {
      await assert.rejects(prepareFlowAgentSettings(page, { ...task, model: variant.model }), rejectedSetting);
      assert.equal(await page.evaluate(() => window.actions.save), 0);
    }, variant.flags);
  }
});

test("Ignored model selection is detected by readback", async () => {
  await fixture(async (page) => {
    await assert.rejects(prepareFlowAgentSettings(page, task), rejectedSetting);
    assert.equal(await page.evaluate(() => window.actions.save), 0);
  }, { staleModel: true });
});

test("A later setting resetting confirmation is detected before Save", async () => {
  await fixture(async (page) => {
    await assert.rejects(prepareFlowAgentSettings(page, task), rejectedSetting);
    assert.equal(await page.evaluate(() => window.actions.save), 0);
  }, { resetConfirmationOnCount: true });
});

test("Unknown setting layout and missing confirmation control fail before model changes", async () => {
  for (const flags of [{ reorderedGroups: true }, { missingAlways: true }]) {
    await fixture(async (page) => {
      await assert.rejects(prepareFlowAgentSettings(page, task), rejectedSetting);
      assert.match(await page.locator('#video-model').innerText(), /Veo 3\.1 - Quality/);
      assert.equal(await page.evaluate(() => window.actions.save), 0);
    }, flags);
  }
});

test("Provider consent remains untouched", async () => {
  await fixture(async (page) => {
    await assert.rejects(prepareFlowAgentSettings(page, task), (error) => error.code === "PROVIDER_NOT_READY");
    assert.equal(await page.evaluate(() => Boolean(window.consentClicked)), false);
    assert.equal(await page.evaluate(() => window.actions.settings), 0);
  }, { consent: true });
});

test("Unsupported modes and video ratios reject before any browser access", async () => {
  const untouchedPage = new Proxy({}, { get() { throw new Error("Browser access must not happen"); } });
  for (const change of [{ mode: "firstlast" }, { mode: "extend" }, { ratio: "1:1" }, { kind: "audio" }, { model: "" }]) {
    await assert.rejects(prepareFlowAgentSettings(untouchedPage, { ...task, ...change }), rejectedSetting);
  }
});
