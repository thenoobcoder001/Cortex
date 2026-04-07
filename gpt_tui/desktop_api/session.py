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
    "chat": "",
    "code": "Focus on implementation quality and concise code changes.",
    "debug": "Prioritize root-cause analysis, reproduction, and minimal-risk fixes.",
    "refactor": "Prioritize maintainability, readability, and behavior-preserving changes.",
    "explain": "Prioritize clear explanation, tradeoffs, and short examples.",
}

BASE_ASSISTANT_SYSTEM_PROMPT = (
    "You are a local desktop coding assistant working inside the user's current workspace. "
    "Answer casual greetings and generic questions naturally and directly. "
    "Do not volunteer statements about lacking file access, tool access, or terminal access unless "
    "the current request truly requires an action you cannot perform. "
    "Do not turn simple chat into a discussion of safety restrictions. "
    "When the user asks about the project or codebase, help clearly and pragmatically."
)

TOOL_DECIDER_SYSTEM_PROMPT = (
    "You are deciding whether the assistant must use workspace tools for the next user request. "
    "Reply with exactly one token: NEED_TOOLS or NO_TOOLS.\n"
    "Reply NEED_TOOLS only if answering correctly requires inspecting or changing files, reading project state, "
    "running commands, or using other workspace tools.\n"
    "Reply NO_TOOLS for casual chat, greetings, generic advice, model comparisons, brainstorming, or questions "
    "that can be answered directly without touching the workspace.\n"
    "Do not explain your answer."
)


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
        self.gemini_provider = GeminiProvider(
            (self.config.gemini_api_key or os.getenv("GEMINI_API_KEY", "")).strip(),
        )
        self.gemini_cli_provider = GeminiCliProvider(self.repo_root)
        self.gemini_cli_provider.session_id = self.config.gemini_session_id.strip()
        self.gemini_cli_provider.session_mode = (
            "resume_id" if self.gemini_cli_provider.session_id else "fresh"
        )
        self.gemini_cli_provider.on_session_init = self._save_gemini_session_id
        self.codex_provider = CodexProvider(self.repo_root)
        self.codex_provider.session_id = self.config.codex_session_id.strip()
        self.codex_provider.session_mode = "resume_id" if self.codex_provider.session_id else "fresh"
        self.codex_provider.on_session_init = self._save_codex_session_id
        self.model = self.config.model or DEFAULT_MODEL
        self.prompt_preset = self.config.prompt_preset or "code"
        self.tool_read_only = self.config.tool_safety_mode == "read"
        self.messages: list[dict[str, Any]] = []
        self.active_chat_id = ""
        self.active_chat_model = ""
        self.running_chat_ids: set[str] = set()
        self.tool_executor = ToolExecutor(
            repo_root=self.repo_root,
            resolve_repo_path=self.files.resolve_repo_path,
            list_files=self.files.list_files,
            read_utf8=self.files.read_utf8,
        )
        self.tool_executor.read_only = self.tool_read_only
        self._restore_active_chat()

    def _provider_state_from_payload(self, payload: dict[str, Any] | None) -> dict[str, str]:
        if not isinstance(payload, dict):
            return {}
        raw = payload.get("provider_state")
        if not isinstance(raw, dict):
            return {}
        out: dict[str, str] = {}
        for key, value in raw.items():
            if value:
                out[str(key)] = str(value)
        return out

    def _make_request_providers(
        self,
        repo_root: Path,
        provider_state: dict[str, str],
    ) -> tuple[GroqProvider, GeminiProvider, GeminiCliProvider, CodexProvider, ToolExecutor]:
        groq_provider = GroqProvider(
            api_key=(self.config.api_key or os.getenv("GROQ_API_KEY", "")).strip(),
        )
        gemini_provider = GeminiProvider(os.getenv("GEMINI_API_KEY", "").strip())
        gemini_cli_provider = GeminiCliProvider(repo_root)
        gemini_session_id = provider_state.get("gemini_cli_session_id", "").strip()
        gemini_cli_provider.session_id = gemini_session_id
        gemini_cli_provider.session_mode = "resume_id" if gemini_session_id else "fresh"
        codex_provider = CodexProvider(repo_root)
        codex_session_id = provider_state.get("codex_session_id", "").strip()
        codex_provider.session_id = codex_session_id
        codex_provider.session_mode = "resume_id" if codex_session_id else "fresh"
        file_service = RepoFileService(repo_root)
        tool_executor = ToolExecutor(
            repo_root=repo_root,
            resolve_repo_path=file_service.resolve_repo_path,
            list_files=file_service.list_files,
            read_utf8=file_service.read_utf8,
        )
        tool_executor.read_only = self.tool_read_only
        return groq_provider, gemini_provider, gemini_cli_provider, codex_provider, tool_executor

    def _provider_for_request(
        self,
        model: str,
        groq_provider: GroqProvider,
        gemini_provider: GeminiProvider,
        gemini_cli_provider: GeminiCliProvider,
        codex_provider: CodexProvider,
    ):
        if model.startswith("gemini"):
            if model.startswith("gemini-cli:"):
                return gemini_cli_provider
            return gemini_provider
        if model.startswith("codex:"):
            return codex_provider
        return groq_provider

    def _save_gemini_session_id(self, session_id: str) -> None:
        cleaned = session_id.strip()
        if not cleaned:
            return
        self.gemini_cli_provider.session_id = cleaned
        self.gemini_cli_provider.session_mode = "resume_id"
        self.config.gemini_session_id = cleaned
        self.config.save()

    def _save_codex_session_id(self, session_id: str) -> None:
        cleaned = session_id.strip()
        if not cleaned:
            return
        self.codex_provider.session_id = cleaned
        self.codex_provider.session_mode = "resume_id"
        self.config.codex_session_id = cleaned
        self.config.save()

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
        self.active_chat_model = str(payload.get("model", "")).strip()
        self.messages = self._normalize_messages(payload.get("messages", []))
        if self.model.startswith("gemini-cli:") and not self.active_chat_model.startswith("gemini-cli:"):
            self.gemini_cli_provider.session_id = ""
            self.gemini_cli_provider.session_mode = "fresh"
            self.config.gemini_session_id = ""
        if self.model.startswith("codex:") and not self.active_chat_model.startswith("codex:"):
            self.codex_provider.session_id = ""
            self.codex_provider.session_mode = "fresh"
            self.config.codex_session_id = ""
            self.config.save()

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

    def _model_family(self, model: str) -> str:
        if model.startswith("gemini-cli:"):
            return "gemini-cli"
        if model.startswith("gemini"):
            return "gemini"
        if model.startswith("codex:"):
            return "codex"
        return "groq"

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
        self.active_chat_model = model
        self.config.active_chat_id = self.active_chat_id
        self.config.repo_root = str(self.repo_root)
        self.config.model = model
        self.config.prompt_preset = self.prompt_preset
        self.config.tool_safety_mode = "read" if self.tool_read_only else "write"
        self.config.gemini_session_id = self.gemini_cli_provider.session_id
        self.config.codex_session_id = self.codex_provider.session_id
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
        self.config.gemini_session_id = ""
        self.config.codex_session_id = ""
        self.config.save()
        self.active_chat_id = ""
        self.active_chat_model = ""
        self.messages = []
        self.gemini_cli_provider.session_id = ""
        self.gemini_cli_provider.session_mode = "fresh"
        self.codex_provider.session_id = ""
        self.codex_provider.session_mode = "fresh"

    def _apply_prompt_preset(self, text: str) -> str:
        preset = PRESET_PROMPTS.get(self.prompt_preset, "")
        if not preset:
            return text
        return f"[Mode: {self.prompt_preset}] {preset}\n\n{text}"

    def _context_carry_limit(self) -> int:
        try:
            limit = int(self.config.context_carry_messages)
        except (TypeError, ValueError):
            limit = 5
        return max(0, min(limit, 20))

    def _looks_like_repo_task(self, text: str) -> bool:
        lowered = text.lower()
        repo_markers = (
            "repo",
            "repository",
            "project",
            "code",
            "file",
            "folder",
            "function",
            "class",
            "component",
            "bug",
            "fix",
            "implement",
            "update",
            "edit",
            "refactor",
            "debug",
            "test",
            "terminal",
            "command",
            "script",
            "read ",
            "write ",
            "search ",
            "inspect ",
            "change ",
            ".py",
            ".js",
            ".ts",
            ".tsx",
            "/",
            "\\",
        )
        return any(marker in lowered for marker in repo_markers)

    def _effective_prompt_preset(self, text: str, prompt_preset: str) -> str:
        normalized = prompt_preset.strip() or "code"
        if normalized in {"chat", "explain"}:
            return normalized
        if self._looks_like_repo_task(text):
            return normalized
        return "chat"

    def _should_use_tool_mode(self, text: str, prompt_preset: str) -> bool:
        if prompt_preset not in {"code", "debug", "refactor"}:
            return False
        return self._looks_like_repo_task(text)

    def _should_use_tool_mode_with_model(
        self,
        provider: Any,
        model: str,
        message: str,
        prompt_preset: str,
        repo_root: Path,
    ) -> bool:
        if prompt_preset == "chat":
            return False
        try:
            decision = provider.chat_completion(
                [
                    {"role": "system", "content": TOOL_DECIDER_SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": (
                            f"Workspace: {repo_root}\n"
                            f"Mode: {prompt_preset}\n"
                            f"Request: {message}"
                        ),
                    },
                ],
                model,
            ).strip().upper()
        except Exception:
            return self._should_use_tool_mode(message, prompt_preset)
        if "NEED_TOOLS" in decision:
            return True
        if "NO_TOOLS" in decision:
            return False
        return self._should_use_tool_mode(message, prompt_preset)

    def _messages_with_context(
        self,
        messages: list[dict[str, Any]],
        prompt_preset: str | None = None,
        assistant_memory: str | None = None,
    ) -> list[dict[str, Any]]:
        copied = [dict(message) for message in messages]
        copied.insert(0, {"role": "system", "content": BASE_ASSISTANT_SYSTEM_PROMPT})
        memory_text = (assistant_memory if assistant_memory is not None else self.config.assistant_memory).strip()
        if memory_text:
            copied.insert(
                1,
                {
                    "role": "system",
                    "content": f"Persistent user preferences and workspace memory:\n{memory_text}",
                },
            )
        preset_value = prompt_preset or self.prompt_preset
        if preset_value == "chat":
            return copied
        for index in range(len(copied) - 1, -1, -1):
            if copied[index].get("role") == "user":
                original = str(copied[index].get("content", ""))
                preset = PRESET_PROMPTS.get(preset_value, "")
                copied[index]["content"] = (
                    f"[Mode: {preset_value}] {preset}\n\n{original}" if preset else original
                )
                break
        return copied

    def _recent_chat_context(self, messages: list[dict[str, Any]], limit: int = 5) -> list[dict[str, Any]]:
        visible = [
            dict(message)
            for message in messages
            if str(message.get("role", "")).strip() in {"user", "assistant"}
        ]
        if limit <= 0:
            return visible
        return visible[-limit:]

    def _event(self, event_type: str, **payload: Any) -> dict[str, Any]:
        return {"type": event_type, **payload}

    def _chat_items(self, chat_store: ProjectChatStore) -> list[dict[str, Any]]:
        return [
            {
                "chatId": chat.chat_id,
                "title": chat.title,
                "updatedAt": chat.updated_at,
                "createdAt": chat.created_at,
                "model": chat.model,
            }
            for chat in chat_store.list_chats()
        ]

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            chat_items = self._chat_items(self.chat_store)
            repo_files = self.files.list_files(self.repo_root, 200)
            return {
                "app": {"name": APP_NAME, "version": VERSION},
                "config": {
                    "model": self.model,
                    "repoRoot": str(self.repo_root),
                    "activeChatId": self.active_chat_id,
                    "apiKey": self.config.api_key,
                    "geminiApiKey": self.config.gemini_api_key,
                    "promptPreset": self.prompt_preset,
                    "toolSafetyMode": "read" if self.tool_read_only else "write",
                    "assistantMemory": self.config.assistant_memory,
                    "contextCarryMessages": self._context_carry_limit(),
                },
                "providers": self._providers(),
                "models": self._models(),
                "chats": chat_items,
                "messages": self.messages,
                "files": repo_files,
                "providerName": self._provider_name_for_model(self.model),
                "runningChatIds": sorted(self.running_chat_ids),
            }

    def list_chats(self, repo_root: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            target_repo_root = Path(repo_root).resolve() if repo_root else self.repo_root
            chat_store = ProjectChatStore(target_repo_root)
            return self._chat_items(chat_store)

    def new_chat(self, repo_root: str | None = None) -> dict[str, Any]:
        with self._lock:
            target_repo_root = Path(repo_root).resolve() if repo_root else self.repo_root
            if target_repo_root != self.repo_root:
                self._set_repo_root(target_repo_root)
            self.messages = []
            self.active_chat_id = ""
            self.active_chat_model = ""
            self.config.active_chat_id = ""
            self.gemini_cli_provider.session_id = ""
            self.gemini_cli_provider.session_mode = "fresh"
            self.config.gemini_session_id = ""
            self.codex_provider.session_id = ""
            self.codex_provider.session_mode = "fresh"
            self.config.codex_session_id = ""
            self.config.save()
            return self.snapshot()

    def activate_chat(self, chat_id: str, repo_root: str | None = None) -> dict[str, Any]:
        with self._lock:
            target_repo_root = Path(repo_root).resolve() if repo_root else self.repo_root
            if target_repo_root != self.repo_root:
                self._set_repo_root(target_repo_root)
            payload = self.chat_store.load_chat(chat_id)
            if not payload:
                raise ValueError(f"Chat not found: {chat_id}")
            self.active_chat_id = chat_id
            self.active_chat_model = str(payload.get("model", "")).strip()
            self.messages = self._normalize_messages(payload.get("messages", []))
            self.config.active_chat_id = chat_id
            if self.model.startswith("gemini-cli:") and not self.active_chat_model.startswith("gemini-cli:"):
                self.gemini_cli_provider.session_id = ""
                self.gemini_cli_provider.session_mode = "fresh"
                self.config.gemini_session_id = ""
            if self.model.startswith("codex:") and not self.active_chat_model.startswith("codex:"):
                self.codex_provider.session_id = ""
                self.codex_provider.session_mode = "fresh"
                self.config.codex_session_id = ""
            self.config.save()
            return self.snapshot()

    def delete_chat(self, chat_id: str, repo_root: str | None = None) -> dict[str, Any]:
        with self._lock:
            if chat_id in self.running_chat_ids:
                raise ValueError("Cannot delete a chat while it is still running.")
            target_repo_root = Path(repo_root).resolve() if repo_root else self.repo_root
            target_store = ProjectChatStore(target_repo_root)
            ok = target_store.delete_chat(chat_id)
            if not ok:
                raise ValueError(f"Chat could not be deleted: {chat_id}")
            if self.active_chat_id == chat_id and target_repo_root == self.repo_root:
                self.active_chat_id = ""
                self.active_chat_model = ""
                self.messages = []
                self.config.active_chat_id = ""
                self.config.save()
            return self.snapshot()

    def update_config(
        self,
        *,
        model: str | None = None,
        repo_root: str | None = None,
        api_key: str | None = None,
        gemini_api_key: str | None = None,
        prompt_preset: str | None = None,
        tool_safety_mode: str | None = None,
        assistant_memory: str | None = None,
        context_carry_messages: int | None = None,
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
                if self.model.startswith("gemini-cli:") and not self.active_chat_model.startswith("gemini-cli:"):
                    self.gemini_cli_provider.session_id = ""
                    self.gemini_cli_provider.session_mode = "fresh"
                    self.config.gemini_session_id = ""
                if self.model.startswith("codex:") and not self.active_chat_model.startswith("codex:"):
                    self.codex_provider.session_id = ""
                    self.codex_provider.session_mode = "fresh"
                    self.config.codex_session_id = ""
            if api_key is not None:
                key = api_key.strip()
                self.groq_provider.set_api_key(key)
                self.config.api_key = key
            if gemini_api_key is not None:
                key = gemini_api_key.strip()
                self.gemini_provider.set_api_key(key)
                self.config.gemini_api_key = key
            if prompt_preset is not None:
                self.prompt_preset = prompt_preset.strip() or "code"
                self.config.prompt_preset = self.prompt_preset
            if tool_safety_mode is not None:
                mode = tool_safety_mode.strip() or "write"
                self.tool_read_only = mode == "read"
                self.tool_executor.read_only = self.tool_read_only
                self.config.tool_safety_mode = "read" if self.tool_read_only else "write"
            if assistant_memory is not None:
                self.config.assistant_memory = assistant_memory.strip()
            if context_carry_messages is not None:
                self.config.context_carry_messages = max(0, min(int(context_carry_messages), 20))
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

    def send_message(
        self,
        text: str,
        *,
        chat_id: str | None = None,
        repo_root: str | None = None,
        model: str | None = None,
        prompt_preset: str | None = None,
        tool_safety_mode: str | None = None,
    ) -> dict[str, Any]:
        completed_event: dict[str, Any] | None = None
        for event in self.send_message_events(
            text,
            chat_id=chat_id,
            repo_root=repo_root,
            model=model,
            prompt_preset=prompt_preset,
            tool_safety_mode=tool_safety_mode,
        ):
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

    def send_message_events(
        self,
        text: str,
        *,
        chat_id: str | None = None,
        repo_root: str | None = None,
        model: str | None = None,
        prompt_preset: str | None = None,
        tool_safety_mode: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        message = text.strip()
        if not message:
            raise ValueError("Message is required.")

        with self._lock:
            request_model = (model or self.model).strip() or DEFAULT_MODEL
            request_prompt_preset = (prompt_preset or self.prompt_preset).strip() or "code"
            effective_prompt_preset = self._effective_prompt_preset(message, request_prompt_preset)
            request_tool_read_only = (
                (tool_safety_mode or ("read" if self.tool_read_only else "write")).strip() == "read"
            )
            request_repo_root = Path(repo_root).resolve() if repo_root else self.repo_root
            chat_store = ProjectChatStore(request_repo_root)
            existing_payload = chat_store.load_chat(chat_id) if chat_id else None
            provider_state = self._provider_state_from_payload(existing_payload)
            (
                groq_provider,
                gemini_provider,
                gemini_cli_provider,
                codex_provider,
                tool_executor,
            ) = self._make_request_providers(request_repo_root, provider_state)
            tool_executor.read_only = request_tool_read_only
            provider = self._provider_for_request(
                request_model,
                groq_provider,
                gemini_provider,
                gemini_cli_provider,
                codex_provider,
            )
            if not provider.connected:
                raise ValueError(
                    f"{self._provider_name_for_model(request_model)} is not ready for requests.",
                )

            if existing_payload:
                base_messages = self._normalize_messages(existing_payload.get("messages", []))
                active_chat_model = str(existing_payload.get("model", "")).strip()
            else:
                base_messages = []
                active_chat_model = ""

            base_messages.append({"role": "user", "content": message})
            stored_messages = [dict(message_item) for message_item in base_messages]

            if chat_id:
                if chat_id in self.running_chat_ids:
                    raise ValueError("This chat is already running a request.")
                chat_store.save_chat(chat_id, base_messages, model=request_model, provider_state=provider_state)
            else:
                chat_id = chat_store.create_chat(base_messages, model=request_model, provider_state=provider_state)
                if self.repo_root == request_repo_root and self.active_chat_id == "":
                    self.active_chat_id = chat_id
                    self.config.active_chat_id = chat_id

            if self.repo_root == request_repo_root and self.active_chat_id == chat_id:
                self.messages = [dict(message_item) for message_item in base_messages]
                self.active_chat_model = request_model

            self.running_chat_ids.add(chat_id)
            self.config.save()
            start_snapshot = self.snapshot()

        started = time.monotonic()
        yield self._event("user_message", message=message, chatId=chat_id, snapshot=start_snapshot)
        yield self._event(
            "status",
            phase="started",
            message=f"Running {self._provider_name_for_model(request_model)}...",
            chatId=chat_id,
        )

        try:
            if request_model.startswith("codex:") or request_model.startswith("gemini-cli:"):
                provider_messages = [dict(message_item) for message_item in base_messages]
                if (
                    request_model.startswith(("gemini-cli:", "codex:"))
                    and active_chat_model
                    and self._model_family(active_chat_model) != self._model_family(request_model)
                ):
                    carry_limit = self._context_carry_limit()
                    provider_messages = self._recent_chat_context(base_messages, limit=carry_limit)
                    if request_model.startswith("gemini-cli:"):
                        gemini_cli_provider.session_id = ""
                        gemini_cli_provider.session_mode = "fresh"
                    if request_model.startswith("codex:"):
                        codex_provider.session_id = ""
                        codex_provider.session_mode = "fresh"
                    yield self._event(
                        "status",
                        phase="fresh_provider_context",
                        message=f"Started a fresh {self._provider_name_for_model(request_model)} context and carried over the last {carry_limit} chat messages.",
                        chatId=chat_id,
                    )

                working_messages, condensed_count = maybe_trim_context(
                    provider_messages,
                    provider,
                    request_model,
                )
                if condensed_count > 0:
                    yield self._event(
                        "status",
                        phase="context_trimmed",
                        message=f"Condensed {condensed_count} earlier messages to fit context.",
                        chatId=chat_id,
                    )
                if request_model.startswith("gemini-cli:"):
                    prepared_messages = [dict(entry) for entry in working_messages]
                else:
                    prepared_messages = self._messages_with_context(working_messages, effective_prompt_preset)

                cli_events: queue.Queue[dict[str, Any] | None] = queue.Queue()
                result: dict[str, str] = {}
                failure: dict[str, Exception] = {}

                def run_cli() -> None:
                    try:
                        final_text = provider.chat_completion_stream_raw(
                            prepared_messages,
                            request_model,
                            on_output=lambda chunk: cli_events.put(
                                self._event("cli_output", stream="stdout", text=chunk, chatId=chat_id),
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
                final_messages = [dict(entry) for entry in stored_messages]
                final_messages.append({"role": "assistant", "content": final_text})
                next_provider_state = {
                    key: value
                    for key, value in {
                        "gemini_cli_session_id": getattr(gemini_cli_provider, "session_id", ""),
                        "codex_session_id": getattr(codex_provider, "session_id", ""),
                    }.items()
                    if value
                }
                with self._lock:
                    chat_store.save_chat(
                        chat_id,
                        final_messages,
                        model=request_model,
                        provider_state=next_provider_state,
                    )
                    if self.active_chat_id == chat_id and self.repo_root == request_repo_root:
                        self.messages = [dict(entry) for entry in final_messages]
                        self.active_chat_model = request_model
                    self.running_chat_ids.discard(chat_id)
                    snapshot = self.snapshot()
                elapsed_seconds = round(time.monotonic() - started, 2)
                yield self._event("assistant", text=final_text, chatId=chat_id)
                yield self._event(
                    "completed",
                    assistantMessage=final_text,
                    elapsedSeconds=elapsed_seconds,
                    usedTools=0,
                    snapshot=snapshot,
                    chatId=chat_id,
                )
                return

            plain_chat_mode = not self._should_use_tool_mode_with_model(
                provider,
                request_model,
                message,
                request_prompt_preset,
                request_repo_root,
            )
            working_messages, condensed_count = maybe_trim_context(base_messages, provider, request_model)
            if condensed_count > 0:
                yield self._event(
                    "status",
                    phase="context_trimmed",
                    message=f"Condensed {condensed_count} earlier messages to fit context.",
                    chatId=chat_id,
                )
            working_messages = self._messages_with_context(working_messages, effective_prompt_preset)
            if plain_chat_mode:
                fallback_text = provider.chat_completion(working_messages, request_model)
                final_messages = [dict(entry) for entry in stored_messages]
                final_messages.append({"role": "assistant", "content": fallback_text})
                with self._lock:
                    chat_store.save_chat(
                        chat_id,
                        final_messages,
                        model=request_model,
                        provider_state=provider_state,
                    )
                    if self.active_chat_id == chat_id and self.repo_root == request_repo_root:
                        self.messages = [dict(entry) for entry in final_messages]
                        self.active_chat_model = request_model
                    self.running_chat_ids.discard(chat_id)
                    snapshot = self.snapshot()
                elapsed_seconds = round(time.monotonic() - started, 2)
                yield self._event("assistant", text=fallback_text, chatId=chat_id)
                yield self._event(
                    "completed",
                    assistantMessage=fallback_text,
                    elapsedSeconds=elapsed_seconds,
                    usedTools=0,
                    snapshot=snapshot,
                    chatId=chat_id,
                )
                return
            used_tools = 0

            for round_index in range(MAX_TOOL_ROUNDS):
                yield self._event(
                    "status",
                    phase="thinking",
                    message=f"Thinking... round {round_index + 1}",
                    chatId=chat_id,
                )
                try:
                    final_text, asst_dict, tool_calls = provider.chat_with_tools(
                        working_messages,
                        request_model,
                        TOOLS,
                    )
                except RuntimeError as exc:
                    if "__TOOL_FAILED__" not in str(exc):
                        raise
                    yield self._event(
                        "status",
                        phase="fallback_plain_chat",
                        message="Tool call failed, retrying as plain chat.",
                        chatId=chat_id,
                    )
                    fallback_text = provider.chat_completion(working_messages, request_model)
                    final_messages = [dict(entry) for entry in stored_messages]
                    final_messages.append({"role": "assistant", "content": fallback_text})
                    with self._lock:
                        chat_store.save_chat(
                            chat_id,
                            final_messages,
                            model=request_model,
                            provider_state=provider_state,
                        )
                        if self.active_chat_id == chat_id and self.repo_root == request_repo_root:
                            self.messages = [dict(entry) for entry in final_messages]
                            self.active_chat_model = request_model
                        self.running_chat_ids.discard(chat_id)
                        snapshot = self.snapshot()
                    elapsed_seconds = round(time.monotonic() - started, 2)
                    yield self._event("assistant", text=fallback_text, chatId=chat_id)
                    yield self._event(
                        "completed",
                        assistantMessage=fallback_text,
                        elapsedSeconds=elapsed_seconds,
                        usedTools=used_tools,
                        snapshot=snapshot,
                        chatId=chat_id,
                    )
                    return

                if final_text is not None:
                    final_messages = [dict(entry) for entry in stored_messages]
                    final_messages.append({"role": "assistant", "content": final_text})
                    with self._lock:
                        chat_store.save_chat(
                            chat_id,
                            final_messages,
                            model=request_model,
                            provider_state=provider_state,
                        )
                        if self.active_chat_id == chat_id and self.repo_root == request_repo_root:
                            self.messages = [dict(entry) for entry in final_messages]
                            self.active_chat_model = request_model
                        self.running_chat_ids.discard(chat_id)
                        snapshot = self.snapshot()
                    elapsed_seconds = round(time.monotonic() - started, 2)
                    yield self._event("assistant", text=final_text, chatId=chat_id)
                    yield self._event(
                        "completed",
                        assistantMessage=final_text,
                        elapsedSeconds=elapsed_seconds,
                        usedTools=used_tools,
                        snapshot=snapshot,
                        chatId=chat_id,
                    )
                    return

                if asst_dict:
                    working_messages.append(asst_dict)
                    stored_messages.append(dict(asst_dict))

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
                        chatId=chat_id,
                    )
                    result = tool_executor.execute(tool_call.function.name, args)
                    yield self._event(
                        "tool_result",
                        name=tool_call.function.name,
                        result=result,
                        chatId=chat_id,
                    )
                    working_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "name": tool_call.function.name,
                            "content": result,
                        },
                    )
                    stored_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "name": tool_call.function.name,
                            "content": result,
                        },
                    )

            yield self._event(
                "status",
                phase="fallback_plain_chat",
                message="Tool loop did not converge, retrying as plain chat.",
                chatId=chat_id,
            )
            fallback_text = provider.chat_completion(working_messages, request_model)
            final_messages = [dict(entry) for entry in stored_messages]
            final_messages.append({"role": "assistant", "content": fallback_text})
            with self._lock:
                chat_store.save_chat(
                    chat_id,
                    final_messages,
                    model=request_model,
                    provider_state=provider_state,
                )
                if self.active_chat_id == chat_id and self.repo_root == request_repo_root:
                    self.messages = [dict(entry) for entry in final_messages]
                    self.active_chat_model = request_model
                self.running_chat_ids.discard(chat_id)
                snapshot = self.snapshot()
            elapsed_seconds = round(time.monotonic() - started, 2)
            yield self._event("assistant", text=fallback_text, chatId=chat_id)
            yield self._event(
                "completed",
                assistantMessage=fallback_text,
                elapsedSeconds=elapsed_seconds,
                usedTools=used_tools,
                snapshot=snapshot,
                chatId=chat_id,
            )
            return
        except Exception:
            with self._lock:
                self.running_chat_ids.discard(chat_id)
            raise
