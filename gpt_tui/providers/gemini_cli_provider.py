from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable
from rich.markup import escape


class GeminiCliProvider:
    """Provider wrapper that runs `gemini` CLI in headless stream-json mode."""

    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root.resolve()
        self._has_session = False

    @property
    def available(self) -> bool:
        return self._resolve_gemini_executable() is not None

    @property
    def connected(self) -> bool:
        # Gemini CLI auth is handled by the CLI itself.
        return self.available

    def set_repo_root(self, repo_root: Path) -> None:
        new_root = repo_root.resolve()
        if new_root != self.repo_root:
            self._has_session = False
        self.repo_root = new_root

    def set_api_key(self, api_key: str) -> None:
        _ = api_key

    def validate_api_key(self, api_key: str) -> tuple[bool, str]:
        _ = api_key
        return False, "Gemini CLI models do not use API key here. Use `gemini` login flow."

    def _resolve_gemini_executable(self) -> str | None:
        return (
            shutil.which("gemini.cmd")
            or shutil.which("gemini.ps1")
            or shutil.which("gemini")
        )

    def _cli_model_name(self, model: str) -> str:
        if model.startswith("gemini-cli:"):
            return model.split(":", 1)[1]
        return model

    def _build_prompt(self, messages: list[dict[str, Any]]) -> str:
        if not messages:
            return ""

        # Find the actual latest user request
        latest_user = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                latest_user = str(msg.get("content", "")).strip()
                break
        
        if not latest_user and messages:
            latest_user = str(messages[-1].get("content", "")).strip()

        # If we have a session, we only send the latest user message.
        # The CLI's --resume latest handles the history.
        if self._has_session:
            return latest_user

        # First message in session: provide context and system instructions
        system_text = (
            "You are a senior software engineering partner. "
            "If the user just says 'hi' or 'hello', just say hi back briefly. "
            "Do NOT analyze the workspace or list files unless specifically asked. "
            "Be extremely concise."
        )
        for m in messages:
            if m.get("role") == "system":
                system_text = str(m.get("content", "")).strip()
                break

        # Get last 5 messages for initial context if this is a "new" session to the CLI
        # but we have existing messages in TUI (e.g. after model switch)
        history = [m for m in messages if m.get("role") != "system"]
        tail = history[-5:]
        
        context_lines: list[str] = []
        for msg in tail:
            role = str(msg.get("role", "")).strip().upper()
            content = str(msg.get("content", "")).strip()
            if role and content:
                context_lines.append(f"{role.upper()}: {content}")

        if context_lines:
            return (
                f"{system_text}\n\n"
                "Conversation history:\n"
                + "\n".join(context_lines)
                + "\n\nUser's latest request:\n"
                + latest_user
            )
        
        return f"{system_text}\n\n{latest_user}"

    def chat_completion_stream_raw(
        self,
        messages: list[dict[str, Any]],
        model: str,
        on_output: Callable[[str], None] | None = None,
    ) -> str:
        def trace(msg: str) -> None:
            try:
                log_path = self.repo_root / "trace.log"
                with open(log_path, "a", encoding="utf-8") as f:
                    import time
                    f.write(f"[{time.time()}] {msg}\n")
            except:
                pass
                
        trace("Entered chat_completion_stream_raw")
        gemini_exec = self._resolve_gemini_executable()
        if not gemini_exec:
            trace("gemini CLI not found in PATH")
            raise RuntimeError("gemini CLI not found in PATH")

        prompt = self._build_prompt(messages)
        trace(f"Prompt built: len={len(prompt)}")
        cmd = [
            gemini_exec,
            "--prompt",
            prompt,
            "--output-format",
            "stream-json",
            "--approval-mode",
            "yolo",
            "--resume",
            "latest",
        ]

        cli_model = self._cli_model_name(model)
        if cli_model and cli_model != "auto":
            cmd.extend(["--model", cli_model])

        trace(f"Spawning subprocess: {cmd}")
        proc = subprocess.Popen(
            cmd,
            cwd=str(self.repo_root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if proc.stdin:
            proc.stdin.close()
            trace("proc.stdin closed")

        assistant_chunks: list[str] = []
        raw_tail: list[str] = []
        
        # Recognized noise patterns from Gemini CLI that aren't part of the model's message
        noise_patterns = [
            "Loaded cached credentials",
            "YOLO mode is enabled",
            "automatically approved",
            "To run in non-interactive mode",
            "use the --prompt",
            "Attempt 1 failed",
            "Retrying with backoff",
            "GaxiosError",
        ]

        if proc.stdout:
            trace("Begin reading stdout")
            while True:
                raw = proc.stdout.readline()
                if not raw:
                    trace("stdout EOF")
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                
                raw_tail.append(line)
                if len(raw_tail) > 30:
                    raw_tail = raw_tail[-30:]

                # Try to find JSON in the line (it might be prefixed with noise)
                json_start = line.find("{")
                json_end = line.rfind("}")
                
                evt = None
                if json_start != -1 and json_end != -1 and json_end > json_start:
                    json_str = line[json_start : json_end + 1]
                    try:
                        evt = json.loads(json_str)
                    except json.JSONDecodeError:
                        evt = None

                if evt is None:
                    trace(f"Non-JSON line: {line[:100]}")
                    if not any(p in line for p in noise_patterns):
                        assistant_chunks.append(line + "\n")
                        if on_output:
                            on_output(escape(line + "\n"))
                    continue

                # Check for CLI backend errors in JSON format
                if "error" in evt and isinstance(evt["error"], dict):
                    err_msg = evt["error"].get("message", "Unknown CLI error")
                    trace(f"CLI Backend Error: {err_msg}")
                    error_report = f"\n[bold #ff6b6b]![/] [bold]Gemini CLI Backend Error:[/] {escape(err_msg)}\n"
                    if on_output:
                        on_output(error_report)
                    continue

                etype = evt.get("type")
                trace(f"Parsed JSON type: {etype}")
                if etype == "message" and evt.get("role") == "assistant":
                    content = str(evt.get("content", ""))
                    if content:
                        assistant_chunks.append(content)
                        if on_output:
                            on_output(escape(content))
                elif etype == "tool_use":
                    name = str(evt.get("tool_name", "unknown"))
                    params = json.dumps(evt.get("parameters", {}))
                    msg = f"\n[bold #ffcb6b]â–¸ Using tool:[/] [bold]{escape(name)}[/]([dim]{escape(params)}[/])\n"
                    if on_output:
                        on_output(msg)
                elif etype == "tool_result":
                    status = str(evt.get("status", "unknown"))
                    msg = f"[bold #7ad97a]âœ“ Tool result:[/] [dim]{escape(status)}[/]\n"
                    if on_output:
                        on_output(msg)
                elif etype == "result":
                    trace("Result type parsed, breaking loop")
                    break

        trace(f"Loop finished, checking proc.poll() = {proc.poll()}")
        
        # Give it a tiny window to exit gracefully if it sent "result"
        if proc.poll() is None:
            try:
                proc.wait(timeout=0.1)
            except subprocess.TimeoutExpired:
                trace("Graceful wait timed out, terminating...")
                try:
                    proc.terminate()
                except:
                    pass

        code = proc.wait(timeout=5)
        trace(f"Proc exited with code {code}, chunks len {len(assistant_chunks)}")
        
        # If it failed but we got some content, we might still want to return it.
        # But if we got nothing and exit code is non-zero, it's a real error.
        if code != 0 and not assistant_chunks:
            detail = "\n".join(raw_tail).strip() or f"exit code {code}"
            trace(f"Raising RuntimeError: {detail}")
            raise RuntimeError(f"gemini CLI failed: {detail}")

        self._has_session = True
        final = "".join(assistant_chunks).strip()
        trace(f"Returning final string len {len(final)}")
        return final or "(No response from Gemini CLI.)"

    def chat_completion(self, messages: list[dict[str, Any]], model: str) -> str:
        return self.chat_completion_stream_raw(messages, model, on_output=None)

    def chat_with_tools(
        self,
        messages: list[dict[str, Any]],
        model: str,
        tools: list[dict[str, Any]],
    ) -> tuple[str | None, dict | None, list | None]:
        _ = tools
        return self.chat_completion(messages, model), None, None
