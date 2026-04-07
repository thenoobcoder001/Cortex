import json
from pathlib import Path
from gpt_tui.providers.gemini_cli_provider import GeminiCliProvider

def on_out(s):
    print("OUTPUT:", repr(s))

provider = GeminiCliProvider(Path("e:/codex"))
messages = [{"role": "user", "content": "list directory"}]

try:
    print("Starting chat completion...")
    res = provider.chat_completion_stream_raw(messages, "gemini-cli:auto", on_output=on_out)
    print("Finished:")
    print(res)
except Exception as e:
    print("Exception:", str(e))
