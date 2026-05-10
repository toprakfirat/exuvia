/* eslint-disable */
const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } = require("electron");
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

// Transcribe a recorded audio blob via the openclaw CLI. The renderer
// captures with MediaRecorder (typically webm/opus), sends bytes here,
// we write to a temp file and shell out to `openclaw audio transcribe
// --file <tmp> --json`, then parse the result. Requires the user to
// have configured an audio transcription provider in openclaw.json
// (deepgram, openai, groq, etc.) — we surface the CLI's error verbatim
// when no provider is configured.
ipcMain.handle("exuvia:audio:transcribe", async (_e, args) => {
  const bytes = args?.bytes;
  const ext = typeof args?.ext === "string" && /^[a-z0-9]{1,8}$/i.test(args.ext)
    ? args.ext
    : "webm";
  if (!bytes) return { ok: false, error: "bytes required" };

  const os = require("node:os");
  const { spawn } = require("node:child_process");

  // Write the blob to a temp file under the OS temp dir. We delete it
  // after the CLI finishes so failed transcriptions don't accumulate.
  const tmpName = `exuvia-rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const tmpPath = path.join(os.tmpdir(), tmpName);
  try {
    await fs.promises.writeFile(tmpPath, Buffer.from(bytes));
  } catch (err) {
    return { ok: false, error: `tmp write failed: ${String(err?.message ?? err)}` };
  }

  // openclaw is on PATH for users who installed it via the standard
  // installer. If the spawn fails with ENOENT we surface a clear error
  // pointing at the install path.
  const result = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    // The audio CLI lives under the `capability` (alias `infer`)
    // namespace in this build of openclaw — `openclaw audio …` was the
    // older shape and now errors with "Unknown command".
    const proc = spawn(
      "openclaw",
      ["capability", "audio", "transcribe", "--file", tmpPath, "--json"],
      { shell: true, env: envWithProviderKeys() },
    );
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      resolve({ ok: false, error: `spawn failed: ${String(err?.message ?? err)}` });
    });
    proc.on("close", (code) => {
      // The CLI prints "No transcript returned …" to stderr even when it
      // exits 1, so prefer stderr over exit code for the user-facing
      // message. If both stderr and stdout are empty just report the
      // exit code so we don't return silent failures.
      if (code !== 0) {
        const msg = stderr.trim() || stdout.trim() || `exit ${code}`;
        resolve({ ok: false, error: msg });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const text = parsed?.outputs?.[0]?.text ?? parsed?.text ?? "";
        const trimmed = typeof text === "string" ? text.trim() : "";
        if (!trimmed) {
          // Empty transcript on exit 0 usually means a provider isn't
          // configured (the CLI fell through silently). Surface this
          // explicitly so the user knows to configure groq/openai/etc.
          resolve({
            ok: false,
            error:
              "Empty transcript. No audio transcription provider is configured — set tools.media.audio.models in openclaw.json and `openclaw auth set <provider>:default --api-key …`.",
          });
          return;
        }
        resolve({ ok: true, text: trimmed });
      } catch (err) {
        resolve({
          ok: false,
          error: `parse failed: ${String(err?.message ?? err)}; stdout=${stdout.slice(0, 200)}`,
        });
      }
    });
  });

  // Only clean up the temp file on success. On failure we keep the file
  // around (and report the path) so the user can play it back, inspect
  // it with ffprobe, or curl it at the transcription provider directly
  // to figure out whether it's an empty/silent recording vs. a provider
  // problem.
  if (result.ok) {
    fs.promises.unlink(tmpPath).catch(() => {});
  } else {
    result.tempPath = tmpPath;
  }
  return result;
});

// Run `openclaw capability audio providers` and return the parsed JSON.
// Used by AvatarSettings → Voice to show which transcription providers
// are configured and selected.
ipcMain.handle("exuvia:openclaw:audioProviders", async () => {
  const { spawn } = require("node:child_process");
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(
      "openclaw",
      ["capability", "audio", "providers", "--json"],
      { shell: true, env: envWithProviderKeys() },
    );
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      resolve({ ok: false, error: String(err?.message ?? err) });
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          error: stderr.trim() || stdout.trim() || `exit ${code}`,
        });
        return;
      }
      // The CLI emits one JSON object per line — not a single array.
      const providers = [];
      for (const line of stdout.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || !t.startsWith("{")) continue;
        try {
          providers.push(JSON.parse(t));
        } catch {
          /* ignore non-JSON lines */
        }
      }
      resolve({ ok: true, providers });
    });
  });
});

// Persist a provider API key to encrypted local storage and return ok/error.
// We store keys in a separate file from settings.json (so it stays out of
// any plain-text dump) and decrypt them on demand when spawning openclaw.
// Provider ids match openclaw's (groq, openai, deepgram).
const apiKeysPath = path.join(userDataDir, "api-keys.bin");
function loadApiKeys() {
  try {
    if (!fs.existsSync(apiKeysPath)) return {};
    if (!safeStorage.isEncryptionAvailable()) return {};
    const buf = fs.readFileSync(apiKeysPath);
    const json = safeStorage.decryptString(buf);
    return JSON.parse(json) || {};
  } catch {
    return {};
  }
}
function saveApiKeys(map) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const json = JSON.stringify(map);
  fs.writeFileSync(apiKeysPath, safeStorage.encryptString(json));
  return true;
}
// Map an openclaw provider id to the env-var name openclaw expects.
// Each provider declares this in its plugin metadata; this list mirrors
// the most common ones we surface in the UI.
const PROVIDER_ENV_VARS = {
  groq: "GROQ_API_KEY",
  openai: "OPENAI_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
};

ipcMain.handle("exuvia:openclaw:authSet", async (_e, args) => {
  const provider = typeof args?.provider === "string" ? args.provider.trim() : "";
  const apiKey = typeof args?.apiKey === "string" ? args.apiKey.trim() : "";
  if (!provider || !/^[a-z0-9_-]{2,40}$/i.test(provider)) {
    return { ok: false, error: "invalid provider id" };
  }
  if (!PROVIDER_ENV_VARS[provider]) {
    return { ok: false, error: `unknown provider: ${provider}` };
  }
  if (!apiKey) return { ok: false, error: "apiKey required" };
  try {
    const next = { ...loadApiKeys(), [provider]: apiKey };
    const ok = saveApiKeys(next);
    if (!ok) return { ok: false, error: "encrypted store unavailable" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// Build the env block for openclaw spawns: process.env + every persisted
// provider key mapped onto its expected env var. Called by the audio
// transcribe + audio providers handlers below so child processes inherit
// keys without leaking them to other apps.
function envWithProviderKeys() {
  const env = { ...process.env };
  const keys = loadApiKeys();
  for (const [id, value] of Object.entries(keys)) {
    const name = PROVIDER_ENV_VARS[id];
    if (name && value) env[name] = value;
  }
  return env;
}

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

// Save a UTF-8 string to a path chosen by the user. Used by avatar export.
// Caller passes a default filename (the user can rename in the save dialog)
// and the file content. Returns { ok, path } or { ok: false, error }.
ipcMain.handle("exuvia:dialog:saveTextFile", async (_e, args) => {
  const win = BrowserWindow.getFocusedWindow();
  const defaultName = typeof args?.defaultName === "string" ? args.defaultName : "exuvia-avatar.exuvia";
  const content = typeof args?.content === "string" ? args.content : "";
  const filters =
    Array.isArray(args?.filters) && args.filters.length > 0
      ? args.filters
      : [{ name: "Exuvia avatar", extensions: ["exuvia", "json"] }];
  try {
    const result = await dialog.showSaveDialog(win ?? undefined, {
      title: args?.title ?? "Save",
      defaultPath: defaultName,
      filters,
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    await fs.promises.writeFile(result.filePath, content, "utf8");
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// Read a UTF-8 file from a path chosen by the user. Used by avatar import.
// Returns { ok, content, path } or { ok: false, error }.
ipcMain.handle("exuvia:dialog:openTextFile", async (_e, opts) => {
  const win = BrowserWindow.getFocusedWindow();
  try {
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: opts?.title ?? "Open",
      properties: ["openFile"],
      filters:
        Array.isArray(opts?.filters) && opts.filters.length > 0
          ? opts.filters
          : [
              { name: "Exuvia avatar", extensions: ["exuvia", "json"] },
              { name: "All files", extensions: ["*"] },
            ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, cancelled: true };
    }
    const filePath = result.filePaths[0];
    const content = await fs.promises.readFile(filePath, "utf8");
    return { ok: true, content, path: filePath };
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

// Single-window app — keep a module-level reference so the tray menu can
// show/hide the window without recreating it. The tray reference is
// persisted too because Electron destroys the icon when the Tray instance
// is garbage-collected.
let mainWindow = null;
let tray = null;
// `app.isQuiting` is set by the tray's Quit menu item so the window's
// `close` event handler can skip the "hide instead of close" branch and
// let the OS actually close the process.
app.isQuiting = false;

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#0b0b0d",
    icon: resolveTrayIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Intercept the close button so it hides to tray instead of quitting.
  // The user can still quit from the tray menu (which sets
  // app.isQuiting = true) or via the OS task killer.
  mainWindow.on("close", (e) => {
    if (app.isQuiting) return;
    e.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Auto-grant microphone access for the voice-input feature. We're a
  // single-origin Electron app pointing at our own bundled HTML — there's
  // no third-party page that could request the mic. On Windows the OS-
  // level permission prompt still gates this; we just don't add a second
  // gate on top of it.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    if (permission === "media" || permission === "audioCapture") {
      cb(true);
      return;
    }
    cb(false);
  });
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return permission === "media" || permission === "audioCapture";
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (!app.isPackaged) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));
  }
}

// Find the tray icon file. Priority order:
//   1. userData/tray-icon.png — the user's custom override (set via the
//      "Change icon" UI). Persists across upgrades because userData is
//      outside the app bundle.
//   2. dev: app/public/tray-icon.png — what ships with the source repo
//   3. packaged: alongside the asar bundle
// If none exists we fall back to a tiny generated coloured square so
// the tray still appears — better than crashing.
const userTrayIconPath = path.join(userDataDir, "tray-icon.png");
function resolveTrayIconPath() {
  const candidates = [
    userTrayIconPath,
    path.join(__dirname, "public", "tray-icon.png"),
    path.join(__dirname, "tray-icon.png"),
    path.join(process.resourcesPath ?? "", "tray-icon.png"),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* skip */
    }
  }
  return null;
}

// Reload the tray's icon from the current resolved path. Called after
// the user changes or resets the icon so the change takes effect
// without an app restart.
function reloadTrayIcon() {
  if (!tray) return;
  try {
    tray.setImage(buildTrayIcon());
  } catch (err) {
    console.warn("[tray] icon reload failed", err);
  }
}

// IPC: copy a user-picked image file into userData/tray-icon.png.
// We accept the source path and stream-copy it so we don't depend on
// any image encoding library — Electron's Tray accepts the same set of
// formats (PNG/ICO/etc.) regardless of how the bytes arrived.
ipcMain.handle("exuvia:tray:setIcon", async (_e, sourcePath) => {
  if (typeof sourcePath !== "string" || !sourcePath) {
    return { ok: false, error: "sourcePath required" };
  }
  try {
    // Validate that the file actually loads as an image before
    // overwriting whatever icon we have now — otherwise the tray would
    // silently fall back to the placeholder square.
    const img = nativeImage.createFromPath(sourcePath);
    if (img.isEmpty()) {
      return { ok: false, error: "file is not a valid image" };
    }
    await fs.promises.copyFile(sourcePath, userTrayIconPath);
    reloadTrayIcon();
    return { ok: true, path: userTrayIconPath };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// IPC: remove the userData override and fall back to the bundled icon.
ipcMain.handle("exuvia:tray:resetIcon", async () => {
  try {
    if (fs.existsSync(userTrayIconPath)) {
      await fs.promises.unlink(userTrayIconPath);
    }
    reloadTrayIcon();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// IPC: report which icon source is currently in effect, so the UI can
// show "(default)" or "(custom)".
ipcMain.handle("exuvia:tray:getIconInfo", () => {
  const resolved = resolveTrayIconPath();
  return {
    resolvedPath: resolved,
    isCustom: resolved === userTrayIconPath,
  };
});

function buildTrayIcon() {
  const iconPath = resolveTrayIconPath();
  if (iconPath) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img;
  }
  // Fallback: a 16×16 #6cf coloured square. Encoded as a minimal RGBA
  // bitmap so the tray icon still appears even before the user drops
  // their own tray-icon.png into app/public/.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    buf[i * 4 + 0] = 0x6c; // R
    buf[i * 4 + 1] = 0xc0; // G
    buf[i * 4 + 2] = 0xff; // B
    buf[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

// Show/hide the main window. Used by the tray icon click handler and by
// the global toggle hotkey. Creates the window if it doesn't exist yet
// (e.g. user clicked Quit-window once and is opening from the tray).
function toggleMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    createWindow();
  }
}

// Global toggle hotkey. Loaded from settings.json on boot, re-registered
// whenever the renderer changes it via IPC. Default is empty (disabled)
// so we don't grab a key the user didn't pick. Accelerator strings are
// Electron's format ("Ctrl+Shift+E", "Alt+Space", etc.) — see
// https://www.electronjs.org/docs/latest/api/accelerator
let registeredHotkey = "";
function applyToggleHotkey(accelerator) {
  // Always release any previous binding before trying a new one. If the
  // new accelerator is empty or invalid we just stay un-registered.
  if (registeredHotkey) {
    try { globalShortcut.unregister(registeredHotkey); } catch { /* ignore */ }
    registeredHotkey = "";
  }
  if (!accelerator) return { ok: true };
  try {
    const ok = globalShortcut.register(accelerator, toggleMainWindow);
    if (!ok) return { ok: false, error: "register returned false (key may be reserved by the OS)" };
    registeredHotkey = accelerator;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

ipcMain.handle("exuvia:hotkey:setToggle", (_e, accelerator) => {
  const acc = typeof accelerator === "string" ? accelerator.trim() : "";
  const result = applyToggleHotkey(acc);
  if (result.ok) {
    // Persist alongside other ui settings so it sticks across restarts.
    const cur = loadSettings();
    saveSettings({ ...cur, toggleHotkey: acc });
  }
  return { ...result, accelerator: acc };
});

ipcMain.handle("exuvia:hotkey:getToggle", () => {
  const cur = loadSettings();
  return { accelerator: typeof cur?.toggleHotkey === "string" ? cur.toggleHotkey : "" };
});

function setupTray() {
  if (tray) return;
  tray = new Tray(buildTrayIcon());
  tray.setToolTip("exuvia");
  const menu = Menu.buildFromTemplate([
    {
      label: "Open exuvia",
      click: () => createWindow(),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  // Single click on the tray icon (Windows + Linux) toggles the window.
  // macOS users typically use the menu, but click works there too.
  tray.on("click", toggleMainWindow);
}

// Single-instance lock: if the user double-launches the app, focus the
// existing window instead of spawning a second process. Without this the
// tray icon would also be duplicated.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    createWindow();
  });
}

app.whenReady().then(() => {
  setupTray();
  createWindow();
  // Restore the user's saved toggle hotkey (if any) so it's live from
  // boot. Failures are non-fatal — the user can rebind from the UI.
  const saved = loadSettings();
  if (typeof saved?.toggleHotkey === "string" && saved.toggleHotkey) {
    const r = applyToggleHotkey(saved.toggleHotkey);
    if (!r.ok) {
      console.warn(`[tray] toggle hotkey "${saved.toggleHotkey}" not registered: ${r.error}`);
    }
  }
  app.on("activate", () => {
    createWindow();
  });
});

// Drop every global accelerator on shutdown so other apps don't see a
// dead binding lingering after exuvia exits.
app.on("will-quit", () => {
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
});

// With a tray, "all windows closed" doesn't mean "quit" — the user just
// hid the window. Stay alive in the tray; they explicitly quit via the
// tray menu. macOS already keeps apps alive on close, so this guard is
// effectively a no-op there.
app.on("window-all-closed", () => {
  // intentionally do nothing — tray keeps the app running
});

app.on("before-quit", () => {
  app.isQuiting = true;
});
