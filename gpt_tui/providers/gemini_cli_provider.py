from __future__ import annotations

import json
import queue
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable

from rich.markup import escape


HEADLESS_PROMPT_PREFIX = (
    "You are running in non-interactive terminal stream-json mode.\n"
    "Return only the final answer to the user's request.\n"
    "Do not call any tools.\n"
    "Do not use MCP servers or extensions.\n"
    "Do not output planning, thinking, or debugging text.\n"
    "Do not mention tool availability.\n"
)


class GeminiCliProvider:
    """Provider wrapper that runs `gemini` CLI in headless stream-json mode."""

    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root.resolve()
        self._has_session = False
        self.session_id: str = ""
        self.session_mode: str = "resume_latest"  # fresh | resume_latest | resume_id
        self.on_session_init: Callable[[str], None] | None = None

    @property
    def available(self) -> bool:
        return self._resolve_gemini_executable() is not None

    @property
    def connected(self) -> bool:
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
        return shutil.which("gemini.cmd") or shutil.which("gemini.ps1") or shutil.which("gemini")

    def _cli_model_name(self, model: str) -> str:
        if model.startswith("gemini-cli:"):
            raw = model.split(":", 1)[1]
            # Back-compat for older saved configs.
            if raw == "auto":
                return "auto-gemini-2.5"
            return raw
        return model

    def _is_25_pin_requested(self, model: str) -> bool:
        if not model.startswith("gemini-cli:"):
            return False
        raw = model.split(":", 1)[1].lower()
        # Only force 2.5 pin behavior when user explicitly requested 2.5.
        return raw in {"auto", "auto-gemini-2.5"}

    def _build_prompt(self, messages: list[dict[str, Any]]) -> str:
        if not messages:
            return HEADLESS_PROMPT_PREFIX
        system_messages = [
            str(m.get("content", "")).strip()
            for m in messages
            if str(m.get("role", "")).strip() == "system" and str(m.get("content", "")).strip()
        ]
        turns = [
            m for m in messages
            if str(m.get("role", "")).strip() in {"user", "assistant"}
        ]
        if not turns:
            latest = str(messages[-1].get("content", "")).strip()
            prompt = HEADLESS_PROMPT_PREFIX
            if system_messages:
                prompt += "\nInstructions:\n" + "\n\n".join(system_messages) + "\n"
            prompt += f"\nUser request:\n{latest}"
            return prompt.strip()

        tail = turns[-8:]
        latest_user = ""
        for msg in reversed(tail):
            if msg.get("role") == "user":
                latest_user = str(msg.get("content", "")).strip()
                break
        if not latest_user:
            latest_user = str(tail[-1].get("content", "")).strip()

        context_lines: list[str] = []
        for msg in tail[:-1]:
            role = str(msg.get("role", "")).strip()
            content = str(msg.get("content", "")).strip()
            if not role or not content:
                continue
            # Keep handoff prompts compact so model switching stays responsive.
            compact = re.sub(r"\s+", " ", content)
            if len(compact) > 700:
                compact = compact[:700] + "..."
            context_lines.append(f"{role}: {compact}")

        if context_lines:
            prompt = HEADLESS_PROMPT_PREFIX
            if system_messages:
                prompt += "\nInstructions:\n" + "\n\n".join(system_messages) + "\n"
            prompt += (
                "\nConversation context:\n"
                + "\n".join(context_lines)
                + "\n\nLatest request:\n"
                + latest_user
            )
            return prompt
        prompt = HEADLESS_PROMPT_PREFIX
        if system_messages:
            prompt += "\nInstructions:\n" + "\n\n".join(system_messages) + "\n"
        prompt += f"\nUser request:\n{latest_user}"
        return prompt.strip()

    def _friendly_error(self, detail: str) -> str:
        low = detail.lower()
        if "resource_exhausted" in low or "rate" in low or "no capacity available" in low:
            return "Gemini capacity/rate limit reached. Please retry in a moment."
        if "tool/planning loop" in low or "non-interactive tool loop" in low:
            return "Gemini CLI got stuck in a non-interactive tool/planning loop. Please retry or start a fresh chat."
        if "exhausted your capacity" in low or "terminalquotaerror" in low:
            m = re.search(r"reset after ([^\.]+)", detail, flags=re.IGNORECASE)
            if m:
                return f"Gemini quota exhausted. Quota resets after {m.group(1).strip()}."
            return "Gemini quota exhausted. Please retry after reset or switch provider/model."
        if "access is denied" in low or "attachconsole failed" in low:
            return "Gemini CLI could not attach to console in this session. Try relaunching terminal and running `gemini` once."
        if "auth" in low or "login" in low:
            return "Gemini CLI authentication issue. Run `gemini` in terminal and complete login."
        if "timeout" in low:
            return "Gemini CLI timed out waiting for output. Please retry."
        if (
            "loaded cached credentials" in low
            or "loading extension:" in low
            or "supports tool updates" in low
            or "listening for changes" in low
            or "error executing tool" in low
            or "tool \"" in low
        ):
            return "Gemini CLI returned extension/tool chatter instead of a structured response. Retry once or start a fresh session."
        return detail

    def _is_transient_error(self, detail: str) -> bool:
        low = detail.lower()
        transient_patterns = (
            "resource_exhausted",
            "rate",
            "no capacity available",
            "retrying with backoff",
            "temporarily unavailable",
            "non-interactive tool loop",
        )
        return any(p in low for p in transient_patterns)

    def _is_capacity_error(self, detail: str) -> bool:
        low = detail.lower()
        return (
            "resource_exhausted" in low
            or "model_capacity_exhausted" in low
            or "no capacity available" in low
            or "rate limit exceeded" in low
            or "ratelimitexceeded" in low
            or "exhausted your capacity" in low
            or "terminalquotaerror" in low
        )

    def _extract_non_json_error(self, line: str) -> str | None:
        """Capture meaningful transport/runtime failures from non-JSON stderr chatter."""
        low = line.lower().strip()
        if not low:
            return None

        # Ignore common startup chatter and model planning chatter.
        noise_prefixes = (
            "loaded cached credentials",
            "yolo mode is enabled",
            "loading extension:",
            "server '",
            "listening for changes",
            "i will ",
            "i'll ",
        )
        if low.startswith(noise_prefixes):
            return None
        if "supports tool updates" in low:
            return None

        error_hints = (
            "error when talking to gemini api",
            "retryablequotaerror",
            "terminalquotaerror",
            "failed with status",
            "attempt ",
            "access is denied",
            "attachconsole failed",
            "timeout",
            "timed out",
            "login",
            "sign in",
            "not signed in",
            "unauthorized",
            "forbidden",
            "resource_exhausted",
            "no capacity available",
            "exhausted your capacity",
            "status: 429",
            "status 429",
            "authentication",
            "not authenticated",
            "an unexpected critical error occurred",
            "error executing tool",
            "tool \"",
        )
        if any(h in low for h in error_hints):
            return line
        return None

    def _is_planning_chatter(self, text: str) -> bool:
        """Detect first-person planning/debug chatter that should not be shown as assistant output."""
        low = text.lower().strip()
        if not low:
            return False
        first_person = ("i will ", "i'll ", "i am ", "i'm ", "i have ", "i've ")
        if not any(p in low for p in first_person):
            return False
        signals = (
            "begin by",
            "start by",
            "search",
            "read ",
            "examine",
            "inspect",
            "check ",
            "look for",
            "review",
            "implement",
            "create",
            "update",
            "use ",
            "run ",
            "test ",
            "investigate",
            "explore",
            "roadblock",
            "stuck",
            "toolset",
            "tools",
            "run_shell_command",
            "write_file",
            "replace",
            "cli_help",
            "codebase_investigator",
            "missing from my tool",
            "unable to modify files",
            "not found",
            "to understand",
            "to see how",
            "determine if",
            "event handlers",
            "sessionmodal",
        )
        return any(s in low for s in signals)

    def _is_structured_fragment(self, line: str) -> bool:
        """Filter raw backend/log fragments that are not assistant prose."""
        raw = line.strip()
        low = raw.lower()
        if not low:
            return True
        if low in {"{", "}", "[", "]", "],", "},", "')", "'}", "' ]"}:
            return True
        if low.startswith(("responsetype:", "signal:", "paramsserializer:", "validatestatus:", "errorredactor:")):
            return True
        if low.startswith((
            "'alt-svc':",
            "'content-length':",
            "'server-timing':",
            "'x-",
            "'content-type':",
            "'x-frame-options':",
            "'x-content-type-options':",
            "'x-xss-protection':",
        )):
            return True
        if low.startswith((
            "\"domain\":",
            "\"metadata\":",
            "\"model\":",
            "\"message\":",
            "\"details\":",
            "\"errors\":",
            "\"error\":",
            "\"code\":",
            "'        \"message\":",
            "'        \"domain\":",
            "'        \"metadata\":",
        )):
            return True
        if "abortsignal" in low or "gaxios" in low:
            return True
        if "\\n' +" in low or low.endswith("' +"):
            return True
        # Generic quoted key/value log-style fragments.
        if re.match(r"^[\"']?[a-z0-9_@.\-]+[\"']?\s*:\s*.+$", low) and any(
            k in low for k in ("domain", "metadata", "model", "message", "status", "headers", "responseurl", "error")
        ):
            return True
        return False

    def _is_non_json_assistant_text(self, line: str) -> bool:
        """Kept for compatibility; non-JSON assistant text is intentionally disabled."""
        _ = line
        return False

    def _is_backend_trace_line(self, line: str) -> bool:
        low = line.lower().strip()
        if not low:
            return True
        trace_prefixes = (
            "attempt ",
            "gaxioserror",
            "at ",
            "config:",
            "response:",
            "headers:",
            "status:",
            "statustext:",
            "request:",
            "responseurl:",
            "data:",
            "method:",
            "params:",
            "authorization:",
            "'content-type':",
            "'user-agent':",
            "'x-goog-api-client':",
            "[symbol(",
            "url:",
            "server:",
            "date:",
            "vary:",
            "\"error\":",
            "\"code\":",
            "\"message\":",
            "\"errors\":",
            "\"details\":",
            "'  \"error\":",
            "'    \"code\":",
            "'    \"message\":",
            "'    \"errors\":",
            "'    \"details\":",
            "'      {",
            "'      \"",
            "],",
            "},",
        )
        if low.startswith(trace_prefixes):
            return True
        trace_substrings = (
            "cloudcode-pa.googleapis.com",
            "streamgeneratecontent",
            "google.rpc.errorinfo",
            "model_capacity_exhausted",
            "resource_exhausted",
            "retrying with backoff",
            "node_modules",
            "process.processTicksAndRejections".lower(),
            "oauth2client.requestasync".lower(),
            "ratelimitexceeded",
            "gaxios",
            "<<redacted",
        )
        return any(s in low for s in trace_substrings)

    def _build_cmd(
        self,
        gemini_exec: str,
        prompt: str,
        model: str,
        session_mode: str | None = None,
        session_id: str | None = None,
    ) -> list[str]:
        cmd = [
            gemini_exec,
            "--prompt",
            prompt,
            "--output-format",
            "stream-json",
            "--approval-mode",
            "yolo",
            "--accept-raw-output-risk",
            # Hard-disable extensions in TUI mode for predictable coding chat behavior.
            "--extensions",
            "none",
        ]

        use_mode = session_mode or self.session_mode
        use_session_id = self.session_id if session_id is None else session_id

        if use_mode == "fresh":
            pass
        elif use_mode == "resume_id" and use_session_id:
            cmd.extend(["--resume", use_session_id])
        else:
            cmd.extend(["--resume", "latest"])

        cli_model = self._cli_model_name(model)
        if cli_model:
            cmd.extend(["--model", cli_model])
        return cmd

    def _read_stdout_thread(self, pipe: Any, out_q: queue.Queue[bytes | None]) -> None:
        try:
            while True:
                raw = pipe.readline()
                if not raw:
                    break
                out_q.put(raw)
        finally:
            out_q.put(None)

    def chat_completion_stream_raw(
        self,
        messages: list[dict[str, Any]],
        model: str,
        on_output: Callable[[str], None] | None = None,
    ) -> str:
        def trace(msg: str) -> None:
            try:
                log_path = self.repo_root / "out" / "logs" / "trace.log"
                log_path.parent.mkdir(parents=True, exist_ok=True)
                with open(log_path, "a", encoding="utf-8") as f:
                    f.write(f"[{time.time()}] {msg}\n")
            except Exception:
                pass

        gemini_exec = self._resolve_gemini_executable()
        if not gemini_exec:
            raise RuntimeError("gemini CLI not found in PATH")

        prompt = self._build_prompt(messages)
        last_detail = ""
        model_for_attempt = model
        switched_to_25 = False
        session_mode_for_attempt = self.session_mode
        session_id_for_attempt = self.session_id
        for attempt in range(3):
            cmd = self._build_cmd(
                gemini_exec,
                prompt,
                model_for_attempt,
                session_mode=session_mode_for_attempt,
                session_id=session_id_for_attempt,
            )
            trace(f"Spawning subprocess (attempt {attempt + 1}): {cmd}")
            proc = subprocess.Popen(
                cmd,
                cwd=str(self.repo_root),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                shell=True,
            )
            if proc.stdin:
                proc.stdin.close()

            assistant_chunks: list[str] = []
            assistant_text = ""
            force_fresh_due_model_mismatch = False
            force_fresh_due_tool_loop = False
            non_json_tool_loop_hits = 0
            startup_noise_hits = 0

            out_q: queue.Queue[bytes | None] = queue.Queue()
            reader = None
            if proc.stdout:
                reader = threading.Thread(
                    target=self._read_stdout_thread,
                    args=(proc.stdout, out_q),
                    daemon=True,
                )
                reader.start()

            started = time.monotonic()
            # Track useful activity only (assistant output / structured events / errors),
            # so planner chatter doesn't keep the request alive forever.
            last_activity = time.monotonic()
            stream_done = False
            while not stream_done:
                now = time.monotonic()
                if now - started > 240:
                    last_detail = "timeout: total stream time exceeded"
                    break
                if now - last_activity > 70:
                    last_detail = "timeout: no stream output for 70s"
                    break

                try:
                    item = out_q.get(timeout=0.5)
                except queue.Empty:
                    if proc.poll() is not None and (reader is None or not reader.is_alive()) and out_q.empty():
                        break
                    continue

                if item is None:
                    stream_done = True
                    break

                line = item.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                json_matches = list(re.finditer(r"\{.*\}", line))
                if not json_matches:
                    trace(f"Non-JSON line: {line}")
                    if any(
                        marker in line.lower()
                        for marker in (
                            "loaded cached credentials",
                            "loading extension:",
                            "supports tool updates",
                            "scheduling mcp context refresh",
                            "executing mcp context refresh",
                            "mcp context refresh complete",
                            "yolo mode is enabled",
                        )
                    ):
                        startup_noise_hits += 1
                        last_activity = time.monotonic()
                    if self._is_capacity_error(line):
                        last_detail = line
                        last_activity = time.monotonic()
                    low_line = line.lower()
                    if (
                        self._is_planning_chatter(line)
                        or "error executing tool" in low_line
                        or "tool execution denied" in low_line
                        or "tool \"run_shell_command\" not found" in low_line
                        or "tool \"write_file\" not found" in low_line
                        or "tool \"replace\" not found" in low_line
                    ):
                        non_json_tool_loop_hits += 1
                    if non_json_tool_loop_hits >= 2:
                        last_detail = "non-interactive tool loop"
                        force_fresh_due_tool_loop = True
                        last_activity = time.monotonic()
                        stream_done = True
                        try:
                            proc.terminate()
                        except Exception:
                            pass
                        break
                    extracted = self._extract_non_json_error(line)
                    if extracted:
                        last_detail = extracted
                        last_activity = time.monotonic()
                    continue

                for match in json_matches:
                    json_str = match.group(0)
                    try:
                        evt = json.loads(json_str)
                    except json.JSONDecodeError:
                        continue

                    if "error" in evt and isinstance(evt["error"], dict):
                        last_detail = str(evt["error"].get("message", "Unknown CLI error"))
                        trace(f"CLI Error: {last_detail}")
                        last_activity = time.monotonic()
                        continue

                    etype = evt.get("type")
                    if etype == "init":
                        last_activity = time.monotonic()
                        init_model = str(evt.get("model", "")).strip().lower()
                        if (
                            self._is_25_pin_requested(model_for_attempt)
                            and "gemini-3" in init_model
                            and session_mode_for_attempt != "fresh"
                        ):
                            last_detail = f"resumed session kept model {init_model}"
                            force_fresh_due_model_mismatch = True
                            stream_done = True
                            try:
                                proc.terminate()
                            except Exception:
                                pass
                            break
                        sid = str(evt.get("session_id", "")).strip()
                        if sid and sid != self.session_id:
                            self.session_id = sid
                            self.session_mode = "resume_id"
                            if self.on_session_init:
                                self.on_session_init(sid)

                    if etype == "message" and evt.get("role") == "assistant":
                        content = str(evt.get("content", ""))
                        is_delta = bool(evt.get("delta", False))
                        if not content:
                            continue
                        if self._is_planning_chatter(content):
                            continue
                        last_activity = time.monotonic()
                        if is_delta:
                            delta = content
                            assistant_text += content
                        else:
                            if content.startswith(assistant_text):
                                delta = content[len(assistant_text):]
                                assistant_text = content
                            else:
                                delta = content
                                assistant_text += content
                        if delta:
                            assistant_chunks.append(delta)
                            if on_output:
                                on_output(escape(delta))
                    elif etype == "result":
                        last_activity = time.monotonic()
                        stream_done = True
                        break

            if last_detail.startswith("timeout"):
                try:
                    proc.terminate()
                except Exception:
                    pass

            if proc.poll() is None:
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    try:
                        proc.terminate()
                    except Exception:
                        pass

            try:
                code = proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                code = 124
                last_detail = last_detail or "timeout: process did not exit"

            if assistant_chunks:
                self._has_session = True
                final = "".join(assistant_chunks).strip()
                return final or "(No response from Gemini CLI.)"
            if code == 0:
                last_detail = last_detail or "no assistant output returned in stream-json mode"

            detail = last_detail.strip() if last_detail else f"exit code {code}"
            last_detail = detail
            if force_fresh_due_tool_loop and session_mode_for_attempt != "fresh":
                session_mode_for_attempt = "fresh"
                session_id_for_attempt = ""
                if on_output:
                    on_output("\n[bold #ffcb6b]![/] Resumed chat was stuck in a tool loop; starting a fresh Gemini session.\n")
                continue
            if "timeout" in detail.lower() and session_mode_for_attempt != "fresh":
                session_mode_for_attempt = "fresh"
                session_id_for_attempt = ""
                if on_output:
                    on_output("\n[bold #ffcb6b]![/] Request timed out; retrying with a fresh Gemini session.\n")
                continue
            if force_fresh_due_model_mismatch and session_mode_for_attempt != "fresh":
                session_mode_for_attempt = "fresh"
                session_id_for_attempt = ""
                if on_output:
                    on_output(
                        "\n[bold #ffcb6b]![/] Resumed chat was on Gemini 3; starting a fresh Gemini 2.5 session.\n"
                    )
                continue
            # If Gemini 3 auto capacity is exhausted, automatically fall back to Gemini 2.5 auto.
            if (
                not switched_to_25
                and self._is_capacity_error(detail)
                and model_for_attempt in {"gemini-cli:auto", "gemini-cli:auto-gemini-3"}
            ):
                switched_to_25 = True
                model_for_attempt = "gemini-cli:auto-gemini-2.5"
                if on_output:
                    on_output("\n[bold #ffcb6b]![/] Gemini 3 capacity full, switching to Gemini 2.5 auto.\n")
                continue
            if attempt < 2 and self._is_transient_error(detail):
                if on_output:
                    on_output(f"\n[bold #ffcb6b]![/] Gemini temporary error, retrying ({attempt + 1}/2)...\n")
                time.sleep(0.8 * (2**attempt))
                continue
            break

        raise RuntimeError(f"gemini CLI failed: {self._friendly_error(last_detail)}")

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
