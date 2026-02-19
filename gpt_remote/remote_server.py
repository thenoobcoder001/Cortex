"""
remote_server.py — Standalone Codex Mobile Server.

Usage:
  cd e:/codex/gpt-tui
  python gpt_remote/remote_server.py
"""
import json
import os
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Add project root to path so we can import gpt_tui
PROJECT_ROOT = Path(__file__).parents[1].resolve()
sys.path.append(str(PROJECT_ROOT))

from gpt_tui.config import AppConfig
from gpt_tui.providers.gemini_provider import GeminiProvider
from gpt_tui.providers.groq_provider import GroqProvider
from gpt_tui.services.file_service import RepoFileService
from gpt_tui.ui.constants import TOOLS, DEFAULT_MODEL
from gpt_tui.ui.tool_executor import ToolExecutor, ToolExecutorHooks

# Global state for the server
CONVERSATION = []
CONFIG = AppConfig.load()
REPO_ROOT = PROJECT_ROOT
FILES = RepoFileService(repo_root=REPO_ROOT)

def _load_dotenv() -> None:
    """Minimal .env loader."""
    env_file = REPO_ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value

_load_dotenv()

def get_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()
    return IP

class RemoteHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/' or self.path == '/index.html':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            static_file = Path(__file__).parent / "static" / "index.html"
            if static_file.exists():
                self.wfile.write(static_file.read_bytes())
            else:
                self.wfile.write(b"<h1>Error: index.html not found</h1>")
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == '/api/chat':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data)
            user_msg = data.get('message', '')

            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self.end_headers()

            # Initialize providers
            groq_key = os.environ.get("GROQ_API_KEY", "").strip() or CONFIG.api_key.strip()
            gemini_key = os.environ.get("GEMINI_API_KEY", "").strip()
            
            model = CONFIG.model or DEFAULT_MODEL
            if model.startswith('gemini'):
                if not gemini_key:
                    log_to_stream("Error: GEMINI_API_KEY missing from .env")
                    return
                provider = GeminiProvider(api_key=gemini_key)
            else:
                if not groq_key:
                    log_to_stream("Error: GROQ_API_KEY missing from .env")
                    return
                provider = GroqProvider(api_key=groq_key)
            
            def log_to_stream(msg):
                print(f"[Remote] {msg}")
                packet = json.dumps({"type": "status", "message": msg})
                try:
                    self.wfile.write(f"data: {packet}\n\n".encode())
                    self.wfile.flush()
                except: pass

            hooks = ToolExecutorHooks(log=log_to_stream)
            executor = ToolExecutor(
                repo_root=REPO_ROOT,
                resolve_repo_path=FILES.resolve_repo_path,
                list_files=FILES.list_files,
                read_utf8=FILES.read_utf8,
                hooks=hooks
            )

            if not CONVERSATION:
                CONVERSATION.append({
                    "role": "system",
                    "content": "You are a coding assistant running on a Windows laptop accessible via mobile. Use tools for all file actions."
                })

            CONVERSATION.append({"role": "user", "content": user_msg})
            working_msgs = list(CONVERSATION)
            final_content = ""
            
            for round_num in range(8):
                log_to_stream(f"Thinking (Round {round_num+1})...")
                try:
                    final_text, asst_dict, tool_calls = provider.chat_with_tools(working_msgs, model, TOOLS)
                except Exception as e:
                    log_to_stream(f"Error: {str(e)}")
                    break

                if final_text:
                    final_content = final_text
                    break
                
                working_msgs.append(asst_dict)
                for tc in tool_calls:
                    log_to_stream(f"Using tool: {tc.function.name}")
                    try:
                        args = json.loads(tc.function.arguments) or {}
                    except: args = {}
                    result = executor.execute(tc.function.name, args)
                    working_msgs.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "name": tc.function.name,
                        "content": result
                    })

            if final_content:
                CONVERSATION.append({"role": "assistant", "content": final_content})
                packet = json.dumps({"type": "content", "content": final_content})
                try:
                    self.wfile.write(f"data: {packet}\n\n".encode())
                    self.wfile.flush()
                except: pass
        else:
            self.send_error(404)

def run_server():
    port = 8080
    ip = get_ip()
    server = ThreadingHTTPServer(('0.0.0.0', port), RemoteHandler)
    print("\n" + "="*50)
    print("🚀 STANDALONE CODEX REMOTE LIVE")
    print(f"Mobile URL: http://{ip}:{port}")
    print("="*50 + "\n")
    server.serve_forever()

if __name__ == '__main__':
    run_server()
