from pathlib import Path

from gpt_tui.providers.codex_provider import CodexProvider


def test_fresh_write_enabled_codex_uses_full_auto(monkeypatch) -> None:
    provider = CodexProvider(Path("."))
    provider.tool_read_only = False
    monkeypatch.setattr(provider, "_resolve_codex_executable", lambda: "codex")

    cmd = provider._build_exec_command("codex:gpt-5.4", json_mode=True, resume=False)

    assert "--full-auto" in cmd
    assert "--sandbox" not in cmd
    assert "--json" in cmd


def test_fresh_read_only_codex_uses_read_only_sandbox(monkeypatch) -> None:
    provider = CodexProvider(Path("."))
    provider.tool_read_only = True
    monkeypatch.setattr(provider, "_resolve_codex_executable", lambda: "codex")

    cmd = provider._build_exec_command("codex:gpt-5.4", json_mode=True, resume=False)

    assert "--full-auto" not in cmd
    assert "--sandbox" in cmd
    assert "read-only" in cmd


def test_resume_write_enabled_codex_keeps_full_auto(monkeypatch) -> None:
    provider = CodexProvider(Path("."))
    provider.tool_read_only = False
    provider.session_id = "thread-123"
    monkeypatch.setattr(provider, "_resolve_codex_executable", lambda: "codex")

    cmd = provider._build_exec_command("codex:gpt-5.4", json_mode=True, resume=True)

    assert cmd[:3] == ["codex", "exec", "resume"]
    assert "--full-auto" in cmd
    assert "thread-123" in cmd
