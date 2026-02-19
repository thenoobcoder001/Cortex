"""
constants.py — All static data: branding, model lists, tool schemas, limits.
No Textual imports here — this file must be importable anywhere.
"""
from __future__ import annotations

from typing import Any

# ─── Branding ────────────────────────────────────────────────────────
APP_NAME = "GPT TUI"
VERSION = "0.2.0"

WELCOME_ART = r"""[bold #ff6b6b]
   ██████╗ ██████╗ ████████╗  ████████╗██╗   ██╗██╗
  ██╔════╝ ██╔══██╗╚══██╔══╝  ╚══██╔══╝██║   ██║██║
  ██║  ███╗██████╔╝   ██║        ██║   ██║   ██║██║
  ██║   ██║██╔═══╝    ██║        ██║   ██║   ██║██║
  ╚██████╔╝██║        ██║        ██║   ╚██████╔╝██║
   ╚═════╝ ╚═╝        ╚═╝        ╚═╝    ╚═════╝ ╚═╝[/]
"""

WELCOME_MSG = (
    f"[dim #7a8a9e]v{VERSION}[/]  ·  "
    "[dim #7a8a9e]Windows-first coding assistant[/]  ·  "
    "[dim #7a8a9e]Gemini + Groq[/]\n"
    "[dim #536374]─────────────────────────────────────────────────────[/]\n"
    f"[dim #7a8a9e]Shift + Mouse to select text[/]  ·  "
    "[dim #7a8a9e]Ctrl+G[/] [dim]copy last reply[/]\n"
    "[dim #536374]─────────────────────────────────────────────────────[/]\n"
    "[#7a8a9e]Ctrl+K[/] [dim]API keys[/]  │  "
    "[#7a8a9e]Ctrl+T[/] [dim]switch model[/]  │  "
    "[#7a8a9e]/help[/] [dim]commands[/]  │  "
    "[#7a8a9e]Ctrl+L[/] [dim]clear[/]"
)

# ─── Model registry ──────────────────────────────────────────────────
GEMINI_MODELS: list[tuple[str, str]] = [
    ("gemini-2.0-flash",              "Gemini 2.0 Flash       [free · fast]"),
    ("gemini-1.5-flash",              "Gemini 1.5 Flash       [free · fast]"),
    ("gemini-1.5-pro",                "Gemini 1.5 Pro         [free · smart · 50 req/day]"),
    ("gemini-2.0-flash-thinking-exp", "Gemini 2.0 Thinking    [free · reasoning]"),
]
GROQ_MODELS: list[tuple[str, str]] = [
    ("llama-3.3-70b-versatile",        "Llama 3.3 70B          [free · fast]"),
    ("llama-3.1-8b-instant",           "Llama 3.1 8B           [free · fastest]"),
    ("deepseek-r1-distill-llama-70b",  "DeepSeek R1 70B        [free · reasoning]"),
    ("mixtral-8x7b-32768",             "Mixtral 8x7B           [free · long ctx]"),
]

DEFAULT_MODEL = "llama-3.3-70b-versatile"

# ─── Context window ──────────────────────────────────────────────────
# Auto-summarization fires when total message chars exceed this.
# ~80K chars ≈ 20K tokens — safely below all supported models.
CONTEXT_CHAR_LIMIT = 80_000

# How many recent messages to keep intact when summarizing
KEEP_RECENT_MESSAGES = 6

# Maximum turns of model <-> tool interaction before stopping
MAX_TOOL_ROUNDS = 8

# ─── Tool schemas (OpenAI function-calling format) ───────────────────
TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create or overwrite a file on disk with the given content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path":    {"type": "string", "description": "Relative or absolute file path."},
                    "content": {"type": "string", "description": "Full file content to write."},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": (
                "Edit a file by replacing an exact string with new content. "
                "Use for targeted changes without rewriting the whole file."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path":    {"type": "string", "description": "Relative or absolute file path."},
                    "old_str": {"type": "string", "description": "The exact string to find and replace."},
                    "new_str": {"type": "string", "description": "The replacement string."},
                },
                "required": ["path", "old_str", "new_str"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read and return the content of a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative or absolute file path."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_path",
            "description": "Permanently delete a file OR directory (and all its contents) from disk.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative or absolute path to delete."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rename_file",
            "description": "Rename or move a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "old_path": {"type": "string", "description": "Current file path."},
                    "new_path": {"type": "string", "description": "New file path."},
                },
                "required": ["old_path", "new_path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_directory",
            "description": "Create a directory (and any missing parents).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path to create."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List files in a directory within the repo.",
            "parameters": {
                "type": "object",
                "properties": {
                    "directory": {
                        "type": "string",
                        "description": "Directory path (optional, defaults to repo root).",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_terminal_command",
            "description": "Run a Windows shell command in the project directory. Use this for generic tasks like moving files (move), copying (copy), running scripts (python), or using git.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The command line string to execute."},
                },
                "required": ["command"],
            },
        },
    },
]
