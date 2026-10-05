"""
Shared fixtures. The unit tests need no models; the `models` tests need SPEECH_MODELS_DIR
populated by download_models.py and the test clips (SPEECH_TEST_ASSETS, default
/home/claude/speech-assets/bn_test), and are skipped otherwise.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from speech.config import Settings  # noqa: E402
from speech.engine import Engine, Recognition  # noqa: E402
from speech.layout import ModelPaths  # noqa: E402
from speech.vad import VadState  # noqa: E402

ASSETS = Path(os.environ.get("SPEECH_TEST_ASSETS", "/home/claude/speech-assets/bn_test"))
TOKEN = "integration-token"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def _models_present() -> tuple[bool, str]:
    raw = os.environ.get("SPEECH_MODELS_DIR")
    if not raw:
        return False, "SPEECH_MODELS_DIR is not set"
    paths = ModelPaths(Path(raw))
    required = [
        paths.vad,
        paths.stt_en_dir / "encoder.int8.onnx",
        paths.stt_bn_dir / "model.onnx",
        paths.lid_dir / "hyperparams.yaml",
        paths.coqui_bn_dir / "model.onnx",
        paths.kokoro_dir("fp32") / "model.onnx",
    ]
    missing = [str(p) for p in required if not p.exists()]
    if missing:
        return False, f"models missing: {missing[0]}"
    if not (ASSETS / "cv_31549899.wav").exists():
        return False, f"test clips missing in {ASSETS}"
    return True, ""


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    present, reason = _models_present()
    if present:
        return
    skip = pytest.mark.skip(reason=f"models tests skipped: {reason}")
    for item in items:
        if "models" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
def settings(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Settings:
    monkeypatch.setenv("SPEECH_MODELS_DIR", str(tmp_path))
    monkeypatch.delenv("SPEECH_TOKEN", raising=False)
    monkeypatch.setenv("SPEECH_THREADS", "2")
    monkeypatch.setenv("SPEECH_MAX_SESSIONS", "2")
    return Settings.from_env()


class FakeVad:
    """Speech is whatever is loud: the protocol tests send tones for speech and zeros for silence."""

    version = 0

    def new_state(self) -> VadState:
        return VadState()

    def probability(self, state: VadState, window: np.ndarray) -> float:
        return 1.0 if float(np.max(np.abs(window))) > 0.05 else 0.0


class FakeEngine:
    """Enough of `Engine` for the WebSocket session and the HTTP routes, with no models."""

    def __init__(self, text: str = "hello there") -> None:
        self.vad = FakeVad()
        self.executor = ThreadPoolExecutor(max_workers=2)
        self.ready = True
        self.text = text
        self.tts = None
        self.calls: list[dict[str, Any]] = []
        self.sessions = 0
        self.max_sessions = 2
        self.lid_language = "bn"
        self.lid_confidence = 0.97
        self.delay_s = 0.0

    async def recognise(self, audio: np.ndarray, mode: str, sticky: str) -> Recognition:
        import asyncio

        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        self.calls.append({"samples": int(audio.size), "mode": mode, "sticky": sticky})
        if mode in ("bn", "en"):
            language, skipped = mode, True
            lid = {"bn": 1.0 if mode == "bn" else 0.0, "en": 1.0 if mode == "en" else 0.0}
        else:
            skipped = False
            other = self.lid_language
            lid = {other: self.lid_confidence, ("en" if other == "bn" else "bn"): round(1 - self.lid_confidence, 4)}
            language = other if (other != sticky and self.lid_confidence >= 0.8 and audio.size >= 16000) else sticky
        return Recognition(
            text=self.text,
            language=language,
            language_confidence=lid[language],
            lid=lid,
            lid_skipped=skipped,
            model="fake",
            duration_ms=int(1000 * audio.size / 16000),
            latency_ms=1,
            timings={},
            switched=language != sticky,
        )

    def acquire_session(self) -> bool:
        if self.sessions >= self.max_sessions:
            return False
        self.sessions += 1
        return True

    def release_session(self) -> None:
        self.sessions = max(0, self.sessions - 1)

    def health(self) -> tuple[int, dict[str, Any]]:
        if not self.ready:
            return 503, {"status": "loading", "models": {"vad": False}, "threads": 2, "missing": ["vad"]}
        return 200, {"status": "ok", "models": {"vad": True, "stt_bn": True, "stt_en": True, "lid": True, "tts": []}, "threads": 2}


@pytest.fixture
def fake_engine() -> FakeEngine:
    return FakeEngine()


def tone(ms: int, rate: int = 16000, amplitude: float = 0.3, frequency: float = 220.0) -> np.ndarray:
    t = np.arange(int(rate * ms / 1000)) / rate
    return (amplitude * np.sin(2 * np.pi * frequency * t)).astype(np.float32)


def pcm16(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


def frames(data: bytes, frame_ms: int, rate: int) -> list[bytes]:
    size = int(rate * frame_ms / 1000) * 2
    return [data[i : i + size] for i in range(0, len(data), size)]


@dataclass
class Live:
    base: str
    ws: str
    engine: Engine


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="session")
def live() -> Iterator[Live]:
    """A real uvicorn server with the real models, started once for every `models` test."""
    import httpx
    import uvicorn

    from speech.memory import configure as configure_memory
    from speech.server import create_app

    os.environ["SPEECH_TOKEN"] = TOKEN
    os.environ.setdefault("SPEECH_THREADS", "4")
    settings = Settings.from_env()
    configure_memory(trim=settings.heap_trim)
    engine = Engine(settings)
    engine.load()
    port = _free_port()
    app = create_app(settings, engine=engine, autoload=False)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", ws="websockets-sansio"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            if httpx.get(f"{base}/health", timeout=2).status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    else:
        raise RuntimeError("server did not come up")
    yield Live(base=base, ws=f"ws://127.0.0.1:{port}", engine=engine)
    server.should_exit = True
    thread.join(timeout=10)
