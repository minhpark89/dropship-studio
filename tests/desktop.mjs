import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const packaged = process.argv.includes('--packaged');
const output = path.resolve('.verification', packaged ? 'desktop-packaged' : 'desktop');
await fs.mkdir(output, { recursive: true });
const env = { ...process.env, STUDIO_DATA_DIR: path.join(output, `data-${randomUUID()}`) };
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({
  executablePath: path.resolve(packaged ? 'release/win-unpacked/Dropship Studio.exe' : 'node_modules/electron/dist/electron.exe'),
  args: packaged ? [] : [path.resolve('desktop/main.cjs')],
  env,
  timeout: 60000,
});
const errors = [];
try {
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.getByRole('heading', { name: 'Bắt đầu bằng một ý tưởng.' }).waitFor();
  const data = await page.evaluate(async () => (await fetch('/api/health')).json());
  assert.ok(data.tools.every((tool) => tool.available));
  assert.equal(data.browser.available, true);
  const system = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), userData: app.getPath('userData') }));
  assert.equal(system.packaged, packaged);
  const isNodeExposed = await page.evaluate(() => typeof window.require !== 'undefined' || typeof window.process !== 'undefined');
  assert.equal(isNodeExposed, false);
  await page.locator('nav').getByRole('button', { name: 'Tài khoản', exact: true }).click();
  await page.getByRole('heading', { name: 'Tài khoản của bạn.' }).waitFor();
  await page.screenshot({ path: path.join(output, 'accounts.png'), fullPage: true });
  await page.locator('nav').getByRole('button', { name: 'Dựng video', exact: true }).click();
  await page.getByRole('heading', { name: 'Dựng câu chuyện của bạn.' }).waitFor();
  await page.screenshot({ path: path.join(output, 'editor.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const report = { passed: true, packaged, system, tools: data.tools, browserAvailable: data.browser.available, nodeExposed: isNodeExposed, errors };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await application.close();
}
