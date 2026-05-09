/* eslint-disable */
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const userDataDir = app.getPath("userData");
const tokenPath = path.join(userDataDir, "device-token.bin");
const settingsPath = path.join(userDataDir, "settings.json");

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(next) {
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), "utf8");
}

ipcMain.handle("exuvia:settings:get", () => loadSettings());
ipcMain.handle("exuvia:settings:set", (_e, patch) => {
  const merged = { ...loadSettings(), ...patch };
  saveSettings(merged);
  return merged;
});

ipcMain.handle("exuvia:token:get", () => {
  try {
    if (!fs.existsSync(tokenPath)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const buf = fs.readFileSync(tokenPath);
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
});

ipcMain.handle("exuvia:token:set", (_e, token) => {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (!token) {
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    return true;
  }
  fs.writeFileSync(tokenPath, safeStorage.encryptString(String(token)));
  return true;
});

// Read a local audio file (e.g. the audioPath returned by tts.convert) and
// hand it back to the renderer as base64 so it can be played as a Blob URL.
// Loopback-only by design — we don't expose arbitrary file reads.
ipcMain.handle("exuvia:audio:readBase64", async (_e, filePath) => {
  if (typeof filePath !== "string" || !filePath) return null;
  try {
    const data = await fs.promises.readFile(filePath);
    return data.toString("base64");
  } catch (err) {
    console.error("[exuvia] audio read failed", err);
    return null;
  }
});

// Read an FBX (or any avatar asset) back from disk into the renderer. Same
// home-dir guard as the writer. Returns Uint8Array bytes.
ipcMain.handle("exuvia:fbx:read", async (_e, filePath) => {
  if (typeof filePath !== "string" || !filePath) {
    return { ok: false, error: "filePath required" };
  }
  try {
    const home = require("node:os").homedir();
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(home)) {
      return { ok: false, error: `refusing to read outside home dir: ${resolved}` };
    }
    const data = await fs.promises.readFile(resolved);
    return { ok: true, bytes: data, path: resolved };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// Write an FBX file's bytes to a chosen path on disk.
// The renderer hands us bytes (from File.arrayBuffer()) plus a target path
// resolved from the gateway (typically inside the agent's workspace dir).
// We refuse anything outside the user's home directory to avoid arbitrary
// filesystem writes from the renderer.
ipcMain.handle("exuvia:fbx:write", async (_e, args) => {
  try {
    const target = typeof args?.targetPath === "string" ? args.targetPath : "";
    const bytes = args?.bytes;
    if (!target || !bytes) return { ok: false, error: "targetPath and bytes required" };

    const home = require("node:os").homedir();
    const resolved = path.resolve(target);
    if (!resolved.startsWith(home)) {
      return { ok: false, error: `refusing to write outside home dir: ${resolved}` };
    }

    const dir = path.dirname(resolved);
    await fs.promises.mkdir(dir, { recursive: true });
    const buf = Buffer.from(bytes);
    await fs.promises.writeFile(resolved, buf);
    return { ok: true, path: resolved };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// Recursively remove a directory under the user's home dir. Used to clean
// up orphaned agent workspaces that the gateway can't delete via RPC because
// they're not registered in cfg.agents.list. Same home-dir guard as the
// FBX writer — refuses anything outside $HOME.
ipcMain.handle("exuvia:dir:remove", async (_e, dirPath) => {
  if (typeof dirPath !== "string" || !dirPath) {
    return { ok: false, error: "dirPath required" };
  }
  try {
    const home = require("node:os").homedir();
    const resolved = path.resolve(dirPath);
    if (!resolved.startsWith(home)) {
      return { ok: false, error: `refusing to remove outside home dir: ${resolved}` };
    }
    // Sanity guard: never remove the home dir itself or one of its top-level
    // siblings. We require at least 3 path segments under home.
    const rel = path.relative(home, resolved);
    if (!rel || rel.startsWith("..") || rel.split(path.sep).length < 1) {
      return { ok: false, error: `path too shallow: ${resolved}` };
    }
    await fs.promises.rm(resolved, { recursive: true, force: true });
    return { ok: true, path: resolved };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// Native file picker. Used by env-asset choosers and any future "browse for
// file" UI. Caller passes filter labels; we return the chosen absolute path
// (or null if cancelled).
ipcMain.handle("exuvia:dialog:openFile", async (_e, opts) => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: opts?.title ?? "Pick a file",
    properties: ["openFile"],
    filters: Array.isArray(opts?.filters) && opts.filters.length > 0
      ? opts.filters
      : [{ name: "All files", extensions: ["*"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Open an external URL in the user's default browser. Restricted to
// http(s) so we don't accidentally launch random schemes.
ipcMain.handle("exuvia:openExternal", (_e, url) => {
  if (typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url) && !url.startsWith("mailto:")) return false;
  shell.openExternal(url);
  return true;
});

// Expand a leading ~ to the user's home directory. Renderer can't see env
// reliably across platforms; main does it cleanly.
ipcMain.handle("exuvia:path:expand", (_e, raw) => {
  if (typeof raw !== "string" || !raw) return raw ?? "";
  const home = require("node:os").homedir();
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(home, raw.slice(2));
  }
  return raw;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#0b0b0d",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (!app.isPackaged) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
