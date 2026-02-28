"""
app.py â€” GptTuiApp: UI layout, lifecycle, event handlers, agentic worker loop.

Responsibilities:
  - Compose the Textual UI (layout, CSS, bindings)
  - Handle user input, keyboard shortcuts, slash commands
  - Run the agentic "ask_model" loop (model â†’ tools â†’ model â†’ reply)
  - Delegate tool execution to ToolsMixin
  - Delegate branding/constants to constants.py
  - Delegate modals to modals.py
"""
from __future__ import annotations

from datetime import datetime
import json
import os
import time
from pathlib import Path
from typing import Any
from rich.markup import escape


def _load_dotenv() -> None:
    """Minimal .env loader â€” no extra package needed."""
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
from textual.containers import Horizontal, Vertical, VerticalScroll, ScrollableContainer
from textual.widgets import (
    Button,
    DirectoryTree,
    Footer,
    Header,
    Label,
    LoadingIndicator,
    RichLog,
    Static,
    TextArea,
)

from gpt_tui.config import AppConfig
from gpt_tui.providers.codex_provider import CodexProvider
from gpt_tui.providers.gemini_cli_provider import GeminiCliProvider
from gpt_tui.providers.gemini_provider import GeminiProvider
from gpt_tui.providers.groq_provider import GroqProvider
from gpt_tui.services.file_service import RepoFileService

from gpt_tui.ui.constants import (
    APP_NAME,
    CODEX_MODELS,
    CONTEXT_CHAR_LIMIT,
    DEFAULT_MODEL,
    MAX_TOOL_ROUNDS,
    TOOLS,
    WELCOME_ART,
    WELCOME_MSG,
)
from gpt_tui.ui.modals import ApiKeyModal, ModelPickerModal
from gpt_tui.ui.tool_executor import ToolsMixin


PRESET_PROMPTS: dict[str, str] = {
    "code": "Focus on implementation quality and concise code changes.",
    "debug": "Prioritize root-cause analysis, reproduction, and minimal-risk fixes.",
    "refactor": "Prioritize maintainability, readability, and behavior-preserving changes.",
    "explain": "Prioritize clear explanation, tradeoffs, and short examples.",
}


class ChatInput(TextArea):
    """A TextArea that sends on Enter and allows newlines on Shift+Enter."""

    BINDINGS = [
        Binding("enter", "submit", "Submit", show=False, priority=True),
    ]

    def action_submit(self) -> None:
        self.app.action_submit_prompt()

    def on_key(self, event: Key) -> None:
        """Force Enter to submit; Shift+Enter keeps newline behavior."""
        is_enter = event.key in ("enter", "return")
        is_shift = bool(getattr(event, "shift", False))
        if is_enter and not is_shift:
            event.stop()
            event.prevent_default()
            self.app.action_submit_prompt()


class ChatMessage(Horizontal):
    """A dedicated widget for a single chat message."""

    def __init__(self, role: str, content: str, timestamp: str, classes: str) -> None:
        super().__init__(classes=f"msg_container {classes}")
        self.role = role
        self.content = content
        self.timestamp = timestamp

    def compose(self) -> ComposeResult:
        with Vertical(classes="msg_content_col"):
            yield Label(f"{self.timestamp} {self.role}", classes="msg_header")
            yield Static(self.content, classes="msg_body")
        # Add a copy button that only shows up when relevant
        yield Button("Copy", id="msg_copy_btn", classes="msg_copy_btn", variant="primary")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.has_class("msg_copy_btn"):
            self.app._copy_to_clipboard(self.content)
            self.app._set_status(f"Copied {self.role}'s message.")
            event.button.label = "Copied"
            def _reset() -> None:
                try:
                    event.button.label = "Copy"
                except Exception:
                    pass
            self.set_timer(1.0, _reset)


