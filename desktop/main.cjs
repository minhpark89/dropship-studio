const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let studio;
let window;
let splash;
let closing = false;

const splashHtml = (version) => `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:grid;place-items:center;background:#101416;color:#f3f7f5;font:14px "Segoe UI Variable","Segoe UI",sans-serif;-webkit-app-region:drag}.card{width:100%;height:100%;display:grid;place-items:center;text-align:center;padding:32px}.mark{width:54px;height:54px;border:1px solid #ffb27b;border-radius:16px;display:grid;place-items:center;margin:0 auto 18px;background:linear-gradient(145deg,#4a3026,#1f2025);box-shadow:0 8px 30px #0005}.mark:before{content:"";width:22px;height:22px;border-radius:7px;background:#ffc28e;box-shadow:8px -7px 0 -3px #ef8650}.name{font-size:21px;font-weight:700;letter-spacing:.03em}.name span{display:block;color:#ffc18b;font-size:10px;letter-spacing:.2em;margin-top:4px}.status{margin-top:23px;color:#b5c4be;font-size:12px}.bar{height:3px;width:180px;margin:10px auto 0;background:#3d2b29;border-radius:3px;overflow:hidden}.bar i{display:block;height:100%;width:38%;background:#ffad73;border-radius:3px;animation:load 1.2s ease-in-out infinite}@keyframes load{0%{transform:translateX(-130%)}100%{transform:translateX(480%)}}.version{position:absolute;bottom:16px;color:#71847d;font-size:11px;letter-spacing:.08em}</style></head><body><div class="card"><div><div class="mark"></div><div class="name">Viral<span>STUDIO</span></div><div class="status" id="status">Starting local workspace...</div><div class="bar"><i></i></div></div></div><div class="version">v${version}</div></body></html>`;

function createSplash() {
  splash = new BrowserWindow({ width: 460, height: 300, frame: false, resizable: false, movable: true, show: true, center: true, title: `Viral Studio v${app.getVersion()}`, backgroundColor: "#101416", webPreferences: { sandbox: true } });
  splash.setMenuBarVisibility(false);
  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(app.getVersion()))}`);
}

function setSplashStatus(status) {
  if (!splash || splash.isDestroyed()) return;
  splash.webContents.executeJavaScript(`document.getElementById('status').textContent=${JSON.stringify(String(status))}`).catch(() => {});
}

function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.close();
  splash = null;
}

async function openDataFolder() {
  const error = await shell.openPath(studio.store.root);
  if (error) throw new Error(error);
  return { opened: true };
}

const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();

app.on("second-instance", () => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app
  .whenReady()
  .then(async () => {
    if (!locked) return;
    app.setAppUserModelId("local.viral.studio");
    createSplash();
    setSplashStatus("Preparing local workspace...");
    const { startServer } = await import(
      pathToFileURL(path.join(__dirname, "../server/index.js")).href
    );
    const { findInstance } = await import(
      pathToFileURL(path.join(__dirname, "../server/instance.js")).href
    );
    const packagedRoot = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe"));
    const preferredData = path.join(packagedRoot, "Viral Data");
    const legacyData = path.join(packagedRoot, "Dropship Data");
    const installedLegacyData = path.join(path.dirname(packagedRoot), "Dropship Studio", "Dropship Data");
    // A portable build is often launched from the repository's release folder
    // while the installed Dropship/Viral build still owns the user's data.
    // Reuse that existing store so an upgrade does not appear to lose projects,
    // research results, accounts or the new Research render action.
    const commonInstalledLegacyData = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Dropship Studio", "Dropship Data")
      : "";
    const commonInstalledViralData = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Viral Studio", "Viral Data")
      : "";
    const directory = process.env.STUDIO_DATA_DIR || (app.isPackaged
      ? (fs.existsSync(preferredData)
        ? preferredData
        : fs.existsSync(legacyData)
          ? legacyData
          : fs.existsSync(installedLegacyData)
            ? installedLegacyData
            : fs.existsSync(commonInstalledLegacyData)
              ? commonInstalledLegacyData
              : fs.existsSync(commonInstalledViralData)
                ? commonInstalledViralData
                : preferredData)
      : path.join(__dirname, "../.studio"));
    setSplashStatus("Checking the local server...");
    let existing = await findInstance(directory);
    if (!existing) {
      try {
        setSplashStatus("Starting local server...");
        studio = await startServer({
          port: 0,
          dataDir: directory,
          desktop: { reveal: async (target) => shell.showItemInFolder(target) },
        });
      } catch (error) {
        if (error.code !== "INSTANCE_RUNNING") throw error;
        existing = await findInstance(directory);
        if (!existing) throw error;
      }
    }
    if (existing) {
      studio = {
        address: existing.address,
        store: { root: existing.root },
        close: async () => {},
      };
    }
    setSplashStatus("Opening Viral Studio...");
    window = new BrowserWindow({
      width: 1440,
      height: 950,
      minWidth: 960,
      minHeight: 700,
      title: `Viral Studio v${app.getVersion()}`,
      icon: path.join(__dirname, "../build/icon.ico"),
      backgroundColor: "#101416",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    ipcMain.handle("studio:open-data-folder", async (event) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== new URL(studio.address).origin
      ) {
        throw new Error("Yêu cầu không thuộc cửa sổ Viral Studio.");
      }
      return openDataFolder();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (
        /^https:\/\/(?:www\.)?(?:dola\.com|flow\.google\.com)(?:\/|$)/.test(url)
      )
        shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(`${studio.address}/`)) event.preventDefault();
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Ứng dụng",
          submenu: [
            {
              label: "Mở thư mục dữ liệu",
              click: () => openDataFolder().catch((error) => {
                dialog.showErrorBox("Không mở được thư mục dữ liệu", error.message);
              }),
            },
            { type: "separator" },
            { label: "Thoát", accelerator: "Alt+F4", click: () => app.quit() },
          ],
        },
        {
          label: "Chỉnh sửa",
          submenu: [
            { role: "undo", label: "Hoàn tác nhập" },
            { role: "redo", label: "Làm lại nhập" },
            { type: "separator" },
            { role: "cut", label: "Cắt" },
            { role: "copy", label: "Sao chép" },
            { role: "paste", label: "Dán" },
            { role: "selectAll", label: "Chọn tất cả" },
          ],
        },
        {
          label: "Hiển thị",
          submenu: [
            { role: "reload", label: "Tải lại giao diện" },
            { role: "resetZoom", label: "Kích thước mặc định" },
            { role: "zoomIn", label: "Phóng to" },
            { role: "zoomOut", label: "Thu nhỏ" },
            { role: "togglefullscreen", label: "Toàn màn hình" },
          ],
        },
      ]),
    );
    window.once("ready-to-show", () => {
      window.show();
      closeSplash();
    });
    await window.loadURL(studio.address);
  })
  .catch((error) => {
    closeSplash();
    dialog.showErrorBox("Không mở được Viral Studio", error.message);
    app.exit(1);
  });

app.on("before-quit", (event) => {
  if (closing || !studio) return;
  event.preventDefault();
  closing = true;
  if (window && !window.isDestroyed()) window.hide();
  Promise.resolve()
    .then(() => studio.close())
    .then(
      () => app.exit(0),
      () => app.exit(1),
    );
});
app.on("window-all-closed", () => app.quit());
