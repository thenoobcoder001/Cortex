from __future__ import annotations

import tempfile
from pathlib import Path
import unittest

from gpt_tui.services.file_service import RepoFileService
from gpt_tui.ui.tool_executor import ToolExecutor, ToolExecutorHooks, maybe_trim_context


class _FakeProvider:
    def chat_completion(self, messages, model):
        return "- summary bullet 1\n- summary bullet 2"


class ToolExecutorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.files = RepoFileService(self.root)
        self.logs: list[str] = []
        self.preview: list[Path] = []
        self.clears = 0
        self.reloads = 0

        hooks = ToolExecutorHooks(
            log=self.logs.append,
            preview_show=self.preview.append,
            preview_clear=self._mark_clear,
            tree_reload=self._mark_reload,
        )
        self.executor = ToolExecutor(
            repo_root=self.root,
            resolve_repo_path=self.files.resolve_repo_path,
            list_files=self.files.list_files,
            read_utf8=self.files.read_utf8,
            hooks=hooks,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _mark_clear(self) -> None:
        self.clears += 1

    def _mark_reload(self) -> None:
        self.reloads += 1

    def test_write_edit_read_roundtrip(self) -> None:
        file_path = self.root / "a.txt"
        out = self.executor.execute(
            "write_file", {"path": "a.txt", "content": "hello world"}
        )
        self.assertIn("OK: written", out)
        self.assertTrue(file_path.exists())

        out = self.executor.execute(
            "edit_file", {"path": "a.txt", "old_str": "world", "new_str": "codex"}
        )
        self.assertIn("OK: edited", out)

        out = self.executor.execute("read_file", {"path": str(file_path)})
        self.assertIn("hello codex", out)
        self.assertGreaterEqual(len(self.preview), 1)

    def test_reject_path_outside_repo(self) -> None:
        outside = Path("C:/Windows/System32/drivers/etc/hosts")
        out = self.executor.execute("write_file", {"path": str(outside), "content": "x"})
        self.assertTrue(out.startswith("ERROR:"))

    def test_delete_directory(self) -> None:
        d = self.root / "tmpdir"
        (d / "x.txt").parent.mkdir(parents=True, exist_ok=True)
        (d / "x.txt").write_text("x", encoding="utf-8")
        out = self.executor.execute("delete_path", {"path": "tmpdir"})
        self.assertIn("OK: deleted", out)
        self.assertFalse(d.exists())
        self.assertEqual(self.clears, 1)

    def test_rename_and_list(self) -> None:
        src = self.root / "from.txt"
        src.write_text("a", encoding="utf-8")
        out = self.executor.execute(
            "rename_file", {"old_path": "from.txt", "new_path": "to.txt"}
        )
        self.assertIn("OK: renamed", out)
        listing = self.executor.execute("list_files", {"directory": str(self.root)})
        self.assertIn("to.txt", listing)

    def test_run_terminal_command(self) -> None:
        out = self.executor.execute("run_terminal_command", {"command": "echo hello"})
        self.assertIn("STDOUT:", out)
        self.assertIn("hello", out.lower())


class ContextTrimTests(unittest.TestCase):
    def test_trim_occurs(self) -> None:
        provider = _FakeProvider()
        messages = [{"role": "system", "content": "sys"}]
        for i in range(30):
            messages.append({"role": "user", "content": "x" * 500})
            messages.append({"role": "assistant", "content": "y" * 500})

        trimmed, condensed = maybe_trim_context(
            messages,
            provider,
            "model",
            context_char_limit=2000,
            keep_recent_messages=4,
        )
        self.assertGreater(condensed, 0)
        self.assertIn("[Context summary]", trimmed[1]["content"])


if __name__ == "__main__":
    unittest.main()

