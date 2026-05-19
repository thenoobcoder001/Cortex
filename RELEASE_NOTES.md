## Cortex v0.0.4 — Desktop Startup, Relay, and Mobile Workspace Fixes

> ⚠️ **Windows SmartScreen warning:** Windows may block the installer on first run. Click **"More info" → "Run anyway"** — the app is safe to run. This happens because the installer is not yet code signed.

### Startup and desktop stability
- Backend now runs as a child process instead of blocking the Electron main process
- Fixed "Startup interrupted" by using the actual bound backend port in the renderer URL
- Fixed startup hangs and "Not Responding" cases caused by repeated synchronous config/provider checks
- Removed the extra standalone backend from the dev command so Electron owns the backend lifecycle

### Cortex relay and mobile
- Fixed Cortex relay re-pairing loops after reconnects by preserving signed relay sessions
- Fixed the desktop sign-in form flash during relay reconnect
- Mobile status/config calls now use lite snapshots that skip expensive file trees, workspace diffs, and message payloads
- Mobile chat actions now return lite snapshots, fixing workspace opens for large repos such as `mobile-coapp`
- Relay-proxied localhost requests are now treated as mobile/remote requests, not desktop-local requests

### Workspace and chat fixes
- Fixed chat rename UI behavior and persistence
- Added faster project chat loading through lightweight `/api/chats` responses
- Cached CLI availability checks for Codex, Gemini CLI, and Claude CLI
- Improved boot screen text contrast
- Auto-written `.claudeignore` files are included for repo confinement and secret exclusion

---

## Cortex v0.0.2 — Security & Stability

> ⚠️ **Windows SmartScreen warning:** Windows may block the installer on first run. Click **"More info" → "Run anyway"** — the app is safe to run. This happens because the installer is not yet code signed.

### Security hardening
- Mobile/relay callers can no longer overwrite API keys or sensitive config
- Device pairing guard — mobile devices must be explicitly approved before controlling the desktop
- Rate limiting on all endpoints (30/min chat, 10/min config, 60/min default)
- Relay audit log with 10 MB rotation
- CLI child processes no longer inherit host environment variables (GitHub tokens, AWS keys, etc.)
- Terminal access blocked for remote/relay callers — desktop only
- Auto-written `.claudeignore`, `.claude/settings.json`, `AGENTS.md`, `GEMINI.md` per repo for AI confinement

### Fixes
- Fixed Windows spawn crash for Node.js installed in paths with spaces
- Fixed CORS blocking Vite dev renderer on `127.0.0.1:5173`
- Fixed `spawn cmd.exe ENOENT` caused by missing PATH in clean environment

### Refactoring
- Backend routes split into `routes/` folder
- Constants split into `constants/` folder with separate `tools.js`
- AI context files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) added to repo root

---

## Cortex v0.0.1 — Initial Release

Cortex is a desktop chat interface that brings your AI coding assistants — Claude, Gemini CLI, and OpenAI Codex — into a single app.

### Features
- **Multiple AI providers** — Claude CLI, Gemini CLI, and OpenAI Codex from one window
- **Project workspaces** — pick any folder as a project; the AI runs in context of that repo
- **Persistent chat sessions** — history saved per project, restored on next launch
- **Live streaming** — responses stream token by token as they arrive
- **Stop anytime** — interrupt a running response mid-generation
- **Prompt presets** — Chat, Code, Plan, Debug, Refactor, Explain modes
- **Tool safety toggle** — write-enabled or read-only mode for CLI tools
- **File diff viewer** — see what files the AI changed, accept or revert
- **Open in editor** — launch project in VS Code, Cursor, or Antigravity

### Requirements
- Windows 10/11
- At least one provider installed:
  - [Claude CLI](https://claude.ai/code)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli)
  - [OpenAI Codex CLI](https://github.com/openai/codex)

### Installation
Download `Cortex Setup 0.0.1.exe` below and run it.
