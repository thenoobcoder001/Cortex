import sys
from pathlib import Path
from gpt_tui.providers.gemini_cli_provider import GeminiCliProvider

def test_state():
    repo_root = Path("e:/codex/gpt-tui").resolve()
    provider = GeminiCliProvider(repo_root=repo_root)
    
    # Simulate a history where the user passed a secret word, the AI replied, and the user asks for it.
    messages = [
        {"role": "user", "content": "hello! my secret word for today is WATERMELON."},
        {"role": "assistant", "content": "Got it! I will remember that your secret word is WATERMELON."},
        {"role": "user", "content": "what was my secret word?"}
    ]

    print("--- TESTING GEMINI CLI STATE ---")
    print(f"Prompting with context length: {len(messages)} messages")
    
    try:
        final_text = provider.chat_completion_stream_raw(messages, "gemini-cli:auto", on_output=lambda x: sys.stdout.write(x))
        print("\n\n--- FINAL OUTPUT ---")
        print(final_text)
        return True
    except Exception as e:
        print(f"\nERROR: {e}")
        return False

if __name__ == "__main__":
    ok = test_state()
    raise SystemExit(0 if ok else 1)
