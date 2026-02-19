from __future__ import annotations

import json
from typing import Any

try:
    from groq import Groq
except ImportError:  # pragma: no cover
    Groq = None


class GroqProvider:
    def __init__(self, api_key: str = "") -> None:
        self.api_key = api_key.strip()

    @property
    def available(self) -> bool:
        return Groq is not None

    @property
    def connected(self) -> bool:
        return self.available and bool(self.api_key)

    def set_api_key(self, api_key: str) -> None:
        self.api_key = api_key.strip()

    def validate_api_key(self, api_key: str) -> tuple[bool, str]:
        key = api_key.strip()
        if not self.available:
            return False, "groq package is missing."
        if not key:
            return False, "API key is empty."
        try:
            client = Groq(api_key=key)
            client.models.list()
            return True, "API key confirmed."
        except Exception as exc:  # noqa: BLE001
            return False, f"API key validation failed: {exc}"

    # ── Legacy streaming (no tools) ───────────────────────────────────
    def chat_completion(self, messages: list[dict[str, Any]], model: str) -> str:
        if not self.available:
            raise RuntimeError("groq package missing")
        if not self.api_key:
            raise RuntimeError("missing GROQ API key")

        client = Groq(api_key=self.api_key)
        stream = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.2,
            stream=True,
        )
        parts: list[str] = []
        for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            if delta:
                parts.append(delta)
        return "".join(parts).strip() or "(No content returned.)"

    # ── Tool-calling (agentic) ────────────────────────────────────────
    def chat_with_tools(
        self,
        messages: list[dict[str, Any]],
        model: str,
        tools: list[dict[str, Any]],
    ) -> tuple[str | None, dict | None, list | None]:
        """Single model call with tools.

        Returns one of:
          (final_text, None, None)          – model produced a text reply
          (None, asst_msg_dict, tool_calls)  – model wants to call tools
        Raises RuntimeError on API errors.
        """
        if not self.available:
            raise RuntimeError("groq package missing")
        if not self.api_key:
            raise RuntimeError("missing GROQ API key")

        client = Groq(api_key=self.api_key)
        try:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                temperature=0.2,
                max_tokens=8192,   # enough room for large file content in tool args
            )
        except Exception as exc:
            err = str(exc)
            # Groq returns 400 when tool call JSON is malformed / too long
            if "tool_use_failed" in err or "failed_generation" in err:
                raise RuntimeError("__TOOL_FAILED__") from exc
            raise

        choice = response.choices[0]
        msg = choice.message

        if msg.tool_calls:
            asst_dict: dict[str, Any] = {
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in msg.tool_calls
                ],
            }
            return None, asst_dict, msg.tool_calls

        return (msg.content or "(No response.)"), None, None
