from __future__ import annotations

import argparse
import json
import os
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.responses import StreamingResponse

from gpt_tui.desktop_api.session import DesktopSessionService


service = DesktopSessionService()
app = FastAPI(title="gpt-tui desktop api", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConfigUpdatePayload(BaseModel):
    model: str | None = None
    repoRoot: str | None = None
    apiKey: str | None = None
    promptPreset: str | None = None
    toolSafetyMode: str | None = None


class ActivateChatPayload(BaseModel):
    chatId: str
    repoRoot: str | None = None


class RepoRootPayload(BaseModel):
    repoRoot: str | None = None


class SendMessagePayload(BaseModel):
    message: str
    chatId: str | None = None
    repoRoot: str | None = None
    model: str | None = None
    promptPreset: str | None = None
    toolSafetyMode: str | None = None


def _http_error(error: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(error))


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/status")
def status() -> dict[str, Any]:
    return service.snapshot()


@app.get("/api/chats")
def list_chats(repoRoot: str | None = None) -> dict[str, Any]:
    try:
        return {"chats": service.list_chats(repoRoot)}
    except Exception as error:  # noqa: BLE001
        raise _http_error(error) from error


@app.post("/api/config")
def update_config(payload: ConfigUpdatePayload) -> dict[str, Any]:
    try:
        return service.update_config(
            model=payload.model,
            repo_root=payload.repoRoot,
            api_key=payload.apiKey,
            prompt_preset=payload.promptPreset,
            tool_safety_mode=payload.toolSafetyMode,
        )
    except Exception as error:  # noqa: BLE001
        raise _http_error(error) from error


@app.post("/api/chats/new")
def new_chat(payload: RepoRootPayload) -> dict[str, Any]:
    try:
        return service.new_chat(repo_root=payload.repoRoot)
    except Exception as error:  # noqa: BLE001
        raise _http_error(error) from error


@app.post("/api/chats/activate")
def activate_chat(payload: ActivateChatPayload) -> dict[str, Any]:
    try:
        return service.activate_chat(payload.chatId, repo_root=payload.repoRoot)
    except Exception as error:  # noqa: BLE001
        raise _http_error(error) from error


@app.post("/api/chats/delete")
def delete_chat(payload: ActivateChatPayload) -> dict[str, Any]:
    try:
        return service.delete_chat(payload.chatId, repo_root=payload.repoRoot)
    except Exception as error:  # noqa: BLE001
        raise _http_error(error) from error


@app.post("/api/chat/send")
def send_message(payload: SendMessagePayload) -> dict[str, Any]:
    try:
        return service.send_message(
            payload.message,
            chat_id=payload.chatId,
            repo_root=payload.repoRoot,
            model=payload.model,
            prompt_preset=payload.promptPreset,
            tool_safety_mode=payload.toolSafetyMode,
        )
    except Exception as error:  # noqa: BLE001
        raise _http_error(error) from error


@app.post("/api/chat/send-stream")
def send_message_stream(payload: SendMessagePayload) -> StreamingResponse:
    def stream() -> Any:
        try:
            for event in service.send_message_events(
                payload.message,
                chat_id=payload.chatId,
                repo_root=payload.repoRoot,
                model=payload.model,
                prompt_preset=payload.promptPreset,
                tool_safety_mode=payload.toolSafetyMode,
            ):
                yield json.dumps(event, ensure_ascii=False) + "\n"
        except Exception as error:  # noqa: BLE001
            yield json.dumps({"type": "error", "message": str(error)}, ensure_ascii=False) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.get("/api/file")
def read_file(path: str) -> dict[str, Any]:
    try:
        return service.read_file(path)
    except Exception as error:  # noqa: BLE001
        raise _http_error(error) from error


def main() -> None:
    parser = argparse.ArgumentParser(description="gpt-tui desktop backend")
    parser.add_argument(
        "--host",
        default=os.getenv("GPT_TUI_BACKEND_HOST", "127.0.0.1"),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("GPT_TUI_BACKEND_PORT", "8765")),
    )
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
