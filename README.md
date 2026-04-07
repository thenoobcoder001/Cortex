# gpt-tui (Windows TUI - Refactored)

Windows-first coding TUI with:
- Cleaner two-pane UI (workspace + assistant)
- Split architecture (`ui`, `providers`, `services`, `config`)
- API key onboarding with live validation + persistence
- Repo-safe absolute-path file commands

## What this includes

- Textual app with improved layout + status chips
- Prompt input box (Enter to submit)
- Groq-backed chat responses
- Simple commands:
  - `/help`
  - `/model <model-name>`
  - `/clear`
  - `/repo`
  - `/repo <absolute_dir_path>`
  - `/files [absolute_dir_path]` (absolute path only, inside repo only)
  - `/read <absolute_file_path>` (absolute path only, inside repo only)
  - `/apikey set <key>` (tests key, saves only if valid)
  - `/apikey status`
  - `/apikey clear`
- Keybindings:
  - `q` or `Ctrl+C`: quit
  - `Ctrl+L`: clear chat
  - `Ctrl+1`: focus prompt
  - `Ctrl+2`: focus file tree
  - `Ctrl+R`: refresh file tree

## API key flow

1. Start app
2. Run:
   - `/apikey set gsk_...`
3. App validates the key against Groq
4. On success, app shows confirmation and saves key in local config for future sessions

## File tree behavior

- Navigate in the left pane.
- Select a file to preview its content in chat log.
- Selection is still repo-scoped: outside paths are rejected.

## Run

```powershell
cd E:\codex\gpt-tui
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:GROQ_API_KEY="your_groq_api_key_here"
# Optional:
# $env:GROQ_MODEL="llama-3.3-70b-versatile"
python app.py
```

## Project structure

```text
app.py
desktop_backend.py
desktop_app/
  electron/
  web/
docs/
  help.txt
  instructions.md
gpt_tui/
  config.py
  desktop_api/
  providers/
  services/
  ui/
packaging/
  inno/
    installer.iss
  pyinstaller/
    gpt-tui.spec
    gpt-tui-backend.spec
scripts/
  build-tui.ps1
  build-installer.ps1
tests/
debug/
  manual-tests/
  recovered-files/
  scratch/
```

## Build Windows app (.exe)

```powershell
cd E:\codex\gpt-tui
powershell -ExecutionPolicy Bypass -File .\scripts\build-tui.ps1
```

Output:
- `out\dist\gpt-tui.exe`

Run packaged app:
```powershell
.\out\dist\gpt-tui.exe
```

Or use launcher:
```powershell
.\run-gpt-tui.bat
```

Notes:
- This is a console app (required for Textual TUI).
- Keep using `GROQ_API_KEY` in env (User env is supported by launcher).

## Build Windows installer (.exe setup)

Prerequisite:
- Inno Setup 6 (`ISCC.exe`) installed

Build installer:
```powershell
cd E:\codex\gpt-tui
powershell -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1
```

Output:
- `out\installer\gpt-tui-setup.exe`

The installer creates:
- Start Menu shortcut
- Optional desktop shortcut
- Installed app under `Program Files\gpt-tui`

## Electron + React desktop shell

This repo now also contains a desktop conversion scaffold in `desktop_app/`:

- Python backend API in `gpt_tui/desktop_api`
- React renderer in `desktop_app/web`
- Electron shell in `desktop_app/electron`
- PyInstaller specs in `packaging/pyinstaller`

Development flow:

```powershell
cd E:\codex\gpt-tui
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

cd .\desktop_app
npm install
npm run dev
```

Packaged desktop build flow:

```powershell
cd E:\codex\gpt-tui\desktop_app
npm install
npm run build
```

That build does three things:
- builds the React frontend
- builds the Python backend executable (`gpt-tui-backend.exe`)
- packages the Electron app as a Windows installer with `electron-builder`

## Next phase

- Add provider abstraction (`Ollama`, `OpenAI`, others)
- Add file tools (`list/read`) and patch apply flow
- Add shell command tool with confirmation

## Known issues

- Gemini CLI and Codex CLI depend on local terminal/auth state; backend capacity and auth errors can be intermittent.
- In-terminal mouse selection depends on your terminal emulator and alternate-screen behavior; use in-app copy commands as fallback.
- Live provider tests can be flaky when network/provider limits are hit; use `scripts/smoke_test.ps1` for baseline validation.

## Repo hygiene

- `packaging/` contains installer and PyInstaller assets.
- `scripts/` contains build entrypoints instead of root-level PowerShell files.
- `docs/` contains text documentation that used to live at the repo root.
- `debug/manual-tests/` contains one-off manual checks that are intentionally kept out of automated pytest discovery.
- `out/` contains generated build artifacts and logs so the repo root stays source-focused.
