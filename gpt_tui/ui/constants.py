"""
constants.py â€” All static data: branding, model lists, tool schemas, limits.
No Textual imports here â€” this file must be importable anywhere.
"""
from __future__ import annotations

from typing import Any

# â”€â”€â”€ Branding â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
APP_NAME = "GPT TUI"
VERSION = "0.2.0"

WELCOME_ART = r"""[bold #ff6b6b]
   â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•— â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•— â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—  â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—â–ˆâ–ˆâ•—   â–ˆâ–ˆâ•—â–ˆâ–ˆâ•—
  â–ˆâ–ˆâ•”â•â•â•â•â• â–ˆâ–ˆâ•”â•â•â–ˆâ–ˆâ•—â•šâ•â•â–ˆâ–ˆâ•”â•â•â•  â•šâ•â•â–ˆâ–ˆâ•”â•â•â•â–ˆâ–ˆâ•‘   â–ˆâ–ˆâ•‘â–ˆâ–ˆâ•‘
  â–ˆâ–ˆâ•‘  â–ˆâ–ˆâ–ˆâ•—â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•”â•   â–ˆâ–ˆâ•‘        â–ˆâ–ˆâ•‘   â–ˆâ–ˆâ•‘   â–ˆâ–ˆâ•‘â–ˆâ–ˆâ•‘
  â–ˆâ–ˆâ•‘   â–ˆâ–ˆâ•‘â–ˆâ–ˆâ•”â•â•â•â•    â–ˆâ–ˆâ•‘        â–ˆâ–ˆâ•‘   â–ˆâ–ˆâ•‘   â–ˆâ–ˆâ•‘â–ˆâ–ˆâ•‘
  â•šâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•”â•â–ˆâ–ˆâ•‘        â–ˆâ–ˆâ•‘        â–ˆâ–ˆâ•‘   â•šâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•”â•â–ˆâ–ˆâ•‘
   â•šâ•â•â•â•â•â• â•šâ•â•        â•šâ•â•        â•šâ•â•    â•šâ•â•â•â•â•â• â•šâ•â•[/]
"""

WELCOME_MSG = (
    f"[dim #7a8a9e]v{VERSION}[/]  Â·  "
    "[dim #7a8a9e]Windows-first coding assistant[/]  Â·  "
    "[dim #7a8a9e]Gemini + Groq + Codex[/]\n"
    "[dim #536374]â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€[/]\n"
    f"[dim #7a8a9e]Shift + Mouse to select text[/]  Â·  "
    "[dim #7a8a9e]Ctrl+G[/] [dim]copy last reply[/]\n"
    "[dim #536374]â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€[/]\n"
    "[#7a8a9e]Ctrl+K[/] [dim]API keys[/]  â”‚  "
    "[#7a8a9e]Ctrl+T[/] [dim]switch model[/]  â”‚  "
    "[#7a8a9e]/help[/] [dim]commands[/]  â”‚  "
    "[#7a8a9e]Ctrl+L[/] [dim]clear[/]"
)

# â”€â”€â”€ Model registry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
GEMINI_MODELS: list[tuple[str, str]] = [
    ("gemini-2.0-flash",              "Gemini 2.0 Flash       [free Â· fast]"),
    ("gemini-1.5-flash",              "Gemini 1.5 Flash       [free Â· fast]"),
    ("gemini-1.5-pro",                "Gemini 1.5 Pro         [free Â· smart Â· 50 req/day]"),
    ("gemini-2.0-flash-thinking-exp", "Gemini 2.0 Thinking    [free Â· reasoning]"),
]
GEMINI_CLI_MODELS: list[tuple[str, str]] = [
    ("gemini-cli:auto",             "Gemini CLI Auto       [terminal agent]"),
    ("gemini-cli:gemini-2.0-flash", "Gemini CLI 2.0 Flash  [stable]"),
    ("gemini-cli:gemini-1.5-flash", "Gemini CLI 1.5 Flash  [stable]"),
]

GROQ_MODELS: list[tuple[str, str]] = [
    ("llama-3.3-70b-versatile",        "Llama 3.3 70B          [free Â· fast]"),
    ("llama-3.1-8b-instant",           "Llama 3.1 8B           [free Â· fastest]"),
    ("deepseek-r1-distill-llama-70b",  "DeepSeek R1 70B        [free Â· reasoning]"),
    ("mixtral-8x7b-32768",             "Mixtral 8x7B           [free Â· long ctx]"),
]
CODEX_MODELS: list[tuple[str, str]] = [
    ("codex:gpt-5", "Codex GPT-5           [terminal agent]"),
]

DEFAULT_MODEL = "gemini-cli:gemini-2.0-flash"

# â”€â”€â”€ Context window â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Auto-summarization fires when total message chars exceed this.
# ~80K chars â‰ˆ 20K tokens â€” safely below all supported models.
CONTEXT_CHAR_LIMIT = 80_000

# How many recent messages to keep intact when summarizing
KEEP_RECENT_MESSAGES = 6

# Maximum turns of model <-> tool interaction before stopping
MAX_TOOL_ROUNDS = 8

# â”€â”€â”€ Tool schemas (OpenAI function-calling format) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
