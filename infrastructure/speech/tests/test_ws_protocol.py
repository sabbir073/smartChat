"""The /v1/listen protocol, driven through the real server code with a fake VAD and recogniser."""

from __future__ import annotations

import json
import time
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse
from starlette.websockets import WebSocketDisconnect

from speech.config import Settings
from speech.server import create_app
from tests.conftest import FakeEngine, frames, pcm16, tone


def client_for(settings: Settings, engine: FakeEngine) -> TestClient:
    return TestClient(create_app(settings, engine=engine, autoload=False))


def collect(ws: Any, until: str = "transcript", limit: int = 20, timeout_s: float = 10.0) -> list[dict[str, Any]]:
    """Receive JSON events until one of type `until` (inclusive) or the limit."""
    events: list[dict[str, Any]] = []
    deadline = time.monotonic() + timeout_s
    while len(events) < limit and time.monotonic() < deadline:
        event = ws.receive_json()
        events.append(event)
        if event["type"] == until:
            break
    return events


def send_audio(ws: Any, samples: np.ndarray, rate: int = 16000, frame_ms: int = 20) -> None:
    for frame in frames(pcm16(samples), frame_ms, rate):
        ws.send_bytes(frame)


def speech_then_silence(speech_ms: int = 1500, silence_ms: int = 1000, rate: int = 16000) -> np.ndarray:
    return np.concatenate([np.zeros(int(rate * 0.5), dtype=np.float32), tone(speech_ms, rate), np.zeros(int(rate * silence_ms / 1000), dtype=np.float32)])


def test_start_ready_speech_events_and_transcript(settings: Settings, fake_engine: FakeEngine) -> None:
    with client_for(settings, fake_engine) as client, client.websocket_connect("/v1/listen") as ws:
        ws.send_json({"type": "start", "sampleRate": 16000, "language": "auto", "sticky": "en", "callId": "c1"})
        assert ws.receive_json() == {"type": "ready"}
        send_audio(ws, speech_then_silence())
        events = collect(ws)
        kinds = [e["type"] for e in events]
        assert kinds == ["speech_start", "speech_end", "transcript"], events
        start, end, transcript = events
        assert 480 <= start["t"] <= 540  # speech begins at 500 ms, reported at window resolution
        assert abs(end["durationMs"] - 1500) <= 64
        assert end["t"] - (start["t"] + end["durationMs"]) >= 550
        assert transcript["text"] == "hello there"
        assert transcript["language"] == "bn"  # fake LID says bn at 0.97 on a 1.5 s utterance
        assert transcript["languageConfidence"] == 0.97
        assert transcript["lid"] == {"bn": 0.97, "en": 0.03}
        assert transcript["model"] == "fake"
        assert transcript["durationMs"] == end["durationMs"]
        assert transcript["latencyMs"] >= 0
        assert fake_engine.calls[0]["mode"] == "auto" and fake_engine.calls[0]["sticky"] == "en"
        # padding + speech + tail of audio reached the recogniser
        assert 1500 + 250 <= fake_engine.calls[0]["samples"] / 16 <= 1500 + 300 + 240 + 64
        ws.send_json({"type": "stop"})
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()
    assert fake_engine.sessions == 0


def test_sticky_language_follows_lid_and_set(settings: Settings, fake_engine: FakeEngine) -> None:
    with client_for(settings, fake_engine) as client, client.websocket_connect("/v1/listen") as ws:
        ws.send_json({"type": "start"})
        ws.receive_json()
        send_audio(ws, speech_then_silence())
        first = collect(ws)[-1]
        assert first["language"] == "bn"
        send_audio(ws, speech_then_silence())
        second = collect(ws)[-1]
        assert fake_engine.calls[1]["sticky"] == "bn"  # updated after the first utterance
        assert second["language"] == "bn"
        ws.send_json({"type": "set", "language": "en"})
        send_audio(ws, speech_then_silence())
        collect(ws)
        assert fake_engine.calls[2]["sticky"] == "en"
        ws.send_json({"type": "stop"})


def test_forced_language_skips_lid(settings: Settings, fake_engine: FakeEngine) -> None:
    with client_for(settings, fake_engine) as client, client.websocket_connect("/v1/listen") as ws:
        ws.send_json({"type": "start", "language": "en"})
        ws.receive_json()
        send_audio(ws, speech_then_silence())
        transcript = collect(ws)[-1]
        assert transcript["language"] == "en"
        assert transcript["lid"] == {"bn": 0.0, "en": 1.0}
        assert fake_engine.calls[0]["mode"] == "en"
        ws.send_json({"type": "stop"})


