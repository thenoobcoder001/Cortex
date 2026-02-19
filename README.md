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
gpt_tui/
  config.py
  main.py
  providers/
    groq_provider.py
  services/
    file_service.py
  ui/
    app.py
app.py
```

## Build Windows app (.exe)

```powershell
cd E:\codex\gpt-tui
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

Output:
- `dist\gpt-tui.exe`

Run packaged app:
```powershell
.\dist\gpt-tui.exe
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
powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
```

Output:
- `installer\gpt-tui-setup.exe`

The installer creates:
- Start Menu shortcut
- Optional desktop shortcut
- Installed app under `Program Files\gpt-tui`

## Next phase

- Add provider abstraction (`Ollama`, `OpenAI`, others)
- Add file tools (`list/read`) and patch apply flow
- Add shell command tool with confirmation
