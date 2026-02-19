from __future__ import annotations

from datetime import datetime
import os
from pathlib import Path
from typing import Any


def _load_dotenv() -> None:
    """Minimal .env loader — no extra package needed."""
    env_file = Path(__file__).parents[2] / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()

from textual import work, on
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import (
    Button,
    DirectoryTree,
    Footer,
    Header,
    Input,
    RichLog,
    Static,
    Label,
)

from gpt_tui.config import AppConfig
from gpt_tui.providers.groq_provider import GroqProvider
from gpt_tui.services.file_service import RepoFileService

# ─── Branding ────────────────────────────────────────────────────────
APP_NAME = "GPT TUI"
VERSION = "0.2.0"

WELCOME_ART = r"""[bold #ff6b6b]
   ██████╗ ██████╗ ████████╗  ████████╗██╗   ██╗██╗
  ██╔════╝ ██╔══██╗╚══██╔══╝  ╚══██╔══╝██║   ██║██║
  ██║  ███╗██████╔╝   ██║        ██║   ██║   ██║██║
  ██║   ██║██╔═══╝    ██║        ██║   ██║   ██║██║
  ╚██████╔╝██║        ██║        ██║   ╚██████╔╝██║
   ╚═════╝ ╚═╝        ╚═╝        ╚═╝    ╚═════╝ ╚═╝[/]
"""

WELCOME_MSG = (
    f"[dim #7a8a9e]v{VERSION}[/]  ·  "
    "[dim #7a8a9e]Windows-first coding assistant[/]  ·  "
    "[dim #7a8a9e]Powered by Groq[/]\n"
    "[dim #536374]─────────────────────────────────────────────────────[/]\n"
    "[#7a8a9e]Ctrl+K[/] [dim]settings[/]  │  "
    "[#7a8a9e]/help[/] [dim]commands[/]  │  "
    "[#7a8a9e]Ctrl+L[/] [dim]clear[/]  │  "
    "[#7a8a9e]Ctrl+2[/] [dim]files[/]"
)


# ─── API Key Modal ───────────────────────────────────────────────────
class ApiKeyModal(ModalScreen[str | None]):
    """Modal popup for API key configuration."""

    CSS = """
    ApiKeyModal {
        align: center middle;
    }

    #modal_overlay {
        width: 70;
        height: auto;
        border: heavy #ff6b6b 50%;
        background: #13161b;
        padding: 2 3;
    }

    #modal_header {
        text-align: center;
        text-style: bold;
        color: #ff6b6b;
        margin-bottom: 1;
    }

    #modal_divider {
        color: #2a3040;
        margin-bottom: 1;
    }

    .modal_label {
        color: #8a97a6;
        margin-top: 1;
        text-style: bold;
    }

    .modal_hint {
        color: #4a5568;
    }

    #api_input {
        margin: 1 0;
        border: tall #2a3442;
        background: #0b0e12;
        color: #e8f0fa;
    }

    #api_input:focus {
        border: tall #ff6b6b;
    }

    #provider_info {
        color: #5ec4ff;
        margin-bottom: 1;
    }

    #modal_buttons {
        height: auto;
        align: right middle;
        margin-top: 1;
    }

    #cancel_btn {
        margin-right: 1;
        background: #2a3040;
        color: #8a97a6;
        border: none;
    }

    #save_btn {
        background: #ff6b6b;
        color: #ffffff;
        border: none;
        text-style: bold;
    }

    #cancel_btn:hover {
        background: #3a4050;
    }

    #save_btn:hover {
        background: #ff8585;
    }
    """

    def compose(self) -> ComposeResult:
        with Vertical(id="modal_overlay"):
            yield Static("⚙  SETTINGS & API CONFIG", id="modal_header")
            yield Static("─" * 64, id="modal_divider")
            yield Label("Provider", classes="modal_label")
            yield Static("  Groq  ·  llama-3.3-70b-versatile", id="provider_info")
            yield Label("API Key", classes="modal_label")
            yield Static("  Get your key at console.groq.com", classes="modal_hint")
            yield Input(
                placeholder="  gsk_...",
                id="api_input",
                password=True,
            )
            with Horizontal(id="modal_buttons"):
                yield Button("Cancel", id="cancel_btn")
                yield Button("Save & Validate", id="save_btn")

    def on_mount(self) -> None:
        self.query_one("#api_input", Input).focus()

    @on(Button.Pressed, "#save_btn")
    def save(self) -> None:
        key = self.query_one("#api_input", Input).value.strip()
        self.dismiss(key)

    @on(Button.Pressed, "#cancel_btn")
    def cancel(self) -> None:
        self.dismiss(None)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "api_input":
            key = event.value.strip()
            self.dismiss(key)


