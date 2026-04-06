from __future__ import annotations

import json
import os
import queue
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterator

from gpt_tui.config import AppConfig
from gpt_tui.providers.codex_provider import CodexProvider
from gpt_tui.providers.gemini_cli_provider import GeminiCliProvider
from gpt_tui.providers.gemini_provider import GeminiProvider
from gpt_tui.providers.groq_provider import GroqProvider
from gpt_tui.services.chat_store import ProjectChatStore
from gpt_tui.services.file_service import RepoFileService
from gpt_tui.ui.constants import (
    APP_NAME,
    CODEX_MODELS,
    DEFAULT_MODEL,
    GEMINI_CLI_MODELS,
    GEMINI_MODELS,
    GROQ_MODELS,
    MAX_TOOL_ROUNDS,
    TOOLS,
    VERSION,
)
from gpt_tui.ui.tool_executor import ToolExecutor, maybe_trim_context


PRESET_PROMPTS: dict[str, str] = {
    "code": "Focus on implementation quality and concise code changes.",
    "debug": "Prioritize root-cause analysis, reproduction, and minimal-risk fixes.",
    "refactor": "Prioritize maintainability, readability, and behavior-preserving changes.",
    "explain": "Prioritize clear explanation, tradeoffs, and short examples.",
}


class DesktopSessionService:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.config = AppConfig.load()
        self.repo_root = self._initial_repo_root()
        self.files = RepoFileService(self.repo_root)
        self.chat_store = ProjectChatStore(self.repo_root)
        self.groq_provider = GroqProvider(
            api_key=(self.config.api_key or os.getenv("GROQ_API_KEY", "")).strip(),
        )
        self.gemini_provider = GeminiProvider(os.getenv("GEMINI_API_KEY", "").strip())
        self.gemini_cli_provider = GeminiCliProvider(self.repo_root)
        self.codex_provider = CodexProvider(self.repo_root)
        self.model = self.config.model or DEFAULT_MODEL
        self.prompt_preset = self.config.prompt_preset or "code"
        self.tool_read_only = self.config.tool_safety_mode == "read"
        self.messages: list[dict[str, Any]] = []
        self.active_chat_id = ""
        self.tool_executor = ToolExecutor(
            repo_root=self.repo_root,
            resolve_repo_path=self.files.resolve_repo_path,
            list_files=self.files.list_files,
            read_utf8=self.files.read_utf8,
        )
        self.tool_executor.read_only = self.tool_read_only
        self._restore_active_chat()

    def _initial_repo_root(self) -> Path:
        if self.config.repo_root:
            configured = Path(self.config.repo_root)
            if configured.is_absolute() and configured.exists() and configured.is_dir():
                return configured.resolve()
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

    def _restore_active_chat(self) -> None:
        if not self.config.active_chat_id:
            return
        payload = self.chat_store.load_chat(self.config.active_chat_id)
        if not payload:
            return
        self.active_chat_id = self.config.active_chat_id
        self.messages = self._normalize_messages(payload.get("messages", []))

    def _normalize_messages(self, messages: Any) -> list[dict[str, Any]]:
        if not isinstance(messages, list):
            return []
        normalized: list[dict[str, Any]] = []
        for message in messages:
            if not isinstance(message, dict):
                continue
            role = str(message.get("role", "")).strip()
            if not role:
                continue
            normalized.append(dict(message))
        return normalized

    def _provider_for_model(self, model: str):
        if model.startswith("gemini"):
            if model.startswith("gemini-cli:"):
                return self.gemini_cli_provider
            return self.gemini_provider
        if model.startswith("codex:"):
            return self.codex_provider
        return self.groq_provider

    def _provider_name_for_model(self, model: str) -> str:
        if model.startswith("gemini"):
            return "Gemini CLI" if model.startswith("gemini-cli:") else "Gemini"
        if model.startswith("codex:"):
            return "Codex"
        return "Groq"

    def _models(self) -> list[dict[str, str]]:
        groups = [
            ("Gemini", GEMINI_MODELS),
            ("Gemini CLI", GEMINI_CLI_MODELS),
            ("Groq", GROQ_MODELS),
            ("Codex", CODEX_MODELS),
        ]
        models: list[dict[str, str]] = []
        for group, entries in groups:
            for model_id, label in entries:
                models.append({"id": model_id, "label": label, "group": group})
        return models

    def _providers(self) -> dict[str, dict[str, Any]]:
        return {
            "groq": {
                "available": self.groq_provider.available,
                "connected": self.groq_provider.connected,
            },
            "gemini": {
                "available": self.gemini_provider.available,
                "connected": self.gemini_provider.connected,
            },
            "geminiCli": {
                "available": self.gemini_cli_provider.available,
                "connected": self.gemini_cli_provider.connected,
            },
            "codex": {
                "available": self.codex_provider.available,
                "connected": self.codex_provider.connected,
            },
        }

    def _save_active_chat(self) -> None:
        model = self.model or DEFAULT_MODEL
        if self.active_chat_id:
            self.chat_store.save_chat(self.active_chat_id, self.messages, model=model)
        else:
            self.active_chat_id = self.chat_store.create_chat(self.messages, model=model)
        self.config.active_chat_id = self.active_chat_id
        self.config.repo_root = str(self.repo_root)
        self.config.model = model
        self.config.prompt_preset = self.prompt_preset
        self.config.tool_safety_mode = "read" if self.tool_read_only else "write"
        self.config.save()

    def _set_repo_root(self, repo_root: Path) -> None:
        resolved = repo_root.resolve()
        ok, message = self.files.set_repo_root(resolved)
        if not ok:
            raise ValueError(message)
        self.repo_root = self.files.repo_root
        self.chat_store.set_repo_root(self.repo_root)
        self.gemini_cli_provider.set_repo_root(self.repo_root)
        self.codex_provider.set_repo_root(self.repo_root)
        self.tool_executor.set_repo_root(self.repo_root)
        self.config.repo_root = str(self.repo_root)
        self.config.active_chat_id = ""
        self.config.save()
        self.active_chat_id = ""
        self.messages = []

    def _apply_prompt_preset(self, text: str) -> str:
        preset = PRESET_PROMPTS.get(self.prompt_preset, "")
        if not preset:
            return text
        return f"[Mode: {self.prompt_preset}] {preset}\n\n{text}"

    def _messages_with_preset(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        copied = [dict(message) for message in messages]
        for index in range(len(copied) - 1, -1, -1):
            if copied[index].get("role") == "user":
                copied[index]["content"] = self._apply_prompt_preset(
                    str(copied[index].get("content", "")),
                )
                break
        return copied

    def _event(self, event_type: str, **payload: Any) -> dict[str, Any]:
        return {"type": event_type, **payload}

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            chat_items = [
                {
                    "chatId": chat.chat_id,
                    "title": chat.title,
                    "updatedAt": chat.updated_at,
                    "createdAt": chat.created_at,
                    "model": chat.model,
                }
                for chat in self.chat_store.list_chats()
            ]
            repo_files = self.files.list_files(self.repo_root, 200)
            return {
                "app": {"name": APP_NAME, "version": VERSION},
                "config": {
                    "model": self.model,
                    "repoRoot": str(self.repo_root),
                    "activeChatId": self.active_chat_id,
                    "promptPreset": self.prompt_preset,
                    "toolSafetyMode": "read" if self.tool_read_only else "write",
                },
                "providers": self._providers(),
                "models": self._models(),
                "chats": chat_items,
                "messages": self.messages,
                "files": repo_files,
                "providerName": self._provider_name_for_model(self.model),
            }

    def new_chat(self) -> dict[str, Any]:
        with self._lock:
            self.messages = []
            self.active_chat_id = ""
            self.config.active_chat_id = ""
            self.config.save()
            return self.snapshot()

    def activate_chat(self, chat_id: str) -> dict[str, Any]:
        with self._lock:
            payload = self.chat_store.load_chat(chat_id)
            if not payload:
                raise ValueError(f"Chat not found: {chat_id}")
            self.active_chat_id = chat_id
            self.messages = self._normalize_messages(payload.get("messages", []))
            self.config.active_chat_id = chat_id
            self.config.save()
            return self.snapshot()

    def update_config(
        self,
        *,
        model: str | None = None,
        repo_root: str | None = None,
        api_key: str | None = None,
        prompt_preset: str | None = None,
        tool_safety_mode: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if repo_root is not None:
                target = Path(repo_root.strip())
                if not target.exists() or not target.is_dir():
                    raise ValueError(f"Directory not found: {target}")
                self._set_repo_root(target)
            if model is not None:
                self.model = model.strip() or DEFAULT_MODEL
                self.config.model = self.model
            if api_key is not None:
                key = api_key.strip()
                self.groq_provider.set_api_key(key)
                self.config.api_key = key
            if prompt_preset is not None:
                self.prompt_preset = prompt_preset.strip() or "code"
                self.config.prompt_preset = self.prompt_preset
            if tool_safety_mode is not None:
                mode = tool_safety_mode.strip() or "write"
                self.tool_read_only = mode == "read"
                self.tool_executor.read_only = self.tool_read_only
                self.config.tool_safety_mode = "read" if self.tool_read_only else "write"
            self.config.save()
            return self.snapshot()

    def read_file(self, raw_path: str) -> dict[str, Any]:
        with self._lock:
            file_path, error = self.files.resolve_repo_path(raw_path)
            if not file_path:
                raise ValueError(error)
            try:
                content, truncated = self.files.read_utf8(file_path)
            except UnicodeDecodeError as exc:
                raise ValueError("Binary/non-UTF8 file") from exc
            return {
                "path": str(file_path),
                "content": content,
                "truncated": truncated,
            }

    def send_message(self, text: str) -> dict[str, Any]:
        completed_event: dict[str, Any] | None = None
        for event in self.send_message_events(text):
            if event["type"] == "completed":
                completed_event = event
        if completed_event is None:
            raise RuntimeError("Send completed without a final completion event.")
        return {
            "assistantMessage": completed_event["assistantMessage"],
            "elapsedSeconds": completed_event["elapsedSeconds"],
            "usedTools": completed_event["usedTools"],
            "snapshot": completed_event["snapshot"],
        }

    def send_message_events(self, text: str) -> Iterator[dict[str, Any]]:
        message = text.strip()
        if not message:
            raise ValueError("Message is required.")

        with self._lock:
            provider = self._provider_for_model(self.model)
            if not provider.connected:
                raise ValueError(
                    f"{self._provider_name_for_model(self.model)} is not ready for requests.",
                )

            self.messages.append({"role": "user", "content": message})
            yield self._event("user_message", message=message)
            started = time.monotonic()
            yield self._event(
                "status",
                phase="started",
                message=f"Running {self._provider_name_for_model(self.model)}...",
            )

            if self.model.startswith("codex:") or self.model.startswith("gemini-cli:"):
                working_messages, condensed_count = maybe_trim_context(
                    self.messages,
                    provider,
                    self.model,
                )
                if condensed_count > 0:
                    yield self._event(
                        "status",
                        phase="context_trimmed",
                        message=f"Condensed {condensed_count} earlier messages to fit context.",
                    )
                if self.model.startswith("gemini-cli:"):
                    prepared_messages = [dict(entry) for entry in working_messages]
                else:
                    prepared_messages = self._messages_with_preset(working_messages)
                cli_events: queue.Queue[dict[str, Any] | None] = queue.Queue()
                result: dict[str, str] = {}
                failure: dict[str, Exception] = {}

                def run_cli() -> None:
                    try:
                        final_text = provider.chat_completion_stream_raw(
                            prepared_messages,
                            self.model,
                            on_output=lambda chunk: cli_events.put(
                                self._event("cli_output", stream="stdout", text=chunk),
                            ),
                        )
                        result["assistant"] = final_text
                    except Exception as error:  # noqa: BLE001
                        failure["error"] = error
                    finally:
                        cli_events.put(None)

                worker = threading.Thread(target=run_cli, daemon=True)
                worker.start()

                while True:
                    event = cli_events.get()
                    if event is None:
                        break
                    yield event

                worker.join()
                if "error" in failure:
                    raise failure["error"]
                final_text = result.get("assistant", "")
                self.messages = prepared_messages
                self.messages.append({"role": "assistant", "content": final_text})
                self._save_active_chat()
                elapsed_seconds = round(time.monotonic() - started, 2)
                snapshot = self.snapshot()
                yield self._event("assistant", text=final_text)
                yield self._event(
                    "completed",
                    assistantMessage=final_text,
                    elapsedSeconds=elapsed_seconds,
                    usedTools=0,
                    snapshot=snapshot,
                )
                return

            working_messages, condensed_count = maybe_trim_context(self.messages, provider, self.model)
            if condensed_count > 0:
                yield self._event(
                    "status",
                    phase="context_trimmed",
                    message=f"Condensed {condensed_count} earlier messages to fit context.",
                )
            working_messages = self._messages_with_preset(working_messages)
            used_tools = 0

            for round_index in range(MAX_TOOL_ROUNDS):
                yield self._event(
                    "status",
                    phase="thinking",
                    message=f"Thinking... round {round_index + 1}",
                )
                try:
                    final_text, asst_dict, tool_calls = provider.chat_with_tools(
                        working_messages,
                        self.model,
                        TOOLS,
                    )
                except RuntimeError as exc:
                    if "__TOOL_FAILED__" not in str(exc):
                        raise
                    yield self._event(
                        "status",
                        phase="fallback_plain_chat",
                        message="Tool call failed, retrying as plain chat.",
                    )
                    fallback_text = provider.chat_completion(working_messages, self.model)
                    self.messages = working_messages
                    self.messages.append({"role": "assistant", "content": fallback_text})
                    self._save_active_chat()
                    elapsed_seconds = round(time.monotonic() - started, 2)
                    snapshot = self.snapshot()
                    yield self._event("assistant", text=fallback_text)
                    yield self._event(
                        "completed",
                        assistantMessage=fallback_text,
                        elapsedSeconds=elapsed_seconds,
                        usedTools=used_tools,
                        snapshot=snapshot,
                    )
                    return

                if final_text is not None:
                    self.messages = working_messages
                    self.messages.append({"role": "assistant", "content": final_text})
                    self._save_active_chat()
                    elapsed_seconds = round(time.monotonic() - started, 2)
                    snapshot = self.snapshot()
                    yield self._event("assistant", text=final_text)
                    yield self._event(
                        "completed",
                        assistantMessage=final_text,
                        elapsedSeconds=elapsed_seconds,
                        usedTools=used_tools,
                        snapshot=snapshot,
                    )
                    return

                if asst_dict:
                    working_messages.append(asst_dict)

                if not tool_calls:
                    break

                for tool_call in tool_calls:
                    used_tools += 1
                    try:
                        args = json.loads(tool_call.function.arguments) or {}
                    except json.JSONDecodeError:
                        args = {}
                    yield self._event(
                        "tool_call",
                        name=tool_call.function.name,
                        args=args,
                    )
                    result = self.tool_executor.execute(tool_call.function.name, args)
                    yield self._event(
                        "tool_result",
                        name=tool_call.function.name,
                        result=result,
                    )
                    working_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "name": tool_call.function.name,
                            "content": result,
                        },
                    )

            raise RuntimeError("Maximum tool-call rounds reached.")
