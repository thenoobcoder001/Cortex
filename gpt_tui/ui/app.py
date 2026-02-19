"""
app.py — GptTuiApp: UI layout, lifecycle, event handlers, agentic worker loop.

Responsibilities:
  - Compose the Textual UI (layout, CSS, bindings)
  - Handle user input, keyboard shortcuts, slash commands
  - Run the agentic "ask_model" loop (model → tools → model → reply)
  - Delegate tool execution to ToolsMixin
  - Delegate branding/constants to constants.py
  - Delegate modals to modals.py
"""
from __future__ import annotations

from datetime import datetime
import json
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
from textual.events import Key
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import (
    Button,
    DirectoryTree,
    Footer,
    Header,
    RichLog,
    Static,
    TextArea,
)

from gpt_tui.config import AppConfig
from gpt_tui.providers.gemini_provider import GeminiProvider
from gpt_tui.providers.groq_provider import GroqProvider
from gpt_tui.services.file_service import RepoFileService

from gpt_tui.ui.constants import (
    APP_NAME,
    CONTEXT_CHAR_LIMIT,
    DEFAULT_MODEL,
    MAX_TOOL_ROUNDS,
    TOOLS,
    WELCOME_ART,
    WELCOME_MSG,
)
from gpt_tui.ui.modals import ApiKeyModal, ModelPickerModal
from gpt_tui.ui.tool_executor import ToolsMixin


class ChatInput(TextArea):
    """A TextArea that sends on Enter and allows newlines on Shift+Enter."""

    BINDINGS = [
        Binding("enter", "submit", "Submit", show=False, priority=True),
    ]

    def action_submit(self) -> None:
        self.app.action_submit_prompt()

    def on_key(self, event: Key) -> None:
        """Force Enter to submit; Shift+Enter keeps newline behavior."""
        is_enter = event.key == "enter"
        is_shift = bool(getattr(event, "shift", False))
        if is_enter and not is_shift:
            event.stop()
            event.prevent_default()
            self.app.action_submit_prompt()


