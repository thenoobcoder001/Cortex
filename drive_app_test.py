import time
import subprocess
import os
from pathlib import Path

def drive_app():
    # Start the app
    proc = subprocess.Popen(
        ["python", "app.py"],
        cwd="e:/codex/gpt-tui",
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    
    time.sleep(5) # Wait for init
    
    print("App started. Sending 'hi'...")
    # The app should default to gemini-cli:auto if that's what's in config
    # Send 'hi' and Enter
    proc.stdin.write("hi\n")
    proc.stdin.flush()
    
    print("Waiting for response (this takes ~1 min for CLI)...")
    # Wait long enough for the CLI response
    time.sleep(70)
    
    # We can't easily read the TUI screen, but we can check trace.log
    trace_path = Path("e:/codex/gpt-tui/trace.log")
    if trace_path.exists():
        content = trace_path.read_text(encoding="utf-8")
        last_lines = content.splitlines()[-20:]
        print("\nLast lines of trace.log:")
        for line in last_lines:
            print(line)
    
    proc.terminate()
    print("\nTest finished.")

if __name__ == "__main__":
    drive_app()