# ─── Main App ────────────────────────────────────────────────────────
class GptTuiApp(App[None]):
    CSS = """
    Screen {
        background: #0d0f14;
        color: #c9d1d9;
    }

    Header {
        background: #10131a;
        color: #e6edf3;
        text-style: bold;
    }

    Footer {
        background: #10131a;
    }

    /* ── Main body ── */
    #body {
        height: 1fr;
    }

    /* ── Chat panel (left / main) ── */
    #chat_panel {
        width: 1fr;
        background: #0d0f14;
    }

    /* ── Status bar at top of chat ── */
    #status_bar {
        height: auto;
        background: #10131a;
        padding: 0 2;
        border-bottom: solid #1c2030;
    }

    .chip {
        margin-right: 2;
        padding: 0 1;
        text-style: bold;
    }

    /* ── Chat log ── */
    #chat_log {
        height: 1fr;
        background: #0d0f14;
        padding: 1 2;
    }

    /* ── Bottom input area ── */
    #input_area {
        height: auto;
        background: #10131a;
        padding: 1 2 0 2;
        border-top: solid #1c2030;
    }

    #prompt {
        border: tall #2a3442;
        background: #13161e;
        color: #e8f0fa;
        padding: 0 1;
    }

    #prompt:focus {
        border: tall #ff6b6b 70%;
    }

    #input_footer {
        height: 1;
        padding: 0 1;
        overflow: hidden;
    }

    #status_line {
        color: #4a5568;
        width: 1fr;
        overflow: hidden;
    }

    #model_badge {
        color: #5ec4ff;
        text-style: bold;
        width: auto;
        text-align: right;
    }

    /* ── Sidebar (right) ── */
    #sidebar {
        width: 38;
        min-width: 30;
        max-width: 50;
        background: #10131a;
        border-left: solid #1c2030;
    }

    #sidebar_header {
        height: auto;
        background: #10131a;
        padding: 0 1;
        border-bottom: solid #1c2030;
    }

    #panel_title {
        color: #ff6b6b;
        text-style: bold;
        width: 1fr;
    }

    #settings_btn {
        min-width: 4;
        background: transparent;
        color: #4a5568;
        border: none;
        padding: 0 1;
    }

    #settings_btn:hover {
        color: #ff6b6b;
    }

    /* file tree takes upper ~40% of sidebar */
    #file_tree {
        height: 40%;
        background: transparent;
        padding: 0 1;
        border-bottom: solid #1c2030;
    }

    DirectoryTree > .directory-tree--folder {
        color: #ffcb6b;
    }

    DirectoryTree > .directory-tree--file {
        color: #8a97a6;
    }

    DirectoryTree:focus > .directory-tree--cursor {
        background: #1c2030;
        color: #e8f0fa;
    }

    /* file preview pane in sidebar */
    #preview_header {
        height: auto;
        background: #13161e;
        padding: 0 1;
        border-bottom: solid #1c2030;
    }

    #preview_label {
        color: #5ec4ff;
        text-style: bold;
        width: 1fr;
    }

    #preview_close {
        min-width: 3;
        background: transparent;
        color: #4a5568;
        border: none;
        padding: 0 1;
    }

    #preview_close:hover {
        color: #ff6b6b;
    }

    #file_preview {
        height: 1fr;
        background: #0b0e12;
        padding: 0 1;
    }
    """

    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit"),
        Binding("ctrl+l", "clear_chat", "Clear"),
        Binding("ctrl+1", "focus_prompt", "Prompt"),
        Binding("ctrl+2", "focus_tree", "Files"),
        Binding("ctrl+3", "focus_preview", "Preview"),
        Binding("ctrl+r", "refresh_tree", "Refresh"),
        Binding("ctrl+k", "open_settings", "Settings"),
    ]

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal(id="body"):
            # ─ Main chat panel ─
            with Vertical(id="chat_panel"):
                with Horizontal(id="status_bar"):
                    yield Static("", id="chip_conn", classes="chip")
                    yield Static("", id="chip_model", classes="chip")
                    yield Static("", id="chip_repo", classes="chip")
                yield RichLog(id="chat_log", wrap=True, highlight=True, markup=True)
                with Vertical(id="input_area"):
                    yield Input(placeholder="  Ask anything or /help ...", id="prompt")
                    with Horizontal(id="input_footer"):
                        yield Static("Ready.", id="status_line")
                        yield Static("", id="model_badge")
            # ─ Sidebar ─
            with Vertical(id="sidebar"):
                with Horizontal(id="sidebar_header"):
                    yield Static("FILES", id="panel_title")
                    yield Button("⚙", id="settings_btn")
                yield DirectoryTree(str(Path.cwd()), id="file_tree")
                with Horizontal(id="preview_header"):
                    yield Static("PREVIEW", id="preview_label")
                    yield Button("✕", id="preview_close")
                yield RichLog(
                    id="file_preview",
                    wrap=True,
                    highlight=True,
                    markup=True,
                )
        yield Footer()

    # ── Lifecycle ─────────────────────────────────────────────────────
    def on_mount(self) -> None:
        self.title = APP_NAME
        self.config = AppConfig.load()
        repo_root = self._initial_repo_root()
        self.files = RepoFileService(repo_root=repo_root)

        key = self.config.api_key.strip() or os.getenv("GROQ_API_KEY", "").strip()
        self.provider = GroqProvider(api_key=key)
        self.model = self.config.model
        self.messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": (
                    "You are a coding assistant running inside a Windows terminal app. "
                    "You have FULL ability to create and edit files on disk. "
                    "When the user asks you to save, create, or write a file, "
                    "you MUST output the file content using this exact format:\n\n"
                    "WRITE_FILE: <filename_or_absolute_path>\n"
                    "```\n"
                    "<file content here>\n"
                    "```\n\n"
                    "The app will automatically detect this format and write the file to disk. "
                    "If no path is given, use the repo root. "
                    "After the WRITE_FILE block you can add a brief explanation. "
                    "Keep responses concise. Never say you cannot save files."
                ),
            }
        ]
        self._last_code_block: str = ""  # tracks last code block from assistant

        self._refresh_header()

        # ── Welcome banner ──
        log = self.query_one("#chat_log", RichLog)
        log.write(WELCOME_ART)
        log.write(WELCOME_MSG)
        log.write("")

        ts = self._timestamp()
        if not self.provider.available:
            log.write(f"[bold #ff6b6b]{ts}[/] [dim #ff6b6b]system[/]  Groq SDK missing. Run: pip install groq")
        elif not self.provider.connected:
            log.write(
                f"[bold #ffcb6b]{ts}[/] [dim #ffcb6b]system[/]  "
                "No API key configured. Press [bold #ff6b6b]Ctrl+K[/] to set up."
            )
        else:
            log.write(f"[bold #7ad97a]{ts}[/] [dim #7ad97a]system[/]  API key loaded. Ready to code!")

        log.write(
            f"[bold #5ec4ff]{ts}[/] [dim #5ec4ff]system[/]  "
            f"Workspace: [bold]{self.files.repo_root}[/]"
        )

        tree = self.query_one("#file_tree", DirectoryTree)
        tree.path = self.files.repo_root
        tree.reload()
        self.query_one("#prompt", Input).focus()

    # ── Actions ───────────────────────────────────────────────────────
    def action_open_settings(self) -> None:
        def handle_key(key: str | None) -> None:
            if key is not None and key:
                self._set_status("Validating API key...")
                self.validate_and_save_api_key(key)

        self.push_screen(ApiKeyModal(), handle_key)

    def action_focus_prompt(self) -> None:
        self.query_one("#prompt", Input).focus()

    def action_focus_tree(self) -> None:
        self.query_one("#file_tree", DirectoryTree).focus()

    def action_focus_preview(self) -> None:
        self.query_one("#file_preview", RichLog).focus()

    def action_refresh_tree(self) -> None:
        self.query_one("#file_tree", DirectoryTree).reload()
        self._set_status("File tree refreshed.")

    def action_clear_chat(self) -> None:
        self.query_one("#chat_log", RichLog).clear()
        self.messages = [self.messages[0]]
        self._log_system("Chat cleared.")

    # ── Event handlers ────────────────────────────────────────────────
    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "settings_btn":
            self.action_open_settings()
        elif event.button.id == "preview_close":
            pv = self.query_one("#file_preview", RichLog)
            pv.clear()
            self.query_one("#preview_label", Static).update("PREVIEW")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "prompt":
            text = event.value.strip()
            event.input.value = ""
            if not text:
                return
            if text.startswith("/"):
                self._handle_command(text)
                return
            self._log_user(text)
            self.messages.append({"role": "user", "content": text})
            self._set_status("Thinking...")
            self.ask_model()

    def on_directory_tree_file_selected(
        self, event: DirectoryTree.FileSelected
    ) -> None:
        resolved, err = self.files.resolve_repo_path(str(event.path.resolve()))
        if not resolved:
            self._set_status(err)
            return
        self._show_preview(resolved)
        self._set_status(f"Viewing: {resolved.name}")

    # ── Commands ──────────────────────────────────────────────────────
    def _handle_command(self, text: str) -> None:
        if text == "/help":
            help_text = (
                "[bold #ff6b6b]Available Commands[/]\n"
                "[#7a8a9e]/help[/]              Show this help\n"
                "[#7a8a9e]/clear[/]             Clear chat history\n"
                "[#7a8a9e]/model <name>[/]      Switch model\n"
                "[#7a8a9e]/repo[/]              Show repo root\n"
                "[#7a8a9e]/repo <path>[/]       Change repo root\n"
                "[#7a8a9e]/files [path][/]      List files\n"
                "[#7a8a9e]/read <file>[/]       Read file content\n"
                "[#7a8a9e]/apikey set <key>[/]  Set API key\n"
                "[#7a8a9e]/apikey status[/]     Check API key\n"
                "[#7a8a9e]/apikey clear[/]      Remove API key"
            )
            self.query_one("#chat_log", RichLog).write(help_text)
            return

        if text == "/clear":
            self.action_clear_chat()
            return

        if text.startswith("/model "):
            next_model = text.removeprefix("/model ").strip()
            if not next_model:
                self._log_system("Usage: /model <name>")
                return
            self.model = next_model
            self.config.model = next_model
            self.config.save()
            self._refresh_header()
            self._log_system(f"Model switched to: [bold]{self.model}[/]")
            return

        if text == "/repo":
            self._log_system(f"Repo root: [bold]{self.files.repo_root}[/]")
            return

        if text.startswith("/repo "):
            raw = text.removeprefix("/repo ").strip()
            self._cmd_set_repo(raw)
            return

        if text == "/files":
            self._cmd_files(str(self.files.repo_root))
            return

        if text.startswith("/files "):
            raw = text.removeprefix("/files ").strip()
            self._cmd_files(raw)
            return

        if text.startswith("/read "):
            raw = text.removeprefix("/read ").strip()
            self._cmd_read(raw)
            return

        if text.startswith("/save "):
            # /save <path> — writes last code block to file
            raw = text.removeprefix("/save ").strip()
            self._cmd_save(raw)
            return

        if text == "/save":
            self._log_system("Usage: /save <filename>  — saves last code block from chat")
            return

        if text == "/apikey status":
            if self.provider.connected:
                self._log_system("[green]●[/] API key is active.")
            else:
                self._log_system("[red]●[/] API key not configured.")
            return

        if text == "/apikey clear":
            self.provider.set_api_key("")
            self.config.api_key = ""
            self.config.save()
            self._refresh_header()
            self._log_system("API key cleared.")
            return

        if text.startswith("/apikey set "):
            raw_key = text.removeprefix("/apikey set ").strip()
            if not raw_key:
                self._log_system("Usage: /apikey set <key>")
                return
            self._set_status("Validating API key...")
            self.validate_and_save_api_key(raw_key)
            return

        self._log_system(f"Unknown command: [bold]{text}[/]. Type [bold]/help[/].")

    def _cmd_set_repo(self, raw_path: str) -> None:
        path = Path(raw_path)
        if not path.is_absolute():
            self._log_system("Usage: /repo <absolute_dir_path>")
            return
        ok, message = self.files.set_repo_root(path)
        self._log_system(message)
        if not ok:
            return
        self.config.repo_root = str(self.files.repo_root)
        self.config.save()
        tree = self.query_one("#file_tree", DirectoryTree)
        tree.path = self.files.repo_root
        tree.reload()
        self._refresh_header()
        self._set_status("Repo updated.")

    def _cmd_files(self, raw_path: str) -> None:
        root, err = self.files.resolve_repo_path(raw_path)
        if not root:
            self._log_system(err)
            return
        if not root.exists() or not root.is_dir():
            self._log_system(f"Directory not found: {root}")
            return
        files = self.files.list_files(root)
        if not files:
            self._log_system(f"No files found under: {root}")
            return
        self._log_system(f"[bold]{len(files)}[/] files under [bold]{root}[/]:")
        for file_path in files:
            self._log_system(f"  {file_path}")

    def _cmd_save(self, raw_name: str) -> None:
        """Save the last code block from the assistant to a file."""
        if not self._last_code_block:
            self._log_system("[red]●[/] No code block from assistant yet. Ask it to generate code first.")
            return
        # resolve path
        path = Path(raw_name)
        if not path.is_absolute():
            path = self.files.repo_root / raw_name
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(self._last_code_block, encoding="utf-8")
            self._log_system(f"[green]●[/] Saved: [bold]{path}[/]")
            self.query_one("#file_tree", DirectoryTree).reload()
            self._show_preview(path)
        except OSError as exc:
            self._log_system(f"[red]●[/] Save failed: {exc}")

    def _write_file(self, rel_or_abs: str, content: str) -> None:
        """Write content to a file path (called automatically from AI response)."""
        path = Path(rel_or_abs)
        if not path.is_absolute():
            path = self.files.repo_root / rel_or_abs
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            self.call_from_thread(
                self._log_system, f"[green]●[/] File written: [bold]{path}[/]"
            )
            self.call_from_thread(
                self.query_one("#file_tree", DirectoryTree).reload
            )
            self.call_from_thread(self._show_preview, path)
        except OSError as exc:
            self.call_from_thread(
                self._log_system, f"[red]●[/] Write failed ({rel_or_abs}): {exc}"
            )

    def _process_file_writes(self, reply: str) -> None:
        """Parse WRITE_FILE blocks from AI reply and save them to disk."""
        import re
        # Pattern: WRITE_FILE: <path>\n```[lang]\n<content>\n```
        pattern = re.compile(
            r"WRITE_FILE:\s*([^\n]+)\n```[^\n]*\n([\s\S]*?)```",
            re.MULTILINE,
        )
        for match in pattern.finditer(reply):
            file_path = match.group(1).strip()
            content = match.group(2)
            self._write_file(file_path, content)

        # Also track the last plain code block for /save command
        plain = re.compile(r"```[^\n]*\n([\s\S]*?)```", re.MULTILINE)
        blocks = plain.findall(reply)
        if blocks:
            self._last_code_block = blocks[-1]

    def _show_preview(self, file_path: Path) -> None:
        """Show file content in the sidebar preview pane (never touches chat)."""
        pv = self.query_one("#file_preview", RichLog)
        pv.clear()
        try:
            snippet, truncated = self.files.read_utf8(file_path)
        except UnicodeDecodeError:
            pv.write(f"[red]Binary / non-UTF8 file:[/] {file_path.name}")
            return
        except OSError as exc:
            pv.write(f"[red]Read error:[/] {exc}")
            return
        self.query_one("#preview_label", Static).update(
            f"[#5ec4ff]{file_path.name}[/]"
        )
        pv.write(snippet)
        if truncated:
            pv.write("[dim #4a5568]... (truncated)[/]")

    def _cmd_read(self, raw_path: str) -> None:
        """Explicit /read command — also shows in preview pane."""
        file_path, err = self.files.resolve_repo_path(raw_path)
        if not file_path:
            self._log_system(err)
            return
        if not file_path.exists() or not file_path.is_file():
            self._log_system(f"File not found: {file_path}")
            return
        self._show_preview(file_path)
        self._log_system(f"Loaded into preview: [bold]{file_path.name}[/]")

    # ── Internals ─────────────────────────────────────────────────────
    def _initial_repo_root(self) -> Path:
        if self.config.repo_root:
            cfg = Path(self.config.repo_root)
            if cfg.is_absolute() and cfg.exists() and cfg.is_dir():
                return cfg.resolve()
        cwd = Path.cwd().resolve()
        blocked = {
            Path(r"C:\Windows"),
            Path(r"C:\Windows\System32"),
            Path(r"C:\Program Files"),
            Path(r"C:\Program Files (x86)"),
        }
        if cwd.exists() and cwd.is_dir() and cwd not in blocked:
            return cwd
        return Path.home().resolve()

    def _refresh_header(self) -> None:
        conn = "Connected" if self.provider.connected else "No Key"
        conn_icon = "[green]●[/]" if self.provider.connected else "[red]●[/]"
        self.query_one("#chip_conn", Static).update(f"{conn_icon} {conn}")
        self.query_one("#chip_model", Static).update(
            f"[#5ec4ff]⬡[/] {self.model}"
        )
        repo_name = Path(str(self.files.repo_root)).name
        self.query_one("#chip_repo", Static).update(
            f"[#ffcb6b]▸[/] {repo_name}"
        )
        self.query_one("#model_badge", Static).update(
            f"[#5ec4ff]{self.model}[/]"
        )
        self.sub_title = f"{self.model} · {self.files.repo_root}"

    def _set_status(self, text: str) -> None:
        self.query_one("#status_line", Static).update(f"[#4a5568]{text}[/]")

    def _timestamp(self) -> str:
        return datetime.now().strftime("%H:%M:%S")

    def _log_user(self, message: str) -> None:
        self.query_one("#chat_log", RichLog).write(
            f"\n[bold #5ec4ff]{self._timestamp()}[/] [bold #5ec4ff]you[/]"
        )
        self.query_one("#chat_log", RichLog).write(f"  {message}")

    def _log_assistant(self, message: str) -> None:
        self.query_one("#chat_log", RichLog).write(
            f"\n[bold #7ad97a]{self._timestamp()}[/] [bold #7ad97a]assistant[/]"
        )
        self.query_one("#chat_log", RichLog).write(f"  {message}")

    def _log_system(self, message: str) -> None:
        self.query_one("#chat_log", RichLog).write(
            f"[#d2a8ff]{self._timestamp()}[/] [dim #d2a8ff]system[/]  {message}"
        )

    # ── Workers ───────────────────────────────────────────────────────
    @work(thread=True, exclusive=True)
    def validate_and_save_api_key(self, raw_key: str) -> None:
        ok, msg = self.provider.validate_api_key(raw_key)
        if ok:
            self.provider.set_api_key(raw_key)
            self.config.api_key = raw_key
            self.config.save()
            self.call_from_thread(self._refresh_header)
            self.call_from_thread(
                self._log_system, "[green]●[/] API key confirmed and saved."
            )
            self.call_from_thread(self._set_status, "API key confirmed.")
        else:
            self.call_from_thread(self._log_system, f"[red]●[/] {msg}")
            self.call_from_thread(self._set_status, "API key validation failed.")

    @work(thread=True, exclusive=True)
    def ask_model(self) -> None:
        if not self.provider.available:
            self.call_from_thread(self._set_status, "groq package missing.")
            return
        if not self.provider.connected:
            self.call_from_thread(
                self._set_status, "No API key. Press Ctrl+K."
            )
            return
        try:
            reply = self.provider.chat_completion(self.messages, self.model)
        except Exception as exc:  # noqa: BLE001
            self.call_from_thread(
                self._log_system, f"[red]●[/] Request failed: {exc}"
            )
            self.call_from_thread(self._set_status, "Request failed.")
            return

        self.messages.append({"role": "assistant", "content": reply})
        self.call_from_thread(self._log_assistant, reply)
        # Auto-process any WRITE_FILE blocks in the response
        self._process_file_writes(reply)
        self.call_from_thread(self._set_status, "Done.")

