import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../server/index.js";

assert.equal(process.platform, "win32", "Native Explorer verification requires Windows");
const execute = promisify(execFile);
const output = path.resolve(".verification/desktop-folder-native");
const root = path.join(output, `data-${randomUUID()}`);
const screenshot = path.join(output, "explorer.png");
await fs.mkdir(output, { recursive: true });
const errors = [];
const report = {
  passed: false,
  at: new Date().toISOString(),
  root,
  errors,
  checks: [],
};

const inspectScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FolderNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr handle, out RECT bounds);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr handle, IntPtr target, uint flags);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
'@
$expected = [IO.Path]::GetFullPath($env:DS_NATIVE_FOLDER)
$shellApp = New-Object -ComObject Shell.Application
$found = @()
$closed = @()
foreach ($entry in @($shellApp.Windows())) {
  try {
    if ([IO.Path]::GetFileName($entry.FullName) -ine 'explorer.exe') {
      continue
    }
    $folder = [IO.Path]::GetFullPath($entry.Document.Folder.Self.Path)
    if (![String]::Equals($folder, $expected, [StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    $handle = [IntPtr][long]$entry.HWND
  } catch {
    continue
  }
  if ($env:DS_NATIVE_ACTION -eq 'close') {
    if ($env:DS_NATIVE_HANDLE -and $handle.ToInt64().ToString() -ne $env:DS_NATIVE_HANDLE) {
      continue
    }
    $entry.Quit()
    $closed += $handle.ToInt64().ToString()
    continue
  }
  $bounds = New-Object FolderNative+RECT
  [void][FolderNative]::GetWindowRect($handle, [ref]$bounds)
  $captured = $false
  if ($env:DS_NATIVE_ACTION -eq 'capture') {
    Add-Type -AssemblyName System.Drawing
    $width = $bounds.Right - $bounds.Left
    $height = $bounds.Bottom - $bounds.Top
    if ($width -gt 0 -and $height -gt 0) {
      $bitmap = New-Object Drawing.Bitmap($width, $height)
      $graphics = [Drawing.Graphics]::FromImage($bitmap)
      $device = $graphics.GetHdc()
      try {
        $captured = [FolderNative]::PrintWindow($handle, $device, 2)
      } finally {
        $graphics.ReleaseHdc($device)
        $graphics.Dispose()
      }
      try {
        if ($captured) {
          $bitmap.Save($env:DS_NATIVE_SHOT, [Drawing.Imaging.ImageFormat]::Png)
        }
      } finally {
        $bitmap.Dispose()
      }
    }
  }
  $found += [pscustomobject]@{
    path = $folder
    handle = $handle.ToInt64().ToString()
    visible = [FolderNative]::IsWindowVisible($handle)
    minimized = [FolderNative]::IsIconic($handle)
    foreground = [FolderNative]::GetForegroundWindow() -eq $handle
    bounds = $bounds
    screenshotCaptured = $captured
  }
}
[pscustomobject]@{ windows = @($found); closed = @($closed) } | ConvertTo-Json -Depth 5 -Compress
`;

async function native(action, handle = "") {
  const { stdout } = await execute("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(inspectScript, "utf16le").toString("base64"),
  ], {
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      DS_NATIVE_FOLDER: root,
      DS_NATIVE_SHOT: screenshot,
      DS_NATIVE_ACTION: action,
      DS_NATIVE_HANDLE: handle,
    },
  });
  return JSON.parse(stdout.trim());
}

let studio;
let application;
try {
  studio = await startServer({ port: 0, dataDir: root });
  report.identity = await (await fetch(`${studio.address}/api/instance`)).json();
  assert.equal((await native("inspect")).windows.length, 0);
  const env = { ...process.env, STUDIO_DATA_DIR: root };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: path.resolve("release/win-unpacked/Viral Studio.exe"),
    args: [`--user-data-dir=${path.join(root, "electron-profile")}`],
    env,
    timeout: 60000,
  });
  const page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.getByRole("heading", { name: "Bắt đầu bằng một ý tưởng." }).waitFor();
  assert.equal(new URL(page.url()).origin, studio.address);
  report.packaged = await application.evaluate(({ app }) => app.isPackaged);
  assert.equal(report.packaged, true);
  await page.locator("nav").getByRole("button", { name: "Cài đặt", exact: true }).click();
  await page.getByRole("heading", { name: "Không gian theo cách bạn làm." }).waitFor();
  await page.getByRole("button", { name: "Mở thư mục", exact: true }).click();
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const result = await native("inspect");
    const window = result.windows.find((item) => item.visible && !item.minimized);
    if (window) {
      report.window = window;
      break;
    }
    await delay(400);
  }
  assert.ok(report.window, "Settings did not open a visible Explorer window at the exact test directory");
  assert.equal(path.resolve(report.window.path), root);
  assert.ok(report.window.bounds.Right - report.window.bounds.Left > 200);
  assert.ok(report.window.bounds.Bottom - report.window.bounds.Top > 200);
  report.checks.push("Settings button in packaged Electron opens real visible, non-minimized Explorer at the exact isolated data directory");
  const captured = await native("capture");
  report.capture = captured.windows.find((item) => item.handle === report.window.handle);
  assert.equal(report.capture?.screenshotCaptured, true);
  report.screenshot = screenshot;
  report.checks.push("PrintWindow captures only the confirmed test Explorer window");
  assert.deepEqual(errors, []);
  await application.close();
  application = null;
  assert.equal(studio.server.listening, true);
  const identityAfter = await (await fetch(`${studio.address}/api/instance`)).json();
  assert.deepEqual(identityAfter, report.identity);
  report.checks.push("Closing packaged desktop preserves the existing isolated backend");
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  try {
    report.cleanup = await native("close", report.window?.handle || "");
    await delay(300);
    const remaining = await native("inspect");
    report.cleanup.remainingMatchingWindows = remaining.windows.length;
    assert.equal(remaining.windows.length, 0);
  } catch (error) {
    report.cleanupError = error.message;
    report.passed = false;
    process.exitCode = 1;
  }
  if (application) await application.close();
  if (studio) await studio.close();
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