# ─── Main App ────────────────────────────────────────────────────────
class GptTuiApp(ToolsMixin, App[None]):
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
    #body { height: 1fr; }

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
        height: 12;
        border: tall #2a3442;
        background: #13161e;
        color: #e8f0fa;
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

    .sidebar_icon_btn {
        min-width: 4;
        background: transparent;
        color: #4a5568;
        border: none;
        padding: 0 1;
    }

    .sidebar_icon_btn:hover { color: #ff6b6b; }

    /* file tree */
    #file_tree {
        height: 40%;
        background: transparent;
        padding: 0 1;
        border-bottom: solid #1c2030;
    }

    DirectoryTree > .directory-tree--folder { color: #ffcb6b; }
    DirectoryTree > .directory-tree--file   { color: #8a97a6; }

    DirectoryTree:focus > .directory-tree--cursor {
        background: #1c2030;
        color: #e8f0fa;
    }

    /* file preview pane */
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

    #preview_close:hover { color: #ff6b6b; }

    #file_preview {
        height: 1fr;
        background: #0b0e12;
        padding: 0 1;
    }
    """

    BINDINGS = [
        Binding("ctrl+c", "quit",           "Quit"),
        Binding("ctrl+l", "clear_chat",     "Clear"),
        Binding("ctrl+1", "focus_prompt",   "Prompt"),
        Binding("ctrl+2", "focus_tree",     "Files"),
        Binding("ctrl+3", "focus_preview",  "Preview"),
        Binding("ctrl+r", "refresh_tree",   "Refresh"),
        Binding("ctrl+k", "open_settings",  "Settings"),
        Binding("ctrl+t", "pick_model",     "Model"),
        Binding("ctrl+g", "copy_last",      "Copy"),
        Binding("ctrl+enter", "submit_prompt", "Send", show=False),
    ]

    # ── Layout ────────────────────────────────────────────────────────
    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal(id="body"):
            # Chat panel
            with Vertical(id="chat_panel"):
                with Horizontal(id="status_bar"):
                    yield Static("", id="chip_conn",  classes="chip")
                    yield Static("", id="chip_model", classes="chip")
                    yield Static("", id="chip_repo",  classes="chip")
                yield RichLog(id="chat_log", wrap=True, highlight=True, markup=True)
                with Vertical(id="input_area"):
                    yield ChatInput(id="prompt")
                    with Horizontal(id="input_footer"):
                        yield Static("Ready.", id="status_line")
                        yield Static("",       id="model_badge")
            # Sidebar
            with Vertical(id="sidebar"):
                with Horizontal(id="sidebar_header"):
                    yield Static("FILES", id="panel_title")
                    yield Button("▣", id="model_switch_btn", classes="sidebar_icon_btn")
                    yield Button("⚙", id="settings_btn",    classes="sidebar_icon_btn")
                yield DirectoryTree(str(Path.cwd()), id="file_tree")
                with Horizontal(id="preview_header"):
                    yield Static("PREVIEW", id="preview_label")
                    yield Button("✕", id="preview_close")
                yield RichLog(id="file_preview", wrap=True, highlight=True, markup=True)
        yield Footer()

    # ── Lifecycle ─────────────────────────────────────────────────────
    def on_mount(self) -> None:
        self.title = APP_NAME
        self.config = AppConfig.load()
        repo_root = self._initial_repo_root()
        self.files = RepoFileService(repo_root=repo_root)
        self._last_code_block: str = ""

        # Providers
        groq_key   = self.config.api_key.strip() or os.getenv("GROQ_API_KEY", "").strip()
        gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.groq_provider   = GroqProvider(api_key=groq_key)
        self.gemini_provider = GeminiProvider(api_key=gemini_key)
        self.model    = self.config.model or DEFAULT_MODEL
        self.provider = self._provider_for_model(self.model)

        # Conversation history
        self.messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": (
                    "You are a coding assistant running inside a Windows terminal app. "
                    "You have full access to the file system via tools. "
                    "Use write_file to create or edit files, read_file to read them, "
                    "and list_files to explore the project. "
                    "Always use tools when the user asks to save, create, edit, or read files. "
                    "Keep explanations concise."
                ),
            }
        ]

        self._refresh_header()

        # Welcome banner
        log = self.query_one("#chat_log", RichLog)
        log.write(WELCOME_ART)
        log.write(WELCOME_MSG)
        log.write("")

        ts = self._timestamp()
        if not self.provider.connected:
            log.write(
                f"[bold #ffcb6b]{ts}[/] [dim #ffcb6b]system[/]  "
                "No API key. Press [bold #ff6b6b]Ctrl+K[/] for settings."
            )
        else:
            pname = "Gemini" if self.model.startswith("gemini") else "Groq"
            log.write(
                f"[bold #7ad97a]{ts}[/] [dim #7ad97a]system[/]  "
                f"{pname} connected. Ready to code!"
            )

        log.write(
            f"[bold #5ec4ff]{ts}[/] [dim #5ec4ff]system[/]  "
            f"Workspace: [bold]{self.files.repo_root}[/]"
        )

        tree = self.query_one("#file_tree", DirectoryTree)
        tree.path = self.files.repo_root
        tree.reload()
        self.query_one("#prompt", ChatInput).focus()

    # ── Actions ───────────────────────────────────────────────────────
    def action_open_settings(self) -> None:
        def handle_key(key: str | None) -> None:
            if key:
                self._set_status("Validating API key...")
                self.validate_and_save_api_key(key)
        self.push_screen(ApiKeyModal(), handle_key)

    def action_pick_model(self) -> None:
        def handle_pick(model: str | None) -> None:
            if model:
                self.model = model
                self.config.model = model
                self.config.save()
                self.provider = self._provider_for_model(model)
                self._refresh_header()
                pname = "Gemini" if model.startswith("gemini") else "Groq"
                self._log_system(
                    f"Switched to [bold #5ec4ff]{model}[/] ({pname})"
                )
        self.push_screen(ModelPickerModal(self.model), handle_pick)

    def action_focus_prompt(self)  -> None: self.query_one("#prompt", ChatInput).focus()
    def action_focus_tree(self)    -> None: self.query_one("#file_tree", DirectoryTree).focus()
    def action_focus_preview(self) -> None: self.query_one("#file_preview", RichLog).focus()

    def action_refresh_tree(self) -> None:
        self.query_one("#file_tree", DirectoryTree).reload()
        self._set_status("File tree refreshed.")

    def action_clear_chat(self) -> None:
        self.query_one("#chat_log", RichLog).clear()
        self.messages = [self.messages[0]]
        self._log_system("Chat cleared.")

    def action_copy_last(self) -> None:
        """Shortcut for ctrl+g."""
        self._cmd_copy()

    # ── Event handlers ────────────────────────────────────────────────
    def action_submit_prompt(self) -> None:
        """Handle prompt submission."""
        inp = self.query_one("#prompt", ChatInput)
        text = inp.text.strip()
        inp.text = ""
        if not text:
            return
        if text.startswith("/"):
            self._handle_command(text)
            return
        self._log_user(text)
        self.messages.append({"role": "user", "content": text})
        self._set_status("Thinking...")
        self.ask_model()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "settings_btn":
            self.action_open_settings()
        elif event.button.id == "model_switch_btn":
            self.action_pick_model()
        elif event.button.id == "preview_close":
            self.query_one("#file_preview", RichLog).clear()
            self.query_one("#preview_label", Static).update("PREVIEW")



    def on_directory_tree_file_selected(
        self, event: DirectoryTree.FileSelected
    ) -> None:
        resolved, err = self.files.resolve_repo_path(str(event.path.resolve()))
        if not resolved:
            self._set_status(err)
            return
        self._show_preview(resolved)
        self._set_status(f"Viewing: {resolved.name}")

    # ── Slash commands ────────────────────────────────────────────────
    def _handle_command(self, text: str) -> None:
        if text == "/help":
            self.query_one("#chat_log", RichLog).write(
                "[bold #ff6b6b]Available Commands[/]\n"
                "[#7a8a9e]/help[/]              Show this help\n"
                "[#7a8a9e]/copy[/]              Copy last AI reply to clipboard\n"
                "[#7a8a9e]/copy art[/]          Copy branding ASCII art\n"
                "[#7a8a9e]/clear[/]             Clear chat history\n"
                "[#7a8a9e]/model <name>[/]      Switch model\n"
                "[#7a8a9e]/repo[/]              Show repo root\n"
                "[#7a8a9e]/repo <path>[/]       Change repo root\n"
                "[#7a8a9e]/files [path][/]      List files\n"
                "[#7a8a9e]/read <file>[/]       Read file content\n"
                "[#7a8a9e]/save <file>[/]       Save last code block\n"
                "[#7a8a9e]/apikey set <key>[/]  Set API key\n"
                "[#7a8a9e]/apikey status[/]     Check API key\n"
                "[#7a8a9e]/apikey clear[/]      Remove API key"
            )
        elif text == "/clear":
            self.action_clear_chat()
        elif text == "/copy":
            self._cmd_copy()
        elif text == "/copy art":
            self._cmd_copy_art()
        elif text.startswith("/model "):
            m = text.removeprefix("/model ").strip()
            if not m:
                self._log_system("Usage: /model <name>")
                return
            self.model = m
            self.config.model = m
            self.config.save()
            self.provider = self._provider_for_model(m)
            self._refresh_header()
            self._log_system(f"Model switched to: [bold]{m}[/]")
        elif text == "/repo":
            self._log_system(f"Repo root: [bold]{self.files.repo_root}[/]")
        elif text.startswith("/repo "):
            self._cmd_set_repo(text.removeprefix("/repo ").strip())
        elif text == "/files":
            self._cmd_files(str(self.files.repo_root))
        elif text.startswith("/files "):
            self._cmd_files(text.removeprefix("/files ").strip())
        elif text.startswith("/read "):
            self._cmd_read(text.removeprefix("/read ").strip())
        elif text == "/save":
            self._log_system("Usage: /save <filename>  — saves last code block from chat")
        elif text.startswith("/save "):
            self._cmd_save(text.removeprefix("/save ").strip())
        elif text == "/apikey status":
            msg = "[green]●[/] API key is active." if self.provider.connected else "[red]●[/] No API key."
            self._log_system(msg)
        elif text == "/apikey clear":
            self.provider.set_api_key("")
            self.config.api_key = ""
            self.config.save()
            self._refresh_header()
            self._log_system("API key cleared.")
        elif text.startswith("/apikey set "):
            raw_key = text.removeprefix("/apikey set ").strip()
            if not raw_key:
                self._log_system("Usage: /apikey set <key>")
                return
            self._set_status("Validating API key...")
            self.validate_and_save_api_key(raw_key)
        else:
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
            self._log_system(f"No files under: {root}")
            return
        self._log_system(f"[bold]{len(files)}[/] files under [bold]{root}[/]:")
        for f in files:
            self._log_system(f"  {f}")

    def _cmd_save(self, raw_name: str) -> None:
        """Save the last code block from the assistant to a file."""
        if not self._last_code_block:
            self._log_system("[red]●[/] No code block yet. Ask the AI for code first.")
            return
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

    def _cmd_copy(self) -> None:
        """Copy the last assistant response to the Windows clipboard."""
        # Find the last assistant message
        last_asst = None
        for m in reversed(self.messages):
            if m.get("role") == "assistant" and m.get("content"):
                last_asst = m["content"]
                break
        
        if not last_asst:
            self._log_system("[red]●[/] Nothing to copy yet.")
            return

        try:
            # Use Windows built-in clip.exe
            with os.popen('clip', 'w') as pipe:
                pipe.write(last_asst)
            self._log_system("[green]●[/] Last reply copied to clipboard!")
        except Exception as exc:
            self._log_system(f"[red]●[/] Copy failed: {exc}")

    def _cmd_copy_art(self) -> None:
        """Copy the GPT TUI ASCII art."""
        from gpt_tui.ui.constants import WELCOME_ART
        # Strip rich tags before copying
        import re
        clean_art = re.sub(r'\[.*?\]', '', WELCOME_ART)
        try:
            with os.popen('clip', 'w') as pipe:
                pipe.write(clean_art)
            self._log_system("[green]●[/] ASCII art copied to clipboard!")
        except Exception as exc:
            self._log_system(f"[red]●[/] Copy failed: {exc}")

    def _show_preview(self, file_path: Path) -> None:
        """Show file content in the sidebar preview pane (never touches chat)."""
        pv = self.query_one("#file_preview", RichLog)
        pv.clear()
        try:
            snippet, truncated = self.files.read_utf8(file_path)
        except UnicodeDecodeError:
            pv.write(f"[red]Binary / non-UTF8:[/] {file_path.name}")
            return
        except OSError as exc:
            pv.write(f"[red]Read error:[/] {exc}")
            return
        self.query_one("#preview_label", Static).update(f"[#5ec4ff]{file_path.name}[/]")
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

    # ── Internal helpers ──────────────────────────────────────────────
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

    def _provider_for_model(self, model: str):
        """Return the correct provider instance for the given model name."""
        return self.gemini_provider if model.startswith("gemini") else self.groq_provider

    def _refresh_header(self) -> None:
        conn      = "Connected" if self.provider.connected else "No Key"
        conn_icon = "[green]●[/]" if self.provider.connected else "[red]●[/]"
        pname     = "Gemini" if self.model.startswith("gemini") else "Groq"
        self.query_one("#chip_conn",  Static).update(f"{conn_icon} {conn}")
        self.query_one("#chip_model", Static).update(
            f"[#5ec4ff]⬡[/] {self.model}  [dim #4a5568]({pname})[/]"
        )
        self.query_one("#chip_repo",  Static).update(
            f"[#ffcb6b]▸[/] {Path(str(self.files.repo_root)).name}"
        )
        self.query_one("#model_badge", Static).update(f"[#5ec4ff]{self.model}[/]")
        self.sub_title = f"{pname} · {self.model} · {self.files.repo_root}"

    def _set_status(self, text: str) -> None:
        self.query_one("#status_line", Static).update(f"[#4a5568]{text}[/]")

    def _timestamp(self) -> str:
        return datetime.now().strftime("%H:%M:%S")

    def _log_user(self, message: str) -> None:
        log = self.query_one("#chat_log", RichLog)
        log.write(f"\n[bold #5ec4ff]{self._timestamp()}[/] [bold #5ec4ff]you[/]")
        log.write(f"  {message}")

    def _log_assistant(self, message: str) -> None:
        log = self.query_one("#chat_log", RichLog)
        log.write(f"\n[bold #7ad97a]{self._timestamp()}[/] [bold #7ad97a]assistant[/]")
        log.write(f"  {message}")

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
            self.call_from_thread(self._log_system, "[green]●[/] API key confirmed and saved.")
            self.call_from_thread(self._set_status, "API key confirmed.")
        else:
            self.call_from_thread(self._log_system, f"[red]●[/] {msg}")
            self.call_from_thread(self._set_status, "API key validation failed.")

    @work(thread=True, exclusive=True)
    def ask_model(self) -> None:
        """Agentic loop: model → tool calls → results → model → ... → final reply."""
        if not self.provider.connected:
            self.call_from_thread(self._set_status, "No API key. Press Ctrl+K.")
            return

        # Auto-trim context if it's getting too long
        self._maybe_trim_context()

        # Work on a local copy so partial tool calls don't corrupt self.messages
        working_msgs = list(self.messages)

        for round_num in range(MAX_TOOL_ROUNDS):
            self.call_from_thread(
                self._set_status,
                f"Thinking... (round {round_num + 1})" if round_num > 0 else "Thinking...",
            )
            try:
                final_text, asst_dict, tool_calls = self.provider.chat_with_tools(
                    working_msgs, self.model, TOOLS
                )
            except RuntimeError as exc:
                if "__TOOL_FAILED__" in str(exc):
                    # Content too large for tool call — fall back to plain chat
                    self.call_from_thread(
                        self._set_status, "Content too large, falling back to plain chat..."
                    )
                    try:
                        reply = self.provider.chat_completion(working_msgs, self.model)
                        self.messages = working_msgs
                        self.messages.append({"role": "assistant", "content": reply})
                        self.call_from_thread(self._log_assistant, reply)
                        self.call_from_thread(
                            self._log_system,
                            "[yellow]●[/] Content too large for tool call. "
                            "Use [bold]/save <filename>[/] to write the code above.",
                        )
                        self.call_from_thread(self._set_status, "Done (plain mode).")
                    except Exception as exc2:  # noqa: BLE001
                        self.call_from_thread(
                            self._log_system, f"[red]●[/] Fallback failed: {exc2}"
                        )
                        self.call_from_thread(self._set_status, "Request failed.")
                    return

                self.call_from_thread(self._log_system, f"[red]●[/] Request failed: {exc}")
                self.call_from_thread(self._set_status, "Request failed.")
                return
            except Exception as exc:  # noqa: BLE001
                self.call_from_thread(self._log_system, f"[red]●[/] Request failed: {exc}")
                self.call_from_thread(self._set_status, "Request failed.")
                return

            if final_text is not None:
                # Model is done — track code blocks for /save, commit to history
                import re
                blocks = re.findall(r"```[^\n]*\n([\s\S]*?)```", final_text, re.MULTILINE)
                if blocks:
                    self._last_code_block = blocks[-1]
                self.messages = working_msgs
                self.messages.append({"role": "assistant", "content": final_text})
                self.call_from_thread(self._log_assistant, final_text)
                self.call_from_thread(self._set_status, "Done.")
                return

            # Model wants to call tools
            working_msgs.append(asst_dict)
            tool_names = [tc.function.name for tc in tool_calls]
            self.call_from_thread(
                self._set_status, f"Using tools: {', '.join(tool_names)}..."
            )
            for tc in tool_calls:
                try:
                    args = json.loads(tc.function.arguments) or {}
                except json.JSONDecodeError:
                    args = {}
                result = self._execute_tool(tc.function.name, args)
                working_msgs.append({
                    "role":         "tool",
                    "tool_call_id": tc.id,
                    "name":         tc.function.name,
                    "content":      result,
                })

        # Exceeded max rounds
        self.call_from_thread(
            self._log_system,
            "[yellow]●[/] Reached max tool-call rounds. Try rephrasing.",
        )
        self.call_from_thread(self._set_status, "Done (max rounds).")
