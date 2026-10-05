#!/usr/bin/env python3
"""
Load the running service the way a day of calls would, and watch its memory.

Interleaves WebSocket listen sessions (real clips, 10 ms frames, several utterances each),
/v1/tts requests (varied texts so the cache keeps missing, several voices and output rates) and
/v1/transcribe calls, and prints the server's RSS (from /proc) after every round. Used to chase
the memory growth that took the first deployment down, and kept so it can be rerun after any
model or dependency change.

    python tools/loadtest.py --pid $(pgrep -f "speech.server") --rounds 10 \
        --sessions 2 --tts 20 --transcribes 5 [--only tts|listen|transcribe]
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf
import soxr
from websockets.sync.client import connect

ASSETS = Path("/home/claude/speech-assets/bn_test")
CLIPS = ["cv_31515636.wav", "cv_31549899.wav", "cv_31617644.wav", "en.wav"]
BN_PHRASES = [
    "হ্যালো, গেটচ্যাটে আপনাকে স্বাগতম।",
    "আপনার অর্ডার নম্বর {n} টাকায় নিশ্চিত হয়েছে।",
    "অনুগ্রহ করে একটু অপেক্ষা করুন, আমি দেখছি।",
    "আপনার পার্সেল {n} তারিখে পৌঁছাবে। ধন্যবাদ।",
    "আমি আপনাকে কীভাবে সাহায্য করতে পারি? আপনার ফোন নম্বর বলুন।",
]
EN_PHRASES = [
    "Hello, welcome to GetChat. How can I help you today?",
    "Your order number {n} has been confirmed and will ship tomorrow.",
    "One moment please, I am checking that for you.",
    "The total comes to {n} taka including delivery. Is that okay?",
    "Thank you for calling. Have a nice day and goodbye.",
]


def rss(pid: int) -> dict[str, int]:
    out: dict[str, int] = {}
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith(("VmRSS", "RssAnon", "RssFile", "VmHWM", "Threads")):
                key, value = line.split(":", 1)
                out[key] = int(value.strip().split()[0])
    except OSError:
        pass
    return out


def load_clip(name: str, rate: int) -> bytes:
    samples, sr = sf.read(ASSETS / name, dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    if sr != rate:
        samples = soxr.resample(samples, sr, rate)
    silence = np.zeros(int(rate * 1.0), dtype=np.float32)
    return (np.clip(np.concatenate([samples, silence]), -1, 1) * 32767).astype("<i2").tobytes()


def listen_session(ws_base: str, headers: dict[str, str], clips: list[bytes], rate: int, frame_ms: int) -> int:
    frame = int(rate * frame_ms / 1000) * 2
    transcripts = 0
    with connect(f"{ws_base}/v1/listen", additional_headers=headers, max_size=None) as ws:
        ws.send(json.dumps({"type": "start", "sampleRate": rate, "language": "auto", "callId": f"load-{time.time():.0f}"}))
        ws.recv()
        for clip in clips:
            for i in range(0, len(clip), frame):
                ws.send(clip[i : i + frame])
            while True:
                event = json.loads(ws.recv(timeout=30))
                if event["type"] == "transcript":
                    transcripts += 1
                    break
        ws.send(json.dumps({"type": "stop"}))
        try:
            while True:
                ws.recv(timeout=5)
        except Exception:  # noqa: BLE001 - closed by the server after the flush
            pass
    return transcripts


def tts_call(client: httpx.Client, base: str, text: str, language: str, voice: str, rate: int) -> int:
    total = 0
    with client.stream("POST", f"{base}/v1/tts", json={"text": text, "language": language, "voice": voice, "sampleRate": rate}) as response:
        response.raise_for_status()
        for chunk in response.iter_raw():
            total += len(chunk)
    return total


def transcribe_call(client: httpx.Client, base: str, name: str) -> str:
    response = client.post(f"{base}/v1/transcribe?language=auto", content=(ASSETS / name).read_bytes(), headers={"Content-Type": "audio/wav"})
    response.raise_for_status()
    return response.json()["text"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://127.0.0.1:3010")
    parser.add_argument("--token", default="")
    parser.add_argument("--pid", type=int, required=True, help="server pid, for /proc RSS")
    parser.add_argument("--rounds", type=int, default=10)
    parser.add_argument("--sessions", type=int, default=2, help="listen sessions per round")
    parser.add_argument("--utterances", type=int, default=3, help="clips per session")
    parser.add_argument("--tts", type=int, default=20, help="TTS requests per round")
    parser.add_argument("--transcribes", type=int, default=5, help="transcribe requests per round")
    parser.add_argument("--only", choices=["tts", "listen", "transcribe"], default=None)
    parser.add_argument("--voices", default="bn_bd,en_piper", help="comma-separated TTS voices to rotate")
    parser.add_argument("--rates", default="24000,48000", help="comma-separated TTS output rates")
    parser.add_argument("--frame-ms", type=int, default=10)
    parser.add_argument("--long", action="store_true", help="TTS texts of three sentences, like real agent replies")
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()

    headers = {"Authorization": f"Bearer {args.token}"} if args.token else {}
    base = args.base
    ws_base = base.replace("http://", "ws://").replace("https://", "wss://")
    rng = random.Random(args.seed)
    voices = args.voices.split(",")
    rates = [int(r) for r in args.rates.split(",")]
    clips16 = [load_clip(name, 16000) for name in CLIPS]
    clips48 = [load_clip(name, 48000) for name in CLIPS]
    counter = 0

    start = rss(args.pid)
    print(f"start: {start}", flush=True)
    started = time.monotonic()
    with httpx.Client(headers=headers, timeout=120) as client:
        for round_index in range(1, args.rounds + 1):
            if args.only in (None, "listen"):
                for s in range(args.sessions):
                    rate = 48000 if s % 2 else 16000
                    pool = clips48 if rate == 48000 else clips16
                    listen_session(ws_base, headers, [rng.choice(pool) for _ in range(args.utterances)], rate, args.frame_ms)
            if args.only in (None, "tts"):
                for _ in range(args.tts):
                    counter += 1
                    voice = rng.choice(voices)
                    language = "bn" if voice.startswith("bn") else "en"
                    pool = BN_PHRASES if language == "bn" else EN_PHRASES
                    phrase = " ".join(rng.sample(pool, 3) if args.long else [rng.choice(pool)]).replace("{n}", str(1000 + counter))
                    tts_call(client, base, phrase, language, voice, rng.choice(rates))
            if args.only in (None, "transcribe"):
                for _ in range(args.transcribes):
                    transcribe_call(client, base, rng.choice(CLIPS))
            now = rss(args.pid)
            print(
                f"round {round_index:3d} t={time.monotonic() - started:6.0f}s rss={now.get('VmRSS', 0) // 1024:5d}MB anon={now.get('RssAnon', 0) // 1024:5d}MB threads={now.get('Threads')}", flush=True
            )
    end = rss(args.pid)
    print(f"growth: {(end.get('VmRSS', 0) - start.get('VmRSS', 0)) // 1024} MB RSS, {(end.get('RssAnon', 0) - start.get('RssAnon', 0)) // 1024} MB anon over {args.rounds} rounds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
