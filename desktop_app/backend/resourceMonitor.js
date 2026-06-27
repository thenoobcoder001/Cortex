const os = require("node:os");
const { spawnSync } = require("node:child_process");
const platform = require("./platform");

const PROCESS_TABLE_TTL_MS = 2000;
let cachedProcessTable = { at: 0, rows: [] };

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percent(used, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((used / total) * 1000) / 10));
}

function normalizeProcessRows(rows) {
  return rows
    .map((row) => ({
      pid: Math.trunc(toNumber(row.pid ?? row.ProcessId)),
      ppid: Math.trunc(toNumber(row.ppid ?? row.ParentProcessId)),
      name: String(row.name ?? row.Name ?? row.command ?? "").trim(),
      memoryBytes: Math.max(0, toNumber(row.memoryBytes ?? row.WorkingSetSize ?? row.rssBytes)),
    }))
    .filter((row) => row.pid > 0);
}

function windowsProcessRows() {
  const script = [
    "Get-CimInstance Win32_Process",
    "| Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name",
    "| ConvertTo-Json -Compress",
  ].join(" ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || !String(result.stdout || "").trim()) {
    return [];
  }
  const parsed = JSON.parse(result.stdout);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return normalizeProcessRows(rows);
}

function unixProcessRows() {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,rss=,comm="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return [];
  }
  const rows = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        memoryBytes: Number(match[3]) * 1024,
        name: match[4],
      };
    })
    .filter(Boolean);
  return normalizeProcessRows(rows);
}

function processRows() {
  const now = Date.now();
  if (now - cachedProcessTable.at < PROCESS_TABLE_TTL_MS) {
    return cachedProcessTable.rows;
  }
  try {
    cachedProcessTable = {
      at: now,
      rows: platform.isWin ? windowsProcessRows() : unixProcessRows(),
    };
  } catch {
    cachedProcessTable = { at: now, rows: [] };
  }
  return cachedProcessTable.rows;
}

function summarizeProcessTrees(rootPids, rows) {
  const roots = [...new Set((rootPids || []).map((pid) => Math.trunc(Number(pid))).filter((pid) => pid > 0))];
  if (!roots.length || !rows.length) {
    return { rootPids: roots, processCount: 0, memoryBytes: 0 };
  }

  const childrenByParent = new Map();
  const rowByPid = new Map();
  for (const row of rows) {
    rowByPid.set(row.pid, row);
    if (!childrenByParent.has(row.ppid)) {
      childrenByParent.set(row.ppid, []);
    }
    childrenByParent.get(row.ppid).push(row.pid);
  }

  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const childPid of childrenByParent.get(pid) || []) {
      stack.push(childPid);
    }
  }

  let memoryBytes = 0;
  for (const pid of seen) {
    memoryBytes += rowByPid.get(pid)?.memoryBytes || 0;
  }
  return { rootPids: roots, processCount: seen.size, memoryBytes };
}

function pressureLevel(memoryPercent, activeAgents) {
  if (memoryPercent >= 92) return "critical";
  if (memoryPercent >= 85 || activeAgents >= 5) return "warning";
  return "ok";
}

function buildResourceSnapshot(requestRegistry) {
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const usedMemoryBytes = Math.max(0, totalMemoryBytes - freeMemoryBytes);
  const memoryPercent = percent(usedMemoryBytes, totalMemoryBytes);
  const activeRuns = typeof requestRegistry?.entries === "function" ? requestRegistry.entries() : [];
  const rows = activeRuns.length ? processRows() : [];
  const appMemory = process.memoryUsage();

  const agents = activeRuns.map((run) => {
    const tree = summarizeProcessTrees(run.pids || [], rows);
    return {
      chatId: run.chatId,
      model: run.model || "",
      repoRoot: run.repoRoot || "",
      startedAt: run.startedAt || "",
      rootPids: tree.rootPids,
      processCount: tree.processCount,
      memoryBytes: tree.memoryBytes,
    };
  });

  const agentMemoryBytes = agents.reduce((sum, agent) => sum + agent.memoryBytes, 0);
  const level = pressureLevel(memoryPercent, agents.length);
  const warnings = [];
  if (memoryPercent >= 92) {
    warnings.push("System memory is critically high.");
  } else if (memoryPercent >= 85) {
    warnings.push("System memory is getting close to the limit.");
  }
  if (agents.length >= 5) {
    warnings.push("Five or more agents are running in parallel.");
  }

  return {
    sampledAt: new Date().toISOString(),
    level,
    warnings,
    system: {
      totalMemoryBytes,
      freeMemoryBytes,
      usedMemoryBytes,
      memoryPercent,
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg(),
    },
    app: {
      pid: process.pid,
      memoryBytes: appMemory.rss,
      heapUsedBytes: appMemory.heapUsed,
      heapTotalBytes: appMemory.heapTotal,
    },
    agents: {
      activeCount: agents.length,
      memoryBytes: agentMemoryBytes,
      processCount: agents.reduce((sum, agent) => sum + agent.processCount, 0),
      items: agents,
    },
  };
}

module.exports = {
  buildResourceSnapshot,
};
