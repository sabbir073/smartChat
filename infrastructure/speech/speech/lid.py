"""
Spoken language identification, restricted to the two languages the agent speaks.

speechbrain's VoxLingua107 ECAPA-TDNN classifier scores 107 languages; only the Bengali and
English logits are read and the probability is renormalised over those two, so a Bangladeshi
caller whose accent drifts the top-1 towards Assamese or Hindi still comes out as Bengali. This
is the only place torch is used, which is why torch's thread count is pinned here: speechbrain
runs on the executor threads, next to the ONNX recognisers, inside the same CPU budget.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from speech.audio import STT_SAMPLE_RATE
from speech.config import LANGUAGES
from speech.stt import ModelLoadError

# The language of an utterance does not change after its first seconds, and the classifier's
# cost grows with length (about 100 ms per second of audio on two threads), so an utterance is
# judged on at most four seconds of it: measured on the reference clips, two seconds already
# give a confident, correct answer, and four cost about 430 ms. The slice starts a little after
# the utterance begins, past the prefix padding, when there is enough audio to spare.
MAX_SECONDS = 4.0
SKIP_SECONDS = 0.25


@dataclass(frozen=True)
class LidResult:
    language: str
    confidence: float
    probabilities: dict[str, float]
    top: str  # the classifier's own top-1 label among all 107, for the logs
    ms: int


class LanguageIdentifier:
    def __init__(self, directory: Path, threads: int) -> None:
        if not (directory / "hyperparams.yaml").exists():
            raise ModelLoadError(f"language-ID model is missing: {directory} (run download_models.py)")
        import torch

        torch.set_num_threads(threads)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass  # already set by an earlier import; only possible to do once per process
        for name in ("speechbrain", "speechbrain.utils.checkpoints", "speechbrain.utils.parameter_transfer"):
            logging.getLogger(name).setLevel(logging.WARNING)
        from speechbrain.inference.classifiers import EncoderClassifier

        # `pretrained_path` in hyperparams.yaml points at the HF repo; overriding it with the
        # local directory keeps speechbrain from touching the network or an HF cache.
        self._torch = torch
        self._classifier = EncoderClassifier.from_hparams(
            source=str(directory),
            savedir=str(directory),
            overrides={"pretrained_path": str(directory)},
            run_opts={"device": "cpu"},
        )
        self._classifier.eval()
        encoder = self._classifier.hparams.label_encoder
        labels = {str(encoder.ind2lab[i]): i for i in range(len(encoder.ind2lab))}
        encoder.expect_len(len(labels))  # 107 languages; otherwise speechbrain warns on every load
        self._index = {}
        for language in LANGUAGES:
            matches = [i for label, i in labels.items() if label.startswith(f"{language}:")]
            if not matches:
                raise ModelLoadError(f"language-ID label set has no entry for {language!r}")
            self._index[language] = matches[0]
        self._labels = {i: label for label, i in labels.items()}

    def identify(self, audio: np.ndarray, sample_rate: int = STT_SAMPLE_RATE) -> LidResult:
        started = time.monotonic()
        torch = self._torch
        limit = int(MAX_SECONDS * sample_rate)
        offset = min(int(SKIP_SECONDS * sample_rate), max(0, audio.size - limit))
        clip = audio[offset : offset + limit]
        if clip.size < sample_rate // 4:
            # A quarter second is below what the embedding can judge; say "undecided" honestly.
            return LidResult(language="", confidence=0.5, probabilities={lang: 0.5 for lang in LANGUAGES}, top="", ms=0)
        with torch.inference_mode():
            wav = torch.from_numpy(np.ascontiguousarray(clip, dtype=np.float32)).unsqueeze(0)
            log_probs, _score, index, _label = self._classifier.classify_batch(wav)
        row = log_probs[0]
        pair = torch.softmax(torch.stack([row[self._index[lang]] for lang in LANGUAGES]), dim=0).tolist()
        probabilities = {lang: round(float(p), 4) for lang, p in zip(LANGUAGES, pair, strict=True)}
        language = max(probabilities, key=probabilities.get)
        return LidResult(
            language=language,
            confidence=probabilities[language],
            probabilities=probabilities,
            top=self._labels.get(int(index[0]), ""),
            ms=int((time.monotonic() - started) * 1000),
        )
