const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const platform = require("./platform");

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
  const home = os.homedir();
  const candidates = [
    existingDir(baseEnv.ANDROID_HOME),
    existingDir(baseEnv.ANDROID_SDK_ROOT),
  ];

  if (platform.isWin) {
    const localAppData = existingDir(baseEnv.LOCALAPPDATA);
    candidates.push(existingDir("E:\\Android\\Sdk"));
    if (localAppData) {
      candidates.push(existingDir(path.join(localAppData, "Android", "Sdk")));
    }
  } else if (platform.isMac) {
    candidates.push(existingDir(path.join(home, "Library", "Android", "sdk")));
  } else if (platform.isLinux) {
    candidates.push(existingDir(path.join(home, "Android", "Sdk")));
    candidates.push(existingDir("/usr/lib/android-sdk"));
    candidates.push(existingDir("/opt/android-sdk"));
  }

  return candidates.filter(Boolean);
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
  const home = os.homedir();
  const profileHome = platform.isWin ? existingDir(baseEnv.USERPROFILE) : "";
  const sdkParent = sdkRoot ? existingDir(path.dirname(sdkRoot)) : "";
  
  return [
    normalizeAndroidUserHome(baseEnv.ANDROID_USER_HOME),
    sdkParent ? existingDir(path.join(sdkParent, ".android")) : "",
    existingDir(path.join(home, ".android")),
    profileHome ? existingDir(path.join(profileHome, ".android")) : "",
  ].filter(Boolean);
}

function avdHomeCandidates(baseEnv, sdkRoot, userHome) {
  const home = os.homedir();
  const profileHome = platform.isWin ? existingDir(baseEnv.USERPROFILE) : "";
  const sdkParent = sdkRoot ? existingDir(path.dirname(sdkRoot)) : "";
  
  return [
    // Explicit env override
    existingDir(baseEnv.ANDROID_AVD_HOME),
    // AVDs alongside the SDK root
    sdkParent ? existingDir(path.join(sdkParent, "avd")) : "",
    // AVDs inside .android
    userHome ? existingDir(path.join(userHome, "avd")) : "",
    // Typical location
    existingDir(path.join(home, ".android", "avd")),
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
      path.join(sdkRoot, "tools"),
      path.join(sdkRoot, "tools", "bin"),
    ].filter((d) => existingDir(d));
    
    if (toolDirs.length > 0) {
      const pathSep = platform.isWin ? ";" : ":";
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
  "PATH", "Path", "PATHEXT", "COMSPEC", "SystemRoot", "OS",
  "PROCESSOR_ARCHITECTURE", "USERPROFILE", "HOME", "SHELL",
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
  const allEnvKeys = Object.keys(process.env);
  
  for (const key of CLI_ALLOWED_ENV_KEYS) {
    // Find the actual key in process.env (handles case-sensitivity differences)
    const actualKey = allEnvKeys.find(k => k.toUpperCase() === key.toUpperCase());
    if (actualKey) {
      clean[key] = process.env[actualKey];
    }
  }
  
  return resolveAndroidEnv({ ...clean, ...extras });
}

module.exports = {
  resolveAndroidEnv,
  buildCleanEnv,
};
