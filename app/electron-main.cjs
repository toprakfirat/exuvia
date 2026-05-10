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

  // Auto-grant microphone access for the voice-input feature. We're a
  // single-origin Electron app pointing at our own bundled HTML — there's
  // no third-party page that could request the mic. On Windows the OS-
  // level permission prompt still gates this; we just don't add a second
  // gate on top of it.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    if (permission === "media" || permission === "audioCapture") {
      cb(true);
      return;
    }
    cb(false);
  });
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return permission === "media" || permission === "audioCapture";
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
