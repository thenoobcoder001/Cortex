from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable


class CodexProvider:
    """Provider wrapper that runs `codex exec` in the terminal."""

    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root.resolve()

    @property
    def available(self) -> bool:
        return self._resolve_codex_executable() is not None

    @property
    def connected(self) -> bool:
        # Codex CLI auth is handled by `codex login`; no API key in this app.
        return self.available

    def set_repo_root(self, repo_root: Path) -> None:
        self.repo_root = repo_root.resolve()

    def set_api_key(self, api_key: str) -> None:
        # No-op for codex CLI provider.
        _ = api_key

    def validate_api_key(self, api_key: str) -> tuple[bool, str]:
        _ = api_key
        return False, "Codex model does not require API key here. Use `codex login` in terminal."

    def _build_prompt(self, messages: list[dict[str, Any]]) -> str:
        if not messages:
            return ""
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

        if context_lines:
            return (
                "Conversation context:\n"
                + "\n".join(context_lines)
                + "\n\nLatest request:\n"
                + latest_user
            )
        return latest_user

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

    def _extract_assistant_from_raw_output(self, output: str) -> str:
        text = output.strip()
        if not text:
            return "(No response from codex.)"

        marker = "\ncodex\n"
        start = text.rfind(marker)
        if start != -1:
            body = text[start + len(marker):]
            end = body.find("\ntokens used")
            if end != -1:
                body = body[:end]
            body = body.strip()
            if body:
                return body

        return text

    def chat_completion_stream_raw(
        self,
        messages: list[dict[str, Any]],
        model: str,
        on_output: Callable[[str], None] | None = None,
    ) -> str:
        """Run codex exec and stream terminal-like output as lines."""
        codex_exec = self._resolve_codex_executable()
        if not codex_exec:
            raise RuntimeError("codex CLI not found in PATH")

        prompt = self._build_prompt(messages)
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

        proc = subprocess.Popen(
            cmd,
            cwd=str(self.repo_root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if proc.stdin:
            proc.stdin.write(prompt.encode("utf-8"))
            proc.stdin.close()

        chunks: list[str] = []
        if proc.stdout:
            while True:
                raw = proc.stdout.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace")
                chunks.append(line)
                if on_output and self._should_stream_line(line):
                    on_output(line.rstrip("\r\n"))

        return_code = proc.wait(timeout=600)
        full_output = "".join(chunks)
        if return_code != 0:
            detail = full_output.strip() or f"exit code {return_code}"
            raise RuntimeError(f"codex exec failed: {detail}")

        return self._extract_assistant_from_raw_output(full_output)

    def chat_completion_events(
        self,
        messages: list[dict[str, Any]],
        model: str,
        on_event: Callable[[str, str], None] | None = None,
    ) -> str:
        """Run codex exec in JSON mode and surface live events."""
        codex_exec = self._resolve_codex_executable()
        if not codex_exec:
            raise RuntimeError("codex CLI not found in PATH")

        prompt = self._build_prompt(messages)
        cmd = [
            codex_exec,
            "exec",
            "-",
            "-C",
            str(self.repo_root),
            "--skip-git-repo-check",
            "--model",
            self._cli_model_name(model),
            "--json",
            "--color",
            "never",
        ]

        proc = subprocess.Popen(
            cmd,
            cwd=str(self.repo_root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        if proc.stdin:
            proc.stdin.write(prompt.encode("utf-8"))
            proc.stdin.close()

        assistant_text = ""
        if proc.stdout:
            while True:
                raw = proc.stdout.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    if on_event:
                        on_event("status", line)
                    continue

                event_type = str(event.get("type", ""))
                if event_type == "item.completed":
                    item = event.get("item") or {}
                    item_type = str(item.get("type", ""))
                    text = str(item.get("text", "")).strip()
                    if not text:
                        continue
                    if item_type == "reasoning":
                        if on_event:
                            on_event("reasoning", text)
                    elif item_type == "agent_message":
                        assistant_text = text
                        if on_event:
                            on_event("assistant", text)
                elif event_type == "error":
                    msg = str(event.get("message", "codex error")).strip()
                    if on_event:
                        on_event("error", msg)

        stderr_bytes = b""
        if proc.stderr:
            stderr_bytes = proc.stderr.read()
        return_code = proc.wait(timeout=600)

        if return_code != 0:
            stderr = (stderr_bytes or b"").decode("utf-8", errors="replace").strip()
            detail = stderr or f"exit code {return_code}"
            raise RuntimeError(f"codex exec failed: {detail}")

        if assistant_text:
            return assistant_text
        return "(No response from codex.)"

    def chat_completion(self, messages: list[dict[str, Any]], model: str) -> str:
        codex_exec = self._resolve_codex_executable()
        if not codex_exec:
            raise RuntimeError("codex CLI not found in PATH")

        prompt = self._build_prompt(messages)
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
            output_file = Path(tmp.name)

        cmd = [
            codex_exec,
            "exec",
            "-",
            "-C",
            str(self.repo_root),
            "--skip-git-repo-check",
            "--output-last-message",
            str(output_file),
            "--model",
            self._cli_model_name(model),
        ]

        try:
            result = subprocess.run(
                cmd,
                input=prompt.encode("utf-8"),
                capture_output=True,
                text=False,
                cwd=str(self.repo_root),
                timeout=600,
            )
            if result.returncode != 0:
                stderr = (result.stderr or b"").decode("utf-8", errors="replace").strip()
                stdout = (result.stdout or b"").decode("utf-8", errors="replace").strip()
                detail = stderr or stdout or f"exit code {result.returncode}"
                raise RuntimeError(f"codex exec failed: {detail}")

            if output_file.exists():
                text = output_file.read_text(encoding="utf-8").strip()
                if text:
                    return text

            stdout = (result.stdout or b"").decode("utf-8", errors="replace").strip()
            if stdout:
                return stdout

            return "(No response from codex.)"
        finally:
            try:
                output_file.unlink(missing_ok=True)
            except OSError:
                pass

    def chat_with_tools(
        self,
        messages: list[dict[str, Any]],
        model: str,
        tools: list[dict[str, Any]],
    ) -> tuple[str | None, dict | None, list | None]:
        # Codex exec already runs agentically in terminal; return final text directly.
        _ = tools
        return self.chat_completion(messages, model), None, None
