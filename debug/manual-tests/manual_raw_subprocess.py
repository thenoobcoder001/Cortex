import subprocess
import json
import time

cmd = [
    'gemini.cmd', 
    '--prompt', "Conversation history:\nSYSTEM: test\n\nUser's latest request:\nhi", 
    '--output-format', 'stream-json', 
    '--approval-mode', 'yolo'
]

print(f"Running cmd: {cmd}")
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
if p.stdin:
    p.stdin.close()
lines = []
start = time.monotonic()
if p.stdout:
    while True:
        if time.monotonic() - start > 45:
            lines.append("[timeout] stopping read loop after 45s")
            break
        raw = p.stdout.readline()
        if not raw:
            break
        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
        lines.append(line)
        try:
            evt = json.loads(line)
            if evt.get("type") == "result":
                break
        except json.JSONDecodeError:
            pass
if p.poll() is None:
    try:
        p.terminate()
    except Exception:
        pass
    try:
        p.wait(timeout=3)
    except Exception:
        pass
print("OUTPUT:")
print("\n".join(lines))
