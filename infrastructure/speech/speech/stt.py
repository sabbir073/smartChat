"""
Speech to text: one sherpa-onnx recogniser per language, plus the optional one-model fallback.

  bn  IndicConformer-bn (AI4Bharat, MIT), CTC branch, fp32 by default. The int8 variant is
      smaller (about 350 MB less RSS) but measured slower here and made one more mistake on the
      three reference clips, so it is opt-in (SPEECH_STT_BN_VARIANT=int8).
  en  Parakeet-TDT 0.6B v3 int8 (NVIDIA, CC-BY-4.0), a 25-language transducer; it also happens
      to produce readable romanised Bengali when LID is wrong, which is why LID is consulted.
  fallback  Omnilingual ASR 300M CTC v2 int8 (Meta, Apache-2.0), 1600 languages, only when
      SPEECH_STT_FALLBACK=omnilingual; stands in for the Bengali model when that cannot load.

Every recogniser is created once with at most two intra-op threads and shared by all sessions:
sherpa-onnx streams are per call, the ONNX Runtime session is thread-safe, and two decodes can
run at the same time inside the four-thread budget.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np
import sherpa_onnx

from speech.audio import STT_SAMPLE_RATE
from speech.config import Settings
from speech.layout import ModelPaths

_SPACES_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class Transcript:
    text: str
    language: str
    model: str
    decode_ms: int


class Recogniser(Protocol):
    name: str
    language: str

    def transcribe(self, audio: np.ndarray, sample_rate: int = STT_SAMPLE_RATE) -> Transcript: ...


class ModelLoadError(RuntimeError):
    pass


class SherpaRecogniser:
    def __init__(self, name: str, language: str, recognizer: sherpa_onnx.OfflineRecognizer) -> None:
        self.name = name
        self.language = language
        self._recognizer = recognizer

    def transcribe(self, audio: np.ndarray, sample_rate: int = STT_SAMPLE_RATE) -> Transcript:
        started = time.monotonic()
        text = ""
        if audio.size >= sample_rate // 20:  # under 50 ms there is nothing to decode
            stream = self._recognizer.create_stream()
            stream.accept_waveform(sample_rate, audio.astype(np.float32, copy=False))
            self._recognizer.decode_stream(stream)
            text = _SPACES_RE.sub(" ", stream.result.text).strip()
        return Transcript(text=text, language=self.language, model=self.name, decode_ms=int((time.monotonic() - started) * 1000))


def _require(path: Path, what: str) -> str:
    if not path.exists():
        raise ModelLoadError(f"{what} is missing: {path} (run download_models.py)")
    return str(path)


def load_bengali(paths: ModelPaths, settings: Settings) -> SherpaRecogniser:
    model = _require(paths.stt_bn_model(settings.stt_bn_variant), f"IndicConformer-bn {settings.stt_bn_variant} model")
    tokens = _require(paths.stt_bn_dir / "tokens.txt", "IndicConformer-bn tokens")
    recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
        model=model,
        tokens=tokens,
        num_threads=settings.stt_threads,
        sample_rate=STT_SAMPLE_RATE,
        feature_dim=80,
        decoding_method="greedy_search",
        provider=settings.ort_provider(),
    )
    return SherpaRecogniser("indicconformer-bn" + ("-int8" if settings.stt_bn_variant == "int8" else ""), "bn", recognizer)


def load_english(paths: ModelPaths, settings: Settings) -> SherpaRecogniser:
    directory = paths.stt_en_dir
    recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=_require(directory / "encoder.int8.onnx", "Parakeet encoder"),
        decoder=_require(directory / "decoder.int8.onnx", "Parakeet decoder"),
        joiner=_require(directory / "joiner.int8.onnx", "Parakeet joiner"),
        tokens=_require(directory / "tokens.txt", "Parakeet tokens"),
        num_threads=settings.stt_threads,
        sample_rate=STT_SAMPLE_RATE,
        feature_dim=80,
        decoding_method="greedy_search",
        model_type="nemo_transducer",
        provider=settings.ort_provider(),
    )
    return SherpaRecogniser("parakeet-tdt-0.6b-v3-int8", "en", recognizer)


def load_omnilingual(paths: ModelPaths, settings: Settings) -> SherpaRecogniser:
    directory = paths.stt_fallback_dir
    recognizer = sherpa_onnx.OfflineRecognizer.from_omnilingual_asr_ctc(
        model=_require(directory / "model.int8.onnx", "Omnilingual model"),
        tokens=_require(directory / "tokens.txt", "Omnilingual tokens"),
        num_threads=settings.stt_threads,
        decoding_method="greedy_search",
        provider=settings.ort_provider(),
    )
    return SherpaRecogniser("omnilingual-ctc-300m-v2-int8", "bn", recognizer)
