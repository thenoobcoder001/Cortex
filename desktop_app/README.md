# Cortex

A desktop chat interface that unifies your AI coding assistants — Claude, Gemini CLI, and Codex — into a single app. Switch providers, manage multiple projects, and keep persistent chat history, all without leaving one window.

---

## Download

**Windows installer available — no setup required.**

1. Go to [Releases](../../releases/latest)
2. Download `Cortex Setup 0.0.1.exe`
3. Run the installer and launch **Cortex** from the Start Menu

---

## Why

Most AI coding CLIs are powerful but isolated. You end up with multiple terminals open, no shared history, and no easy way to switch between Claude, Codex, and Gemini mid-project. Cortex wraps them all in one place.

---

## Features

- **Multiple AI providers** — Claude CLI, Gemini CLI, OpenAI Codex, and more, all from one window
- **Project workspaces** — pick any folder as a project; the AI runs in context of that repo
- **Persistent chat sessions** — history is saved per project and restored on next launch
- **Live streaming** — responses stream as they arrive
- **Stop anytime** — interrupt a running response mid-generation
- **Prompt presets** — switch between Chat, Code, Plan, Debug, Refactor, and Explain modes
- **Tool safety toggle** — flip between write-enabled and read-only mode for CLI tools
- **File diff viewer** — see exactly what files the AI changed, then accept or revert
- **Open in editor** — launch the current project in VS Code, Cursor, or Antigravity

---

## Providers

Cortex currently ships with three built-in providers, with more on the way:

| Provider | Requires |
|---|---|
| Claude | [`claude` CLI](https://claude.ai/code) installed and authenticated |
| Gemini CLI | [`gemini` CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated |
| OpenAI Codex | [`codex` CLI](https://github.com/openai/codex) installed |

You only need the providers you want to use. Cortex detects which CLIs are available on your PATH automatically.

---

## Development

If you prefer to run from source instead of the installer:

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- At least one supported AI provider installed (see table above)

### Setup

```bash
cd desktop_app
npm install
```

### Run in dev mode

```bash
npm run dev
```

This starts three processes in parallel:
- Vite dev server (React UI at `http://127.0.0.1:5173`)
- Electron window (loads the Vite URL)
- Local backend server (at `http://127.0.0.1:8765`)

### Build installer

```bash
npm run build
```

Builds the React UI and packages a Windows NSIS installer into `dist/`.

---

## Project structure

```
desktop_app/
├── backend/          # Node.js HTTP server — handles sessions, providers, file ops
├── electron/
│   ├── main.js       # Electron main process
│   └── preload.js    # Context bridge (IPC)
└── web/
    └── src/
        └── App.jsx   # React UI
```

---

## License

MIT
