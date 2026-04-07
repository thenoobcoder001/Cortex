from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable


class CodexProvider:
    """Provider wrapper that runs `codex exec` in the terminal."""

    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root.resolve()
        self._has_session = False
        self.session_id: str = ""
        self.session_mode: str = "fresh"  # fresh | resume_id
        self.on_session_init: Callable[[str], None] | None = None

    @property
    def available(self) -> bool:
        return self._resolve_codex_executable() is not None

    @property
    def connected(self) -> bool:
        # Codex CLI auth is handled by `codex login`; no API key in this app.
        return self.available

    def set_repo_root(self, repo_root: Path) -> None:
        new_root = repo_root.resolve()
        if new_root != self.repo_root:
            self._has_session = False
            self.session_id = ""
            self.session_mode = "fresh"
        self.repo_root = new_root

    def set_api_key(self, api_key: str) -> None:
        # No-op for codex CLI provider.
        _ = api_key

    def validate_api_key(self, api_key: str) -> tuple[bool, str]:
        _ = api_key
        return False, "Codex model does not require API key here. Use `codex login` in terminal."

    def _build_prompt(self, messages: list[dict[str, Any]]) -> str:
        if not messages:
            return ""
        system_messages = [
            str(m.get("content", "")).strip()
            for m in messages
            if str(m.get("role", "")).strip() == "system" and str(m.get("content", "")).strip()
        ]
        # Keep Codex input minimal: latest user message + short prior context.
        tail = [m for m in messages[-6:] if str(m.get("role", "")) in {"user", "assistant"}]
        latest_user = ""
        for msg in reversed(tail):
            if msg.get("role") == "user":
                latest_user = str(msg.get("content", "")).strip()
                break

        if not latest_user:
            latest_user = str(messages[-1].get("content", "")).strip()

        context_lines: list[str] = []
        for msg in tail[:-1]:
            role = str(msg.get("role", "")).strip()
            content = str(msg.get("content", "")).strip()
            if not role or not content:
                continue
            context_lines.append(f"{role}: {content}")

        prompt = ""
        if system_messages:
            prompt += "Instructions:\n" + "\n\n".join(system_messages) + "\n\n"
        if context_lines:
            prompt += (
                "Conversation context:\n"
                + "\n".join(context_lines)
                + "\n\nLatest request:\n"
                + latest_user
            )
            return prompt
        prompt += latest_user
        return prompt

    def _should_stream_line(self, line: str) -> bool:
        text = line.strip()
        if not text:
            return True
        hidden_prefixes = (
            "OpenAI Codex",
            "workdir:",
            "model:",
            "provider:",
            "approval:",
            "sandbox:",
            "reasoning effort:",
            "reasoning summaries:",
            "session id:",
            "mcp startup:",
            "tokens used",
        )
        if text.startswith(hidden_prefixes):
            return False
        if text in {"user"}:
            return False
        if text == "--------":
            return False
        return True

    def _resolve_codex_executable(self) -> str | None:
        return shutil.which("codex.cmd") or shutil.which("codex")

    def _cli_model_name(self, model: str) -> str:
        if model.startswith("codex:"):
            return model.split(":", 1)[1]
        return model

    def _build_exec_command(self, model: str, *, json_mode: bool, resume: bool) -> list[str]:
        codex_exec = self._resolve_codex_executable()
        if not codex_exec:
            raise RuntimeError("codex CLI not found in PATH")

        if resume and self.session_id:
            cmd = [
                codex_exec,
                "exec",
                "resume",
                "--skip-git-repo-check",
                "--model",
                self._cli_model_name(model),
            ]
            if json_mode:
                cmd.append("--json")
            cmd.extend([self.session_id, "-"])
        else:
            cmd = [
                codex_exec,
                "exec",
                "-",
                "-C",
                str(self.repo_root),
                "--skip-git-repo-check",
                "--model",
                self._cli_model_name(model),
                "--color",
                "never",
            ]
            if json_mode:
                cmd.append("--json")
        return cmd

    def _run_json_exec(
        self,
        messages: list[dict[str, Any]],
        model: str,
        on_output: Callable[[str], None] | None = None,
    ) -> str:
        prompt = self._build_prompt(messages)
        resume = self.session_mode == "resume_id" and bool(self.session_id)
        cmd = self._build_exec_command(model, json_mode=True, resume=resume)

        proc = subprocess.Popen(
            cmd,
            cwd=str(self.repo_root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        if proc.stdin:
            proc.stdin.write(prompt)
            proc.stdin.close()

        assistant_text = ""
        stderr_text = ""
        try:
            if proc.stdout:
                while True:
                    line = proc.stdout.readline()
                    if not line:
                        break
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    event_type = str(event.get("type", "")).strip()
                    if event_type == "thread.started":
                        thread_id = str(event.get("thread_id", "")).strip()
                        if thread_id:
                            self.session_id = thread_id
                            self.session_mode = "resume_id"
                            if self.on_session_init:
                                self.on_session_init(thread_id)
                    elif event_type == "item.completed":
                        item = event.get("item") or {}
                        if str(item.get("type", "")).strip() != "agent_message":
                            continue
                        next_text = str(item.get("text", "")).strip()
                        if not next_text:
                            continue
                        delta = next_text
                        if assistant_text and next_text.startswith(assistant_text):
                            delta = next_text[len(assistant_text):]
                        assistant_text = next_text
                        if delta and on_output:
                            on_output(delta)
                    elif event_type == "error":
                        message = str(event.get("message", "")).strip()
                        if message:
                            stderr_text = message
        finally:
            if proc.stderr:
                stderr_text = (proc.stderr.read() or "").strip() or stderr_text

        return_code = proc.wait(timeout=600)
        if return_code != 0:
            detail = stderr_text or f"exit code {return_code}"
            raise RuntimeError(f"codex exec failed: {detail}")

        self._has_session = bool(self.session_id)
        if assistant_text:
            return assistant_text
        return "(No response from codex.)"

    def chat_completion_stream_raw(
        self,
        messages: list[dict[str, Any]],
        model: str,
        on_output: Callable[[str], None] | None = None,
    ) -> str:
        """Run codex exec in JSON mode and stream assistant text."""
        return self._run_json_exec(messages, model, on_output=on_output)

    def chat_completion_events(
        self,
        messages: list[dict[str, Any]],
        model: str,
        on_event: Callable[[str, str], None] | None = None,
    ) -> str:
        """Run codex exec in JSON mode and surface live events."""
        def relay_output(chunk: str) -> None:
            if on_event:
                on_event("assistant", chunk)

        return self._run_json_exec(messages, model, on_output=relay_output)

    def chat_completion(self, messages: list[dict[str, Any]], model: str) -> str:
        return self._run_json_exec(messages, model, on_output=None)

    def chat_with_tools(
        self,
        messages: list[dict[str, Any]],
        model: str,
        tools: list[dict[str, Any]],
    ) -> tuple[str | None, dict | None, list | None]:
        # Codex exec already runs agentically in terminal; return final text directly.
        _ = tools
        return self.chat_completion(messages, model), None, None
