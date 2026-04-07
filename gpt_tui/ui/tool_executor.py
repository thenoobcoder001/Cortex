"""
tool_executor.py

Generic tool execution and context-trim helpers.
This module avoids direct Textual dependencies so it can be reused/tested.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import shutil
from typing import Any, Callable

from gpt_tui.services.shell_service import ShellService, ShellResult
from gpt_tui.ui.constants import CONTEXT_CHAR_LIMIT, KEEP_RECENT_MESSAGES


LogFn = Callable[[str], None]
PathHook = Callable[[Path], None]
VoidHook = Callable[[], None]


@dataclass
class ToolExecutorHooks:
    """Optional UI hooks used by ToolExecutor."""

    log: LogFn | None = None
    tree_reload: VoidHook | None = None
    preview_show: PathHook | None = None
    preview_clear: VoidHook | None = None


class ToolExecutor:
    """Provider-agnostic executor for filesystem and shell tools."""

    def __init__(
        self,
        repo_root: Path,
        resolve_repo_path: Callable[[str], tuple[Path | None, str]],
        list_files: Callable[[Path, int], list[str]],
        read_utf8: Callable[[Path], tuple[str, bool]],
        hooks: ToolExecutorHooks | None = None,
        run_command: Callable[[str], ShellResult] | None = None,
        shell_timeout_seconds: int = 30,
    ) -> None:
        self.repo_root = repo_root.resolve()
        self.resolve_repo_path = resolve_repo_path
        self.list_files = list_files
        self.read_utf8 = read_utf8
        self.hooks = hooks or ToolExecutorHooks()
        self._shell_service = ShellService(self.repo_root, shell_timeout_seconds)
        self.run_command = run_command or self._shell_service.run
        self.read_only = False

    def set_repo_root(self, repo_root: Path) -> None:
        self.repo_root = repo_root.resolve()
        self._shell_service.set_cwd(self.repo_root)

    def execute(self, name: str, args: dict[str, Any] | None) -> str:
        args = args or {}
        if self.read_only and name in {
            "write_file",
            "edit_file",
            "delete_file",
            "delete_path",
            "rename_file",
            "create_directory",
            "run_terminal_command",
        }:
            return "ERROR: tool safety mode is read-only; mutating tools are blocked."

        if name == "write_file":
            return self._write_file(args)
        if name == "edit_file":
            return self._edit_file(args)
        if name == "read_file":
            return self._read_file(args)
        if name in ("delete_file", "delete_path"):
            return self._delete_path(args)
        if name == "rename_file":
            return self._rename_file(args)
        if name == "create_directory":
            return self._create_directory(args)
        if name == "list_files":
            return self._list_files(args)
        if name == "run_terminal_command":
            return self._run_terminal_command(args)
        return f"ERROR: unknown tool '{name}'"

    def _emit_log(self, message: str) -> None:
        if self.hooks.log:
            self.hooks.log(message)

    def _emit_tree_reload(self) -> None:
        if self.hooks.tree_reload:
            self.hooks.tree_reload()

    def _emit_preview_show(self, path: Path) -> None:
        if self.hooks.preview_show:
            self.hooks.preview_show(path)

    def _emit_preview_clear(self) -> None:
        if self.hooks.preview_clear:
            self.hooks.preview_clear()

    def _resolve_any_path(self, raw_path: str) -> tuple[Path | None, str]:
        if not raw_path:
            return None, "Path is required."
        candidate = Path(raw_path)
        target = candidate if candidate.is_absolute() else self.repo_root / candidate
        try:
            resolved = target.resolve()
            resolved.relative_to(self.repo_root)
        except ValueError:
            return None, "Path rejected: outside repo root."
        return resolved, ""

    def _write_file(self, args: dict[str, Any]) -> str:
        path, err = self._resolve_any_path(str(args.get("path", "")))
        if not path:
            return f"ERROR: {err}"
        content = str(args.get("content", ""))
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        except OSError as exc:
            return f"ERROR: {exc}"
        self._emit_log(f"[green]*[/] Written: [bold]{path.name}[/]")
        self._emit_tree_reload()
        self._emit_preview_show(path)
        return f"OK: written {path}"

    def _edit_file(self, args: dict[str, Any]) -> str:
        path, err = self._resolve_any_path(str(args.get("path", "")))
        if not path:
            return f"ERROR: {err}"
        old_str = str(args.get("old_str", ""))
        new_str = str(args.get("new_str", ""))
        if not path.exists():
            return f"ERROR: file not found: {path}"
        try:
            original = path.read_text(encoding="utf-8")
            if old_str not in original:
                return f"ERROR: string not found in {path.name}"
            updated = original.replace(old_str, new_str, 1)
            path.write_text(updated, encoding="utf-8")
        except OSError as exc:
            return f"ERROR: {exc}"
        self._emit_log(f"[green]*[/] Edited: [bold]{path.name}[/]")
        self._emit_tree_reload()
        self._emit_preview_show(path)
        return f"OK: edited {path}"

    def _read_file(self, args: dict[str, Any]) -> str:
        raw_path = str(args.get("path", ""))
        file_path, err = self.resolve_repo_path(raw_path)
        if not file_path:
            file_path, err = self._resolve_any_path(raw_path)
            if not file_path:
                return f"ERROR: {err}"
        try:
            content, truncated = self.read_utf8(file_path)
        except UnicodeDecodeError:
            return "ERROR: Binary/non-UTF8 file"
        except OSError as exc:
            return f"ERROR: {exc}"
        self._emit_preview_show(file_path)
        return content + ("\n...(truncated)" if truncated else "")

    def _delete_path(self, args: dict[str, Any]) -> str:
        path, err = self._resolve_any_path(str(args.get("path", "")))
        if not path:
            return f"ERROR: {err}"
        if not path.exists():
            return f"ERROR: path not found: {path}"
        try:
            if path.is_dir():
                shutil.rmtree(path)
                label = "Dir"
            else:
                path.unlink()
                label = "File"
        except OSError as exc:
            return f"ERROR: {exc}"
        self._emit_log(f"[red]*[/] Deleted {label}: [bold]{path.name}[/]")
        self._emit_tree_reload()
        self._emit_preview_clear()
        return f"OK: deleted {path}"

    def _rename_file(self, args: dict[str, Any]) -> str:
        old_path, err = self._resolve_any_path(str(args.get("old_path", "")))
        if not old_path:
            return f"ERROR: {err}"
        new_path, err = self._resolve_any_path(str(args.get("new_path", "")))
        if not new_path:
            return f"ERROR: {err}"
        if not old_path.exists():
            return f"ERROR: source not found: {old_path}"
        try:
            new_path.parent.mkdir(parents=True, exist_ok=True)
            old_path.rename(new_path)
        except OSError as exc:
            return f"ERROR: {exc}"
        self._emit_log(f"[cyan]*[/] Renamed: [bold]{old_path.name}[/] -> [bold]{new_path.name}[/]")
        self._emit_tree_reload()
        return f"OK: renamed to {new_path}"

    def _create_directory(self, args: dict[str, Any]) -> str:
        path, err = self._resolve_any_path(str(args.get("path", "")))
        if not path:
            return f"ERROR: {err}"
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return f"ERROR: {exc}"
        self._emit_log(f"[cyan]*[/] Created dir: [bold]{path.name}[/]")
        self._emit_tree_reload()
        return f"OK: directory created {path}"

    def _list_files(self, args: dict[str, Any]) -> str:
        directory = str(args.get("directory", "")).strip()
        target = self.repo_root if not directory else self._resolve_any_path(directory)[0]
        if not target:
            return "ERROR: invalid directory path"
        if not target.exists() or not target.is_dir():
            return f"ERROR: directory not found: {target}"
        files = self.list_files(target, 200)
        return "\n".join(files) if files else "(no files)"

    def _run_terminal_command(self, args: dict[str, Any]) -> str:
        command = str(args.get("command", "")).strip()
        if not command:
            return "ERROR: no command provided"
        try:
            result = self.run_command(command)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR running command: {exc}"
        self._emit_log(f"[cyan]*[/] Ran: [dim]{command}[/]")
        return f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}\n(Exit {result.exit_code})"


def maybe_trim_context(
    messages: list[dict[str, Any]],
    provider: Any,
    model: str,
    *,
    context_char_limit: int = CONTEXT_CHAR_LIMIT,
    keep_recent_messages: int = KEEP_RECENT_MESSAGES,
) -> tuple[list[dict[str, Any]], int]:
    """
    Summarize old messages if context is too long.

    Returns: (possibly_new_messages, condensed_count)
    """
    total_chars = sum(len(str(m.get("content", ""))) for m in messages)
    if total_chars <= context_char_limit or len(messages) <= 2:
        return messages, 0

    system_msg = messages[0]
    recent = messages[-keep_recent_messages:] if len(messages) > keep_recent_messages else []
    to_summarize = messages[1 : len(messages) - keep_recent_messages]
    if not to_summarize:
        return messages, 0

    lines: list[str] = []
    for msg in to_summarize:
        role = msg.get("role", "")
        content = str(msg.get("content", ""))[:800]
        if role == "user":
            lines.append(f"USER: {content}")
        elif role == "assistant":
            lines.append(f"ASSISTANT: {content}")
        elif role == "tool":
            lines.append(f"TOOL({msg.get('name', '')}): {content[:200]}")
    transcript = "\n".join(lines)

    summarize_msgs = [
        system_msg,
        {
            "role": "user",
            "content": (
                "Summarize this conversation history in 3-8 concise bullets. "
                "Keep decisions, file changes, and critical constraints.\n\n"
                f"{transcript}"
            ),
        },
    ]

    try:
        summary = provider.chat_completion(summarize_msgs, model)
    except Exception:  # noqa: BLE001
        summary = f"(Earlier conversation condensed - {len(to_summarize)} messages)"

    trimmed = [
        system_msg,
        {"role": "assistant", "content": f"[Context summary]\n{summary}"},
        *recent,
    ]
    return trimmed, len(to_summarize)


class ToolsMixin:
    """
    Backward-compatible mixin for GptTuiApp.

    Keeps public method names unchanged while delegating to generic helpers.
    """

    _tool_executor: ToolExecutor | None = None

    def _get_tool_executor(self) -> ToolExecutor:
        if self._tool_executor is None:
            hooks = ToolExecutorHooks(
                log=lambda msg: self.call_from_thread(self._log_system, msg),
                tree_reload=lambda: self.call_from_thread(
                    self.query_one("#file_tree").reload
                ),
                preview_show=lambda path: self.call_from_thread(self._show_preview, path),
                preview_clear=lambda: self.call_from_thread(
                    self.query_one("#file_preview").clear
                ),
            )
            self._tool_executor = ToolExecutor(
                repo_root=self.files.repo_root,
                resolve_repo_path=self.files.resolve_repo_path,
                list_files=self.files.list_files,
                read_utf8=self.files.read_utf8,
                hooks=hooks,
            )
        self._tool_executor.set_repo_root(self.files.repo_root)
        self._tool_executor.read_only = bool(getattr(self, "tool_read_only", False))
        return self._tool_executor

    def _maybe_trim_context(self) -> None:
        self.messages, condensed = maybe_trim_context(
            self.messages,
            self.provider,
            self.model,
        )
        if condensed:
            self._log_system(
                f"[yellow]*[/] Context auto-summarized ({condensed} old messages condensed)."
            )
            self._set_status("Context summarized. Ready.")

    def _execute_tool(self, name: str, args: dict[str, Any]) -> str:
        return self._get_tool_executor().execute(name, args)
