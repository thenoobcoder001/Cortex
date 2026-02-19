from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


# ── Minimal shims so the app can treat Gemini tool calls like Groq's ──

class _Fn:
    def __init__(self, name: str, arguments: str) -> None:
        self.name = name
        self.arguments = arguments


class _TC:
    def __init__(self, call_id: str, name: str, arguments: str) -> None:
        self.id = call_id
        self.function = _Fn(name, arguments)


# ── GeminiProvider ────────────────────────────────────────────────────

class GeminiProvider:
    """Gemini provider using the REST API — no extra packages needed."""

    BASE = "https://generativelanguage.googleapis.com/v1beta"

    def __init__(self, api_key: str = "") -> None:
        self.api_key = api_key.strip()

    @property
    def available(self) -> bool:
        return True  # stdlib only — always available

    @property
    def connected(self) -> bool:
        return bool(self.api_key)

    def set_api_key(self, api_key: str) -> None:
        self.api_key = api_key.strip()

    def validate_api_key(self, api_key: str) -> tuple[bool, str]:
        key = api_key.strip()
        if not key:
            return False, "API key is empty."
        try:
            url = f"{self.BASE}/models?key={key}"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=10):
                pass
            return True, "Gemini API key confirmed."
        except urllib.error.HTTPError as e:
            return False, f"Gemini key rejected (HTTP {e.code})"
        except Exception as exc:  # noqa: BLE001
            return False, f"Validation error: {exc}"

    # ── Message conversion ────────────────────────────────────────────

    def _to_gemini_messages(
        self, messages: list[dict[str, Any]]
    ) -> tuple[str | None, list[dict[str, Any]]]:
        """Convert OpenAI-format messages → Gemini contents + system_instruction."""
        system_text: str | None = None
        contents: list[dict[str, Any]] = []

        for msg in messages:
            role = msg["role"]

            if role == "system":
                system_text = msg["content"]
                continue

            if role in ("user", "human"):
                contents.append({"role": "user", "parts": [{"text": msg["content"] or ""}]})

            elif role == "assistant":
                tool_calls = msg.get("tool_calls", [])
                if tool_calls:
                    parts: list[dict[str, Any]] = []
                    if msg.get("content"):
                        parts.append({"text": msg["content"]})
                    for tc in tool_calls:
                        raw_args = tc["function"]["arguments"]
                        args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                        parts.append({"functionCall": {"name": tc["function"]["name"], "args": args}})
                    contents.append({"role": "model", "parts": parts})
                else:
                    contents.append({"role": "model", "parts": [{"text": msg["content"] or ""}]})

            elif role == "tool":
                # Tool results attach as user-turn functionResponse parts
                part = {
                    "functionResponse": {
                        "name": msg.get("name", "unknown"),
                        "response": {"result": msg["content"]},
                    }
                }
                # Merge consecutive tool results into one user turn
                if (
                    contents
                    and contents[-1]["role"] == "user"
                    and any("functionResponse" in p for p in contents[-1]["parts"])
                ):
                    contents[-1]["parts"].append(part)
                else:
                    contents.append({"role": "user", "parts": [part]})

        return system_text, contents

    def _to_gemini_tools(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Convert OpenAI tool schemas → Gemini function_declarations."""
        TYPE_MAP = {
            "object": "OBJECT", "string": "STRING", "integer": "INTEGER",
            "number": "NUMBER", "boolean": "BOOLEAN", "array": "ARRAY",
        }

        def _fix_schema(s: dict[str, Any]) -> dict[str, Any]:
            out: dict[str, Any] = {}
            if "type" in s:
                out["type"] = TYPE_MAP.get(s["type"], s["type"].upper())
            if "description" in s:
                out["description"] = s["description"]
            if "properties" in s:
                out["properties"] = {k: _fix_schema(v) for k, v in s["properties"].items()}
            if "required" in s:
                out["required"] = s["required"]
            if "items" in s:
                out["items"] = _fix_schema(s["items"])
            return out

        decls = [
            {
                "name": t["function"]["name"],
                "description": t["function"]["description"],
                "parameters": _fix_schema(t["function"].get("parameters", {})),
            }
            for t in tools
        ]
        return [{"function_declarations": decls}]

    # ── API call ──────────────────────────────────────────────────────

    def _post(self, model: str, body: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.BASE}/models/{model}:generateContent?key={self.api_key}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body_txt = e.read().decode(errors="replace")
            if e.code == 429:
                raise RuntimeError(
                    "Gemini quota exhausted. Press Ctrl+T to switch to a Groq model "
                    "(free · 14,400 req/day). Quota will reset tomorrow."
                ) from e
            if e.code in (401, 403):
                raise RuntimeError(
                    "Gemini API key rejected (403). Press Ctrl+K to update your key."
                ) from e
            if e.code == 404:
                raise RuntimeError(
                    f"Model '{model}' not found. Press Ctrl+T to pick a different model."
                ) from e
            # Signal tool-call failure so the app can fall back to plain chat
            if e.code == 400 and ("tool_use_failed" in body_txt or "RECITATION" in body_txt):
                raise RuntimeError("__TOOL_FAILED__") from e
            raise RuntimeError(f"Gemini error {e.code}: {body_txt[:200]}") from e


    def _parse_response(
        self, result: dict[str, Any]
    ) -> tuple[str | None, dict | None, list | None]:
        candidate = result["candidates"][0]
        parts = candidate["content"]["parts"]

        fn_calls = [p["functionCall"] for p in parts if "functionCall" in p]
        text_parts = [p.get("text", "") for p in parts if "text" in p]

        if fn_calls:
            tool_calls = [
                _TC(f"call_{i}", fc["name"], json.dumps(fc["args"]))
                for i, fc in enumerate(fn_calls)
            ]
            asst_dict: dict[str, Any] = {
                "role": "assistant",
                "content": "".join(text_parts),
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in tool_calls
                ],
            }
            return None, asst_dict, tool_calls

        return ("".join(text_parts).strip() or "(No response.)"), None, None

    # ── Public interface (mirrors GroqProvider) ───────────────────────

    def chat_completion(self, messages: list[dict[str, Any]], model: str) -> str:
        system_text, contents = self._to_gemini_messages(messages)
        body: dict[str, Any] = {
            "contents": contents,
            "generation_config": {"temperature": 0.2, "maxOutputTokens": 8192},
        }
        if system_text:
            body["system_instruction"] = {"parts": [{"text": system_text}]}
        result = self._post(model, body)
        text, _, _ = self._parse_response(result)
        return text or "(No response.)"

    def chat_with_tools(
        self,
        messages: list[dict[str, Any]],
        model: str,
        tools: list[dict[str, Any]],
    ) -> tuple[str | None, dict | None, list | None]:
        system_text, contents = self._to_gemini_messages(messages)
        body: dict[str, Any] = {
            "contents": contents,
            "tools": self._to_gemini_tools(tools),
            "tool_config": {"function_calling_config": {"mode": "AUTO"}},
            "generation_config": {"temperature": 0.2, "maxOutputTokens": 8192},
        }
        if system_text:
            body["system_instruction"] = {"parts": [{"text": system_text}]}
        result = self._post(model, body)
        return self._parse_response(result)
