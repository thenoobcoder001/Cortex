from __future__ import annotations

import tempfile
from pathlib import Path
import unittest

from gpt_tui.services.chat_store import ProjectChatStore


class ChatStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.store = ProjectChatStore(self.root)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_create_and_load_chat(self) -> None:
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "Implement feature x"},
        ]
        chat_id = self.store.create_chat(msgs, model="gemini-cli:auto-gemini-2.5")
        self.assertTrue(chat_id)

        listed = self.store.list_chats()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0].chat_id, chat_id)
        self.assertIn("Implement feature x", listed[0].title)

        loaded = self.store.load_chat(chat_id)
        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertEqual(loaded.get("chat_id"), chat_id)
        self.assertEqual(len(loaded.get("messages", [])), 2)

    def test_update_existing_chat(self) -> None:
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "First"},
        ]
        chat_id = self.store.create_chat(msgs, model="gemini-cli:auto-gemini-2.5")
        msgs.append({"role": "assistant", "content": "Answer"})
        self.store.save_chat(chat_id, msgs, model="gemini-cli:auto-gemini-3")

        listed = self.store.list_chats()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0].model, "gemini-cli:auto-gemini-3")

        loaded = self.store.load_chat(chat_id)
        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertEqual(len(loaded.get("messages", [])), 3)

    def test_repo_isolation(self) -> None:
        chat_id = self.store.create_chat(
            [{"role": "system", "content": "sys"}],
            model="gemini-cli:auto-gemini-2.5",
        )
        self.assertTrue(chat_id)
        self.assertEqual(len(self.store.list_chats()), 1)

        other_root = self.root / "other"
        other_root.mkdir(parents=True, exist_ok=True)
        self.store.set_repo_root(other_root)
        self.assertEqual(self.store.list_chats(), [])


if __name__ == "__main__":
    unittest.main()
