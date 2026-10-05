#!/usr/bin/env python3
"""
Listening samples: every voice saying the same greeting, through the service's own pipeline
(cleaning, number normalisation, loudness matching, resampling to 24 kHz), written as WAV.

    SPEECH_MODELS_DIR=/models python tools/make_samples.py --out ./samples
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from speech.config import Settings  # noqa: E402
from speech.layout import ModelPaths  # noqa: E402
from speech.tts import TtsEngine, load_voices  # noqa: E402

BN_TEXT = "হ্যালো, গেটচ্যাটে আপনাকে স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি? আপনার অর্ডার নম্বর ১৫০০ টাকায় নিশ্চিত হয়েছে।"
EN_TEXT = "Hello, welcome to GetChat. How can I help you today? Your order of 1,500 taka has been confirmed."
SAMPLES = [
    ("bn_female.wav", "bn", "bn_female", 0, BN_TEXT),
    ("bn_bd_s0.wav", "bn", "bn_bd", 0, BN_TEXT),
    ("bn_bd_s1.wav", "bn", "bn_bd", 1, BN_TEXT),
    ("bn_bd_s2.wav", "bn", "bn_bd", 2, BN_TEXT),
    ("en_female.wav", "en", "en_female", 0, EN_TEXT),
    ("en_male.wav", "en", "en_male", 0, EN_TEXT),
    ("en_piper.wav", "en", "en_piper", 0, EN_TEXT),
]
RATE = 24_000


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="directory for the WAV files")
    args = parser.parse_args()
    settings = Settings.from_env()
    engine = TtsEngine(load_voices(ModelPaths(settings.models_dir), settings))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, language, voice, speaker, text in SAMPLES:
        plan = engine.plan(text, language, voice, speaker, 1.0, RATE)
        started = time.monotonic()
        pieces = [engine.render_sentence(sentence, RATE, first=(index == 0)) for index, sentence in enumerate(plan.sentences)]
        elapsed = time.monotonic() - started
        audio = np.concatenate(pieces)
        sf.write(out / name, audio, RATE, subtype="PCM_16")
        seconds = audio.size / RATE
        peak = float(np.max(np.abs(audio)))
        rms = float(np.sqrt(np.mean(audio**2)))
        clipped = int(np.sum(np.abs(audio) >= 0.999))
        print(f"{name}: {seconds:.2f}s synth {elapsed:.2f}s RTF {elapsed / seconds:.3f} peak {peak:.3f} rms {rms:.3f} clipped-samples {clipped} sentences {len(plan.sentences)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
