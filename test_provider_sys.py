import sys
import json
from pathlib import Path
from gpt_tui.providers.gemini_cli_provider import GeminiCliProvider

def on_out(s):
    print("OUTPUT:", repr(s))
    sys.stdout.flush()

provider = GeminiCliProvider(Path("e:/codex"))
# Include the system message from app.py
messages = [
    {
        "role": "system",
        "content": (
            "You are a coding assistant running inside a Windows terminal app. "
            "You have full access to the file system via tools. "
            "Use write_file to create or edit files, read_file to read them, "
            "and list_files to explore the project. "
            "Always use tools when the user asks to save, create, edit, or read files. "
            "Keep explanations concise."
        ),
    },
    {"role": "user", "content": "hello"}
]

try:
    print("Starting chat completion...")
    res = provider.chat_completion_stream_raw(messages, "gemini-cli:auto", on_output=on_out)
    print("Finished:")
    print(res)
except Exception as e:
    print("Exception:", str(e))