def test_empty_transcript_is_still_sent(settings: Settings) -> None:
    engine = FakeEngine(text="")
    with client_for(settings, engine) as client, client.websocket_connect("/v1/listen") as ws:
        ws.send_json({"type": "start"})
        ws.receive_json()
        send_audio(ws, speech_then_silence())
        transcript = collect(ws)[-1]
        assert transcript["type"] == "transcript" and transcript["text"] == ""
        ws.send_json({"type": "stop"})


def test_short_blip_is_cancelled(settings: Settings, fake_engine: FakeEngine) -> None:
    with client_for(settings, fake_engine) as client, client.websocket_connect("/v1/listen") as ws:
        ws.send_json({"type": "start", "minSpeechMs": 250})
        ws.receive_json()
        audio = np.concatenate([np.zeros(8000, dtype=np.float32), tone(100), np.zeros(16000, dtype=np.float32)])
        send_audio(ws, audio)
        events = collect(ws, until="speech_cancel", limit=3, timeout_s=5)
        assert [e["type"] for e in events] == ["speech_start", "speech_cancel"]
        assert fake_engine.calls == []
        ws.send_json({"type": "stop"})


def test_stop_flushes_an_open_utterance(settings: Settings, fake_engine: FakeEngine) -> None:
    with client_for(settings, fake_engine) as client, client.websocket_connect("/v1/listen") as ws:
        ws.send_json({"type": "start"})
        ws.receive_json()
        send_audio(ws, tone(1200))  # no trailing silence
        ws.send_json({"type": "stop"})
        events = collect(ws)
        assert [e["type"] for e in events] == ["speech_start", "speech_end", "transcript"]
        assert events[1]["durationMs"] >= 1100


def test_mute_ignores_audio_and_unmute_resumes(settings: Settings, fake_engine: FakeEngine) -> None:
    with client_for(settings, fake_engine) as client, client.websocket_connect("/v1/listen") as ws:
        ws.send_json({"type": "start"})
        ws.receive_json()
        ws.send_json({"type": "mute"})
        send_audio(ws, speech_then_silence())  # would be an utterance when unmuted
        ws.send_json({"type": "unmute"})
        send_audio(ws, speech_then_silence())
        events = collect(ws)
        assert [e["type"] for e in events] == ["speech_start", "speech_end", "transcript"]
        # the clock kept running while muted: the second clip starts 3 s + 0.5 s in
        assert events[0]["t"] >= 3000 + 480
        assert len(fake_engine.calls) == 1
        ws.send_json({"type": "stop"})


def test_max_speech_cuts_long_utterances(settings: Settings, fake_engine: FakeEngine) -> None:
    with client_for(settings, fake_engine) as client, client.websocket_connect("/v1/listen") as ws:
        ws.send_json({"type": "start", "maxSpeechMs": 2000})
        ws.receive_json()
        send_audio(ws, np.concatenate([tone(5000), np.zeros(16000, dtype=np.float32)]))
        events: list[dict[str, Any]] = []
        while len([e for e in events if e["type"] == "transcript"]) < 3:
            events.append(ws.receive_json())
        kinds = [e["type"] for e in events]
        assert kinds.count("speech_end") == 3 and kinds.count("speech_start") == 3
        ends = [e for e in events if e["type"] == "speech_end"]
        assert abs(ends[0]["durationMs"] - 2000) <= 64
        transcripts = [e for e in events if e["type"] == "transcript"]
        assert transcripts[0]["cut"] is True and transcripts[-1]["cut"] is False
        ws.send_json({"type": "stop"})


def test_48k_input_is_resampled(settings: Settings, fake_engine: FakeEngine) -> None:
    with client_for(settings, fake_engine) as client, client.websocket_connect("/v1/listen") as ws:
        ws.send_json({"type": "start", "sampleRate": 48000})
        ws.receive_json()
        send_audio(ws, speech_then_silence(rate=48000), rate=48000)
        events = collect(ws)
        assert [e["type"] for e in events] == ["speech_start", "speech_end", "transcript"]
        assert abs(events[1]["durationMs"] - 1500) <= 64
        assert abs(fake_engine.calls[0]["samples"] / 16 - (1500 + 300 + 240)) <= 100
        ws.send_json({"type": "stop"})


def test_transcripts_stay_in_order_with_a_slow_recogniser(settings: Settings, fake_engine: FakeEngine) -> None:
    fake_engine.delay_s = 0.2
    with client_for(settings, fake_engine) as client, client.websocket_connect("/v1/listen") as ws:
        ws.send_json({"type": "start"})
        ws.receive_json()
        for _ in range(3):
            send_audio(ws, speech_then_silence(speech_ms=600))
        ws.send_json({"type": "stop"})
        events: list[dict[str, Any]] = []
        try:
            while True:
                events.append(ws.receive_json())
        except Exception:  # noqa: BLE001 - the server closed after the last transcript
            pass
        transcripts = [e for e in events if e["type"] == "transcript"]
        assert len(transcripts) == 3
        assert [t["t"] for t in transcripts] == sorted(t["t"] for t in transcripts)


