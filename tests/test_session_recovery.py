import json
from pathlib import Path

from gpt_tui import config as config_module
from gpt_tui.desktop_api.session import DesktopSessionService
from gpt_tui.services.chat_store import ProjectChatStore


def test_service_recovers_interrupted_runs_on_startup(monkeypatch, tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    chat_store = ProjectChatStore(repo_root)
    chat_id = chat_store.create_chat(
        [{"role": "user", "content": "Finish the refactor"}],
        model="codex:gpt-5.4",
    )

    config_dir = tmp_path / "config"
    config_file = config_dir / "config.json"
    config_dir.mkdir()
    config_file.write_text(
        json.dumps(
            {
                "repo_root": str(repo_root),
                "active_chat_id": chat_id,
                "model": "codex:gpt-5.4",
                "active_runs": [
                    {
                        "chat_id": chat_id,
                        "repo_root": str(repo_root),
                        "model": "codex:gpt-5.4",
                        "last_user_message": "Finish the refactor",
                        "started_at": "2026-04-07T12:00:00",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)

    service = DesktopSessionService()
    snapshot = service.snapshot()

    assert service.config.active_runs == []
    assert len(service.config.interrupted_runs) == 1
    assert chat_id in snapshot["interruptedChatIds"]
    assert snapshot["interruptedRuns"][0]["chatId"] == chat_id
    assert snapshot["interruptedRuns"][0]["repoRoot"] == str(repo_root)
    assert snapshot["chats"][0]["interrupted"] is True


def test_delete_chat_clears_interrupted_recovery_state(monkeypatch, tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    chat_store = ProjectChatStore(repo_root)
    chat_id = chat_store.create_chat(
        [{"role": "user", "content": "Investigate the crash"}],
        model="gemini-cli:auto-gemini-2.5",
    )

    config_dir = tmp_path / "config"
    config_file = config_dir / "config.json"
    config_dir.mkdir()
    config_file.write_text(
        json.dumps(
            {
                "repo_root": str(repo_root),
                "interrupted_runs": [
                    {
                        "chat_id": chat_id,
                        "repo_root": str(repo_root),
                        "model": "gemini-cli:auto-gemini-2.5",
                        "last_user_message": "Investigate the crash",
                        "started_at": "2026-04-07T12:00:00",
                        "recovered_at": "2026-04-07T12:00:10",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)

    service = DesktopSessionService()
    snapshot = service.delete_chat(chat_id, repo_root=str(repo_root))

    assert snapshot["interruptedChatIds"] == []
    assert service.config.interrupted_runs == []