# â”€â”€â”€ Main App â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    /* â”€â”€ Main body â”€â”€ */
    #body { height: 1fr; }

    /* â”€â”€ Chat panel (left / main) â”€â”€ */
    #chat_panel {
        width: 1fr;
        background: #0d0f14;
    }

    /* â”€â”€ Status bar at top of chat â”€â”€ */
    #status_bar {
        height: auto;
        background: #10131a;
        padding: 0 2;
        border-bottom: solid #1c2030;
    }

    #loading_indicator {
        display: none;
        width: 10;
        height: 1;
        margin-left: 2;
        color: #ff6b6b;
    }

    .chip {
        margin-right: 2;
        padding: 0 1;
        text-style: bold;
    }

    /* â”€â”€ Chat log â”€â”€ */
    #chat_log {
        height: 1fr;
        background: #0d0f14;
        padding: 1 2;
    }

    .msg_container {
        height: auto;
        padding: 1 0;
        margin-bottom: 1;
        border-top: solid #1c2030;
        layout: horizontal; /* Allow positioning button on right */
    }

    .msg_content_col {
        width: 1fr;
        height: auto;
    }

    .msg_header {
        text-style: bold;
        padding-bottom: 0;
    }

    .msg_user .msg_header { color: #5ec4ff; }
    .msg_assistant .msg_header { color: #7ad97a; }
    .msg_system .msg_header { color: #d2a8ff; }

    .msg_body {
        padding: 0 0 0 2;
        color: #c9d1d9;
    }

    .msg_copy_btn {
        min-width: 8;
        height: 1;
        background: transparent;
        color: #4a5568;
        border: none;
        margin-top: 0;
        padding: 0 1;
        text-style: dim;
    }

    .msg_copy_btn:hover {
        color: #7ad97a;
        background: #1c2030;
        text-style: bold;
    }

    #stream_box {
        display: none;
        height: auto;
        min-height: 1;
        max-height: 20;
        background: #13161e;
        color: #7ad97a;
        padding: 1 2;
        border-top: dashed #2a3442;
        overflow-y: scroll;
    }

    /* â”€â”€ Bottom input area â”€â”€ */
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

    #middle_panel {
        display: none;
        width: 58;
        min-width: 40;
        max-width: 76;
        background: #0f131a;
        border-left: solid #1c2030;
    }

    /* â”€â”€ Sidebar (right) â”€â”€ */
    #sidebar {
        width: 48;
        min-width: 38;
        max-width: 62;
        background: #10131a;
        border-left: solid #1c2030;
    }

    #sidebar_header {
        height: auto;
        background: #10131a;
        padding: 0 1;
        border-bottom: solid #1c2030;
    }
    #model_quickbar {
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
        min-width: 7;
        background: transparent;
        color: #4a5568;
        border: none;
        padding: 0 1;
    }

    .sidebar_icon_btn:hover { color: #ff6b6b; }
    .model_opt_btn {
        min-width: 8;
        background: transparent;
        color: #8a97a6;
        border: none;
        padding: 0 1;
    }
    .model_opt_btn:hover { color: #5ec4ff; }

    /* file tree */
    #file_tree {
        height: 34%;
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

    #console_header {
        height: auto;
        background: #13161e;
        padding: 0 1;
        border-top: solid #1c2030;
        border-bottom: solid #1c2030;
    }

    #console_label {
        color: #7ad97a;
        text-style: bold;
        width: 1fr;
    }

    #codex_console_scroller {
        height: 1fr;
        background: #090c10;
        padding: 0 1;
    }

    #codex_console {
        height: auto;
        width: 1fr;
        color: #4a5568;
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
        Binding("ctrl+shift+c", "copy_console", "Copy Console"),
        Binding("ctrl+shift+s", "copy_stream", "Copy Stream"),
        Binding("ctrl+enter", "submit_prompt", "Send", show=False),
    ]

    # â”€â”€ Layout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal(id="body"):
            # Chat panel
            with Vertical(id="chat_panel"):
                with Horizontal(id="status_bar"):
                    yield Static("", id="chip_conn",  classes="chip")
                    yield Static("", id="chip_model", classes="chip")
                    yield Static("", id="chip_repo",  classes="chip")
                    yield Static("", id="chip_mode", classes="chip")
                    yield LoadingIndicator(id="loading_indicator")
                yield VerticalScroll(id="chat_log", can_focus=True)
                yield Static("", id="stream_box", classes="stream_area")
                with Vertical(id="input_area"):
                    yield ChatInput(id="prompt")
                    with Horizontal(id="input_footer"):
                        yield Static("Ready.", id="status_line")
                        yield Static("",       id="model_badge")
            # Middle preview panel
            with Vertical(id="middle_panel"):
                with Horizontal(id="preview_header"):
                    yield Static("PREVIEW", id="preview_label")
                    yield Button("✕", id="preview_close")
                yield RichLog(id="file_preview", wrap=True, highlight=True, markup=True)
            # Sidebar
            with Vertical(id="sidebar"):
                with Horizontal(id="sidebar_header"):
                    yield Static("FILES", id="panel_title")
                    yield Button("RES", id="resume_btn", classes="sidebar_icon_btn")
                    yield Button("NEW", id="new_chat_btn", classes="sidebar_icon_btn")
                    yield Button("STR", id="copy_stream_btn", classes="sidebar_icon_btn")
                    yield Button("CON", id="copy_console_btn", classes="sidebar_icon_btn")
                    yield Button("MOD", id="model_switch_btn", classes="sidebar_icon_btn")
                    yield Button("SET", id="settings_btn",    classes="sidebar_icon_btn")
                with Horizontal(id="model_quickbar"):
                    yield Button("GCLI", id="model_q_gcli", classes="model_opt_btn")
                    yield Button("GEM", id="model_q_gem", classes="model_opt_btn")
                    yield Button("GROQ", id="model_q_groq", classes="model_opt_btn")
                    yield Button("CODEX", id="model_q_codex", classes="model_opt_btn")
                yield DirectoryTree(str(Path.cwd()), id="file_tree")
                with Horizontal(id="console_header"):
                    yield Static("CONSOLE", id="console_label")
                    yield Button("Copy", id="console_copy_btn", classes="sidebar_icon_btn")
                with VerticalScroll(id="codex_console_scroller"):
                    yield Static("[dim]CLI live output will appear here.[/]", id="codex_console")
        yield Footer()

    # â”€â”€ Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    def on_mount(self) -> None:
        self.title = APP_NAME
        self.config = AppConfig.load()
        repo_root = self._initial_repo_root()
        self.files = RepoFileService(repo_root=repo_root)
        self._last_code_block: str = ""
        self._last_stream_text: str = ""
        self._last_console_text: str = ""
        self._active_streaming_message: ChatMessage | None = None
        self._thinking_timer = None
        self._thinking_dots_count = 0
        self.prompt_preset = (self.config.prompt_preset or "code").strip().lower()
        if self.prompt_preset not in PRESET_PROMPTS:
            self.prompt_preset = "code"
        self.tool_read_only = (self.config.tool_safety_mode == "read")
        self._last_turn_seconds: float = 0.0
        self._last_turn_chars: int = 0
        self._last_turn_tools: int = 0

        # Providers
        groq_key   = self.config.api_key.strip() or os.getenv("GROQ_API_KEY", "").strip()
        gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.groq_provider   = GroqProvider(api_key=groq_key)
        self.gemini_provider = GeminiProvider(api_key=gemini_key)
        self.gemini_cli_provider = GeminiCliProvider(repo_root=repo_root)
        self.gemini_cli_provider.session_id = self.config.gemini_session_id
        self.gemini_cli_provider.session_mode = "resume_id" if self.config.gemini_session_id else "fresh"
        
        def save_session_id(sid: str) -> None:
            self.config.gemini_session_id = sid
            self.config.save()
            self.gemini_cli_provider.session_mode = "resume_id"
            
        self.gemini_cli_provider.on_session_init = save_session_id
        
        self.codex_provider  = CodexProvider(repo_root=repo_root)
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
        log = self.query_one("#chat_log", VerticalScroll)
        log.mount(Static(WELCOME_ART, classes="welcome_art"))
        self._log_system(WELCOME_MSG)

        ts = self._timestamp()
        if not self.provider.connected:
            if self.model.startswith("codex:"):
                self._log_system("Codex CLI not found. Install codex CLI or pick Gemini/Groq.")
            elif self.model.startswith("gemini-cli:"):
                self._log_system("Gemini CLI not found. Install Gemini CLI or pick Gemini/Groq.")
            else:
                self._log_system("No API key. Press [bold #ff6b6b]Ctrl+K[/] for settings.")
        else:
            pname = self._provider_name_for_model(self.model)
            self._log_system(f"{pname} connected. Ready to code!")

        self._log_system(f"Workspace: [bold]{self.files.repo_root}[/]")

        tree = self.query_one("#file_tree", DirectoryTree)
        tree.path = self.files.repo_root
        tree.reload()
        self._set_preview_visible(False)
        self._maybe_run_setup_check()
        
        self.query_one("#prompt", ChatInput).focus()

    # â”€â”€ Actions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
                pname = self._provider_name_for_model(model)
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
        log = self.query_one("#chat_log", VerticalScroll)
        log.query("*").remove()
        self.messages = [self.messages[0]]
        self._last_stream_text = ""
        self._last_console_text = ""
        self.query_one("#codex_console", Static).update("")
        self._log_system("Chat cleared.")

    def action_copy_last(self) -> None:
        """Shortcut for ctrl+g."""
        self._cmd_copy()
    
    def action_copy_console(self) -> None:
        self._cmd_copy_console()

    def action_copy_stream(self) -> None:
        self._cmd_copy_stream()

    def _flash_button_label(self, button: Button, temp: str, original: str) -> None:
        button.label = temp
        def _reset() -> None:
            try:
                button.label = original
            except Exception:
                pass
        self.set_timer(1.0, _reset)

    def _switch_model_quick(self, model: str) -> None:
        self.model = model
        self.config.model = model
        self.config.save()
        self.provider = self._provider_for_model(model)
        self._refresh_header()
        pname = self._provider_name_for_model(model)
        self._set_status(f"Model switched to {model}")
        self._log_system(f"Switched to [bold #5ec4ff]{model}[/] ({pname})")

    def _cycle_codex_model(self) -> None:
        codex_ids = [m for m, _ in CODEX_MODELS]
        if not codex_ids:
            return
        current = self.model if self.model.startswith("codex:") else codex_ids[0]
        try:
            idx = codex_ids.index(current)
            nxt = codex_ids[(idx + 1) % len(codex_ids)]
        except ValueError:
            nxt = codex_ids[0]
        self._switch_model_quick(nxt)

    def _copy_to_clipboard(self, text: str) -> None:
        """Copy text to the Windows clipboard."""
        try:
            import subprocess
            subprocess.run(['clip'], input=text.encode('utf-16'), check=True)
        except Exception as exc:
            self._log_system(f"[red]![/] Copy failed: {exc}")

    # â”€â”€ Event handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        elif event.button.id == "resume_btn":
            self._cmd_resume_latest()
        elif event.button.id == "new_chat_btn":
            self._cmd_new_chat()
        elif event.button.id == "copy_stream_btn":
            self._cmd_copy_stream()
            self._flash_button_label(event.button, "Copied", "STR")
        elif event.button.id == "copy_console_btn":
            self._cmd_copy_console()
            self._flash_button_label(event.button, "Copied", "CON")
        elif event.button.id == "console_copy_btn":
            self._cmd_copy_console()
            self._flash_button_label(event.button, "Copied", "Copy")
        elif event.button.id == "model_q_gcli":
            self._switch_model_quick("gemini-cli:auto-gemini-2.5")
            self._flash_button_label(event.button, "Active", "GCLI")
        elif event.button.id == "model_q_gem":
            self._switch_model_quick("gemini-2.0-flash")
            self._flash_button_label(event.button, "Active", "GEM")
        elif event.button.id == "model_q_groq":
            self._switch_model_quick("llama-3.3-70b-versatile")
            self._flash_button_label(event.button, "Active", "GROQ")
        elif event.button.id == "model_q_codex":
            self._cycle_codex_model()
            self._flash_button_label(event.button, "Active", "CODEX")
        elif event.button.id == "preview_close":
            self.query_one("#file_preview", RichLog).clear()
            self.query_one("#preview_label", Static).update("PREVIEW")
            self._set_preview_visible(False)



    def on_directory_tree_file_selected(
        self, event: DirectoryTree.FileSelected
    ) -> None:
        resolved, err = self.files.resolve_repo_path(str(event.path.resolve()))
        if not resolved:
            self._set_status(err)
            return
        self._show_preview(resolved)
        self._set_status(f"Viewing: {resolved.name}")

    # â”€â”€ Slash commands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    def _handle_command(self, text: str) -> None:
        if text == "/help":
            self._log_system(
                "[bold #ff6b6b]Available Commands[/]\n"
                "[#7a8a9e]/help[/]              Show this help\n"
                "[#7a8a9e]/copy[/]              Copy last AI reply to clipboard\n"
                "[#7a8a9e]/copy console[/]      Copy sidebar console text\n"
                "[#7a8a9e]/copy stream[/]       Copy current/last streamed output\n"
                "[#7a8a9e]/copy art[/]          Copy branding ASCII art\n"
                "[#7a8a9e]/newchat[/]           Start fresh chat session\n"
                "[#7a8a9e]/resume latest[/]     Resume latest CLI session\n"
                "[#7a8a9e]/resume <id>[/]       Resume specific Gemini session id\n"
                "[#7a8a9e]/preset <mode>[/]     Set prompt mode: code/debug/refactor/explain\n"
                "[#7a8a9e]/safety <mode>[/]     Tool safety: read/write\n"
                "[#7a8a9e]/export md <file>[/]  Export chat to Markdown\n"
                "[#7a8a9e]/export txt <file>[/] Export chat to plain text\n"
                "[#7a8a9e]/setup check[/]       Re-run environment setup checks\n"
                "[#7a8a9e]/clear[/]             Clear chat history\n"
                "[#7a8a9e]/models[/]            Show quick model options\n"
                "[#7a8a9e]/codex models[/]      List codex model options\n"
                "[#7a8a9e]/codex model <name>[/] Switch codex model\n"
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
        elif text == "/copy console":
            self._cmd_copy_console()
        elif text == "/copy stream":
            self._cmd_copy_stream()
        elif text == "/copy art":
            self._cmd_copy_art()
        elif text == "/models":
            codex_lines = "\n".join(f"- {m}" for m, _ in CODEX_MODELS)
            self._log_system(
                "Quick model options:\n"
                "- gemini-cli:auto-gemini-2.5\n"
                "- gemini-cli:auto-gemini-3\n"
                "- gemini-cli:gemini-3-flash-preview\n"
                "- gemini-2.0-flash\n"
                "- gemini-1.5-flash\n"
                "- llama-3.3-70b-versatile\n"
                f"{codex_lines}\n"
                "Use /model <name>, /codex model <name>, or sidebar quick buttons (GCLI/GEM/GROQ/CODEX)."
            )
        elif text == "/codex models":
            self._log_system(
                "Available codex models:\n"
                + "\n".join(f"- {m}" for m, _ in CODEX_MODELS)
            )
        elif text.startswith("/codex model "):
            raw = text.removeprefix("/codex model ").strip()
            if not raw:
                self._log_system("Usage: /codex model <name>")
                return
            model = raw if raw.startswith("codex:") else f"codex:{raw}"
            self._switch_model_quick(model)
        elif text == "/newchat":
            self._cmd_new_chat()
        elif text == "/resume latest":
            self._cmd_resume_latest()
        elif text.startswith("/resume "):
            sid = text.removeprefix("/resume ").strip()
            if not sid:
                self._log_system("Usage: /resume <session_id>")
                return
            self._cmd_resume_session_id(sid)
        elif text.startswith("/preset "):
            mode = text.removeprefix("/preset ").strip().lower()
            self._cmd_set_preset(mode)
        elif text.startswith("/safety "):
            mode = text.removeprefix("/safety ").strip().lower()
            self._cmd_set_safety_mode(mode)
        elif text.startswith("/export md "):
            self._cmd_export_chat("md", text.removeprefix("/export md ").strip())
        elif text.startswith("/export txt "):
            self._cmd_export_chat("txt", text.removeprefix("/export txt ").strip())
        elif text == "/setup check":
            self.config.setup_checked = False
            self._maybe_run_setup_check()
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
            self._log_system("Usage: /save <filename>  â€” saves last code block from chat")
        elif text.startswith("/save "):
            self._cmd_save(text.removeprefix("/save ").strip())
        elif text == "/apikey status":
            msg = "[green]â—[/] API key is active." if self.provider.connected else "[red]â—[/] No API key."
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
        self.codex_provider.set_repo_root(self.files.repo_root)
        self.gemini_cli_provider.set_repo_root(self.files.repo_root)
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
            self._log_system("[red]â—[/] No code block yet. Ask the AI for code first.")
            return
        path = Path(raw_name)
        if not path.is_absolute():
            path = self.files.repo_root / raw_name
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(self._last_code_block, encoding="utf-8")
            self._log_system(f"[green]â—[/] Saved: [bold]{path}[/]")
            self.query_one("#file_tree", DirectoryTree).reload()
            self._show_preview(path)
        except OSError as exc:
            self._log_system(f"[red]â—[/] Save failed: {exc}")

    def _cmd_copy(self) -> None:
        """Copy the last assistant response to the Windows clipboard."""
        # Find the last assistant message
        last_asst = None
        for m in reversed(self.messages):
            if m.get("role") == "assistant" and m.get("content"):
                last_asst = m["content"]
                break
        
        if not last_asst:
            self._log_system("[red]â—[/] Nothing to copy yet.")
            return

        self._copy_to_clipboard(last_asst)
        self._log_system("[green]â—[/] Last reply copied to clipboard!")

    def _cmd_copy_art(self) -> None:
        """Copy the GPT TUI ASCII art."""
        from gpt_tui.ui.constants import WELCOME_ART
        # Strip rich tags before copying
        import re
        clean_art = re.sub(r'\[.*?\]', '', WELCOME_ART)
        self._copy_to_clipboard(clean_art)
        self._log_system("[green]â—[/] ASCII art copied to clipboard!")

    def _cmd_copy_console(self) -> None:
        """Copy sidebar console content to clipboard."""
        console = self.query_one("#codex_console", Static)
        text = str(console.renderable).strip()
        if not text:
            text = self._last_console_text.strip()
        if not text:
            self._log_system("[red]â—[/] Console is empty.")
            return
        self._copy_to_clipboard(text)
        self._log_system("[green]â—[/] Console copied to clipboard!")

    def _cmd_copy_stream(self) -> None:
        """Copy current stream (or the most recent finished stream) to clipboard."""
        text = self._stream_buffer.strip() if hasattr(self, "_stream_buffer") else ""
        if not text:
            text = self._last_stream_text.strip()
        if not text:
            self._log_system("[red]â—[/] No stream output to copy yet.")
            return
        self._copy_to_clipboard(text)
        self._log_system("[green]â—[/] Stream output copied to clipboard!")

    def _cmd_new_chat(self) -> None:
        self.action_clear_chat()
        self.gemini_cli_provider.session_mode = "fresh"
        self.gemini_cli_provider.session_id = ""
        self.config.gemini_session_id = ""
        self.config.save()
        self._log_system("Started a fresh chat session (no resume).")
        self._refresh_header()

    def _cmd_resume_latest(self) -> None:
        self.gemini_cli_provider.session_mode = "resume_latest"
        self.gemini_cli_provider.session_id = ""
        self.config.gemini_session_id = ""
        self.config.save()
        self._log_system("Gemini CLI set to resume latest session.")
        self._refresh_header()

    def _cmd_resume_session_id(self, session_id: str) -> None:
        self.gemini_cli_provider.session_id = session_id
        self.gemini_cli_provider.session_mode = "resume_id"
        self.config.gemini_session_id = session_id
        self.config.save()
        self._log_system(f"Gemini CLI will resume session: [bold]{session_id}[/]")
        self._refresh_header()

    def _cmd_set_preset(self, mode: str) -> None:
        if mode not in PRESET_PROMPTS:
            self._log_system("Usage: /preset <code|debug|refactor|explain>")
            return
        self.prompt_preset = mode
        self.config.prompt_preset = mode
        self.config.save()
        self._log_system(f"Prompt preset set to: [bold]{mode}[/]")
        self._refresh_header()

    def _cmd_set_safety_mode(self, mode: str) -> None:
        if mode not in {"read", "write"}:
            self._log_system("Usage: /safety <read|write>")
            return
        self.tool_read_only = (mode == "read")
        self.config.tool_safety_mode = mode
        self.config.save()
        self._log_system(f"Tool safety mode: [bold]{mode}[/]")
        self._refresh_header()

    def _cmd_export_chat(self, fmt: str, raw_name: str) -> None:
        if fmt not in {"md", "txt"}:
            self._log_system("ERROR: unsupported export format")
            return
        if not raw_name:
            self._log_system(f"Usage: /export {fmt} <filename>")
            return
        path = Path(raw_name)
        if not path.is_absolute():
            path = self.files.repo_root / raw_name
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            lines: list[str] = []
            if fmt == "md":
                lines.append(f"# GPT TUI Export - {self._timestamp()}")
                lines.append(f"- Model: `{self.model}`")
                lines.append(f"- Provider: `{self._provider_name_for_model(self.model)}`")
                lines.append("")
            for msg in self.messages:
                role = str(msg.get("role", "unknown")).upper()
                content = str(msg.get("content", ""))
                if fmt == "md":
                    lines.append(f"## {role}")
                    lines.append("")
                    lines.append(content)
                    lines.append("")
                else:
                    lines.append(f"[{role}]")
                    lines.append(content)
                    lines.append("")
            path.write_text("\n".join(lines), encoding="utf-8")
            self._log_system(f"[green]â—[/] Exported chat to [bold]{path}[/]")
            self.query_one("#file_tree", DirectoryTree).reload()
        except OSError as exc:
            self._log_system(f"[red]â—[/] Export failed: {exc}")

    def _show_preview(self, file_path: Path) -> None:
        """Show file content in the sidebar preview pane (never touches chat)."""
        self._set_preview_visible(True)
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

    def _set_preview_visible(self, visible: bool) -> None:
        self.query_one("#middle_panel", Vertical).display = visible
        self.query_one("#preview_header", Horizontal).display = visible
        self.query_one("#file_preview", RichLog).display = visible

    def _cmd_read(self, raw_path: str) -> None:
        """Explicit /read command â€” also shows in preview pane."""
        file_path, err = self.files.resolve_repo_path(raw_path)
        if not file_path:
            self._log_system(err)
            return
        if not file_path.exists() or not file_path.is_file():
            self._log_system(f"File not found: {file_path}")
            return
        self._show_preview(file_path)
        self._log_system(f"Loaded into preview: [bold]{file_path.name}[/]")

    # â”€â”€ Internal helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        if model.startswith("gemini"):
            if model.startswith("gemini-cli:"):
                return self.gemini_cli_provider
            return self.gemini_provider
        if model.startswith("codex:"):
            return self.codex_provider
        return self.groq_provider

    def _provider_name_for_model(self, model: str) -> str:
        if model.startswith("gemini"):
            if model.startswith("gemini-cli:"):
                return "Gemini CLI"
            return "Gemini"
        if model.startswith("codex:"):
            return "Codex"
        return "Groq"

    def _maybe_run_setup_check(self) -> None:
        if self.config.setup_checked:
            return
        checks: list[str] = []
        gemini_ok = self.gemini_cli_provider.available
        codex_ok = self.codex_provider.available
        checks.append(f"Gemini CLI: {'OK' if gemini_ok else 'Missing'}")
        checks.append(f"Codex CLI: {'OK' if codex_ok else 'Missing'}")
        checks.append(f"GROQ key: {'OK' if bool(self.groq_provider.api_key) else 'Missing'}")
        checks.append(f"GEMINI key: {'OK' if bool(os.getenv('GEMINI_API_KEY', '').strip()) else 'Missing'}")
        self._log_system("[bold #ffcb6b]First-run setup check[/]\n" + "\n".join(f"- {c}" for c in checks))
        if not gemini_ok:
            self._log_system("Install Gemini CLI and run `gemini` once to login.")
        if not codex_ok:
            self._log_system("Install Codex CLI and run `codex login`.")
        self.config.setup_checked = True
        self.config.save()

    def _apply_prompt_preset(self, text: str) -> str:
        preset = PRESET_PROMPTS.get(self.prompt_preset, "")
        if not preset:
            return text
        return f"[Mode: {self.prompt_preset}] {preset}\n\n{text}"

    def _messages_with_preset(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not messages:
            return messages
        copied = list(messages)
        for i in range(len(copied) - 1, -1, -1):
            if copied[i].get("role") == "user":
                m = dict(copied[i])
                m["content"] = self._apply_prompt_preset(str(m.get("content", "")))
                copied[i] = m
                break
        return copied

    def _record_turn_stats(self, elapsed_s: float, final_text: str, tool_count: int = 0) -> None:
        self._last_turn_seconds = elapsed_s
        self._last_turn_chars = len(final_text or "")
        self._last_turn_tools = tool_count

    def _friendly_request_error(self, exc: Exception) -> str:
        text = str(exc)
        low = text.lower()
        if "resource_exhausted" in low or "429" in low or "rate" in low:
            return "Provider rate/capacity limit reached. Please retry shortly."
        if "access is denied" in low or "attachconsole failed" in low:
            return "Terminal attach failed for CLI provider. Re-open terminal and retry."
        if "not found in path" in low:
            return text
        return text

    def _refresh_header(self) -> None:
        conn      = "Connected" if self.provider.connected else "No Key"
        conn_icon = "[green]â—[/]" if self.provider.connected else "[red]â—[/]"
        pname     = self._provider_name_for_model(self.model)
        self.query_one("#chip_conn",  Static).update(f"{conn_icon} {conn}")
        self.query_one("#chip_model", Static).update(
            f"[#5ec4ff]â¬¡[/] {self.model}  [dim #4a5568]({pname})[/]"
        )
        self.query_one("#chip_repo",  Static).update(
            f"[#ffcb6b]â–¸[/] {Path(str(self.files.repo_root)).name}"
        )
        safety = "read-only" if self.tool_read_only else "write-enabled"
        sid = ""
        if self.model.startswith("gemini-cli:"):
            if self.gemini_cli_provider.session_mode == "fresh":
                sid = "fresh"
            elif self.gemini_cli_provider.session_mode == "resume_id" and self.gemini_cli_provider.session_id:
                sid = f"id:{self.gemini_cli_provider.session_id[:8]}"
            else:
                sid = "latest"
        stats = f"{self._last_turn_seconds:.1f}s/{self._last_turn_chars}c/{self._last_turn_tools}t"
        self.query_one("#chip_mode", Static).update(
            f"[#7ad97a]mode[/] {self.prompt_preset}  [dim]{safety}  {sid}  {stats}[/]"
        )
        self.query_one("#model_badge", Static).update(f"[#5ec4ff]{self.model}[/]")
        self.sub_title = f"{pname} Â· {self.model} Â· {self.files.repo_root}"

    def _set_status(self, text: str) -> None:
        self.query_one("#status_line", Static).update(f"[#4a5568]{text}[/]")

    def _timestamp(self) -> str:
        return datetime.now().strftime("%H:%M:%S")

    def _log_user(self, message: str) -> None:
        self._mount_message("you", message, "msg_user")

    def _log_assistant(self, message: str) -> None:
        if self._active_streaming_message:
            self._active_streaming_message.query_one(".msg_body", Static).update(message)
            self._active_streaming_message.content = message
            self._active_streaming_message = None
        else:
            self._mount_message("assistant", message, "msg_assistant")

    def _log_system(self, message: str) -> None:
        self._mount_message("system", message, "msg_system")

    def _mount_message(self, role: str, content: str, classes: str) -> ChatMessage:
        log = self.query_one("#chat_log", VerticalScroll)
        msg = ChatMessage(role, content, self._timestamp(), classes)
        log.mount(msg)
        log.scroll_end()
        return msg

    def _log_codex_stream_line(self, line: str) -> None:
        self._handle_stream_chunk(line + "\n")

    def _handle_stream_chunk(self, chunk: str) -> None:
        # Update the live stream
        self._update_stream(chunk)

        # Also update the sidebar console
        console = self.query_one("#codex_console", Static)
        current = str(console.renderable)
        next_text = current + chunk
        console.update(next_text)
        self._last_console_text = next_text
        self.query_one("#codex_console_scroller", VerticalScroll).scroll_end()

    def _update_thinking_dots(self) -> None:
        """Cycle through ., .., ... while waiting for model."""
        if self._active_streaming_message and not self._stream_buffer:
            self._thinking_dots_count = (self._thinking_dots_count % 3) + 1
            dots = "." * self._thinking_dots_count
            try:
                body = self._active_streaming_message.query_one(".msg_body", Static)
                body.update(f"[dim]Thinking{dots}[/]")
            except:
                pass

    def _start_stream(self) -> None:
        self.query_one("#loading_indicator", LoadingIndicator).display = True
        self._stream_buffer = ""
        self._thinking_dots_count = 0
        # Mount the placeholder message widget in the chat log
        self._active_streaming_message = self._mount_message("assistant", "[dim]Thinking...[/]", "msg_assistant")
        
        if self._thinking_timer:
            self._thinking_timer.stop()
        self._thinking_timer = self.set_interval(0.5, self._update_thinking_dots)

    def _update_stream(self, chunk: str) -> None:
        if not self._stream_buffer and self._thinking_timer:
            # First real chunk arrived!
            self._thinking_timer.stop()
            self._thinking_timer = None

        self._stream_buffer += chunk
        if self._active_streaming_message:
            body = self._active_streaming_message.query_one(".msg_body", Static)
            body.update(self._stream_buffer)
            self._active_streaming_message.content = self._stream_buffer
            self.query_one("#chat_log", VerticalScroll).scroll_end()

    def _finish_stream(self) -> None:
        self.query_one("#loading_indicator", LoadingIndicator).display = False
        if self._thinking_timer:
            self._thinking_timer.stop()
            self._thinking_timer = None
        if self._stream_buffer.strip():
            self._last_stream_text = self._stream_buffer
        elif self._active_streaming_message:
            # Avoid leaving a stale "Thinking..." placeholder on failed/empty runs.
            try:
                body = self._active_streaming_message.query_one(".msg_body", Static)
                body.update("[dim]No response.[/]")
            except Exception:
                pass
            self._active_streaming_message.content = "No response."
            self._active_streaming_message = None

    def _clear_codex_console(self) -> None:
        self.query_one("#codex_console", Static).update("")

    # Workers
    @work(thread=True, exclusive=True)
    def validate_and_save_api_key(self, raw_key: str) -> None:
        ok, msg = self.provider.validate_api_key(raw_key)
        if ok:
            self.provider.set_api_key(raw_key)
            self.config.api_key = raw_key
            self.config.save()
            self.call_from_thread(self._refresh_header)
            self.call_from_thread(self._log_system, "[green]â—[/] API key confirmed and saved.")
            self.call_from_thread(self._set_status, "API key confirmed.")
        else:
            self.call_from_thread(self._log_system, f"[red]â—[/] {msg}")
            self.call_from_thread(self._set_status, "API key validation failed.")

    @work(thread=True, exclusive=True)
    def ask_model(self) -> None:
        """Agentic loop: model â†’ tool calls â†’ results â†’ model â†’ ... â†’ final reply."""
        if not self.provider.connected:
            if self.model.startswith("codex:"):
                self.call_from_thread(self._set_status, "Codex CLI not found in PATH.")
            elif self.model.startswith("gemini-cli:"):
                self.call_from_thread(self._set_status, "Gemini CLI not found in PATH.")
            else:
                self.call_from_thread(self._set_status, "No API key. Press Ctrl+K.")
            return

        if self.model.startswith("codex:") or self.model.startswith("gemini-cli:"):
            self._maybe_trim_context()
            # Gemini CLI gets raw user text; the "[Mode: ...]" preset prefix tends to
            # trigger agentic/tool-planning behavior in piped non-interactive mode.
            if self.model.startswith("gemini-cli:"):
                working_msgs = list(self.messages)
            else:
                working_msgs = self._messages_with_preset(list(self.messages))
            cli_name = "Codex CLI" if self.model.startswith("codex:") else "Gemini CLI"
            self.call_from_thread(self._set_status, f"Running via {cli_name}...")
            self.call_from_thread(self._clear_codex_console)
            self.call_from_thread(self._start_stream)
            started = time.monotonic()
            try:
                cli_provider = (
                    self.codex_provider if self.model.startswith("codex:")
                    else self.gemini_cli_provider
                )
                final_text = cli_provider.chat_completion_stream_raw(
                    working_msgs,
                    self.model,
                    on_output=lambda chunk: self.call_from_thread(
                        self._handle_stream_chunk, chunk
                    ),
                )
            except Exception as exc:  # noqa: BLE001
                self.call_from_thread(self._finish_stream)
                self.call_from_thread(self._log_system, f"[red]![/] Request failed: {self._friendly_request_error(exc)}")
                self.call_from_thread(self._set_status, "Request failed.")
                return

            self.call_from_thread(self._finish_stream)
            elapsed = time.monotonic() - started
            self._record_turn_stats(elapsed, final_text, 0)
            import re
            blocks = re.findall(r"```[^\n]*\n([\s\S]*?)```", final_text, re.MULTILINE)
            if blocks:
                self._last_code_block = blocks[-1]
            self.messages = working_msgs
            self.messages.append({"role": "assistant", "content": final_text})
            self.call_from_thread(self._log_assistant, final_text)
            self.call_from_thread(self._refresh_header)
            self.call_from_thread(self._set_status, "Done.")
            return

        # Auto-trim context if it's getting too long
        self._maybe_trim_context()

        # Work on a local copy so partial tool calls don't corrupt self.messages
        working_msgs = self._messages_with_preset(list(self.messages))
        started = time.monotonic()
        used_tools = 0

        for round_num in range(MAX_TOOL_ROUNDS):
            status_text = (
                f"Thinking... (round {round_num + 1})"
                if round_num > 0
                else "Thinking..."
            )
            self.call_from_thread(self._set_status, status_text)
            
            # Show "Thinking..." in the chat log for the first round
            if round_num == 0:
                self.call_from_thread(self._start_stream)
            
            try:
                final_text, asst_dict, tool_calls = self.provider.chat_with_tools(
                    working_msgs, self.model, TOOLS
                )
            except RuntimeError as exc:
                self.call_from_thread(self._finish_stream)
                if "__TOOL_FAILED__" in str(exc):
                    # Content too large for tool call â€” fall back to plain chat
                    self.call_from_thread(self._finish_stream)
                    self.call_from_thread(
                        self._set_status, "Content too large, falling back to plain chat..."
                    )
                    # Start a new "thinking" indicator for the plain chat fallback
                    self.call_from_thread(self._start_stream)
                    try:
                        reply = self.provider.chat_completion(working_msgs, self.model)
                        self.messages = working_msgs
                        self.messages.append({"role": "assistant", "content": reply})
                        self.call_from_thread(self._log_assistant, reply)
                        self.call_from_thread(
                            self._log_system,
                            "[yellow]â—[/] Content too large for tool call. "
                            "Use [bold]/save <filename>[/] to write the code above.",
                        )
                        self.call_from_thread(self._set_status, "Done (plain mode).")
                    except Exception as exc2:  # noqa: BLE001
                        self.call_from_thread(
                            self._log_system, f"[red]â—[/] Fallback failed: {exc2}"
                        )
                        self.call_from_thread(self._set_status, "Request failed.")
                    return

                self.call_from_thread(self._log_system, f"[red]â—[/] Request failed: {self._friendly_request_error(exc)}")
                self.call_from_thread(self._set_status, "Request failed.")
                return
            except Exception as exc:  # noqa: BLE001
                self.call_from_thread(self._finish_stream)
                self.call_from_thread(self._log_system, f"[red]â—[/] Request failed: {self._friendly_request_error(exc)}")
                self.call_from_thread(self._set_status, "Request failed.")
                return

            if final_text is not None:
                self.call_from_thread(self._finish_stream)
                # Model is done â€” track code blocks for /save, commit to history
                import re
                blocks = re.findall(r"```[^\n]*\n([\s\S]*?)```", final_text, re.MULTILINE)
                if blocks:
                    self._last_code_block = blocks[-1]
                self.messages = working_msgs
                self.messages.append({"role": "assistant", "content": final_text})
                elapsed = time.monotonic() - started
                self._record_turn_stats(elapsed, final_text, used_tools)
                self.call_from_thread(self._log_assistant, final_text)
                self.call_from_thread(self._refresh_header)
                self.call_from_thread(self._set_status, "Done.")
                return

            # Model wants to call tools
            # Note: We keep _active_streaming_message alive through tool rounds
            # so it can show progress if desired, but for now we'll just keep it 
            # as "Thinking (round X)..."
            tool_names = [tc.function.name for tc in tool_calls]
            self.call_from_thread(
                self._set_status, f"Using tools: {', '.join(tool_names)}..."
            )
            for tc in tool_calls:
                used_tools += 1
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
        self.call_from_thread(self._finish_stream)
        self.call_from_thread(
            self._log_system,
            "[yellow]â—[/] Reached max tool-call rounds. Try rephrasing.",
        )
        self.call_from_thread(self._set_status, "Done (max rounds).")

