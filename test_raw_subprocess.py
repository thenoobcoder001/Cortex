import subprocess

cmd = [
    'gemini.cmd', 
    '--prompt', "Conversation history:\nSYSTEM: test\n\nUser's latest request:\nhi", 
    '--output-format', 'stream-json', 
    '--approval-mode', 'yolo'
]

print(f"Running cmd: {cmd}")
p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
out = p.stdout.read().decode('utf-8')
print("OUTPUT:")
print(out)
