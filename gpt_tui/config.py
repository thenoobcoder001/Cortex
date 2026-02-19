from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


def _config_dir() -> Path:
    local = os.getenv("LOCALAPPDATA", "").strip()
    if local:
        return Path(local) / "gpt-tui"
    return Path.home() / ".gpt-tui"


CONFIG_DIR = _config_dir()
CONFIG_FILE = CONFIG_DIR / "config.json"


@dataclass
class AppConfig:
    api_key: str = ""
    model: str = "gemini-2.0-flash"
    repo_root: str = ""

    @classmethod
    def load(cls) -> "AppConfig":
        if not CONFIG_FILE.exists():
            return cls()
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return cls()
        return cls(
            api_key=str(data.get("api_key", "")),
            model=str(data.get("model", "gemini-2.0-flash")),
            repo_root=str(data.get("repo_root", "")),
        )

    def save(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "api_key": self.api_key,
            "model": self.model,
            "repo_root": self.repo_root,
        }
        CONFIG_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")

