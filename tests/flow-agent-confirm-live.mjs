import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { decodeFlowRpc } from '../server/providers/flow-rpc.js';

const directory = path.resolve('.verification/flow-agent-live');
const filename = path.join(directory, 'confirmation.json');
const plan = JSON.parse(await fs.readFile(path.join(directory, 'plan.json'), 'utf8'));
assert.equal(await fs.stat(filename).then(() => true, () => false), false, 'Confirmation already attempted; observe without resubmitting.');
const report = { projectUrl: plan.projectUrl, events: [], requests: [], at: new Date().toISOString() };
const save = () => fs.writeFile(filename, JSON.stringify(report, null, 2));
function safe(value, depth = 0) {
  if (depth > 40) return '<depth>';
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
assert.ok(page, 'Existing proposal project must remain open.');
const pending = new Set();
const relevant = url => /\/data\/batchexecute(?:\?|$)|FlowCreationAgentService\/StreamChat/.test(url);
const requestListener = request => {
  if (!relevant(request.url())) return;
  const body = request.postData() || '';
  const encoded = new URLSearchParams(body).get('f.req');
  report.requests.push({ path: new URL(request.url()).pathname, data: safe(unpack(encoded || body)) });
};
const responseListener = response => {
  if (!relevant(response.url())) return;
  const operation = (async () => {
    const text = await response.text();
    const data = /batchexecute/.test(response.url()) ? decodeFlowRpc(text) : unpack(text);
    report.events.push({ path: new URL(response.url()).pathname, status: response.status(), data: safe(data) });
  })().catch(error => report.events.push({ readError: error.name }));
  pending.add(operation);
  operation.finally(() => pending.delete(operation));
};
try {
  const panel = page.locator('flow-agent-panel');
  const text = await panel.innerText();
  assert.match(text, /Model: Veo 3\.1 - Fast/);
  assert.match(text, /Duration: 8 seconds/);
  assert.match(text, /Aspect Ratio: 9:16/);
  assert.match(text, /Quantity: 1 video/);
  assert.match(text, /Please confirm/);
  assert.equal(await panel.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
  page.on('request', requestListener);
  page.on('response', responseListener);
  await panel.locator('div.ProseMirror[contenteditable="true"]').fill('Yes, proceed with exactly this one video: Veo 3.1 Fast, 8 seconds, portrait 9:16, quantity 1, using the proposed water bottle prompt.');
  report.confirmationAttemptedAt = new Date().toISOString();
  await save();
  await panel.getByRole('button', { name: 'Start generation', exact: true }).click();
  for (let iteration = 0; iteration < 12; iteration += 1) {
    await page.waitForTimeout(10000);
    const busy = await panel.getByRole('button', { name: 'Stop', exact: true }).count();
    console.log(JSON.stringify({ elapsedSeconds: (iteration + 1) * 10, busy: Boolean(busy), events: report.events.length }));
    if (!busy) break;
  }
  report.panelText = safe(await panel.innerText());
  report.controls = await panel.locator('button').evaluateAll(elements => elements.map(element => ({ label: element.getAttribute('aria-label'), text: element.innerText, disabled: element.disabled })));
  await page.screenshot({ path: path.join(directory, 'confirmation.png') });
  await fs.writeFile(path.join(directory, 'confirmation-panel.html'), await panel.innerHTML());
  await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => setTimeout(resolve, 5000))]);
  await save();
  console.log(JSON.stringify({ text: report.panelText, controls: report.controls, events: report.events.length }));
} finally {
  page.off('request', requestListener);
  page.off('response', responseListener);
  await browser.close();
}
