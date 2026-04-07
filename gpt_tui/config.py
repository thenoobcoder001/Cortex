from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _config_dir() -> Path:
    local = os.getenv("LOCALAPPDATA", "").strip()
    if local:
        return Path(local) / "gpt-tui"
    return Path.home() / ".gpt-tui"


CONFIG_DIR = _config_dir()
CONFIG_FILE = CONFIG_DIR / "config.json"


def _normalize_run_entries(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    normalized: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        chat_id = str(item.get("chat_id", "")).strip()
        repo_root = str(item.get("repo_root", "")).strip()
        if not chat_id or not repo_root:
            continue
        normalized.append(
            {
                "chat_id": chat_id,
                "repo_root": repo_root,
                "model": str(item.get("model", "")).strip(),
                "last_user_message": str(item.get("last_user_message", "")).strip(),
                "started_at": str(item.get("started_at", "")).strip(),
                "recovered_at": str(item.get("recovered_at", "")).strip(),
            }
        )
    return normalized


@dataclass
class AppConfig:
    api_key: str = ""
    gemini_api_key: str = ""
    model: str = "gemini-cli:auto-gemini-2.5"
    repo_root: str = ""
    active_chat_id: str = ""
    gemini_session_id: str = ""
    codex_session_id: str = ""
    codex_session_mode: str = "resume_latest"
    prompt_preset: str = "code"
    tool_safety_mode: str = "write"
    assistant_memory: str = ""
    context_carry_messages: int = 5
    setup_checked: bool = False
    active_runs: list[dict[str, str]] = field(default_factory=list)
    interrupted_runs: list[dict[str, str]] = field(default_factory=list)

    @classmethod
    def load(cls) -> "AppConfig":
        if not CONFIG_FILE.exists():
            return cls()
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return cls()
        try:
            context_carry_messages = int(data.get("context_carry_messages", 5) or 5)
        except (TypeError, ValueError):
            context_carry_messages = 5
        return cls(
            api_key=str(data.get("api_key", "")),
            gemini_api_key=str(data.get("gemini_api_key", "")),
            model=str(data.get("model", "gemini-cli:auto-gemini-2.5")),
            repo_root=str(data.get("repo_root", "")),
            active_chat_id=str(data.get("active_chat_id", "")),
            gemini_session_id=str(data.get("gemini_session_id", "")),
            codex_session_id=str(data.get("codex_session_id", "")),
            codex_session_mode=str(data.get("codex_session_mode", "resume_latest")),
            prompt_preset=str(data.get("prompt_preset", "code")),
            tool_safety_mode=str(data.get("tool_safety_mode", "write")),
            assistant_memory=str(data.get("assistant_memory", "")),
            context_carry_messages=context_carry_messages,
            setup_checked=bool(data.get("setup_checked", False)),
            active_runs=_normalize_run_entries(data.get("active_runs", [])),
            interrupted_runs=_normalize_run_entries(data.get("interrupted_runs", [])),
        )

    def save(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "api_key": self.api_key,
            "gemini_api_key": self.gemini_api_key,
            "model": self.model,
            "repo_root": self.repo_root,
            "active_chat_id": self.active_chat_id,
            "gemini_session_id": self.gemini_session_id,
            "codex_session_id": self.codex_session_id,
            "codex_session_mode": self.codex_session_mode,
            "prompt_preset": self.prompt_preset,
            "tool_safety_mode": self.tool_safety_mode,
            "assistant_memory": self.assistant_memory,
            "context_carry_messages": self.context_carry_messages,
            "setup_checked": self.setup_checked,
            "active_runs": self.active_runs,
            "interrupted_runs": self.interrupted_runs,
        }
        CONFIG_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
