import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { decodeFlowRpc } from '../server/providers/flow-rpc.js';

const directory = path.resolve('.verification/flow-agent-live');
const filename = path.join(directory, 'approval.json');
const plan = JSON.parse(await fs.readFile(path.join(directory, 'plan.json'), 'utf8'));
assert.equal(await fs.stat(filename).then(() => true, () => false), false, 'Approval already attempted; never automatically repeat.');
const report = { projectUrl: plan.projectUrl, events: [], requests: [], at: new Date().toISOString() };
let saving = Promise.resolve();
function save() {
  const data = JSON.stringify(report, null, 2);
  saving = saving.then(() => fs.writeFile(filename, data));
  return saving;
}
function safe(value, depth = 0) {
  if (depth > 50) return '<depth>';
  if (Array.isArray(value)) return value.map(item => safe(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|cookie|password|credential|authorization/i.test(key) ? '<redacted>' : safe(item, depth + 1)]));
  }
  if (typeof value !== 'string') return value;
  if (/^[\[{]/.test(value)) {
    try { return safe(JSON.parse(value), depth + 1); } catch {}
  }
  if (/https?:\/\//.test(value)) return value.replace(/https?:\/\/[^\s"<>]+/g, match => {
    try { return `<url:${new URL(match).hostname}>`; } catch { return '<url>'; }
  });
  if (/@/.test(value)) return '<redacted>';
  if (value.length > 160 && !/\s/.test(value)) return `<opaque:${value.length}>`;
  return value;
}
function unpack(text) {
  try { return JSON.parse(text); } catch {}
  return text.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return line; }
  });
}
const browser = await chromium.connectOverCDP('http://127.0.0.1:64478');
const page = browser.contexts()[0].pages().find(item => item.url() === plan.projectUrl);
assert.ok(page, 'Original proposal project must be open.');
const relevant = url => {
  const parsed = new URL(url);
  return ['flow.google.com', 'aisandbox-pa.googleapis.com'].includes(parsed.hostname) && /batchexecute|StreamChat|operations|media/.test(parsed.pathname);
};
const pending = new Set();
const requestListener = request => {
  if (!relevant(request.url())) return;
  const body = request.postData() || '';
  const encoded = new URLSearchParams(body).get('f.req');
  report.requests.push({ path: new URL(request.url()).pathname, data: safe(unpack(encoded || body)) });
  void save();
};
const responseListener = response => {
  if (!relevant(response.url())) return;
  const operation = (async () => {
    const text = await response.text();
    if (text.length > 8000000) return;
    const data = /batchexecute/.test(response.url()) ? decodeFlowRpc(text) : unpack(text);
    report.events.push({ path: new URL(response.url()).pathname, status: response.status(), data: safe(data) });
    await save();
  })().catch(error => report.events.push({ readError: error.name }));
  pending.add(operation);
  operation.finally(() => pending.delete(operation));
};
try {
  const panel = page.locator('flow-agent-panel');
  const permission = panel.locator('flow-chat-bubble').filter({ has: page.locator('flow-permission-message') });
  assert.equal(await permission.count(), 1);
  report.permissionText = await permission.innerText();
  assert.match(report.permissionText, /generate 1 video/);
  assert.match(report.permissionText, /Veo 3\.1 - Fast/);
  assert.match(report.permissionText, /9:16/);
  assert.match(report.permissionText, /costing 20 credits/);
  const approve = permission.getByRole('radio', { name: 'Approve', exact: true });
  assert.equal(await approve.count(), 1);
  assert.equal(await approve.getAttribute('aria-disabled'), 'false');
  page.on('request', requestListener);
  page.on('response', responseListener);
  report.mediaApprovalAttemptedAt = new Date().toISOString();
  await save();
  await approve.click({ timeout: 15000 });
  for (let iteration = 0; iteration < 60; iteration += 1) {
    await page.waitForTimeout(10000);
    report.panelText = safe(await panel.innerText());
    report.observedAt = new Date().toISOString();
    report.mediaElements = await page.locator('video').count();
    await save();
    if (iteration % 3 === 0) console.log(JSON.stringify({ seconds: (iteration + 1) * 10, events: report.events.length, videos: report.mediaElements, tail: report.panelText.slice(-1500) }));
    const stop = await panel.getByRole('button', { name: 'Stop', exact: true }).count();
    if (iteration >= 5 && !stop && !/generating|in progress|\b\d+%/i.test(report.panelText.slice(-2000))) break;
  }
  await fs.writeFile(path.join(directory, 'result-panel.html'), await panel.innerHTML());
  const cdp = await page.context().newCDPSession(page);
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).catch(() => null);
  if (screenshot) await fs.writeFile(path.join(directory, 'result.png'), Buffer.from(screenshot.data, 'base64'));
  await cdp.detach();
  console.log(JSON.stringify({ events: report.events.length, text: report.panelText }));
} finally {
  page.off('request', requestListener);
  page.off('response', responseListener);
  await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => setTimeout(resolve, 3000))]);
  await save();
  await browser.close();
}
