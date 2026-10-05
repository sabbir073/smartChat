"""
One `/v1/listen` WebSocket: the live-audio protocol for a call leg.

    client  {"type":"start", ...}                 server  {"type":"ready"}
    client  binary PCM16 frames ...               server  {"type":"speech_start","t":ms}
                                                          {"type":"speech_cancel","t":ms}     (false alarm)
                                                          {"type":"speech_end","t":ms,"durationMs":n}
                                                          {"type":"transcript", ...}
    client  {"type":"mute"} / {"type":"unmute"} / {"type":"set","language":"bn"}
    client  {"type":"stop"}                       server  (remaining transcripts, then close)

Three tasks per session, all on the event loop: the receiver takes frames off the socket and
queues them (dropping audio, never control messages, once more than ten seconds are waiting);
the processor runs VAD on the executor and turns the probabilities into utterances; the
recogniser transcribes utterances one at a time, in order, so transcripts never overtake each
other even though the models run in parallel underneath. Nothing here blocks the loop: every
model call goes through the engine's executor.

Times (`t`) are milliseconds of audio since the first frame, from the sample clock rather than
the wall clock, so they line up with the stream the client sent and are reproducible in tests.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from speech import logs
from speech.audio import STT_SAMPLE_RATE, SUPPORTED_INPUT_RATES, StreamResampler, pcm16_to_float
from speech.config import LANGUAGES, Settings
from speech.engine import Recognition
from speech.vad import WINDOW, Endpointer, EndpointerConfig, SpeechCancel, SpeechEnd, SpeechStart, VadState

log = logs.get("speech.listen")

START_TIMEOUT_S = 10.0
MAX_QUEUED_MS = 10_000
MAX_FRAME_BYTES = 1 << 20


class VadLike(Protocol):
    def new_state(self) -> VadState: ...

    def probability(self, state: VadState, window: np.ndarray) -> float: ...


class EngineLike(Protocol):
    """What a session needs from the engine; the protocol tests supply a fake."""

    vad: VadLike | None
    executor: Any

    @property
    def ready(self) -> bool: ...

    async def recognise(self, audio: np.ndarray, mode: str, sticky: str) -> Recognition: ...


@dataclass(frozen=True)
class StartParams:
    sample_rate: int
    mode: str  # "auto", "bn" or "en"
    sticky: str
    endpointing: EndpointerConfig
    call_id: str

    @classmethod
    def parse(cls, message: dict[str, Any], settings: Settings) -> StartParams:
        def integer(name: str, default: int, low: int, high: int) -> int:
            value = message.get(name, default)
            if value is None:
                return default
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError(f"{name} must be a number")
            value = int(value)
            if not low <= value <= high:
                raise ValueError(f"{name} must be between {low} and {high}")
            return value

        sample_rate = integer("sampleRate", 16_000, 8_000, 96_000)
        if sample_rate not in SUPPORTED_INPUT_RATES:
            raise ValueError(f"sampleRate must be one of {list(SUPPORTED_INPUT_RATES)}")
        mode = message.get("language", "auto") or "auto"
        if mode not in ("auto", *LANGUAGES):
            raise ValueError("language must be auto, bn or en")
        sticky = message.get("sticky") or settings.default_language
        if sticky not in LANGUAGES:
            raise ValueError("sticky must be bn or en")
        if mode in LANGUAGES:
            sticky = mode
        call_id = message.get("callId") or ""
        if not isinstance(call_id, str):
            raise ValueError("callId must be a string")
        endpointing = EndpointerConfig(
            min_silence_ms=integer("minSilenceMs", 550, 100, 5_000),
            min_speech_ms=integer("minSpeechMs", 250, 32, 3_000),
            max_speech_ms=integer("maxSpeechMs", 30_000, 1_000, 120_000),
            prefix_padding_ms=integer("prefixPaddingMs", 300, 0, 2_000),
        )
        return cls(sample_rate=sample_rate, mode=mode, sticky=sticky, endpointing=endpointing, call_id=call_id[:128])


class ListenSession:
    def __init__(self, websocket: WebSocket, engine: EngineLike, settings: Settings, session_id: str) -> None:
        self.ws = websocket
        self.engine = engine
        self.settings = settings
        self.id = session_id
        self.params: StartParams | None = None
        self._send_lock = asyncio.Lock()
        self._queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        self._utterances: asyncio.Queue[tuple[SpeechEnd, float] | None] = asyncio.Queue()
        self._queued_ms = 0.0
        self._pending = np.zeros(0, dtype=np.float32)
        self._resampler: StreamResampler | None = None
        self._endpointer: Endpointer | None = None
        self._vad_state: VadState | None = None
        self._muted = False
        self._closed = False
        self.sticky = settings.default_language
        self.mode = "auto"
        # Counters for the session's closing log line.
        self.frames = 0
        self.dropped_frames = 0
        self.utterances = 0
        self.started_at = time.monotonic()

    # --- entry point ---

    async def run(self) -> None:
        try:
            await self._handshake()
        except (ValueError, json.JSONDecodeError) as error:
            await self._send({"type": "error", "message": f"bad start message: {error}"})
            await self._close(1008, "bad start")
            return
        except asyncio.TimeoutError:
            await self._send({"type": "error", "message": "no start message within 10 s"})
            await self._close(1008, "no start")
            return
        except WebSocketDisconnect:
            return

        receiver = asyncio.create_task(self._receive_loop(), name=f"{self.id}-recv")
        processor = asyncio.create_task(self._process_loop(), name=f"{self.id}-vad")
        recogniser = asyncio.create_task(self._recognise_loop(), name=f"{self.id}-stt")
        try:
            await processor  # ends on stop or disconnect
            # Let every queued utterance come back before the socket is closed.
            await recogniser
            await self._close(1000, "stopped")
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - the session dies, the server does not; log it in full
            log.exception("session failed", extra={"event": "session_error", "session": self.id})
            await self._send({"type": "error", "message": "internal error"})
            await self._close(1011, "internal error")
        finally:
            for task in (receiver, processor, recogniser):
                if not task.done():
                    task.cancel()
            await asyncio.gather(receiver, processor, recogniser, return_exceptions=True)
            log.info(
                "session ended",
                extra={
                    "event": "session_end",
                    "session": self.id,
                    "callId": self.params.call_id if self.params else "",
                    "seconds": round(time.monotonic() - self.started_at, 1),
                    "frames": self.frames,
                    "droppedFrames": self.dropped_frames,
                    "utterances": self.utterances,
                    "sticky": self.sticky,
                },
            )

    # --- the three loops ---

    async def _handshake(self) -> None:
        message = await asyncio.wait_for(self.ws.receive(), timeout=START_TIMEOUT_S)
        if message.get("type") == "websocket.disconnect":
            raise WebSocketDisconnect(message.get("code", 1000))
        text = message.get("text")
        if text is None:
            raise ValueError("the first frame must be a JSON text frame")
        payload = json.loads(text)
        if not isinstance(payload, dict) or payload.get("type") != "start":
            raise ValueError('expected {"type":"start"}')
        params = StartParams.parse(payload, self.settings)
        self.params = params
        self.mode = params.mode
        self.sticky = params.sticky
        self._endpointer = Endpointer(params.endpointing)
        self._resampler = StreamResampler(params.sample_rate, STT_SAMPLE_RATE)
        assert self.engine.vad is not None
        self._vad_state = self.engine.vad.new_state()
        log.info(
            "session started",
            extra={"event": "session_start", "session": self.id, "callId": params.call_id, "sampleRate": params.sample_rate, "language": params.mode, "sticky": params.sticky},
        )
        await self._send({"type": "ready"})

    async def _receive_loop(self) -> None:
        try:
            while True:
                message = await self.ws.receive()
                kind = message.get("type")
                if kind == "websocket.disconnect":
                    self._queue.put_nowait(("close", None))
                    return
                data = message.get("bytes")
                if data is not None:
                    if len(data) > MAX_FRAME_BYTES:
                        await self._send({"type": "error", "message": "frame too large"})
                        continue
                    frame_ms = 1000.0 * (len(data) / 2) / (self.params.sample_rate if self.params else STT_SAMPLE_RATE)
                    if self._queued_ms + frame_ms > MAX_QUEUED_MS:
                        # The processor is behind by more than ten seconds: real-time audio
                        # that late is useless to a conversation, so it is dropped here.
                        self.dropped_frames += 1
                        if self.dropped_frames in (1, 100, 1000):
                            log.warning("dropping audio, session is behind", extra={"event": "backpressure", "session": self.id, "dropped": self.dropped_frames})
                        continue
                    self._queued_ms += frame_ms
                    self._queue.put_nowait(("audio", (data, frame_ms)))
                    continue
                text = message.get("text")
                if text is None:
                    continue
                try:
                    control = json.loads(text)
                except json.JSONDecodeError:
                    await self._send({"type": "error", "message": "control frame is not JSON"})
                    continue
                if not isinstance(control, dict) or not isinstance(control.get("type"), str):
                    await self._send({"type": "error", "message": "control frame needs a type"})
                    continue
                self._queue.put_nowait(("control", control))
                if control["type"] == "stop":
                    return
        except WebSocketDisconnect:
            self._queue.put_nowait(("close", None))
        except asyncio.CancelledError:
            raise
        except RuntimeError:
            # Starlette raises RuntimeError on receive() after a disconnect; same outcome.
            self._queue.put_nowait(("close", None))

    async def _process_loop(self) -> None:
        assert self._endpointer is not None
        while True:
            kind, payload = await self._queue.get()
            if kind == "audio":
                data, frame_ms = payload
                self._queued_ms = max(0.0, self._queued_ms - frame_ms)
                self.frames += 1
                await self._ingest(data)
            elif kind == "control":
                if await self._control(payload):
                    return
            else:  # close: the client is gone, nothing can be sent any more
                self._closed = True
                self._utterances.put_nowait(None)
                return

    async def _recognise_loop(self) -> None:
        while True:
            item = await self._utterances.get()
            if item is None:
                return
            event, ended_at = item
            if self._closed:
                continue
            try:
                result = await self.engine.recognise(event.audio, self.mode, self.sticky)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one bad utterance must not end the call
                log.exception("recognition failed", extra={"event": "recognise_error", "session": self.id})
                await self._send({"type": "error", "message": "recognition failed"})
                continue
            if self.mode == "auto":
                self.sticky = result.language
            latency_ms = int((time.monotonic() - ended_at) * 1000)
            self.utterances += 1
            await self._send(
                {
                    "type": "transcript",
                    "text": result.text,
                    "language": result.language,
                    "languageConfidence": result.language_confidence,
                    "durationMs": event.duration_ms,
                    "latencyMs": latency_ms,
                    "lid": result.lid,
                    "model": result.model,
                    "t": event.t_ms,
                    "startMs": event.start_ms,
                    "cut": event.cut,
                }
            )
            log.info(
                "utterance",
                extra={
                    "event": "utterance",
                    "session": self.id,
                    "callId": self.params.call_id if self.params else "",
                    "language": result.language,
                    "lid": result.lid,
                    "lidSkipped": result.lid_skipped,
                    "switched": result.switched,
                    "model": result.model,
                    "durationMs": event.duration_ms,
                    "latencyMs": latency_ms,
                    "modelMs": result.latency_ms,
                    "timings": result.timings,
                    "chars": len(result.text),
                    "cut": event.cut,
                },
            )

    # --- audio in ---

    async def _ingest(self, data: bytes) -> None:
        assert self._endpointer is not None and self._resampler is not None
        samples = self._resampler.process(pcm16_to_float(data))
        if samples.size:
            self._pending = np.concatenate((self._pending, samples)) if self._pending.size else samples
        count = self._pending.size // WINDOW
        if count == 0:
            return
        windows = self._pending[: count * WINDOW].reshape(count, WINDOW)
        self._pending = self._pending[count * WINDOW :]
        if self._muted:
            for window in windows:
                self._endpointer.advance(window)
            return
        loop = asyncio.get_running_loop()
        probabilities: list[float] = await loop.run_in_executor(self.engine.executor, self._vad_batch, windows)
        for window, probability in zip(windows, probabilities, strict=True):
            await self._dispatch(self._endpointer.feed(window, probability))

    def _vad_batch(self, windows: np.ndarray) -> list[float]:
        assert self.engine.vad is not None and self._vad_state is not None
        return [self.engine.vad.probability(self._vad_state, window) for window in windows]

    async def _dispatch(self, events: list[SpeechStart | SpeechCancel | SpeechEnd]) -> None:
        for event in events:
            if isinstance(event, SpeechStart):
                await self._send({"type": "speech_start", "t": event.t_ms})
            elif isinstance(event, SpeechCancel):
                await self._send({"type": "speech_cancel", "t": event.t_ms})
            else:
                await self._send({"type": "speech_end", "t": event.t_ms, "durationMs": event.duration_ms})
                self._utterances.put_nowait((event, time.monotonic()))

    async def _control(self, control: dict[str, Any]) -> bool:
        """Handle one control message; True when the session should end."""
        assert self._endpointer is not None
        kind = control["type"]
        if kind == "stop":
            await self._dispatch(self._endpointer.flush())
            self._utterances.put_nowait(None)
            return True
        if kind == "mute":
            # The agent is about to speak: close whatever the caller was saying, then ignore
            # the line (the sample clock keeps running so later times stay right).
            await self._dispatch(self._endpointer.flush())
            self._muted = True
        elif kind == "unmute":
            self._muted = False
        elif kind == "set":
            language = control.get("language")
            if language not in LANGUAGES:
                await self._send({"type": "error", "message": "set.language must be bn or en"})
            else:
                self.sticky = language
                if self.mode in LANGUAGES:
                    self.mode = language
        elif kind == "start":
            await self._send({"type": "error", "message": "session already started"})
        else:
            await self._send({"type": "error", "message": f"unknown control type {kind!r}"})
        return False

    # --- socket helpers ---

    async def _send(self, payload: dict[str, Any]) -> None:
        if self._closed:
            return
        async with self._send_lock:
            if self.ws.client_state != WebSocketState.CONNECTED or self.ws.application_state != WebSocketState.CONNECTED:
                self._closed = True
                return
            try:
                await self.ws.send_text(json.dumps(payload, ensure_ascii=False))
            except (WebSocketDisconnect, RuntimeError, OSError):
                self._closed = True

    async def _close(self, code: int, reason: str) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await self.ws.close(code=code, reason=reason)
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