def test_bad_start_messages(settings: Settings, fake_engine: FakeEngine) -> None:
    with client_for(settings, fake_engine) as client:
        with client.websocket_connect("/v1/listen") as ws:
            ws.send_json({"type": "start", "sampleRate": 44100})
            error = ws.receive_json()
            assert error["type"] == "error" and "sampleRate" in error["message"]
        with client.websocket_connect("/v1/listen") as ws:
            ws.send_text("not json")
            assert ws.receive_json()["type"] == "error"
        with client.websocket_connect("/v1/listen") as ws:
            ws.send_bytes(b"\x00\x00")
            assert ws.receive_json()["type"] == "error"
    assert fake_engine.sessions == 0


def test_unknown_control_is_an_error_not_a_disconnect(settings: Settings, fake_engine: FakeEngine) -> None:
    with client_for(settings, fake_engine) as client, client.websocket_connect("/v1/listen") as ws:
        ws.send_json({"type": "start"})
        ws.receive_json()
        ws.send_json({"type": "dance"})
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"type": "set", "language": "fr"})
        assert ws.receive_json()["type"] == "error"
        ws.send_text("{broken")
        assert ws.receive_json()["type"] == "error"
        send_audio(ws, speech_then_silence())
        assert collect(ws)[-1]["type"] == "transcript"
        ws.send_json({"type": "stop"})


def test_token_required_on_websocket_and_http(monkeypatch: pytest.MonkeyPatch, settings: Settings, fake_engine: FakeEngine) -> None:
    monkeypatch.setenv("SPEECH_TOKEN", "s3cret")
    secured = Settings.from_env()
    with client_for(secured, fake_engine) as client:
        assert client.get("/health").status_code == 200  # health stays open for the orchestrator
        assert client.get("/v1/voices").status_code == 401
        assert client.get("/v1/voices", headers={"Authorization": "Bearer wrong"}).status_code == 401
        with pytest.raises(WebSocketDenialResponse) as denied:
            with client.websocket_connect("/v1/listen"):
                pass
        assert denied.value.status_code == 401
        with client.websocket_connect("/v1/listen", headers={"Authorization": "Bearer s3cret"}) as ws:
            ws.send_json({"type": "start"})
            assert ws.receive_json() == {"type": "ready"}
            ws.send_json({"type": "stop"})


def test_session_limit_and_loading_state(settings: Settings, fake_engine: FakeEngine) -> None:
    with client_for(settings, fake_engine) as client:
        with client.websocket_connect("/v1/listen") as first, client.websocket_connect("/v1/listen") as second:
            first.send_json({"type": "start"})
            second.send_json({"type": "start"})
            first.receive_json()
            second.receive_json()
            with pytest.raises(WebSocketDenialResponse) as denied:
                with client.websocket_connect("/v1/listen"):
                    pass
            assert denied.value.status_code == 503
            first.send_json({"type": "stop"})
            second.send_json({"type": "stop"})
        fake_engine.ready = False
        assert client.get("/health").status_code == 503
        with pytest.raises(WebSocketDenialResponse) as denied:
            with client.websocket_connect("/v1/listen"):
                pass
        assert denied.value.status_code == 503
        assert client.post("/v1/transcribe", content=b"RIFF", headers={"Content-Type": "audio/wav"}).status_code == 503


def test_backpressure_drops_audio_but_keeps_controls(settings: Settings, fake_engine: FakeEngine) -> None:
    """A burst of 30 s of audio: the session must not grow without bound, and stop still works."""
    fake_engine.delay_s = 0.0
    with client_for(settings, fake_engine) as client, client.websocket_connect("/v1/listen") as ws:
        ws.send_json({"type": "start"})
        ws.receive_json()
        data = pcm16(np.zeros(16000 * 30, dtype=np.float32))
        for frame in frames(data, 200, 16000):
            ws.send_bytes(frame)
        ws.send_json({"type": "stop"})
        events: list[dict[str, Any]] = []
        try:
            while True:
                events.append(ws.receive_json())
        except Exception:  # noqa: BLE001 - closed after the flush
            pass
        assert all(e["type"] != "error" for e in events)


def test_health_and_voices_routes(settings: Settings, fake_engine: FakeEngine) -> None:
    with client_for(settings, fake_engine) as client:
        health = client.get("/health").json()
        assert health["status"] == "ok" and health["models"]["vad"] is True
        assert client.get("/v1/voices").status_code == 503  # the fake has no TTS loaded
        assert client.post("/v1/tts", json={"text": "hi", "language": "en"}).status_code == 503
        bad = client.post("/v1/tts", content=json.dumps({"text": "hi", "language": "fr"}), headers={"Content-Type": "application/json"})
        assert bad.status_code == 400 and "language" in bad.json()["error"]
