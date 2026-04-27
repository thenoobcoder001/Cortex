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

module.exports = {
  resolveAndroidEnv,
};
