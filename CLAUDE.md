# Cortex — AI Coding Desktop App

## What this project is

Cortex is a desktop app that lets you run AI coding assistants (Claude CLI, Codex, Gemini CLI, Groq, Gemini API) against a local code repository. It is built for Windows-first, with mobile access via the Cortex relay service.

The app is **not** a thin wrapper around a web UI. The Node backend owns all state, session management, streaming, and provider routing. The React renderer is display-only.

---

## Stack

| Layer | Technology | Entry point |
|---|---|---|
| Desktop shell | Electron | `desktop_app/electron/main.js` |
| Backend | Node.js HTTP server | `desktop_app/backend/server.js` |
| Frontend | React + Vite | `desktop_app/web/src/App.jsx` |
| Config persistence | JSON on disk | `desktop_app/backend/configStore.js` |
| Chat persistence | JSON per repo | `desktop_app/backend/chatStore.js` |

---

## Architecture

```
Electron main.js
  └─ startBackendServer()        ← Node HTTP on 127.0.0.1:8765
       └─ DesktopSessionService  ← owns all runtime state
            ├─ AppConfigStore    ← global config (API keys, model, repoRoot)
            ├─ ProjectChatStore  ← per-repo chat history
            ├─ RepoFileService   ← file snapshots + diffs
            ├─ ToolExecutor      ← file read/write/edit/run for API models
            └─ Providers         ← CodexProvider, GeminiCliProvider,
                                    GeminiApiProvider, GroqProvider, ClaudeCliProvider

React renderer (http://127.0.0.1:5173 in dev, dist/index.html in prod)
  └─ fetches /api/status, /api/chat/send-stream, etc.
  └─ talks to Electron via preload bridge for native actions
```

---

## Key files

| File | Role |
|---|---|
| `desktop_app/electron/main.js` | Electron boot, IPC handlers, auto-updater |
| `desktop_app/electron/preload.js` | Secure renderer↔main bridge |
| `desktop_app/backend/server.js` | HTTP routes, auth, rate limiting, CORS, relay wiring |
| `desktop_app/backend/sessionService.js` | Core state: repo, chat, model, messages, providers |
| `desktop_app/backend/sessionPersistence.js` | Config save/restore, interrupted run recovery |
| `desktop_app/backend/sessionSend.js` | Streaming send path (sendMessageEvents) |
| `desktop_app/backend/providers.js` | CLI/API provider implementations + spawnCommand() |
| `desktop_app/backend/configStore.js` | AppConfigStore — global JSON config |
| `desktop_app/backend/chatStore.js` | ProjectChatStore — per-repo chat JSON files |
| `desktop_app/backend/fileService.js` | Repo snapshots, diffs |
| `desktop_app/backend/toolExecutor.js` | Local tool execution for API-backed models |
| `desktop_app/backend/cortexRelay.js` | WebSocket relay client (Cortex cloud ↔ desktop) |
| `desktop_app/backend/androidEnv.js` | buildCleanEnv() — strips host env before CLI spawn |
| `desktop_app/backend/terminalService.js` | PTY terminal sessions |
| `desktop_app/backend/constants.js` | Model lists, preset prompts, system prompts |

---

## Dev workflow

```powershell
cd desktop_app
npm install
npm run dev        # starts Vite (5173) + Electron + standalone backend concurrently
```

```powershell
npm run build      # builds React, then packages Electron app
```

Tests:
```powershell
node --test backend/tests/p1Security.test.js
```

---

## Config storage

| What | Where |
|---|---|
| Global config | `%LOCALAPPDATA%\gpt-tui\config.json` |
| Per-repo chats | `<repoRoot>\.gpt-tui\chats\` |
| Relay audit log | `%LOCALAPPDATA%\cortex\relay-audit.log` |
| Desktop launch log | `~\.cortex\logs\desktop-launch.log` |

---

## Provider routing

| Model prefix | Provider |
|---|---|
| `codex:*` | CodexProvider (codex app-server) |
| `gemini-cli:*` | GeminiCliProvider (gemini CLI subprocess) |
| `claude:*` / `claude-*` | ClaudeCliProvider (claude CLI subprocess) |
| `gemini*` | GeminiApiProvider (direct HTTP) |
| everything else | GroqProvider (direct HTTP) |

CLI providers spawn child processes via `spawnCommand()` in `providers.js`.
On Windows, this uses `cmd.exe` via `process.env.COMSPEC` with `windowsVerbatimArguments: true`
to handle paths with spaces correctly.

---

## Cortex relay (mobile access)

The Cortex relay lets a mobile app control the desktop over a cloud WebSocket.

Flow:
```
Mobile app → Cortex cloud relay → WebSocket → CortexRelayClient (desktop)
                                              → proxies to local backend HTTP
```

Key security controls on the relay path:
- Mobile must supply `X-PocketAI-Token` (shared secret, generated on first launch)
- Device pairing guard: `approvedDeviceIds` list, unapproved devices fire `onPairingRequest`
- Sensitive config fields (API keys, remoteAccessEnabled) are stripped from remote POST /api/config
- `/api/terminal/*` is loopback-only — mobile callers get 403
- All relay requests are audit-logged to `relay-audit.log`
- Rate limiting: 30 req/min for chat, 10 req/min for config, 60 req/min default

---

## Security model

See `desktop_app/P1_SECURITY_FIXES.md` for the full breakdown.

Short version:
- **CORS**: explicit allowlist (`localhost:5173`, `127.0.0.1:5173`, Metro, Expo)
- **Auth**: loopback always trusted; network callers need `X-PocketAI-Token`
- **Config writes**: API keys and safety settings blocked from remote callers
- **CLI env**: `buildCleanEnv()` strips everything except an explicit allowlist before spawning claude/codex/gemini
- **Terminal**: desktop-only, blocked for relay/mobile
- **Confinement prompt**: AI anchored to active repoRoot by default; user can override, but file-injected instructions cannot
- **`.claudeignore`**: auto-written to block secrets from AI context window
- **`.claude/settings.json`**: auto-written to restrict Claude Code tool permissions per repo

---

## What NOT to do

- Do not push without explicit user instruction ("dont push unless I tell you")
- Do not use `process.env` directly in child process spawn — always use `buildCleanEnv()`
- Do not add `Access-Control-Allow-Origin: *` — use the `corsOrigin()` helper
- Do not call `cmd.exe` by name — use `process.env.COMSPEC` (handles PATH issues on Windows)
- Do not write terminal endpoints that work from relay — terminal is desktop-only by design
