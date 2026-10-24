import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { prepareFlowAgent, runFlowAgent } from "../server/providers/flow-agent.js";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const group = (items, selected) => `<mat-button-toggle-group>${items.map((item) => `<button role="radio" aria-checked="${item === selected}"><span aria-hidden="true">icon</span>${item}</button>`).join("")}</mat-button-toggle-group>`;

async function fixture() {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><style>[hidden]{display:none!important} flow-agent-panel,flow-settings-view,mat-button-toggle-group{display:block}</style>
    <flow-agent-panel><button id="settings" aria-label="Settings">Settings</button><div class="ProseMirror" contenteditable="true"></div><button id="send" aria-label="Start generation">Start generation</button></flow-agent-panel>
    <flow-settings-view hidden><div role="radiogroup"><button role="radio" id="always" aria-checked="false">Always</button><button role="radio" id="never" aria-checked="true">Never</button></div>
      ${group(["16:9","4:3","1:1","3:4","9:16"],"16:9")}${group(["x1","x2","x3","x4"],"x2")}${group(["16:9","9:16"],"16:9")}${group(["x1","x2","x3","x4"],"x2")}
      <button id="video-model" aria-label="Video generation default model">Veo 3.1 - Quality</button><button id="image-model" aria-label="Image generation default model">Nano Banana 2.1</button><button id="save">Save</button></flow-settings-view><div role="menu" hidden></div>`);
  await page.evaluate(() => {
    const panel = document.querySelector("flow-agent-panel");
    const settings = document.querySelector("flow-settings-view");
    const menu = document.querySelector('[role="menu"]');
    window.calls = [];
    document.querySelector("#settings").onclick = () => { panel.hidden = true; settings.hidden = false; };
    for (const radio of document.querySelectorAll('[role="radio"]')) radio.onclick = () => { for (const sibling of radio.parentElement.querySelectorAll('[role="radio"]')) sibling.setAttribute("aria-checked", "false"); radio.setAttribute("aria-checked", "true"); };
    document.querySelector("#video-model").onclick = () => { menu.replaceChildren(); for (const name of ["Veo 3.1 - Lite", "Veo 3.1 - Fast", "Veo 3.1 - Quality"]) { const option = document.createElement("button"); option.setAttribute("role", "menuitem"); option.textContent = name; option.onclick = () => { document.querySelector("#video-model").textContent = name; menu.hidden = true; }; menu.append(option); } menu.hidden = false; };
    document.querySelector("#save").onclick = () => { settings.hidden = true; panel.hidden = false; };
    document.querySelector("#send").onclick = () => { window.calls.push("send"); const text = panel.querySelector(".ProseMirror"); if (window.calls.length === 1) panel.insertAdjacentHTML("beforeend", '<div>Generation Proposal Here are the details: Model: Veo 3.1 - Fast Duration: 8 seconds Aspect Ratio: 9:16 Quantity: 1 video Please confirm</div>'); else panel.insertAdjacentHTML("beforeend", '<flow-permission-message><div>Would you like me to kick off this 1 video generation, costing 20 credits?</div><div role="radio" aria-label="Approve" aria-disabled="false">Approve</div></flow-permission-message>'); };
    panel.addEventListener("click", (event) => { if (event.target.getAttribute("aria-label") === "Approve") { window.calls.push("approve"); panel.insertAdjacentHTML("beforeend", "<div>Your video generation has started! queued</div>"); } });
  });
  return page;
}

test("Flow Agent prepares settings, requires proposal confirmation, then approves once", async () => {
  const page = await fixture();
  try {
    const task = { kind: "video", mode: "text", model: "Veo 3.1 Fast", ratio: "9:16", duration: 8, prompt: "A bottle" };
    const prepared = await prepareFlowAgent(page, task, []);
    const phases = [];
    await runFlowAgent(page, task, prepared, { beforeAction: async (phase) => phases.push(phase) });
    assert.deepEqual(phases, ["planning", "confirmation", "approval"]);
    assert.deepEqual(await page.evaluate(() => window.calls), ["send", "send", "approve"]);
  } finally { await page.close(); }
});

test("Flow Agent rejects first/last and extension before browser access", async () => {
  const untouched = new Proxy({}, { get() { throw new Error("browser access"); } });
  for (const mode of ["firstlast", "extend"]) await assert.rejects(prepareFlowAgent(untouched, { kind: "video", mode, model: "Veo 3.1 Fast", ratio: "9:16", duration: 8, prompt: "x" }), (error) => error.code === "PROVIDER_SETTING_UNAVAILABLE");
});
