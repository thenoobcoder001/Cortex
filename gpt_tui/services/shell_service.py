from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import subprocess


@dataclass
class ShellResult:
    stdout: str
    stderr: str
    exit_code: int


class ShellService:
    """Runs shell commands in a controlled working directory."""

    def __init__(self, cwd: Path, timeout_seconds: int = 30) -> None:
        self.cwd = cwd.resolve()
        self.timeout_seconds = timeout_seconds

    def set_cwd(self, cwd: Path) -> None:
        self.cwd = cwd.resolve()

    def run(self, command: str) -> ShellResult:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            cwd=str(self.cwd),
            timeout=self.timeout_seconds,
        )
        return ShellResult(
            stdout=result.stdout or "",
            stderr=result.stderr or "",
            exit_code=result.returncode,
        )

