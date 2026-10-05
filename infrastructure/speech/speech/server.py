"""
The speech sidecar's HTTP/WebSocket surface.

    GET  /health            readiness and the loaded models (503 while loading)
    GET  /v1/voices         the TTS voices
    WS   /v1/listen         live audio in, VAD events and transcripts out (speech/session.py)
    POST /v1/tts            text in, chunked PCM16 out, sentence by sentence
    POST /v1/tts/info       the same request's sentences and total duration, no audio
    POST /v1/transcribe     one WAV in, one transcript out (tests and tools)

Every request must carry `Authorization: Bearer <SPEECH_TOKEN>` when the token is set. Model
work never runs on the event loop: the engine's executor does it, and this module only moves
bytes between the socket and the executor. Errors reach the client as short messages, never as
tracebacks.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Query, Request, WebSocket
from fastapi.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, Field, ValidationError
from starlette.websockets import WebSocketDisconnect

from speech import __version__, logs
from speech.audio import STT_SAMPLE_RATE, SUPPORTED_OUTPUT_RATES, decode_wav, float_to_pcm16, to_stt_rate
from speech.config import LANGUAGES, Settings
from speech.engine import Engine
from speech.session import EngineLike, ListenSession
from speech.tts import MAX_TEXT_CHARS, RenderStats, TtsError

log = logs.get("speech.server")

MAX_TRANSCRIBE_BYTES = 32 * 1024 * 1024
MAX_TRANSCRIBE_SECONDS = 600
MAX_JSON_BYTES = 64 * 1024


class TtsRequest(BaseModel):
    text: str = Field(min_length=0, max_length=MAX_TEXT_CHARS)
    language: str = Field(pattern="^(bn|en)$")
    voice: str | None = Field(default=None, max_length=32)
    speakerId: int = Field(default=0, ge=0, le=10_000)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    sampleRate: int = Field(default=24_000)


def _bad_request(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def _authorised(settings: Settings, authorization: str | None) -> bool:
    if not settings.token:
        return True
    if not authorization:
        return False
    scheme, _, credential = authorization.partition(" ")
    return scheme.lower() == "bearer" and secrets.compare_digest(credential.strip(), settings.token)


def create_app(settings: Settings, engine: EngineLike | None = None, autoload: bool = True) -> FastAPI:
    """
    The application. `engine` may be a preloaded or fake engine (tests); with the default, a real
    engine is built and its models load in a background thread when the server starts.
    """
    real_engine: Engine | None = None
    if engine is None:
        real_engine = Engine(settings, on_fatal=_exit_on_fatal)
        engine = real_engine

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if real_engine is not None and autoload:
            real_engine.start_loading()
        log.info("listening", extra={"event": "listening", "port": settings.port, "threads": settings.threads, "maxSessions": settings.max_sessions, "version": __version__})
        try:
            yield
        finally:
            if real_engine is not None:
                real_engine.shutdown()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.engine = engine
    app.state.settings = settings

    @app.middleware("http")
    async def authenticate(request: Request, call_next: Any) -> Response:
        if request.url.path != "/health" and not _authorised(settings, request.headers.get("authorization")):
            return _bad_request("unauthorised", 401)
        return await call_next(request)

    # --- health & voices ---

    @app.get("/health")
    async def health() -> JSONResponse:
        status, payload = _health(engine)
        return JSONResponse(payload, status_code=status)

    @app.get("/v1/voices")
    async def voices() -> JSONResponse:
        tts = getattr(engine, "tts", None)
        if tts is None:
            return _bad_request("models are loading", 503)
        return JSONResponse(
            {
                "voices": [
                    {"id": info.id, "language": info.language, "name": info.name, "speakers": info.speakers, "sampleRate": info.sample_rate, "engine": info.engine, "licence": info.licence}
                    for info in tts.infos()
                ]
            }
        )

    # --- text to speech ---

    async def _parse_tts(request: Request) -> TtsRequest | JSONResponse:
        raw = await request.body()
        if len(raw) > MAX_JSON_BYTES:
            return _bad_request("body too large", 413)
        try:
            return TtsRequest.model_validate_json(raw or b"{}")
        except ValidationError as error:
            first = error.errors()[0] if error.errors() else {}
            return _bad_request(f"invalid request: {'.'.join(str(p) for p in first.get('loc', ()))}: {first.get('msg', 'bad value')}")

    @app.post("/v1/tts")
    async def tts(request: Request) -> Response:
        parsed = await _parse_tts(request)
        if isinstance(parsed, JSONResponse):
            return parsed
        tts_engine = getattr(engine, "tts", None)
        if tts_engine is None:
            return _bad_request("models are loading", 503)
        if parsed.sampleRate not in SUPPORTED_OUTPUT_RATES:
            return _bad_request(f"sampleRate must be one of {list(SUPPORTED_OUTPUT_RATES)}")
        try:
            plan = tts_engine.plan(parsed.text, parsed.language, parsed.voice, parsed.speakerId, parsed.speed, parsed.sampleRate)
        except TtsError as error:
            return _bad_request(str(error))

        headers = {
            "X-Sample-Rate": str(plan.sample_rate),
            "X-Voice": plan.voice,
            "X-Cache": "hit" if plan.cached else "miss",
            "X-Sentences": str(len(plan.sentences)),
            "Cache-Control": "no-store",
        }
        if plan.cached:
            total = tts_engine.cached_duration_ms(plan)
            if total is not None:
                headers["X-Duration-Ms"] = str(total)
        if not plan.sentences:
            headers["X-Duration-Ms"] = "0"
            return Response(b"", media_type="audio/pcm", headers=headers)

        loop = asyncio.get_running_loop()
        stats = RenderStats()
        started = time.monotonic()

        async def stream() -> AsyncIterator[bytes]:
            first_chunk_ms: int | None = None
            try:
                for index, sentence in enumerate(plan.sentences):
                    audio = await loop.run_in_executor(engine.executor, tts_engine.render_sentence, sentence, plan.sample_rate, index == 0, stats)
                    if first_chunk_ms is None:
                        first_chunk_ms = int((time.monotonic() - started) * 1000)
                    yield float_to_pcm16(audio)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the status is already on the wire; log and stop the stream
                log.exception("tts failed mid-stream", extra={"event": "tts_error", "voice": plan.voice})
            finally:
                log.info(
                    "tts",
                    extra={
                        "event": "tts",
                        "language": plan.language,
                        "voice": plan.voice,
                        "speaker": plan.speaker,
                        "speed": plan.speed,
                        "sampleRate": plan.sample_rate,
                        "chars": len(parsed.text),
                        "sentences": len(plan.sentences),
                        "cache": "hit" if plan.cached else "miss",
                        "cachedUnits": stats.cached_units,
                        "renderedUnits": stats.rendered_units,
                        "audioMs": stats.audio_ms,
                        "synthMs": stats.synth_ms,
                        "firstChunkMs": first_chunk_ms,
                        "totalMs": int((time.monotonic() - started) * 1000),
                    },
                )

        return StreamingResponse(stream(), media_type="audio/pcm", headers=headers)

    @app.post("/v1/tts/info")
    async def tts_info(request: Request) -> Response:
        parsed = await _parse_tts(request)
        if isinstance(parsed, JSONResponse):
            return parsed
        tts_engine = getattr(engine, "tts", None)
        if tts_engine is None:
            return _bad_request("models are loading", 503)
        if parsed.sampleRate not in SUPPORTED_OUTPUT_RATES:
            return _bad_request(f"sampleRate must be one of {list(SUPPORTED_OUTPUT_RATES)}")
        try:
            plan = tts_engine.plan(parsed.text, parsed.language, parsed.voice, parsed.speakerId, parsed.speed, parsed.sampleRate)
        except TtsError as error:
            return _bad_request(str(error))
        loop = asyncio.get_running_loop()
        stats = RenderStats()
        total_ms = 0
        started = time.monotonic()
        try:
            for index, sentence in enumerate(plan.sentences):
                audio = await loop.run_in_executor(engine.executor, tts_engine.render_sentence, sentence, plan.sample_rate, index == 0, stats)
                total_ms += int(1000 * audio.size / plan.sample_rate)
        except Exception:  # noqa: BLE001 - reported as a 500 with a plain message
            log.exception("tts info failed", extra={"event": "tts_error", "voice": plan.voice})
            return _bad_request("synthesis failed", 500)
        return JSONResponse(
            {
                "sentences": [sentence.text for sentence in plan.sentences],
                "units": [[{"voice": unit.voice, "language": unit.language, "text": unit.text} for unit in sentence.units] for sentence in plan.sentences],
                "durationMs": total_ms,
                "cache": "hit" if plan.cached else "miss",
                "voice": plan.voice,
                "sampleRate": plan.sample_rate,
                "synthMs": stats.synth_ms,
                "elapsedMs": int((time.monotonic() - started) * 1000),
            }
        )

    # --- one-shot transcription ---

    @app.post("/v1/transcribe")
    async def transcribe(
        request: Request,
        language: str = Query(default="auto"),
        sticky: str | None = Query(default=None),
    ) -> JSONResponse:
        if not getattr(engine, "ready", False):
            return _bad_request("models are loading", 503)
        if language not in ("auto", *LANGUAGES):
            return _bad_request("language must be auto, bn or en")
        sticky = sticky or settings.default_language
        if sticky not in LANGUAGES:
            return _bad_request("sticky must be bn or en")
        if language in LANGUAGES:
            sticky = language
        content_type = request.headers.get("content-type", "")
        if content_type.startswith("multipart/form-data"):
            form = await request.form(max_files=2, max_fields=4)
            upload = form.get("file") or form.get("audio")
            if upload is None or isinstance(upload, str):
                return _bad_request("multipart body needs a 'file' part")
            raw = await upload.read()
        else:
            raw = await request.body()
        if len(raw) > MAX_TRANSCRIBE_BYTES:
            return _bad_request("audio too large", 413)
        if not raw:
            return _bad_request("empty body")
        try:
            samples, rate = await asyncio.get_running_loop().run_in_executor(engine.executor, decode_wav, raw)
        except (RuntimeError, ValueError, TypeError):
            return _bad_request("body is not a readable audio file")
        if samples.size > MAX_TRANSCRIBE_SECONDS * rate:
            return _bad_request(f"audio longer than {MAX_TRANSCRIBE_SECONDS} s", 413)
        if rate != STT_SAMPLE_RATE:
            samples = await asyncio.get_running_loop().run_in_executor(engine.executor, to_stt_rate, samples, rate)
        result = await engine.recognise(samples, language, sticky)
        log.info(
            "transcribe",
            extra={
                "event": "transcribe",
                "language": result.language,
                "lid": result.lid,
                "model": result.model,
                "durationMs": result.duration_ms,
                "latencyMs": result.latency_ms,
                "timings": result.timings,
                "chars": len(result.text),
            },
        )
        return JSONResponse(
            {
                "text": result.text,
                "language": result.language,
                "languageConfidence": result.language_confidence,
                "lid": result.lid,
                "durationMs": result.duration_ms,
                "latencyMs": result.latency_ms,
                "model": result.model,
            }
        )

    # --- live listening ---

    @app.websocket("/v1/listen")
    async def listen(websocket: WebSocket) -> None:
        if not _authorised(settings, websocket.headers.get("authorization")):
            await _deny(websocket, 401, "unauthorised")
            return
        if not getattr(engine, "ready", False):
            await _deny(websocket, 503, "models are loading")
            return
        if not engine.acquire_session():
            await _deny(websocket, 503, "too many sessions")
            return
        session_id = secrets.token_hex(4)
        try:
            await websocket.accept()
            await ListenSession(websocket, engine, settings, session_id).run()
        except WebSocketDisconnect:
            pass
        finally:
            engine.release_session()

    return app


def _health(engine: Any) -> tuple[int, dict[str, Any]]:
    if hasattr(engine, "health"):
        return engine.health()
    return 200, {"status": "ok", "models": {}, "threads": 0}


async def _deny(websocket: WebSocket, status: int, message: str) -> None:
    """Refuse a WebSocket at the handshake with a real HTTP status when the server allows it."""
    log.warning("websocket refused", extra={"event": "listen_refused", "status": status, "reason": message})
    try:
        await websocket.send_denial_response(PlainTextResponse(json.dumps({"error": message}), status_code=status, media_type="application/json"))
    except RuntimeError:
        # The ASGI server lacks the denial extension: a plain close (HTTP 403 to the client).
        await websocket.close(code=1008, reason=message)


def _exit_on_fatal(error: str) -> None:
    """Loading failed: say so and stop the process, so the orchestrator restarts it and the log
    shows why rather than a server that answers 503 for ever."""
    print(json.dumps({"level": "fatal", "event": "fatal", "msg": f"speech: cannot start: {error}"}), file=sys.stderr, flush=True)
    sys.stdout.flush()
    threading.Timer(0.5, lambda: os._exit(1)).start()


def main() -> None:
    import uvicorn

    try:
        settings = Settings.from_env()
    except ValueError as error:
        print(f"speech: bad configuration: {error}", file=sys.stderr)
        sys.exit(2)
    logs.configure(settings.log_level)
    app = create_app(settings)
    uvicorn.run(app, host="0.0.0.0", port=settings.port, log_level="warning", access_log=False, ws="websockets-sansio", ws_max_size=4 * 1024 * 1024, timeout_keep_alive=30)


if __name__ == "__main__":
    main()
