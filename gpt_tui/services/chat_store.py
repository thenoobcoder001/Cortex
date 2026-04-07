from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
import re
import uuid
from pathlib import Path
from typing import Any


@dataclass
class ChatMeta:
    chat_id: str
    title: str
    updated_at: str
    created_at: str
    model: str


class ProjectChatStore:
    """Persist chat sessions under the current project folder."""

    def __init__(self, repo_root: Path) -> None:
        self.set_repo_root(repo_root)

    def set_repo_root(self, repo_root: Path) -> None:
        self.repo_root = repo_root.resolve()

    @property
    def store_dir(self) -> Path:
        return self.repo_root / ".gpt-tui" / "chats"

    @property
    def index_file(self) -> Path:
        return self.store_dir / "index.json"

    def _chat_file(self, chat_id: str) -> Path:
        return self.store_dir / f"{chat_id}.json"

    def _ensure_dir(self) -> None:
        self.store_dir.mkdir(parents=True, exist_ok=True)

    def _now_iso(self) -> str:
        return datetime.now().isoformat(timespec="seconds")

    def _load_index(self) -> list[dict[str, Any]]:
        if not self.index_file.exists():
            return []
        try:
            raw = json.loads(self.index_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        if not isinstance(raw, list):
            return []
        out: list[dict[str, Any]] = []
        for item in raw:
            if isinstance(item, dict) and item.get("chat_id"):
                out.append(item)
        return out

    def _save_index(self, items: list[dict[str, Any]]) -> None:
        self._ensure_dir()
        self.index_file.write_text(json.dumps(items, indent=2), encoding="utf-8")

    def _clean_user_text(self, text: str) -> str:
        cleaned = re.sub(r"^\[Mode:[^\]]+\][^\n]*\n\n", "", text.strip(), count=1)
        return cleaned.strip()

    def _title_from_messages(self, messages: list[dict[str, Any]]) -> str:
        for msg in messages:
            if str(msg.get("role", "")) != "user":
                continue
            text = self._clean_user_text(str(msg.get("content", "")))
            if not text:
                continue
            first = text.splitlines()[0].strip()
            if len(first) > 64:
                return first[:64].rstrip() + "..."
            return first
        return "New chat"

    def list_chats(self) -> list[ChatMeta]:
        items = self._load_index()
        dirty = False
        for item in items:
            title = str(item.get("title", ""))
            if title and not title.startswith("[Mode:"):
                continue
            payload = self.load_chat(str(item.get("chat_id", "")))
            if not payload:
                continue
            clean_title = self._title_from_messages(payload.get("messages", []))
            if clean_title and clean_title != title:
                item["title"] = clean_title
                dirty = True
        if dirty:
            self._save_index(items)
        items.sort(key=lambda x: str(x.get("updated_at", "")), reverse=True)
        out: list[ChatMeta] = []
        for item in items:
            out.append(
                ChatMeta(
                    chat_id=str(item.get("chat_id", "")),
                    title=str(item.get("title", "New chat")),
                    updated_at=str(item.get("updated_at", "")),
                    created_at=str(item.get("created_at", "")),
                    model=str(item.get("model", "")),
                )
            )
        return out

    def load_chat(self, chat_id: str) -> dict[str, Any] | None:
        if not chat_id:
            return None
        file_path = self._chat_file(chat_id)
        if not file_path.exists():
            return None
        try:
            payload = json.loads(file_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict):
            return None
        msgs = payload.get("messages", [])
        if not isinstance(msgs, list):
            return None
        return payload

    def create_chat(
        self,
        messages: list[dict[str, Any]],
        model: str,
        *,
        provider_state: dict[str, Any] | None = None,
    ) -> str:
        chat_id = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        self.save_chat(chat_id, messages, model=model, provider_state=provider_state)
        return chat_id

    def save_chat(
        self,
        chat_id: str,
        messages: list[dict[str, Any]],
        *,
        model: str,
        provider_state: dict[str, Any] | None = None,
    ) -> None:
        if not chat_id:
            return
        self._ensure_dir()
        now = self._now_iso()
        title = self._title_from_messages(messages)
        payload = {
            "chat_id": chat_id,
            "title": title,
            "updated_at": now,
            "model": model,
            "messages": messages,
        }
        if provider_state:
            payload["provider_state"] = provider_state
        self._chat_file(chat_id).write_text(
            json.dumps(payload, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

        items = self._load_index()
        existing = next((x for x in items if str(x.get("chat_id", "")) == chat_id), None)
        if existing is None:
            items.append(
                {
                    "chat_id": chat_id,
                    "title": title,
                    "created_at": now,
                    "updated_at": now,
                    "model": model,
                }
            )
        else:
            existing["title"] = title
            existing["updated_at"] = now
            existing["model"] = model
            if not existing.get("created_at"):
                existing["created_at"] = now
        self._save_index(items)

    def delete_chat(self, chat_id: str) -> bool:
        if not chat_id:
            return False
        file_path = self._chat_file(chat_id)
        if file_path.exists():
            try:
                file_path.unlink()
            except OSError:
                return False

        items = self._load_index()
        next_items = [x for x in items if str(x.get("chat_id", "")) != chat_id]
        if len(next_items) != len(items):
            self._save_index(next_items)
            return True
        return False
