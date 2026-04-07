import sys
from pathlib import Path
from gpt_tui.providers.gemini_cli_provider import GeminiCliProvider

def on_out(s):
    print(f"STREAM: {s}")
    sys.stdout.flush()

repo_root = Path("e:/codex").resolve()
provider = GeminiCliProvider(repo_root=repo_root)
messages = [{"role": "user", "content": "hi"}]

print(f"--- TESTING GEMINI CLI ---")
try:
    # Use the streaming version to see what's happening
    res = provider.chat_completion_stream_raw(messages, "gemini-cli:auto", on_output=on_out)
    print("\n--- FINAL RESULT ---")
    print(res)
    print("--------------------")
except Exception as e:
    print(f"\nFATAL EXCEPTION: {e}")