import sys
import subprocess
from pathlib import Path

def run_cli_prompt(prompt, resume=False):
    root = Path("e:/codex/gpt-tui").resolve()
    cmd = [
        "gemini.cmd", "--prompt", prompt, 
        "--output-format", "stream-json", "--approval-mode", "yolo"
    ]
    if resume:
        cmd.extend(["--resume", "latest"])
        
    print(f"\nRunning: {' '.join(cmd)}")
    proc = subprocess.Popen(cmd, cwd=root, stdout=subprocess.PIPE, text=True)
    out, _ = proc.communicate()
    print("OUTPUT (snippets):")
    import json
    for line in out.splitlines():
        try:
            d = json.loads(line)
            if d.get("role") == "assistant" and d.get("content"):
                print(d["content"])
        except:
            pass

print("1. Set secret word (no resume)")
run_cli_prompt("hello my secret word is COCONUT")

print("2. Ask about secret word (resume)")
run_cli_prompt("what is my secret word?", resume=True)
