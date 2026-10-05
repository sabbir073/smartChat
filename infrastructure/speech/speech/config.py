"""
Everything the service reads from its environment, in one place.

The container is configured only through environment variables (compose sets them), so every
knob is parsed here once, validated, and handed around as a frozen `Settings` object. Nothing
else in the package calls `os.environ`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

LANGUAGES = ("bn", "en")


def _int(name: str, default: int, minimum: int = 0, maximum: int | None = None) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from error
    if value < minimum or (maximum is not None and value > maximum):
        raise ValueError(f"{name} must be between {minimum} and {maximum}, got {value}")
    return value


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    port: int
    token: str
    models_dir: Path
    # Total CPU budget for inference. The container gets ~4 CPUs, so the default is 4: one
    # ThreadPoolExecutor of this many workers runs every model call, and each recogniser gets
    # at most two intra-op threads so two utterances can be decoded at the same time.
    threads: int
    max_sessions: int
    stt_fallback: str  # "" or "omnilingual"
    default_language: str  # the sticky language a session starts with
    provider: str  # sherpa-onnx execution provider: cpu now, cuda later
    stt_bn_variant: str  # "fp32" (the reference accuracy) or "int8"
    kokoro_variant: str  # "fp32" or "int8"
    verify_checksums: bool
    log_level: str

    @property
    def stt_threads(self) -> int:
        return max(1, min(2, self.threads))

    @property
    def tts_threads(self) -> int:
        return max(1, min(2, self.threads))

    @property
    def lid_threads(self) -> int:
        return max(1, min(2, self.threads))

    @classmethod
    def from_env(cls) -> Settings:
        fallback = os.environ.get("SPEECH_STT_FALLBACK", "").strip().lower()
        if fallback not in ("", "none", "omnilingual"):
            raise ValueError(f"SPEECH_STT_FALLBACK must be empty or 'omnilingual', got {fallback!r}")
        default_language = os.environ.get("SPEECH_DEFAULT_LANGUAGE", "en").strip().lower() or "en"
        if default_language not in LANGUAGES:
            raise ValueError(f"SPEECH_DEFAULT_LANGUAGE must be one of {LANGUAGES}, got {default_language!r}")
        stt_bn_variant = os.environ.get("SPEECH_STT_BN_VARIANT", "fp32").strip().lower() or "fp32"
        if stt_bn_variant not in ("fp32", "int8"):
            raise ValueError(f"SPEECH_STT_BN_VARIANT must be fp32 or int8, got {stt_bn_variant!r}")
        kokoro_variant = os.environ.get("SPEECH_KOKORO_VARIANT", "fp32").strip().lower() or "fp32"
        if kokoro_variant not in ("fp32", "int8"):
            raise ValueError(f"SPEECH_KOKORO_VARIANT must be fp32 or int8, got {kokoro_variant!r}")
        return cls(
            port=_int("PORT", 3010, 1, 65535),
            token=os.environ.get("SPEECH_TOKEN", "").strip(),
            models_dir=Path(os.environ.get("SPEECH_MODELS_DIR", "/models")).expanduser(),
            threads=_int("SPEECH_THREADS", 4, 1, 64),
            max_sessions=_int("SPEECH_MAX_SESSIONS", 8, 1, 256),
            stt_fallback="" if fallback == "none" else fallback,
            default_language=default_language,
            provider=os.environ.get("SPEECH_PROVIDER", "cpu").strip().lower() or "cpu",
            stt_bn_variant=stt_bn_variant,
            kokoro_variant=kokoro_variant,
            verify_checksums=_bool("SPEECH_VERIFY_CHECKSUMS", True),
            log_level=os.environ.get("SPEECH_LOG_LEVEL", "info").strip().lower() or "info",
        )
