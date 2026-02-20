"""
modals.py - Textual modal dialogs: ModelPickerModal, ApiKeyModal.
"""
from __future__ import annotations

from textual import on
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Static

from gpt_tui.ui.constants import CODEX_MODELS, GEMINI_MODELS, GROQ_MODELS


class ModelPickerModal(ModalScreen[str | None]):
    """Modal for switching between Gemini / Groq / Codex models."""

    CSS = """
    ModelPickerModal { align: center middle; }

    #mp_overlay {
        width: 62;
        height: auto;
        border: heavy #5ec4ff 50%;
        background: #13161b;
        padding: 2 3;
    }

    #mp_header {
        text-align: center;
        text-style: bold;
        color: #5ec4ff;
        margin-bottom: 1;
    }

    #mp_divider { color: #2a3040; margin-bottom: 1; }

    .mp_section {
        color: #ffcb6b;
        text-style: bold;
        margin-top: 1;
    }

    .mp_model_btn {
        width: 100%;
        background: #1a1f2e;
        color: #c9d1d9;
        border: none;
        margin: 0;
        text-align: left;
    }

    .mp_model_btn:hover { background: #252b3d; color: #e8f0fa; }
    .mp_model_btn.-active { background: #1a2a1a; color: #7ad97a; }

    #mp_cancel {
        margin-top: 1;
        background: #2a3040;
        color: #8a97a6;
        border: none;
        width: 100%;
    }

    #mp_cancel:hover { background: #3a4050; }
    """

    def __init__(self, current_model: str) -> None:
        super().__init__()
        self.current_model = current_model

    def compose(self) -> ComposeResult:
        self._model_list = (
            [m for m, _ in GEMINI_MODELS]
            + [m for m, _ in GROQ_MODELS]
            + [m for m, _ in CODEX_MODELS]
        )

        with Vertical(id="mp_overlay"):
            yield Static("SELECT MODEL", id="mp_header")
            yield Static("-" * 56, id="mp_divider")

            yield Static("  GEMINI (Google)", classes="mp_section")
            for i, (model_id, label) in enumerate(GEMINI_MODELS):
                btn = Button(f"  {label}", id=f"mp_{i}", classes="mp_model_btn")
                if model_id == self.current_model:
                    btn.add_class("-active")
                yield btn

            yield Static("  GROQ (Meta/Mistral)", classes="mp_section")
            offset = len(GEMINI_MODELS)
            for i, (model_id, label) in enumerate(GROQ_MODELS):
                btn = Button(f"  {label}", id=f"mp_{offset + i}", classes="mp_model_btn")
                if model_id == self.current_model:
                    btn.add_class("-active")
                yield btn

            yield Static("  CODEX (Terminal)", classes="mp_section")
            offset2 = len(GEMINI_MODELS) + len(GROQ_MODELS)
            for i, (model_id, label) in enumerate(CODEX_MODELS):
                btn = Button(f"  {label}", id=f"mp_{offset2 + i}", classes="mp_model_btn")
                if model_id == self.current_model:
                    btn.add_class("-active")
                yield btn

            yield Button("Cancel", id="mp_cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        btn_id = event.button.id or ""
        if btn_id == "mp_cancel":
            self.dismiss(None)
            return
        if btn_id.startswith("mp_"):
            idx = int(btn_id[3:])
            self.dismiss(self._model_list[idx])


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

    #cancel_btn:hover { background: #3a4050; }
    #save_btn:hover   { background: #ff8585; }
    """

    def compose(self) -> ComposeResult:
        with Vertical(id="modal_overlay"):
            yield Static("SETTINGS & API CONFIG", id="modal_header")
            yield Static("-" * 64, id="modal_divider")
            yield Label("Provider", classes="modal_label")
            yield Static("  Groq / Gemini", id="provider_info")
            yield Label("API Key", classes="modal_label")
            yield Static("  Enter provider key (not used for Codex CLI)", classes="modal_hint")
            yield Input(placeholder="  gsk_... / AIza...", id="api_input", password=True)
            with Horizontal(id="modal_buttons"):
                yield Button("Cancel", id="cancel_btn")
                yield Button("Save & Validate", id="save_btn")

    def on_mount(self) -> None:
        self.query_one("#api_input", Input).focus()

    @on(Button.Pressed, "#save_btn")
    def save(self) -> None:
        self.dismiss(self.query_one("#api_input", Input).value.strip())

    @on(Button.Pressed, "#cancel_btn")
    def cancel(self) -> None:
        self.dismiss(None)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "api_input":
            self.dismiss(event.value.strip())

