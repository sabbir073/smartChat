"""
End-to-end against the real models and a real uvicorn server (marked `models`; skipped unless
SPEECH_MODELS_DIR is populated). These are the tests that say the service works, not that it
should: real clips in, exact transcripts out, real audio back, measured latencies.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx
import numpy as np
import pytest
import soundfile as sf
from websockets.sync.client import connect

from tests.conftest import ASSETS, HEADERS, Live, frames, pcm16

pytestmark = pytest.mark.models

# Observed in this environment: the owner's note names the "সুস্থ হওয়ার পর..." sentence as the
# transcript of cv_31617644.wav, but that sentence is what both the mp3 and the wav of
# cv_31549899 contain (checked by cross-correlating each wav with each mp3); cv_31617644 is the
# "এছাড়াও তিনি..." clip. The references below are per file as they actually are.
REFERENCES = {
    "cv_31515636.wav": "এই প্রজাতির নানা বিষয় যে গুণাগুণ আছে",
    "cv_31549899.wav": "সুস্থ হওয়ার পর তিনি পার্শ্ববর্তী মির্জাপুর গ্রামে হোমিওপ্যাথি চিকিৎসা আরম্ভ করেন",
    "cv_31617644.wav": "এছাড়াও তিনি চলচ্চিত্র ও নাটকের সংলাপ রচনা নাটক নির্মাণ গীত রচনা ও লেখালেখির সঙ্গে জড়িত রয়েছেন",
}
BN_TEXT = "হ্যালো, গেটচ্যাটে আপনাকে স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি? আপনার অর্ডার নম্বর ১৫০০ টাকায় নিশ্চিত হয়েছে।"
EN_TEXT = "Hello, welcome to GetChat. How can I help you today? Your order of 1,500 taka has been confirmed."


def _normalise(text: str) -> str:
    return " ".join(text.split())


def test_health_lists_every_model(live: Live) -> None:
    health = httpx.get(f"{live.base}/health").json()
    assert health["status"] == "ok"
    assert health["models"]["vad"] and health["models"]["stt_bn"] and health["models"]["stt_en"] and health["models"]["lid"]
    assert health["models"]["tts"] == ["bn_female", "bn_bd", "en_female", "en_male", "en_piper"]
    assert live.engine.rss_after_load_mb is not None and live.engine.rss_after_load_mb > 1000


@pytest.mark.parametrize("name", sorted(REFERENCES))
def test_transcribe_bengali_clips_exactly(live: Live, name: str) -> None:
    started = time.monotonic()
    response = httpx.post(f"{live.base}/v1/transcribe?language=auto", content=(ASSETS / name).read_bytes(), headers={**HEADERS, "Content-Type": "audio/wav"}, timeout=60)
    elapsed = time.monotonic() - started
    assert response.status_code == 200, response.text
    body = response.json()
    assert _normalise(body["text"]) == _normalise(REFERENCES[name])
    assert body["language"] == "bn"
    assert body["lid"]["bn"] >= 0.8
    assert body["languageConfidence"] >= 0.8
    assert body["model"].startswith("indicconformer-bn")
    assert body["latencyMs"] < 5000 and elapsed < 10


def test_transcribe_english(live: Live) -> None:
    response = httpx.post(f"{live.base}/v1/transcribe?language=auto&sticky=bn", content=(ASSETS / "en.wav").read_bytes(), headers={**HEADERS, "Content-Type": "audio/wav"}, timeout=60)
    assert response.status_code == 200, response.text
    body = response.json()
    words = body["text"].lower()
    assert "ask not what your country" in words and "do for your country" in words
    assert body["language"] == "en" and body["lid"]["en"] >= 0.8
    assert body["model"].startswith("parakeet")
    # forced Bengali on English audio still answers (romanised nonsense, but no error)
    forced = httpx.post(f"{live.base}/v1/transcribe?language=bn", content=(ASSETS / "en.wav").read_bytes(), headers={**HEADERS, "Content-Type": "audio/wav"}, timeout=60).json()
    assert forced["language"] == "bn" and forced["lid"] == {"bn": 1.0, "en": 0.0}


def test_transcribe_multipart_and_errors(live: Live) -> None:
    files = {"file": ("clip.wav", (ASSETS / "cv_31549899.wav").read_bytes(), "audio/wav")}
    response = httpx.post(f"{live.base}/v1/transcribe?language=bn", files=files, headers=HEADERS, timeout=60)
    assert response.status_code == 200 and _normalise(response.json()["text"]) == REFERENCES["cv_31549899.wav"]
    assert httpx.post(f"{live.base}/v1/transcribe", content=b"not audio at all", headers={**HEADERS, "Content-Type": "audio/wav"}, timeout=30).status_code == 400
    assert httpx.post(f"{live.base}/v1/transcribe", content=b"", headers=HEADERS, timeout=30).status_code == 400
    assert httpx.post(f"{live.base}/v1/transcribe?language=fr", content=b"x", headers=HEADERS, timeout=30).status_code == 400
    assert httpx.post(f"{live.base}/v1/transcribe", content=b"x", timeout=30).status_code == 401


def test_websocket_end_to_end_bengali_clip(live: Live) -> None:
    """The clip in 20 ms frames plus a second of silence, as the call leg would send it."""
    samples, rate = sf.read(ASSETS / "cv_31549899.wav", dtype="float32")
    assert rate == 16000
    data = pcm16(np.concatenate([samples, np.zeros(16000, dtype=np.float32)]))
    events: list[dict] = []
    with connect(f"{live.ws}/v1/listen", additional_headers=HEADERS, max_size=None) as ws:
        ws.send(json.dumps({"type": "start", "sampleRate": 16000, "language": "auto", "sticky": "en", "callId": "it-1"}))
        assert json.loads(ws.recv()) == {"type": "ready"}
        for frame in frames(data, 20, 16000):
            ws.send(frame)
        sent_at = time.monotonic()
        while True:
            event = json.loads(ws.recv(timeout=20))
            event["_wall_ms"] = int((time.monotonic() - sent_at) * 1000)
            events.append(event)
            if event["type"] == "transcript":
                break
        ws.send(json.dumps({"type": "stop"}))
    kinds = [e["type"] for e in events]
    assert kinds == ["speech_start", "speech_end", "transcript"], events
    start, end, transcript = events
    assert 300 <= start["t"] <= 1500
    assert 4000 <= end["durationMs"] <= 6500
    assert _normalise(transcript["text"]) == REFERENCES["cv_31549899.wav"]
    assert transcript["language"] == "bn" and transcript["lid"]["bn"] >= 0.8
    assert transcript["model"].startswith("indicconformer-bn")
    assert transcript["latencyMs"] < 3000, transcript
    assert transcript["_wall_ms"] < 3000, transcript
    print(f"\nWS e2e: speech_start t={start['t']} speech_end t={end['t']} dur={end['durationMs']} latencyMs={transcript['latencyMs']} wall={transcript['_wall_ms']}")


def test_websocket_english_with_bengali_sticky_switches(live: Live) -> None:
    samples, rate = sf.read(ASSETS / "en.wav", dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    import soxr

    samples = soxr.resample(samples, rate, 48000)
    data = pcm16(np.concatenate([samples, np.zeros(48000, dtype=np.float32)]))
    with connect(f"{live.ws}/v1/listen", additional_headers=HEADERS, max_size=None) as ws:
        ws.send(json.dumps({"type": "start", "sampleRate": 48000, "sticky": "bn"}))
        ws.recv()
        for frame in frames(data, 20, 48000):
            ws.send(frame)
        transcript = None
        while transcript is None:
            event = json.loads(ws.recv(timeout=20))
            if event["type"] == "transcript":
                transcript = event
        ws.send(json.dumps({"type": "stop"}))
    assert transcript["language"] == "en" and transcript["lid"]["en"] >= 0.8
    assert "country" in transcript["text"].lower()


def test_websocket_denied_at_the_handshake(live: Live) -> None:
    from websockets.exceptions import InvalidStatus

    with pytest.raises(InvalidStatus) as denied:
        with connect(f"{live.ws}/v1/listen"):
            pass
    assert denied.value.response.status_code == 401
    with pytest.raises(InvalidStatus) as denied:
        with connect(f"{live.ws}/v1/listen", additional_headers={"Authorization": "Bearer nope"}):
            pass
    assert denied.value.response.status_code == 401


def _stream_tts(live: Live, body: dict) -> tuple[httpx.Response, bytes, int, int, int]:
    """Returns (response, pcm, first_chunk_ms, total_ms, first_chunk_bytes)."""
    started = time.monotonic()
    first_ms = -1
    first_bytes = 0
    chunks: list[bytes] = []
    with httpx.stream("POST", f"{live.base}/v1/tts", json=body, headers=HEADERS, timeout=120) as response:
        for chunk in response.iter_raw():
            if first_ms < 0:
                first_ms = int((time.monotonic() - started) * 1000)
                first_bytes = len(chunk)
            chunks.append(chunk)
    total_ms = int((time.monotonic() - started) * 1000)
    return response, b"".join(chunks), first_ms, total_ms, first_bytes


def _pcm_stats(pcm: bytes, rate: int) -> tuple[float, float]:
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    return len(samples) / rate, float(np.sqrt(np.mean(samples**2))) if samples.size else 0.0


@pytest.mark.parametrize(
    ("language", "voice", "text", "low_s", "high_s"),
    [
        ("bn", "bn_female", BN_TEXT, 5.0, 16.0),
        ("bn", "bn_bd", BN_TEXT, 5.0, 16.0),
        ("en", "en_female", EN_TEXT, 4.0, 12.0),
        ("en", "en_male", EN_TEXT, 4.0, 12.0),
        ("en", "en_piper", EN_TEXT, 4.0, 12.0),
    ],
)
def test_tts_streams_sentence_by_sentence_and_caches(live: Live, language: str, voice: str, text: str, low_s: float, high_s: float) -> None:
    body = {"text": text, "language": language, "voice": voice, "sampleRate": 24000}
    response, pcm, first_ms, total_ms, first_bytes = _stream_tts(live, body)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/pcm")
    assert response.headers["x-sample-rate"] == "24000" and response.headers["x-voice"] == voice
    assert response.headers["x-cache"] == "miss" and response.headers["x-sentences"] == "3"
    duration_s, rms = _pcm_stats(pcm, 24000)
    assert low_s <= duration_s <= high_s, duration_s
    assert rms > 0.02, rms
    assert first_bytes < len(pcm), "the first sentence must arrive before the whole reply"
    assert first_ms < total_ms * 0.8, (first_ms, total_ms)
    print(f"\nTTS {voice}: audio {duration_s:.2f}s rms {rms:.3f} first-chunk {first_ms}ms total {total_ms}ms rtf {total_ms / 1000 / duration_s:.3f}")

    response2, pcm2, first2_ms, total2_ms, _ = _stream_tts(live, body)
    assert response2.headers["x-cache"] == "hit"
    assert abs(int(response2.headers["x-duration-ms"]) - duration_s * 1000) <= 20
    assert pcm2 == pcm
    assert total2_ms < 1000


def test_tts_info_matches_the_stream(live: Live) -> None:
    body = {"text": BN_TEXT, "language": "bn", "sampleRate": 16000}
    info = httpx.post(f"{live.base}/v1/tts/info", json=body, headers=HEADERS, timeout=120).json()
    assert len(info["sentences"]) == 3
    assert info["units"][2][0]["text"] == "আপনার অর্ডার নম্বর এক হাজার পাঁচশো টাকায় নিশ্চিত হয়েছে।"
    response, pcm, _, _, _ = _stream_tts(live, body)
    duration_s, _ = _pcm_stats(pcm, 16000)
    assert abs(duration_s * 1000 - info["durationMs"]) <= 20
    assert response.headers["x-cache"] == "hit"


def test_tts_mixed_script_and_markdown(live: Live) -> None:
    body = {"text": "**Hello!** আপনার অর্ডার #1500 confirmed. Visit https://getchat.site 🎉", "language": "bn", "voice": "bn_bd", "speakerId": 2}
    info = httpx.post(f"{live.base}/v1/tts/info", json=body, headers=HEADERS, timeout=120).json()
    voices_used = {unit["voice"] for sentence in info["units"] for unit in sentence}
    assert voices_used == {"en_female", "bn_bd"}
    response, pcm, _, _, _ = _stream_tts(live, body)
    duration_s, rms = _pcm_stats(pcm, 24000)
    assert response.status_code == 200 and 3.0 <= duration_s <= 15.0 and rms > 0.02


def test_tts_rejects_bad_voice_and_speaker(live: Live) -> None:
    assert httpx.post(f"{live.base}/v1/tts", json={"text": "hi", "language": "en", "voice": "bn_bd"}, headers=HEADERS, timeout=30).status_code == 400
    assert httpx.post(f"{live.base}/v1/tts", json={"text": "hi", "language": "bn", "voice": "bn_bd", "speakerId": 99}, headers=HEADERS, timeout=30).status_code == 400
    assert httpx.post(f"{live.base}/v1/tts", json={"text": "hi", "language": "en", "sampleRate": 12345}, headers=HEADERS, timeout=30).status_code == 400
    empty = httpx.post(f"{live.base}/v1/tts", json={"text": "🎉", "language": "en"}, headers=HEADERS, timeout=30)
    assert empty.status_code == 200 and empty.content == b"" and empty.headers["x-sentences"] == "0"


def test_voices_listing(live: Live) -> None:
    voices = httpx.get(f"{live.base}/v1/voices", headers=HEADERS).json()["voices"]
    assert [v["id"] for v in voices] == ["bn_female", "bn_bd", "en_female", "en_male", "en_piper"]
    by_id = {v["id"]: v for v in voices}
    assert by_id["bn_bd"]["speakers"] == 16 and by_id["bn_bd"]["language"] == "bn"
    assert by_id["en_piper"]["speakers"] == 904


def test_models_report(live: Live, tmp_path: Path) -> None:
    """Not an assertion so much as the numbers the owner asked for, printed with -s."""
    engine = live.engine
    print(f"\nload {engine.load_seconds}s, RSS after load {engine.rss_after_load_mb} MB, threads {engine.settings.threads}")
    for name in ("cv_31549899.wav", "en.wav"):
        samples, rate = sf.read(ASSETS / name, dtype="float32")
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        if rate != 16000:
            import soxr

            samples = soxr.resample(samples, rate, 16000)
        seconds = len(samples) / 16000
        for recogniser in engine.stt.values():
            recogniser.transcribe(samples)
            started = time.monotonic()
            recogniser.transcribe(samples)
            elapsed = time.monotonic() - started
            print(f"STT {recogniser.name} on {name} ({seconds:.2f}s): {elapsed * 1000:.0f} ms, RTF {elapsed / seconds:.3f}")
        started = time.monotonic()
        result = engine.lid.identify(samples)
        print(f"LID on {name}: {int((time.monotonic() - started) * 1000)} ms -> {result.language} {result.probabilities}")
