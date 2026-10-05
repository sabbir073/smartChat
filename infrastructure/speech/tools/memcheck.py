#!/usr/bin/env python3
"""
Run one component in a loop inside this process and watch RSS, to find which engine grows.

    SPEECH_MODELS_DIR=/models python tools/memcheck.py tts --calls 300
    SPEECH_MODELS_DIR=/models python tools/memcheck.py stt --calls 200
    SPEECH_MODELS_DIR=/models python tools/memcheck.py lid --calls 300
    SPEECH_MODELS_DIR=/models python tools/memcheck.py vad --calls 2000

Prints RSS/anon every `--every` calls plus a tracemalloc top list at the end when `--trace` is
set (Python-side allocations only; growth that does not show there is native: allocator
fragmentation or the inference runtimes).
"""

from __future__ import annotations

import argparse
import gc
import random
import sys
import time
import tracemalloc
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from speech.config import Settings  # noqa: E402
from speech.layout import ModelPaths  # noqa: E402

ASSETS = Path("/home/claude/speech-assets/bn_test")
BN = [
    "হ্যালো, গেটচ্যাটে আপনাকে স্বাগতম।",
    "আপনার অর্ডার নম্বর {n} টাকায় নিশ্চিত হয়েছে।",
    "অনুগ্রহ করে একটু অপেক্ষা করুন, আমি দেখছি।",
    "আপনার পার্সেল {n} তারিখে পৌঁছাবে। ধন্যবাদ।",
]
EN = [
    "Hello, welcome to GetChat. How can I help you today?",
    "Your order number {n} has been confirmed and will ship tomorrow.",
    "One moment please, I am checking that for you.",
    "The total comes to {n} taka including delivery. Is that okay?",
]


def rss() -> tuple[int, int]:
    rss_kb = anon_kb = 0
    for line in Path("/proc/self/status").read_text().splitlines():
        if line.startswith("VmRSS"):
            rss_kb = int(line.split()[1])
        elif line.startswith("RssAnon"):
            anon_kb = int(line.split()[1])
    return rss_kb // 1024, anon_kb // 1024


def clips() -> list[np.ndarray]:
    out = []
    for name in ("cv_31515636.wav", "cv_31549899.wav", "cv_31617644.wav", "en.wav"):
        samples, sr = sf.read(ASSETS / name, dtype="float32")
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        if sr != 16000:
            samples = soxr.resample(samples, sr, 16000)
        out.append(np.ascontiguousarray(samples, dtype=np.float32))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("component", choices=["tts", "stt", "lid", "vad", "resample"])
    parser.add_argument("--calls", type=int, default=200)
    parser.add_argument("--every", type=int, default=20)
    parser.add_argument("--voices", default="bn_bd,en_piper")
    parser.add_argument("--trace", action="store_true")
    parser.add_argument("--trim", action="store_true", help="call malloc_trim(0) after every call")
    args = parser.parse_args()
    settings = Settings.from_env()
    paths = ModelPaths(settings.models_dir)
    rng = random.Random(1)
    trim = None
    if args.trim:
        import ctypes

        libc = ctypes.CDLL("libc.so.6")
        trim = lambda: libc.malloc_trim(0)  # noqa: E731

    if args.trace:
        tracemalloc.start(10)

    if args.component == "tts":
        from speech.tts import TtsEngine, load_voices

        engine = TtsEngine(load_voices(paths, settings))
        voices = args.voices.split(",")

        def call(i: int) -> None:
            voice = rng.choice(voices)
            language = "bn" if voice.startswith("bn") else "en"
            text = rng.choice(BN if language == "bn" else EN).replace("{n}", str(1000 + i))
            plan = engine.plan(text, language, voice, 0, 1.0, rng.choice([24000, 48000]))
            for index, sentence in enumerate(plan.sentences):
                engine.render_sentence(sentence, plan.sample_rate, index == 0)

    elif args.component == "stt":
        from speech.stt import load_bengali, load_english

        recognisers = [load_bengali(paths, settings), load_english(paths, settings)]
        audio = clips()

        def call(i: int) -> None:
            clip = rng.choice(audio)
            # variable lengths, like VAD-cut utterances
            cut = clip[: rng.randint(16000, len(clip))]
            rng.choice(recognisers).transcribe(cut)

    elif args.component == "lid":
        from speech.lid import LanguageIdentifier

        lid = LanguageIdentifier(paths.lid_dir, settings.lid_threads)
        audio = clips()

        def call(i: int) -> None:
            clip = rng.choice(audio)
            lid.identify(clip[: rng.randint(16000, len(clip))])

    elif args.component == "vad":
        from speech.vad import WINDOW, Endpointer, EndpointerConfig, SileroVad

        vad = SileroVad(paths.vad)
        audio = clips()

        def call(i: int) -> None:
            state = vad.new_state()
            endpointer = Endpointer(EndpointerConfig())
            clip = np.concatenate([rng.choice(audio), np.zeros(16000, dtype=np.float32)])
            for start in range(0, len(clip) - WINDOW, WINDOW):
                window = clip[start : start + WINDOW]
                endpointer.feed(window, vad.probability(state, window))
            endpointer.flush()

    else:
        from speech.audio import StreamResampler, resample

        audio = clips()

        def call(i: int) -> None:
            clip = rng.choice(audio)
            stream = StreamResampler(48000, 16000)
            up = resample(clip, 16000, 48000)
            for start in range(0, len(up), 480):
                stream.process(up[start : start + 480])
            resample(clip, 16000, 24000)

    for _ in range(3):
        call(0)
    gc.collect()
    base_rss, base_anon = rss()
    print(f"{args.component}: after warm-up rss={base_rss}MB anon={base_anon}MB", flush=True)
    if args.trace:
        snapshot_before = tracemalloc.take_snapshot()
    started = time.monotonic()
    for i in range(1, args.calls + 1):
        call(i)
        if trim:
            trim()
        if i % args.every == 0:
            gc.collect()
            now_rss, now_anon = rss()
            print(f"  {i:5d} calls t={time.monotonic() - started:5.0f}s rss={now_rss}MB (+{now_rss - base_rss}) anon={now_anon}MB (+{now_anon - base_anon})", flush=True)
    if args.trace:
        snapshot_after = tracemalloc.take_snapshot()
        print("tracemalloc top growth:")
        for stat in snapshot_after.compare_to(snapshot_before, "lineno")[:12]:
            print("   ", stat)
    return 0


if __name__ == "__main__":
    sys.exit(main())
