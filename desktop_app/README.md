GPT TUI Desktop

This folder contains the Electron + React shell for gpt-tui.

Development
- Install desktop app dependencies in this folder with `npm install`.
- Start the desktop app with `npm run dev`.

Packaging
- `npm run build:web` builds the React renderer.
- `npm run build` packages the Windows installer with electron-builder.

Notes
- Development and packaged builds both use the bundled Node backend in `backend/`.
