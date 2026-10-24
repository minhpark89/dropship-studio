import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { openFlowProject } from "../server/providers/flow-project.js";

const deniedRpc = `)]}'\n\n105\n[["er",null,null,null,null,401,null,null,null,16],["di",15]]\n`;

async function fixture(run, { status = 200, dialog = false } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  let projectRequests = 0;
  let generationRequests = 0;
  try {
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith("batchexecute")) {
        projectRequests += 1;
        return route.fulfill({ status, contentType: "application/json", body: deniedRpc });
      }
      if (url.pathname === "/generate") {
        generationRequests += 1;
        return route.fulfill({ status: 200, body: "{}" });
      }
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body>
          <span>PRO</span>
          <textarea name="g-recaptcha-response" style="display:none"></textarea>
          <button id="create">add New project</button>
          ${dialog ? '<div role="dialog">Your data and Google Flow<button>Continue</button></div>' : ''}
          <script>
            document.querySelector('#create').onclick = async () => {
              const response = await fetch('/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=jHPbke', {method: 'POST'});
              if (!response.ok) return;
              const input = document.createElement('div');
              input.className = 'ProseMirror';
              input.contentEditable = 'true';
              input.setAttribute('role', 'textbox');
              document.body.append(input);
              const send = document.createElement('button');
              send.textContent = 'Generate';
              send.onclick = () => fetch('/generate', {method: 'POST'});
              document.body.append(send);
            };
          </script>
        </body></html>`,
      });
    });
    const page = await context.newPage();
    await run(page);
    return { projectRequests, generationRequests };
  } finally {
    await browser.close();
  }
}

test("Flow project HTTP 401 fails as expired login before a generation is submitted", async () => {
  const requests = await fixture(async (page) => {
    await assert.rejects(openFlowProject(page, { timeout: 5000 }), (error) => error.code === "NEEDS_LOGIN");
    assert.equal(page.listenerCount("response"), 0);
  }, { status: 401 });
  assert.deepEqual(requests, { projectRequests: 1, generationRequests: 0 });
});

test("Flow does not use the hidden reCAPTCHA textarea as its prompt composer", async () => {
  // Successful project creation has no RPC error body in this fixture.
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.fulfill({
      contentType: "text/html",
      body: '<textarea name="g-recaptcha-response" style="display:none"></textarea><button onclick="document.querySelector(\'div\').style.display=\'block\'">New project</button><div class="ProseMirror" contenteditable="true" style="display:none"></div>',
    }));
    const input = await openFlowProject(page, { timeout: 5000 });
    await input.fill("Product video test");
    assert.equal(await input.innerText(), "Product video test");
    assert.equal(page.listenerCount("response"), 0);
  } finally {
    await browser.close();
  }
});

test("Flow does not accept onboarding on behalf of the user", async () => {
  const requests = await fixture(async (page) => {
    await assert.rejects(openFlowProject(page, { timeout: 5000 }), (error) => error.code === "NEEDS_LOGIN");
    assert.equal(await page.getByRole("dialog").isVisible(), true);
  }, { dialog: true });
  assert.deepEqual(requests, { projectRequests: 0, generationRequests: 0 });
});
