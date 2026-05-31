<div align="center">

<img src="https://img.shields.io/badge/CORTEX-AI%20Desktop-6C63FF?style=for-the-badge&logoColor=white&labelColor=1a1a2e" height="42" alt="Cortex"/>

### Control every AI coding assistant from one desktop app

[![Release](https://img.shields.io/github/v/release/thenoobcoder001/Cortex?style=flat-square&color=6C63FF&label=latest)](https://github.com/thenoobcoder001/Cortex/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0d1117?style=flat-square&logo=windows&logoColor=white)](https://github.com/thenoobcoder001/Cortex/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-0d1117?style=flat-square)](LICENSE)

**Claude · Codex · Gemini · Groq** — one window, your code, all your AI tools.

**⬇ Download** — [click here](https://thenoobcoder001.github.io/Cortex/) or go to [GitHub Releases](https://github.com/thenoobcoder001/Cortex/releases/latest)

</div>

---

## What is Cortex?

Cortex is a desktop app that runs AI coding agents — Claude CLI, OpenAI Codex, Gemini CLI, Groq, and Gemini API — directly against your local code repositories. No browser tab, no copy-pasting file paths. Open a project folder, pick a model, and start building.

> **Think of it as a universal remote control for AI coding assistants.**

- The AI runs **in context of your repo** — it reads, edits, and reasons about real files on disk
- All providers stream responses **live, token by token** with stop-anytime support
- Chat history is **saved per project** and restored automatically on next launch
- A built-in **PTY terminal** and **file diff viewer** are wired directly into the app
- Optional **Cortex relay** lets you drive the desktop AI from your phone

---

## Supported Providers

<table>
<thead>
<tr>
<th width="160">Provider</th>
<th>Connection</th>
<th>Models</th>
</tr>
</thead>
<tbody>
<tr>
<td><img src="https://cdn.simpleicons.org/anthropic/D97757" height="14">&nbsp; <b>Claude</b></td>
<td><code>claude</code> CLI · streaming JSON</td>
<td>claude-opus-4 &nbsp;·&nbsp; claude-sonnet-4 &nbsp;·&nbsp; claude-haiku-4</td>
</tr>
<tr>
<td><img src="https://cdn.simpleicons.org/openai/white" height="14">&nbsp; <b>Codex</b></td>
<td><code>codex app-server</code> · JSON-RPC</td>
<td>gpt-5.5 &nbsp;·&nbsp; gpt-5.4 &nbsp;·&nbsp; gpt-5.4-mini &nbsp;·&nbsp; gpt-5.3-codex<br><sub>Each model: Extra High / High / Medium / Low effort</sub></td>
</tr>
<tr>
<td><img src="https://cdn.simpleicons.org/google/4285F4" height="14">&nbsp; <b>Gemini CLI</b></td>
<td><code>gemini</code> CLI · stream-json</td>
<td>Gemini 2.5 Pro &nbsp;·&nbsp; Gemini 2.5 Flash</td>
</tr>
<tr>
<td><img src="https://cdn.simpleicons.org/google/34A853" height="14">&nbsp; <b>Gemini API</b></td>
<td>Direct HTTP · Google AI Studio key</td>
<td>gemini-2.5-pro &nbsp;·&nbsp; gemini-2.0-flash</td>
</tr>
<tr>
<td><img src="https://cdn.simpleicons.org/groq/F55036" height="14">&nbsp; <b>Groq</b></td>
<td>Direct HTTP · Groq API key</td>
<td>llama-3.3-70b &nbsp;·&nbsp; deepseek-r1 &nbsp;·&nbsp; mixtral</td>
</tr>
<tr>
<td>⚡ <b>Antigravity</b></td>
<td><code>agy</code> CLI</td>
<td><i>Coming soon on Windows</i></td>
</tr>
</tbody>
</table>

---

## Features

<table>
<tr>
<td valign="top" width="50%">

### 🤖 Multi-provider AI
Run Claude, Codex, Gemini, or Groq from a single UI. Switch model or provider mid-project without restarting.

### 📂 Project workspaces
Pick any folder as a workspace. The AI runs in context of that repo — not a blank sandbox.

### 💬 Persistent chat
History saved per project, restored on next launch. Each project keeps its own conversation.

### ⚡ Live streaming
Responses stream token by token as they arrive. Interrupt generation at any point.

</td>
<td valign="top" width="50%">

### 🗂️ File diff viewer
See exactly which files the AI changed. Accept or revert changes per file.

### 📺 Built-in terminal
Full PTY terminal panel inside the app — no context switching.

### 📱 Mobile access via Cortex relay
Control the desktop AI from your phone over the internet. Cortex relay proxies requests securely.

### 🚀 Open in editor
Launch your project directly in VS Code, Visual Studio, Cursor, or File Explorer.

</td>
</tr>
</table>

### Codex effort tiers

The Codex model picker uses a 3-level flyout — provider → model → effort:

```
Codex
 ├─ gpt-5.5       Extra High  /  High  /  Medium  /  Low
 ├─ gpt-5.4       Extra High  /  High  /  Medium  /  Low
 ├─ gpt-5.4-mini  Extra High  /  High  /  Medium  /  Low
 └─ gpt-5.3-codex Extra High  /  High  /  Medium  /  Low
```

---

## ⚠️ Security warning (first launch)

> **Windows:** SmartScreen may block the installer. Click **"More info" → "Run anyway"**.
>
> **macOS:** Gatekeeper may block the app. Go to **System Settings → Privacy & Security → Open Anyway**.

Code signing certificates are not yet purchased. Full source is available here for review.

---

## Download

<table>
<tr>
<th width="180">Platform</th>
<th>File</th>
<th>Notes</th>
</tr>
<tr>
<td><img src="https://cdn.simpleicons.org/windows/0078D4" height="13">&nbsp; Windows 10 / 11</td>
<td><code>Cortex-Setup-x.x.x.exe</code></td>
<td>Run as normal installer</td>
</tr>
<tr>
<td><img src="https://cdn.simpleicons.org/apple/white" height="13">&nbsp; macOS (Apple Silicon)</td>
<td><code>Cortex-Mac-x.x.x-arm64.dmg</code></td>
<td>Open Anyway in Privacy settings</td>
</tr>
<tr>
<td><img src="https://cdn.simpleicons.org/linux/white" height="13">&nbsp; Linux (x64)</td>
<td><code>.deb</code> or <code>.AppImage</code></td>
<td><code>chmod +x Cortex-Linux-*.AppImage</code></td>
</tr>
</table>

Get the latest build from [**Releases →**](https://github.com/thenoobcoder001/Cortex/releases/latest)

---

## Development

```bash
cd desktop_app
npm install
npm run dev        # Vite dev server (5173) + Electron + Node backend
```

```bash
npm run build      # Production Electron package for current platform
```

```bash
node --test backend/tests/p1Security.test.js   # Run security test suite
```

---

## Architecture

<details>
<summary><b>Show architecture</b></summary>

<br>

```
Electron main.js
  └─ Node HTTP backend  (127.0.0.1:8765)
       └─ DesktopSessionService
            ├─ AppConfigStore       — global config (API keys, model, repoRoot)
            ├─ ProjectChatStore     — per-repo chat history
            ├─ RepoFileService      — file snapshots + diffs
            ├─ ToolExecutor         — file read/write/edit for API-backed models
            └─ Providers            — Codex · Claude · GeminiCli · GeminiApi · Groq · Agy

React renderer  (Vite in dev,  dist/ in prod)
  └─ fetches /api/status, /api/chat/send-stream, /api/config, …

Cortex relay  (optional)
  └─ Mobile app → cloud WebSocket → desktop backend
```

| File | Role |
|---|---|
| `desktop_app/electron/main.js` | Electron boot, IPC handlers, auto-updater |
| `desktop_app/backend/server.js` | HTTP routes, auth, rate limiting, CORS |
| `desktop_app/backend/sessionService.js` | Core state: repo, chat, model, streaming |
| `desktop_app/backend/providers.js` | All provider implementations |
| `desktop_app/web/src/App.jsx` | Main React UI |

</details>

---

## Config storage

| What | Location |
|---|---|
| Global config | `%LOCALAPPDATA%\gpt-tui\config.json` |
| Per-repo chats | `<repoRoot>\.gpt-tui\chats\` |
| Relay audit log | `%LOCALAPPDATA%\cortex\relay-audit.log` |

---

<div align="center">

Made by [noobcoder](https://github.com/thenoobcoder001)

</div>
