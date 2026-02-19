from __future__ import annotations

from pathlib import Path


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
        skip_names = {".git", ".venv", "__pycache__", "node_modules"}
        found: list[str] = []
        for path in root.rglob("*"):
            if any(part in skip_names for part in path.parts):
                continue
            if path.is_file():
                found.append(str(path))
            if len(found) >= limit:
                break
        return found

    def read_utf8(self, file_path: Path, max_chars: int = 6000) -> tuple[str, bool]:
        content = file_path.read_text(encoding="utf-8")
        if len(content) <= max_chars:
            return content, False
        return content[:max_chars] + "\n\n...[truncated]...", True

