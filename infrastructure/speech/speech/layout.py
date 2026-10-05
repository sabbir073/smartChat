"""
Where each model lives inside the models directory.

Shared by `download_models.py` (which fills the directory) and the loaders (which read it), so
the two can never disagree about a file name. Everything is relative to `SPEECH_MODELS_DIR`.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

PARAKEET_DIR = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
OMNILINGUAL_DIR = "sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05"
COQUI_BN_DIR = "vits-coqui-bn-custom_female"
PIPER_BN_DIR = "vits-piper-bn_BD-google-medium"
PIPER_EN_DIR = "vits-piper-en_US-libritts_r-medium"
KOKORO_DIR = "kokoro-en-v0_19"
KOKORO_INT8_DIR = "kokoro-int8-en-v0_19"


@dataclass(frozen=True)
class ModelPaths:
    root: Path

    # --- voice activity detection ---
    @property
    def vad(self) -> Path:
        return self.root / "vad" / "silero_vad.onnx"

    # --- speech to text ---
    @property
    def stt_en_dir(self) -> Path:
        return self.root / "stt-en" / PARAKEET_DIR

    @property
    def stt_bn_dir(self) -> Path:
        return self.root / "stt-bn" / "indicconformer-bn"

    def stt_bn_model(self, variant: str) -> Path:
        return self.stt_bn_dir / ("model.int8.onnx" if variant == "int8" else "model.onnx")

    @property
    def stt_fallback_dir(self) -> Path:
        return self.root / "stt-fallback" / OMNILINGUAL_DIR

    # --- language identification ---
    @property
    def lid_dir(self) -> Path:
        return self.root / "lid" / "voxlingua107-ecapa"

    # --- text to speech ---
    @property
    def tts_dir(self) -> Path:
        return self.root / "tts"

    @property
    def coqui_bn_dir(self) -> Path:
        return self.tts_dir / COQUI_BN_DIR

    @property
    def piper_bn_dir(self) -> Path:
        return self.tts_dir / PIPER_BN_DIR

    @property
    def piper_en_dir(self) -> Path:
        return self.tts_dir / PIPER_EN_DIR

    def kokoro_dir(self, variant: str) -> Path:
        return self.tts_dir / (KOKORO_INT8_DIR if variant == "int8" else KOKORO_DIR)

    @property
    def espeak_data_dir(self) -> Path:
        # One copy of espeak-ng-data, shared by every piper-style voice (the Kokoro and piper
        # tarballs ship identical copies; this one comes from the piper English tarball).
        return self.piper_en_dir / "espeak-ng-data"

    @property
    def downloads_dir(self) -> Path:
        return self.root / "downloads"
