import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const execute = promisify(execFile);
const output = path.resolve(".verification/portable-launcher");
const runRoot = path.join(output, `run-${randomUUID()}`);
const sourceExe = path.resolve("release/Dropship Studio 0.1.2.exe");
const sourceLauncher = path.resolve("../Mo Dropship Studio.cmd");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = { passed: false, at: new Date().toISOString(), runRoot, cases: [], errors: [] };
await fs.mkdir(runRoot, { recursive: true });
report.artifact = { file: sourceExe, sha256: hash(await fs.readFile(sourceExe)), bytes: (await fs.stat(sourceExe)).size };
report.launcherSha256 = hash(await fs.readFile(sourceLauncher));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(operation, message, milliseconds = 90000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await delay(300);
  }
  throw new Error(message);
}

async function windowAction(pid, action, screenshot) {
  const args = [path.resolve("tests/portable-window.py"), String(pid), action];
  if (screenshot) args.push(screenshot);
  return JSON.parse((await execute("python", args, { windowsHide: true })).stdout);
}

async function liveOwner(directory) {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(directory, ".server-instance.json"), "utf8"));
    if (!owner.address) return null;
    const response = await fetch(owner.address + "/api/instance", { signal: AbortSignal.timeout(1000) });
    const current = await response.json();
    return current.id === owner.id && path.resolve(current.root) === path.resolve(directory) ? current : null;
  } catch {
    return null;
  }
}

async function runCase(mode) {
  const root = path.join(runRoot, mode);
  const exe = mode === "launcher"
    ? path.join(root, "studio/release/Dropship Studio 0.1.2.exe")
    : path.join(root, "Dropship Studio 0.1.2.exe");
  const data = mode === "launcher" ? path.join(root, "studio/.studio") : path.join(root, "Dropship Data");
  const temporary = path.join(root, "temporary");
  const appData = path.join(root, "appdata");
  await fs.mkdir(path.dirname(exe), { recursive: true });
  await fs.mkdir(temporary, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.link(sourceExe, exe);
  const env = { ...process.env, APPDATA: appData, LOCALAPPDATA: path.join(root, "localappdata"), TEMP: temporary, TMP: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.STUDIO_DATA_DIR;
  delete env.PORTABLE_EXECUTABLE_DIR;
  delete env.PORTABLE_EXECUTABLE_FILE;
  delete env.NODE_OPTIONS;
  const cdpPort = mode === "direct" ? await freePort() : null;
  let child;
  if (mode === "launcher") {
    const launcher = path.join(root, "Mo Dropship Studio.cmd");
    await fs.copyFile(sourceLauncher, launcher);
    assert.equal(hash(await fs.readFile(launcher)), report.launcherSha256);
    child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${launcher}""`], {
      cwd: root, env, windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore",
    });
  } else {
    child = spawn(exe, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(root, "electron-profile")}`], {
      cwd: root, env, windowsHide: true, stdio: "ignore",
    });
  }
  let launchError = null;
  child.once("error", (error) => { launchError = error; });
  let owner;
  let browser;
  const evidence = { mode, expectedRoot: data, wrapperPid: child.pid, consoleErrors: [] };
  report.cases.push(evidence);
  try {
    owner = await until(async () => {
      if (launchError) throw launchError;
      return liveOwner(data);
    }, `${mode}: portable backend did not start in the isolated data directory`);
    evidence.identity = owner;
    const processInfo = JSON.parse((await execute("powershell.exe", ["-NoProfile", "-Command", `Get-Process -Id ${owner.pid} | Select-Object Id,Path | ConvertTo-Json -Compress`], { windowsHide: true })).stdout);
    assert.ok(path.resolve(processInfo.Path).toLowerCase().startsWith(path.resolve(temporary).toLowerCase() + path.sep));
    evidence.extractedProcess = processInfo;
    evidence.health = await (await fetch(owner.address + "/api/health")).json();
    assert.ok(evidence.health.tools.every((tool) => tool.available));
    assert.equal(evidence.health.browser.available, true);
    const state = await (await fetch(owner.address + "/api/state")).json();
    assert.equal(state.accounts.length, 0);
    assert.equal(state.jobs.length, 0);
    assert.equal(state.capabilities.googleProfileReuse, true);
    evidence.window = await until(async () => {
      const result = await windowAction(owner.pid, "inspect");
      return result.windows.find((window) => window.visible && !window.minimized) ? result : null;
    }, `${mode}: test app window was not visible`, 15000);
    if (mode === "direct") {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      const page = browser.contexts()[0].pages().find((page) => page.url().startsWith(owner.address));
      assert.ok(page);
      page.on("pageerror", (error) => evidence.consoleErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") evidence.consoleErrors.push(message.text());
      });
      await page.getByRole("heading", { name: "Bắt đầu bằng một ý tưởng." }).waitFor();
      evidence.nodeExposed = await page.evaluate(() => typeof window.require !== "undefined" || typeof window.process !== "undefined");
      assert.equal(evidence.nodeExposed, false);
      await page.locator("nav").getByRole("button", { name: "Tài khoản", exact: true }).click();
      await page.getByRole("heading", { name: "Tài khoản của bạn." }).waitFor();
      await page.screenshot({ path: path.join(output, "direct-portable-ui.png"), fullPage: true });
      assert.deepEqual(evidence.consoleErrors, []);
      await browser.close();
      browser = null;
    } else {
      evidence.consoleCapture = "Not instrumented; launcher window verified natively and backend checked by HTTP.";
    }
    evidence.capture = await windowAction(owner.pid, "capture", path.join(output, `${mode}-window.png`));
    evidence.startupPassed = true;
  } finally {
    await browser?.close().catch(() => {});
    if (owner && await liveOwner(data)) {
      evidence.close = await windowAction(owner.pid, "close");
      try {
        await until(async () => {
          if (await liveOwner(data)) return false;
          try {
            process.kill(owner.pid, 0);
            return false;
          } catch {
            return true;
          }
        }, `${mode}: test app did not close cleanly`, 15000);
      } catch (error) {
        evidence.closeError = error.message;
        evidence.passed = false;
        evidence.errorDialog = await windowAction(owner.pid, "capture-dialog", path.join(output, `${mode}-close-error.png`));
        await windowAction(owner.pid, "close-dialog");
        const current = await liveOwner(data);
        assert.equal(current?.id, owner.id, "Refusing cleanup: test backend ownership changed");
        const currentProcess = JSON.parse((await execute("powershell.exe", ["-NoProfile", "-Command", `Get-Process -Id ${owner.pid} | Select-Object Id,Path | ConvertTo-Json -Compress`], { windowsHide: true })).stdout);
        assert.equal(currentProcess.Path, evidence.extractedProcess.Path, "Refusing cleanup: process path changed");
        process.kill(owner.pid);
        evidence.forcedTestCleanup = true;
        throw error;
      }
      evidence.closed = true;
      evidence.lockReleased = !(await fs.stat(path.join(data, ".server-instance.json")).catch(() => null));
      assert.equal(evidence.lockReleased, true);
      evidence.passed = true;
    }
  }
}

try {
  for (const mode of ["direct", "launcher"]) {
    try {
      await runCase(mode);
    } catch (error) {
      report.errors.push(error.message);
    }
  }
  assert.equal(hash(await fs.readFile(sourceExe)), report.artifact.sha256);
  assert.equal(hash(await fs.readFile(sourceLauncher)), report.launcherSha256);
  report.passed = report.errors.length === 0;
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.errors.push(error.message);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
