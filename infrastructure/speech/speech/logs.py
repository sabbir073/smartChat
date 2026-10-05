"""
JSON-lines logging: one object per line on stdout, the way the other services log, so the
compose log driver and whatever reads it later never have to parse prose. Extra fields are
passed as `extra={"event": ..., ...}` and land as top-level keys.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from typing import Any

_STANDARD = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime", "taskName"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _STANDARD and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


class _DenialIsNotAnError(logging.Filter):
    """
    uvicorn's websockets-sansio protocol logs "ASGI callable returned without completing
    handshake" after the app refuses a WebSocket with an HTTP denial response (our 401/503 at
    the handshake), although the response was delivered. The refusal is already logged by us.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        return "without completing handshake" not in record.getMessage()


def configure(level: str = "info") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    # uvicorn's own access log is prose and duplicates what we log per request.
    for name in ("uvicorn.access",):
        logging.getLogger(name).disabled = True
    for name in ("uvicorn", "uvicorn.error", "speechbrain", "torch", "httpx"):
        logging.getLogger(name).setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").addFilter(_DenialIsNotAnError())


def get(name: str) -> logging.Logger:
    return logging.getLogger(name)
