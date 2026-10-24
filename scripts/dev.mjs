import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const processes = [];
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  for (const child of processes) child.kill();
};
for (const script of ['server/index.js', 'node_modules/vite/bin/vite.js']) {
  const child = spawn(process.execPath, [script], { cwd: root, stdio: 'inherit', windowsHide: true });
  child.once('exit', (code) => {
    close();
    process.exitCode = code || 0;
  });
  processes.push(child);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
