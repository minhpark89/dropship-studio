import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { BrowserProfiles } from '../server/providers/browser-profiles.js';

assert.equal(process.platform, 'win32', 'This regression verifies actual Windows HWNDs.');
const execute = promisify(execFile);
const output = path.resolve('.verification/windows-login');
await fs.mkdir(output, { recursive: true });
const root = path.join(output, `data-${randomUUID()}`);
const store = new Store(root);
const profiles = new BrowserProfiles(store);
const account = store.add('accounts', { name: 'Isolated window test', provider: 'dola', loginMethod: 'google', status: 'offline' });
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(request.url === '/popup'
    ? '<title>QA Sign-in Popup</title><h1>Local authentication popup fixture</h1><input type="email" aria-label="Email">'
    : '<title>QA Dola Window</title><h1>Local service fixture</h1><button onclick="window.open(\'/popup\', \'qa-login\', \'width=560,height=640\')">Open sign-in popup</button>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const providerSource = await fs.readFile('server/providers/browser-profiles.js', 'utf8');
const report = {
  at: new Date().toISOString(),
  providerSourceSha256: createHash('sha256').update(providerSource).digest('hex'),
  hasRevealMethod: typeof profiles.reveal === 'function',
  root,
  fixture: address,
  checks: [],
  errors: [],
};
const nativeState = async (session, action = 'inspect') => {
  const result = await execute('python', [path.resolve('tests/windows-window-state.py'), String(session.child.pid), action], { windowsHide: true });
  return JSON.parse(result.stdout);
};
const visible = (state) => state.windows.some((window) => window.visible && !window.minimized && window.onScreen);
const record = async (name, operation) => {
  try {
    const evidence = await operation();
    report.checks.push({ name, passed: true, evidence });
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.message, evidence: error.evidence });
    report.errors.push(`${name}: ${error.message}`);
  }
};
const requireVisible = (state, message) => {
  try {
    assert.ok(visible(state), message);
  } catch (error) {
    error.evidence = state;
    throw error;
  }
};

try {
  let session = await profiles.open(account, { visible: true });
  await session.page.goto(address);
  await delay(300);
  await record('Interactive Chrome owns a visible non-minimized on-screen window', async () => {
    const state = await nativeState(session);
    requireVisible(state, 'Chrome process exists but no visible on-screen browser window exists.');
    await session.page.screenshot({ path: path.join(output, 'interactive.png') });
    return state;
  });
  await record('Reopening a minimized account restores its native window', async () => {
    await nativeState(session, 'minimize');
    await delay(200);
    const minimized = await nativeState(session);
    assert.ok(minimized.windows.some((window) => window.minimized), 'Fixture did not minimize Chrome.');
    session = await profiles.open(account, { visible: true });
    await delay(300);
    const restored = await nativeState(session);
    requireVisible(restored, 'Opening the account left its window minimized or hidden.');
    return { minimized, restored };
  });
  await record('Sign-in popup appears on-screen and can receive input', async () => {
    const popupEvent = session.context.waitForEvent('page');
    await session.page.getByRole('button', { name: 'Open sign-in popup' }).click();
    const popup = await popupEvent;
    await popup.waitForLoadState('domcontentloaded');
    if (profiles.reveal) await profiles.reveal(session, popup);
    else await popup.bringToFront();
    await popup.getByLabel('Email').fill('fixture@example.invalid');
    await delay(300);
    const state = await nativeState(session);
    const popupWindow = state.windows.find((window) => window.title.includes('QA Sign-in Popup'));
    try {
      assert.ok(popupWindow?.visible && !popupWindow.minimized && popupWindow.onScreen, 'The sign-in popup is hidden, minimized, or off-screen.');
      assert.equal(popupWindow.foreground, true, 'The sign-in popup did not reach the Windows foreground.');
      assert.equal(await popup.getByLabel('Email').inputValue(), 'fixture@example.invalid');
    } catch (error) {
      error.evidence = state;
      throw error;
    }
    await popup.screenshot({ path: path.join(output, 'popup.png') });
    await popup.close();
    return state;
  });
  await record('An off-screen account window is moved back onto the desktop', async () => {
    const cdp = await session.context.newCDPSession(session.page);
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -12000, top: -12000, width: 800, height: 600 } });
      await delay(150);
      const before = await nativeState(session);
      assert.equal(before.windows.some((window) => window.visible && window.onScreen), false, 'Fixture did not move Chrome off-screen.');
      await profiles.open(account, { visible: true });
      await delay(300);
      const after = await nativeState(session);
      requireVisible(after, 'The account window remained outside the desktop.');
      return { before, after };
    } finally {
      await cdp.detach();
    }
  });
  await record('A closed primary tab does not prevent reopening the account', async () => {
    const replacement = await session.context.newPage();
    await replacement.goto(address);
    await session.page.close();
    session = await profiles.open(account, { visible: true });
    assert.equal(session.page.isClosed(), false);
    await delay(150);
    const state = await nativeState(session);
    requireVisible(state, 'The remaining browser window was not shown after closing its original tab.');
    return state;
  });
  await record('Closing and reopening the account creates another visible window', async () => {
    const oldPid = session.child.pid;
    await profiles.close(account.id);
    session = await profiles.open(account, { visible: true });
    await session.page.goto(address);
    await delay(300);
    const state = await nativeState(session);
    requireVisible(state, 'Reopened Chrome is not visible.');
    assert.notEqual(session.child.pid, oldPid);
    return state;
  });
  await record('A background profile changes into a visible interactive account', async () => {
    await profiles.close(account.id);
    const background = await profiles.open(account);
    await background.page.goto(address);
    const before = await nativeState(background);
    assert.equal(before.windows.some((window) => window.visible), false);
    session = await profiles.open(account, { visible: true });
    await session.page.goto(address);
    await delay(300);
    const after = await nativeState(session);
    requireVisible(after, 'A headless account did not become visible.');
    assert.notEqual(background.child.pid, session.child.pid);
    return { before, after };
  });
} catch (error) {
  report.errors.push(error.message);
} finally {
  await profiles.closeAll();
  await new Promise((resolve) => server.close(resolve));
  report.passed = report.errors.length === 0;
  const filename = process.argv.includes('--baseline') ? 'baseline.json' : 'report.json';
  await fs.writeFile(path.join(output, filename), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
if (!report.passed) process.exitCode = 1;
