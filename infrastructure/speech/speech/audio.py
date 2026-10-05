"""
Audio plumbing: PCM16 bytes <-> float32 samples, resampling, WAV decoding.

Everything inside the service is mono float32 in [-1, 1]; the wire formats are PCM16LE (the WS
stream in, the TTS stream out) and WAV (the one-shot transcribe endpoint). Resampling is done by
libsoxr (python-soxr), a proper band-limited resampler: the telephony leg arrives at 48 kHz from
WebRTC and the TTS voices synthesise at 22.05 or 24 kHz, and a cheap resampler would put
aliasing straight into the recogniser and the caller's ear.
"""

from __future__ import annotations

import io

import numpy as np
import soundfile as sf
import soxr

STT_SAMPLE_RATE = 16_000
SUPPORTED_INPUT_RATES = (16_000, 48_000)
SUPPORTED_OUTPUT_RATES = (8_000, 16_000, 22_050, 24_000, 44_100, 48_000)


def pcm16_to_float(data: bytes) -> np.ndarray:
    """PCM16LE bytes to float32 samples; an odd trailing byte is dropped."""
    usable = len(data) - (len(data) % 2)
    if usable <= 0:
        return np.zeros(0, dtype=np.float32)
    samples = np.frombuffer(data, dtype="<i2", count=usable // 2)
    return samples.astype(np.float32) / 32768.0


def float_to_pcm16(samples: np.ndarray) -> bytes:
    """float32 samples to PCM16LE bytes, clipped rather than wrapped."""
    clipped = np.clip(samples, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def resample(samples: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    """One-shot resampling for whole utterances and TTS sentences."""
    if from_rate == to_rate or samples.size == 0:
        return samples.astype(np.float32, copy=False)
    return soxr.resample(samples.astype(np.float32, copy=False), from_rate, to_rate, quality="HQ").astype(np.float32, copy=False)


class StreamResampler:
    """
    Resamples a live stream frame by frame with continuous filter state, so frame boundaries do
    not click. A pass-through when the rates match.
    """

    def __init__(self, from_rate: int, to_rate: int) -> None:
        self.from_rate = from_rate
        self.to_rate = to_rate
        self._stream = None if from_rate == to_rate else soxr.ResampleStream(from_rate, to_rate, 1, dtype="float32", quality="HQ")

    def process(self, samples: np.ndarray, last: bool = False) -> np.ndarray:
        if self._stream is None:
            return samples.astype(np.float32, copy=False)
        return self._stream.resample_chunk(samples.astype(np.float32, copy=False), last=last)


def decode_wav(data: bytes) -> tuple[np.ndarray, int]:
    """Any libsndfile-readable container to mono float32 plus its sample rate."""
    samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    mono = samples.mean(axis=1) if samples.shape[1] > 1 else samples[:, 0]
    return np.ascontiguousarray(mono, dtype=np.float32), int(rate)


def encode_wav(samples: np.ndarray, rate: int) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, np.clip(samples, -1.0, 1.0), rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def to_stt_rate(samples: np.ndarray, rate: int) -> np.ndarray:
    return resample(samples, rate, STT_SAMPLE_RATE)


def silence(ms: int, rate: int) -> np.ndarray:
    return np.zeros(int(rate * ms / 1000), dtype=np.float32)


def rms(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))


def duration_ms(samples: np.ndarray, rate: int) -> int:
    return int(round(1000 * samples.size / rate))
