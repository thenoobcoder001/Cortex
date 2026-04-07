from __future__ import annotations

import difflib
from pathlib import Path
from typing import Any


class RepoFileService:
    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root.resolve()

    def set_repo_root(self, root: Path) -> tuple[bool, str]:
        path = root.resolve()
        if not path.exists() or not path.is_dir():
            return False, f"Directory not found: {path}"
        self.repo_root = path
        return True, f"Repo root switched to: {self.repo_root}"

    def resolve_repo_path(self, raw_path: str) -> tuple[Path | None, str]:
        if not raw_path:
            return None, "Path is required."
        candidate = Path(raw_path)
        if not candidate.is_absolute():
            return None, "Only absolute paths are allowed."
        resolved = candidate.resolve()
        try:
            resolved.relative_to(self.repo_root)
        except ValueError:
            return None, "Path rejected: outside repo root."
        return resolved, ""

    def list_files(self, root: Path, limit: int = 200) -> list[str]:
        skip_names = {".git", ".gpt-tui", ".venv", "__pycache__", "node_modules"}
        found: list[str] = []
        for path in root.rglob("*"):
            if any(part in skip_names for part in path.parts):
                continue
            if path.is_file():
                found.append(str(path))
            if len(found) >= limit:
                break
        return found

    def snapshot_repo_state(
        self,
        root: Path,
        *,
        limit: int = 2000,
        max_file_bytes: int = 200_000,
    ) -> dict[str, dict[str, Any]]:
        skip_names = {".git", ".gpt-tui", ".venv", "__pycache__", "node_modules"}
        state: dict[str, dict[str, Any]] = {}
        count = 0
        for path in root.rglob("*"):
            if any(part in skip_names for part in path.parts):
                continue
            if not path.is_file():
                continue
            relative = str(path.relative_to(root))
            stat = path.stat()
            text: str | None = None
            if stat.st_size <= max_file_bytes:
                try:
                    text = path.read_text(encoding="utf-8")
                except (OSError, UnicodeDecodeError):
                    text = None
            state[relative] = {
                "path": str(path),
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
                "text": text,
            }
            count += 1
            if count >= limit:
                break
        return state

    def diff_repo_state(
        self,
        before: dict[str, dict[str, Any]],
        after: dict[str, dict[str, Any]],
    ) -> list[dict[str, Any]]:
        changes: list[dict[str, Any]] = []
        for relative in sorted(set(before) | set(after)):
            previous = before.get(relative)
            current = after.get(relative)
            if previous is None and current is not None:
                changes.append(
                    {
                        "action": "create",
                        "path": relative,
                        "oldPath": "",
                        "newPath": "",
                        "diff": self._build_diff(relative, "", current.get("text") or ""),
                    }
                )
                continue
            if previous is not None and current is None:
                changes.append(
                    {
                        "action": "delete",
                        "path": relative,
                        "oldPath": "",
                        "newPath": "",
                        "diff": self._build_diff(relative, previous.get("text") or "", ""),
                    }
                )
                continue
            if previous is None or current is None:
                continue
            if (
                previous.get("size") == current.get("size")
                and previous.get("mtime_ns") == current.get("mtime_ns")
            ):
                continue
            before_text = previous.get("text")
            after_text = current.get("text")
            if before_text == after_text and before_text is not None:
                continue
            changes.append(
                {
                    "action": "edit",
                    "path": relative,
                    "oldPath": "",
                    "newPath": "",
                    "diff": self._build_diff(relative, before_text or "", after_text or ""),
                }
            )
        return changes

    def _build_diff(self, relative: str, before: str, after: str) -> str:
        diff = difflib.unified_diff(
            before.splitlines(),
            after.splitlines(),
            fromfile=f"a/{relative}",
            tofile=f"b/{relative}",
            lineterm="",
        )
        return "\n".join(diff)

    def read_utf8(self, file_path: Path, max_chars: int = 6000) -> tuple[str, bool]:
        content = file_path.read_text(encoding="utf-8")
        if len(content) <= max_chars:
            return content, False
        return content[:max_chars] + "\n\n...[truncated]...", True
