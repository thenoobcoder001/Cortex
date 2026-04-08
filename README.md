# GPT TUI Desktop

Desktop-first local AI coding app built with:
- Electron
- React
- Node.js backend

The old Python/Textual app has been removed. This repo now tracks only the desktop application and its supporting docs/debug artifacts.

## Run

```powershell
cd E:\codex\gpt-tui\desktop_app
npm install
npm run dev
```

That starts:
- the Vite renderer
- Electron
- the local Node backend

## Build

```powershell
cd E:\codex\gpt-tui\desktop_app
npm install
npm run build
```

That builds:
- the React renderer
- the packaged Electron desktop app with the bundled Node backend

## Repo Shape

```text
desktop_app/
  backend/
  electron/
  web/
docs/
  architecture-flow.txt
debug/
out/
images/
```

## Architecture

Main flow:
- Electron boots the local backend
- React talks to the backend over localhost HTTP
- the backend manages chats, projects, provider sessions, diffs, and streaming

Key files:
- `desktop_app/electron/main.js`
- `desktop_app/backend/server.js`
- `desktop_app/backend/sessionService.js`
- `desktop_app/web/src/App.jsx`
- `docs/architecture-flow.txt`

## Current Backend Features

- per-project chat storage
- Codex streaming via `codex app-server`
- Gemini CLI streaming
- Groq and Gemini API support
- per-chat permission mode
- chat interruption / stop
- tracked workspace diffs per chat

## Verification

Current Node-side checks include:
- backend unit/integration tests in `desktop_app/backend/*.test.js`
- renderer production build with `npm run build:web`

## Notes

- `local-notes/` is ignored and intended for private working notes.
- `out/` contains generated artifacts and logs.
- `debug/` is for local scratch artifacts only, not product runtime.
