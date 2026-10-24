import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BrowserProfiles } from "../server/providers/browser-profiles.js";

test("Google sign-in alone does not make Dola ready; Dola requires its own session and working page", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const profiles = new BrowserProfiles(null);
  const account = { provider: "dola", loginMethod: "google" };
  try {
    await context.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<button data-testid="to_login_button">Log in</button><div data-testid="chat_input_input" contenteditable="true"></div>',
      }),
    );
    const page = await context.newPage();
    await page.goto("https://www.dola.com/chat/");
    const session = { context, page };
    await context.addCookies([
      {
        name: "SID",
        value: "fixture-google-session",
        domain: ".google.com",
        path: "/",
        secure: true,
      },
    ]);
    assert.equal(
      (await profiles.inspect(account, session)).status,
      "needs_login",
    );

    const google = await context.newPage();
    await google.goto("https://accounts.google.com/signin");
    const duringGoogle = await profiles.inspect(account, session);
    assert.equal(duringGoogle.status, "needs_login");
    assert.equal(duringGoogle.authStep, "identity");
    await google.close();

    await context.addCookies([
      {
        name: "sessionid",
        value: "fixture-dola-session",
        domain: ".dola.com",
        path: "/",
        secure: true,
      },
    ]);
    assert.equal(
      (await profiles.inspect(account, session)).status,
      "needs_login",
    );
    await page
      .getByTestId("to_login_button")
      .evaluate((button) => button.remove());
    assert.equal((await profiles.inspect(account, session)).status, "ready");

    await page.goto("https://accounts.google.com/signin");
    await page
      .getByTestId("to_login_button")
      .evaluate((button) => button.remove());
    assert.equal(
      (await profiles.inspect(account, session)).status,
      "needs_login",
    );
  } finally {
    await browser.close();
  }
});

test("Flow follows the workspace tab and requires both a Google session and workspace", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const profiles = new BrowserProfiles(null);
  try {
    await context.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>New project</h1>" }),
    );
    const page = await context.newPage();
    await page.goto("https://flow.google.com/about");
    const session = { context, page };
    const account = { provider: "flow" };
    await context.addCookies([
      {
        name: "SID",
        value: "fixture-google-session",
        domain: ".google.com",
        path: "/",
        secure: true,
      },
    ]);
    assert.equal(
      (await profiles.inspect(account, session)).status,
      "needs_login",
    );
    const workspace = await context.newPage();
    await workspace.goto("https://labs.google/fx/tools/flow");
    assert.equal((await profiles.inspect(account, session)).status, "ready");
    assert.equal(session.page, workspace);
    await context.clearCookies();
    assert.equal(
      (await profiles.inspect(account, session)).status,
      "needs_login",
    );
  } finally {
    await browser.close();
  }
});

test("Flow rejects cached workspace labels behind onboarding, loading errors, and unrelated Labs pages", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => route.fulfill({
      contentType: "text/html",
      body: '<h1>New project</h1><div role="dialog">Your data and Google Flow<button>Continue</button></div>',
    }));
    await context.addCookies([{ name: "SID", value: "fixture", domain: ".google.com", path: "/", secure: true }]);
    const page = await context.newPage();
    await page.goto("https://flow.google.com/");
    const profiles = new BrowserProfiles(null);
    const account = { id: "flow-fixture", provider: "flow" };
    const session = { context, page };
    assert.equal((await profiles.inspect(account, session)).status, "needs_login");
    await page.locator('[role="dialog"]').evaluate((element) => element.remove());
    await page.locator("body").evaluate((body) => body.append("Error loading projects"));
    assert.equal((await profiles.inspect(account, session)).status, "error");
    await page.goto("https://labs.google/fx/tools/whisk");
    await page.locator('[role="dialog"]').evaluate((element) => element.remove());
    assert.equal((await profiles.inspect(account, session)).status, "needs_login");
  } finally {
    await browser.close();
  }
});

test("checking a shared account does not adopt another account's service tab", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<h1>New project</h1>" }));
    await context.addCookies([{ name: "SID", value: "fixture", domain: ".google.com", path: "/", secure: true }]);
    const own = await context.newPage();
    const other = await context.newPage();
    await own.goto("https://flow.google.com/about");
    await other.goto("https://flow.google.com/");
    const profiles = new BrowserProfiles(null);
    profiles.sessions.set("other-account", { page: other });
    const session = { context, page: own };
    assert.equal((await profiles.inspect({ id: "own-account", provider: "flow" }, session)).status, "needs_login");
    assert.equal(session.page, own);
  } finally {
    await browser.close();
  }
});
