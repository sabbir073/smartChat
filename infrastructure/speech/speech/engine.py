"""
The models, loaded once, and the recognition policy that uses them.

`Engine.load()` is called in a background thread at startup so `/health` can report 503 while
the weights come in (about 15 s and 2.5 GB of RSS), and it refuses to finish without every
required model: a sidecar that answers with half its voices is worse than one that restarts.

`recognise()` is the one place the language policy lives, shared by the WebSocket sessions and
the one-shot transcribe endpoint:

    forced language   -> that recogniser only, no LID
    auto              -> LID and the sticky language's recogniser in parallel; if LID puts the
                         other language at >= 0.80 on an utterance of >= 1 s, decode again with
                         the other recogniser and make that language sticky

All model calls run on one bounded ThreadPoolExecutor (SPEECH_THREADS workers), never on the
event loop.
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from speech import logs
from speech.audio import STT_SAMPLE_RATE, duration_ms
from speech.config import LANGUAGES, Settings
from speech.layout import ModelPaths
from speech.lid import LanguageIdentifier, LidResult
from speech.stt import ModelLoadError, Recogniser, Transcript, load_bengali, load_english, load_omnilingual
from speech.tts import TtsEngine, load_voices
from speech.vad import SileroVad

log = logs.get("speech.engine")

SWITCH_CONFIDENCE = 0.80
SWITCH_MIN_MS = 1000


@dataclass(frozen=True)
class Recognition:
    text: str
    language: str
    language_confidence: float
    lid: dict[str, float]
    lid_skipped: bool
    model: str
    duration_ms: int
    latency_ms: int
    timings: dict[str, int] = field(default_factory=dict)
    switched: bool = False


def rss_mb() -> int:
    try:
        import psutil

        return int(psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024))
    except (ImportError, OSError):
        return -1


class Engine:
    def __init__(self, settings: Settings, on_fatal: Callable[[str], None] | None = None) -> None:
        self.settings = settings
        self.paths = ModelPaths(settings.models_dir)
        self.executor = ThreadPoolExecutor(max_workers=settings.threads, thread_name_prefix="infer")
        self.vad: SileroVad | None = None
        self.stt: dict[str, Recogniser] = {}
        self.fallback: Recogniser | None = None
        self.lid: LanguageIdentifier | None = None
        self.tts: TtsEngine | None = None
        self.load_error: str | None = None
        self.load_seconds: float | None = None
        self.rss_after_load_mb: int | None = None
        self._loading = False
        self._ready = False
        self._on_fatal = on_fatal
        self.sessions = 0
        self._lock = threading.Lock()

    # --- lifecycle ---

    @property
    def ready(self) -> bool:
        # Set at the very end of load(), after the warm-up, so a health check during the last
        # seconds of loading does not send traffic to models that are still being primed.
        return self._ready

    def start_loading(self) -> threading.Thread:
        thread = threading.Thread(target=self._load_guarded, name="model-loader", daemon=True)
        thread.start()
        return thread

    def _load_guarded(self) -> None:
        try:
            self.load()
        except ModelLoadError as error:
            self.load_error = str(error)
            log.error("model loading failed", extra={"event": "load_failed", "error": str(error)})
            if self._on_fatal:
                self._on_fatal(str(error))
        except Exception as error:  # noqa: BLE001 - anything else here is still fatal, and must be visible
            self.load_error = f"{type(error).__name__}: {error}"
            log.exception("model loading crashed", extra={"event": "load_failed"})
            if self._on_fatal:
                self._on_fatal(self.load_error)

    def load(self) -> None:
        self._loading = True
        settings, paths = self.settings, self.paths
        started = time.monotonic()
        if not paths.root.exists():
            raise ModelLoadError(f"models directory {paths.root} does not exist (run download_models.py)")

        step = time.monotonic()
        self.vad = SileroVad(paths.vad, threads=1)
        log.info("vad loaded", extra={"event": "model_loaded", "model": "silero-vad", "version": self.vad.version, "ms": int((time.monotonic() - step) * 1000)})

        step = time.monotonic()
        self.stt["en"] = load_english(paths, settings)
        log.info("stt_en loaded", extra={"event": "model_loaded", "model": self.stt["en"].name, "ms": int((time.monotonic() - step) * 1000), "rss_mb": rss_mb()})

        if settings.stt_fallback == "omnilingual":
            step = time.monotonic()
            self.fallback = load_omnilingual(paths, settings)
            log.info("stt_fallback loaded", extra={"event": "model_loaded", "model": self.fallback.name, "ms": int((time.monotonic() - step) * 1000), "rss_mb": rss_mb()})

        step = time.monotonic()
        try:
            self.stt["bn"] = load_bengali(paths, settings)
        except ModelLoadError as error:
            if self.fallback is None:
                raise
            log.warning("bengali model unavailable, using the fallback", extra={"event": "model_fallback", "error": str(error)})
            self.stt["bn"] = self.fallback
        log.info("stt_bn loaded", extra={"event": "model_loaded", "model": self.stt["bn"].name, "ms": int((time.monotonic() - step) * 1000), "rss_mb": rss_mb()})

        step = time.monotonic()
        self.lid = LanguageIdentifier(paths.lid_dir, threads=settings.lid_threads)
        log.info("lid loaded", extra={"event": "model_loaded", "model": "voxlingua107-ecapa", "ms": int((time.monotonic() - step) * 1000), "rss_mb": rss_mb()})

        step = time.monotonic()
        self.tts = TtsEngine(load_voices(paths, settings))
        log.info("tts loaded", extra={"event": "model_loaded", "model": ",".join(self.tts.voices), "ms": int((time.monotonic() - step) * 1000), "rss_mb": rss_mb()})

        # One warm-up pass per model on a few seconds of noise: the first call at a given length
        # pays for lazy allocations and graph optimisation (measured: a cold 7 s decode took
        # almost twice as long as a warm one), and it should not be the first caller who pays.
        warm = (np.random.default_rng(0).standard_normal(6 * STT_SAMPLE_RATE) * 0.01).astype(np.float32)
        for recogniser in self.stt.values():
            recogniser.transcribe(warm)
        self.lid.identify(warm)

        self.load_seconds = round(time.monotonic() - started, 2)
        self.rss_after_load_mb = rss_mb()
        self._loading = False
        self._ready = True
        log.info("models ready", extra={"event": "ready", "seconds": self.load_seconds, "rss_mb": self.rss_after_load_mb, "threads": settings.threads})

    def shutdown(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=True)

    # --- health ---

    def health(self) -> tuple[int, dict[str, Any]]:
        models: dict[str, Any] = {
            "vad": self.vad is not None,
            "stt_bn": "bn" in self.stt,
            "stt_en": "en" in self.stt,
            "lid": self.lid is not None,
            "tts": list(self.tts.voices) if self.tts else [],
        }
        payload: dict[str, Any] = {"status": "ok" if self.ready else "loading", "models": models, "threads": self.settings.threads}
        if self.ready:
            payload["sessions"] = self.sessions
            payload["maxSessions"] = self.settings.max_sessions
            payload["rssMb"] = rss_mb()
            payload["loadSeconds"] = self.load_seconds
            if self.fallback is not None:
                payload["models"]["stt_fallback"] = self.fallback.name
            return 200, payload
        missing = [name for name, present in models.items() if not present]
        payload["missing"] = missing
        if self.load_error:
            payload["status"] = "error"
            payload["error"] = self.load_error
        return 503, payload

    # --- sessions ---

    def acquire_session(self) -> bool:
        with self._lock:
            if self.sessions >= self.settings.max_sessions:
                return False
            self.sessions += 1
            return True

    def release_session(self) -> None:
        with self._lock:
            self.sessions = max(0, self.sessions - 1)

    # --- recognition policy ---

    async def recognise(self, audio: np.ndarray, mode: str, sticky: str) -> Recognition:
        """
        `mode` is "auto", "bn" or "en"; `sticky` the language assumed until LID says otherwise.
        `audio` is 16 kHz float32. Returns the transcript and, through `language`, the language
        that should become sticky.
        """
        if not self.ready:
            raise RuntimeError("models are not loaded")
        loop = asyncio.get_running_loop()
        started = time.monotonic()
        length_ms = duration_ms(audio, STT_SAMPLE_RATE)
        timings: dict[str, int] = {}

        if mode in LANGUAGES:
            transcript: Transcript = await loop.run_in_executor(self.executor, self.stt[mode].transcribe, audio)
            timings["stt_ms"] = transcript.decode_ms
            return Recognition(
                text=transcript.text,
                language=mode,
                language_confidence=1.0,
                lid={lang: (1.0 if lang == mode else 0.0) for lang in LANGUAGES},
                lid_skipped=True,
                model=transcript.model,
                duration_ms=length_ms,
                latency_ms=int((time.monotonic() - started) * 1000),
                timings=timings,
            )

        assert self.lid is not None
        lid_future = loop.run_in_executor(self.executor, self.lid.identify, audio)
        stt_future = loop.run_in_executor(self.executor, self.stt[sticky].transcribe, audio)
        # LID usually finishes first; when it calls for the other language, that decode starts
        # at once rather than after the sticky decode it is going to replace.
        lid_result: LidResult = await lid_future
        timings["lid_ms"] = lid_result.ms
        chosen = sticky
        switched = False
        other = "en" if sticky == "bn" else "bn"
        if lid_result.language == other and lid_result.confidence >= SWITCH_CONFIDENCE and length_ms >= SWITCH_MIN_MS:
            chosen = other
            switched = True
            other_future = loop.run_in_executor(self.executor, self.stt[other].transcribe, audio)
            discarded, transcript = await asyncio.gather(stt_future, other_future)
            timings["stt_ms"] = discarded.decode_ms
            timings["switch_stt_ms"] = transcript.decode_ms
        else:
            transcript = await stt_future
            timings["stt_ms"] = transcript.decode_ms
        return Recognition(
            text=transcript.text,
            language=chosen,
            language_confidence=lid_result.probabilities.get(chosen, 0.5),
            lid=dict(lid_result.probabilities),
            lid_skipped=False,
            model=transcript.model,
            duration_ms=length_ms,
            latency_ms=int((time.monotonic() - started) * 1000),
            timings=timings,
            switched=switched,
        )
