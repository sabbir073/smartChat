"""
Memory stays flat under a mixed workload (marked `models`).

The first deployment was OOM-killed after fifteen minutes: ONNX Runtime's per-session arenas
and glibc's per-thread heaps kept every high-water mark (see speech/memory.py). This test runs
the same kind of traffic against the real server - listen sessions with real clips, varied TTS
requests across voices and output rates, one-shot transcriptions - and asserts that the
process's resident set does not keep climbing. The server runs inside this process (the shared
`live` fixture), so /proc/self is the server.
"""

from __future__ import annotations

import json
import random
import time
from pathlib import Path

import httpx
import numpy as np
import pytest
import soundfile as sf
import soxr
from websockets.sync.client import connect

from tests.conftest import ASSETS, HEADERS, Live, frames, pcm16

pytestmark = pytest.mark.models

CLIPS = ["cv_31515636.wav", "cv_31549899.wav", "cv_31617644.wav", "en.wav"]
BN_PHRASES = [
    "হ্যালো, গেটচ্যাটে আপনাকে স্বাগতম।",
    "আপনার অর্ডার নম্বর {n} টাকায় নিশ্চিত হয়েছে।",
    "অনুগ্রহ করে একটু অপেক্ষা করুন, আমি দেখছি।",
    "আপনার পার্সেল {n} তারিখে পৌঁছাবে। ধন্যবাদ।",
]
EN_PHRASES = [
    "Hello, welcome to GetChat. How can I help you today?",
    "Your order number {n} has been confirmed and will ship tomorrow.",
    "One moment please, I am checking that for you.",
    "The total comes to {n} taka including delivery. Is that okay?",
]
ROUNDS = 6
SESSIONS_PER_ROUND = 2
UTTERANCES_PER_SESSION = 3
TTS_PER_ROUND = 25
TRANSCRIBES_PER_ROUND = 5
# Allowed growth from the first round's end to the last: the TTS cache alone may add up to 50 MB.
MAX_GROWTH_MB = 100


def rss_mb() -> int:
    for line in Path("/proc/self/status").read_text().splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1]) // 1024
    raise RuntimeError("no VmRSS in /proc/self/status")


def clip_pcm(name: str, rate: int) -> bytes:
    samples, sr = sf.read(ASSETS / name, dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    if sr != rate:
        samples = soxr.resample(samples, sr, rate)
    return pcm16(np.concatenate([samples, np.zeros(rate, dtype=np.float32)]))


def listen_session(live: Live, clips: list[bytes], rate: int) -> int:
    transcripts = 0
    with connect(f"{live.ws}/v1/listen", additional_headers=HEADERS, max_size=None) as ws:
        ws.send(json.dumps({"type": "start", "sampleRate": rate, "language": "auto"}))
        ws.recv()
        for clip in clips:
            for frame in frames(clip, 10, rate):
                ws.send(frame)
            while json.loads(ws.recv(timeout=30))["type"] != "transcript":
                pass
            transcripts += 1
        ws.send(json.dumps({"type": "stop"}))
        try:
            while True:
                ws.recv(timeout=5)
        except Exception:  # noqa: BLE001 - closed by the server after the flush
            pass
    return transcripts


def test_rss_stays_flat_under_mixed_load(live: Live) -> None:
    rng = random.Random(7)
    clips = {rate: [clip_pcm(name, rate) for name in CLIPS] for rate in (16000, 48000)}
    wavs = {name: (ASSETS / name).read_bytes() for name in CLIPS}
    voices = ["bn_bd", "en_piper", "bn_female", "en_female"]
    readings: list[int] = []
    counter = 0
    with httpx.Client(headers=HEADERS, timeout=120) as client:
        for _ in range(ROUNDS):
            for s in range(SESSIONS_PER_ROUND):
                rate = 48000 if s % 2 else 16000
                assert listen_session(live, [rng.choice(clips[rate]) for _ in range(UTTERANCES_PER_SESSION)], rate) == UTTERANCES_PER_SESSION
            for _ in range(TTS_PER_ROUND):
                counter += 1
                voice = rng.choice(voices)
                language = "bn" if voice.startswith("bn") else "en"
                text = rng.choice(BN_PHRASES if language == "bn" else EN_PHRASES).replace("{n}", str(1000 + counter))
                with client.stream("POST", f"{live.base}/v1/tts", json={"text": text, "language": language, "voice": voice, "sampleRate": rng.choice([16000, 24000, 48000])}) as response:
                    assert response.status_code == 200
                    for _chunk in response.iter_raw():
                        pass
            for _ in range(TRANSCRIBES_PER_ROUND):
                name = rng.choice(CLIPS)
                response = client.post(f"{live.base}/v1/transcribe?language=auto", content=wavs[name], headers={"Content-Type": "audio/wav"})
                assert response.status_code == 200
            time.sleep(0.2)
            readings.append(rss_mb())
            print(f"\nmemory: after round {len(readings)} rss={readings[-1]} MB")

    growth = readings[-1] - readings[0]
    peak = max(readings) - readings[0]
    late = readings[-1] - readings[ROUNDS // 2]
    print(f"memory: rounds={readings} growth={growth} MB peak={peak} MB second-half={late} MB")
    assert growth <= MAX_GROWTH_MB, f"RSS grew by {growth} MB over {ROUNDS - 1} rounds: {readings}"
    assert peak <= MAX_GROWTH_MB + 50, f"RSS peaked {peak} MB above the first round: {readings}"
    # Once the cache has filled, the second half of the run must be flat.
    assert late <= MAX_GROWTH_MB // 2, f"RSS still climbing in the second half: {readings}"
    health = httpx.get(f"{live.base}/health").json()
    assert health["sessions"] == 0
