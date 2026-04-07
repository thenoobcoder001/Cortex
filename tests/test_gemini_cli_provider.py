from pathlib import Path

from gpt_tui.providers.gemini_cli_provider import GeminiCliProvider, HEADLESS_PROMPT_PREFIX


def test_cli_model_name_keeps_flash_preview() -> None:
    provider = GeminiCliProvider(Path("."))
    assert provider._cli_model_name("gemini-cli:gemini-3-flash-preview") == "gemini-3-flash-preview"


def test_cli_model_name_keeps_auto_gemini_3() -> None:
    provider = GeminiCliProvider(Path("."))
    assert provider._cli_model_name("gemini-cli:auto-gemini-3") == "auto-gemini-3"


def test_cli_model_name_back_compat_auto_alias() -> None:
    provider = GeminiCliProvider(Path("."))
    assert provider._cli_model_name("gemini-cli:auto") == "auto-gemini-2.5"


def test_is_25_pin_requested_only_for_25() -> None:
    provider = GeminiCliProvider(Path("."))
    assert provider._is_25_pin_requested("gemini-cli:auto-gemini-2.5")
    assert not provider._is_25_pin_requested("gemini-cli:auto-gemini-3")
    assert not provider._is_25_pin_requested("gemini-cli:gemini-3-flash-preview")


def test_build_prompt_includes_recent_context() -> None:
    provider = GeminiCliProvider(Path("."))
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "First question"},
        {"role": "assistant", "content": "First answer"},
        {"role": "user", "content": "Second question"},
    ]
    prompt = provider._build_prompt(messages)
    assert HEADLESS_PROMPT_PREFIX in prompt
    assert "Conversation context:" in prompt
    assert "user: First question" in prompt
    assert "assistant: First answer" in prompt
    assert "Latest request:\nSecond question" in prompt


def test_build_prompt_with_single_user_message() -> None:
    provider = GeminiCliProvider(Path("."))
    prompt = provider._build_prompt([{"role": "user", "content": "Hello"}])
    assert HEADLESS_PROMPT_PREFIX in prompt
    assert prompt.endswith("User request:\nHello")
