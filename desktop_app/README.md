GPT TUI Desktop

This folder contains the Electron + React shell for gpt-tui.

Development
- Install Python requirements from the repo root.
- Install desktop app dependencies in this folder with `npm install`.
- Start the desktop app with `npm run dev`.

Packaging
- `npm run build:web` builds the React renderer.
- `npm run build:backend` builds the Python backend executable with PyInstaller.
- `npm run build` packages the Windows installer with electron-builder.

Notes
- Development uses your local Python environment and runs `python -m gpt_tui.desktop_api.server`.
- Packaged builds use the bundled `gpt-tui-backend.exe` from `dist-backend`.
