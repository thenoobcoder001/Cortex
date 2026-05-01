const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function existingDir(target) {
  const resolved = String(target || "").trim();
  if (!resolved) {
    return "";
  }
  try {
    const full = path.resolve(resolved);
    return fs.existsSync(full) && fs.statSync(full).isDirectory() ? full : "";
  } catch {
    return "";
  }
}

function existingFile(target) {
  const resolved = String(target || "").trim();
  if (!resolved) {
    return "";
  }
  try {
    const full = path.resolve(resolved);
    return fs.existsSync(full) && fs.statSync(full).isFile() ? full : "";
  } catch {
    return "";
  }
}

function sdkRootCandidates(baseEnv) {
  const localAppData = existingDir(baseEnv.LOCALAPPDATA);
  return [
    existingDir(baseEnv.ANDROID_HOME),
    existingDir(baseEnv.ANDROID_SDK_ROOT),
    existingDir("E:\\Android\\Sdk"),
    localAppData ? existingDir(path.join(localAppData, "Android", "Sdk")) : "",
  ].filter(Boolean);
}

function normalizeAndroidUserHome(rawValue) {
  const direct = existingDir(rawValue);
  if (direct && path.basename(direct).toLowerCase() === ".android") {
    return direct;
  }
  if (direct) {
    const nested = existingDir(path.join(direct, ".android"));
    if (nested) {
      return nested;
    }
  }
  return "";
}

function userHomeCandidates(baseEnv, sdkRoot) {
  const profileHome = existingDir(baseEnv.USERPROFILE) || existingDir(os.homedir());
  const sdkParent = sdkRoot ? existingDir(path.dirname(sdkRoot)) : "";
  return [
    normalizeAndroidUserHome(baseEnv.ANDROID_USER_HOME),
    sdkParent ? existingDir(path.join(sdkParent, ".android")) : "",
    profileHome ? existingDir(path.join(profileHome, ".android")) : "",
  ].filter(Boolean);
}

function avdHomeCandidates(baseEnv, sdkRoot, userHome) {
  const profileHome = existingDir(baseEnv.USERPROFILE) || existingDir(os.homedir());
  const sdkParent = sdkRoot ? existingDir(path.dirname(sdkRoot)) : "";
  return [
    // Explicit env override
    existingDir(baseEnv.ANDROID_AVD_HOME),
    // AVDs alongside the SDK root: E:\Android\avd
    sdkParent ? existingDir(path.join(sdkParent, "avd")) : "",
    // AVDs inside .android: E:\Android\.android\avd
    userHome ? existingDir(path.join(userHome, "avd")) : "",
    // AVDs in USERPROFILE\.android\avd
    profileHome ? existingDir(path.join(profileHome, ".android", "avd")) : "",
  ].filter(Boolean);
}

function resolveAndroidEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const sdkRoot = sdkRootCandidates(baseEnv)[0] || "";
  if (sdkRoot) {
    env.ANDROID_HOME = sdkRoot;
    env.ANDROID_SDK_ROOT = sdkRoot;

    // Add SDK tool directories to PATH so `emulator` and `adb` work without absolute paths
    const toolDirs = [
      path.join(sdkRoot, "emulator"),
      path.join(sdkRoot, "platform-tools"),
    ].filter((d) => existingDir(d));
    if (toolDirs.length > 0) {
      const pathSep = process.platform === "win32" ? ";" : ":";
      const existing = String(env.PATH || env.Path || "");
      const parts = existing ? existing.split(pathSep) : [];
      // Prepend so our SDK paths take priority
      env.PATH = [...toolDirs, ...parts].join(pathSep);
    }
  }

  const userHome = userHomeCandidates(baseEnv, sdkRoot)[0] || "";
  if (userHome) {
    env.ANDROID_USER_HOME = userHome;
    const adbKey = existingFile(path.join(userHome, "adbkey"));
    if (adbKey) {
      env.ADB_VENDOR_KEYS = adbKey;
    }
  }

  const avdHome = avdHomeCandidates(baseEnv, sdkRoot, userHome)[0] || "";
  if (avdHome) {
    env.ANDROID_AVD_HOME = avdHome;
  }

  return env;
}

// Keys that CLI child processes are allowed to inherit from the host environment.
// Everything else (GitHub tokens, AWS/GCP credentials, DB passwords, etc.) is stripped.
const CLI_ALLOWED_ENV_KEYS = new Set([
  // System
  "PATH", "PATHEXT", "COMSPEC", "SystemRoot", "OS",
  "PROCESSOR_ARCHITECTURE", "USERPROFILE", "HOME",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "TERM", "COLORTERM", "TERM_PROGRAM",
  // Node / npm
  "NODE_ENV", "npm_config_cache",
  // AI CLI keys — only what each tool actually needs
  "ANTHROPIC_API_KEY",   // Claude Code
  "OPENAI_API_KEY",      // Codex
  "GEMINI_API_KEY",      // Gemini CLI
  "GOOGLE_API_KEY",      // Gemini CLI alternate
  // Android SDK (populated by resolveAndroidEnv)
  "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_USER_HOME",
  "ANDROID_AVD_HOME", "ADB_VENDOR_KEYS",
]);

function buildCleanEnv(extras = {}) {
  const clean = {};
  for (const key of Object.keys(process.env)) {
    // On Windows, env var names are case-insensitive but Node preserves the
    // original case (e.g. "Path" instead of "PATH"). Normalise to uppercase
    // before checking the allowlist so PATH/Path/PATHEXT/etc. are all kept.
    if (CLI_ALLOWED_ENV_KEYS.has(key) || CLI_ALLOWED_ENV_KEYS.has(key.toUpperCase())) {
      clean[key] = process.env[key];
    }
  }
  return resolveAndroidEnv({ ...clean, ...extras });
}

module.exports = {
  resolveAndroidEnv,
  buildCleanEnv,
};
