"""
Text to speech: five voices behind one pipeline.

  bn_female  Coqui VITS, Bengali, single speaker (Apache-2.0)        22.05 kHz
  bn_bd      piper bn_BD-google-medium, 16 Bangladeshi speakers       22.05 kHz
  en_female  Kokoro v0.19, speaker af_bella (Apache-2.0)              24 kHz
  en_male    Kokoro v0.19, speaker am_michael                         24 kHz
  en_piper   piper en_US-libritts_r-medium, 904 speakers (CC-BY-4.0) 22.05 kHz

A reply is cleaned, split into sentences, each sentence into runs of one script, and each run
is synthesised by the voice for its language: Bengali runs with the requested Bengali voice,
Latin runs with the English default (or the other way round for an English request), joined
with 120 ms of silence. Bengali runs have their digits spelled out first, because neither
Bengali model can read numerals. Every synthesised run is loudness-matched, so a sentence that
switches voices does not jump in volume, and cached, so the greeting and the "one moment" phrases
cost nothing after the first call.

`plan()` is pure text work and runs on the event loop; `render()` runs the model and belongs on
the executor. sherpa-onnx's OfflineTts is safe to call from several threads (ONNX Runtime is,
and sherpa-onnx serialises espeak-ng, which is not).
"""

from __future__ import annotations

import collections
import hashlib
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import sherpa_onnx

from speech.audio import resample, silence
from speech.config import LANGUAGES, Settings
from speech.layout import ModelPaths
from speech.stt import ModelLoadError
from speech.text.bn_numbers import BENGALI_DIGITS, normalize_numbers
from speech.text.clean import clean_text, expand_hash_numbers, expand_taka_for_english
from speech.text.sentences import split_script_runs, split_sentences

RUN_GAP_MS = 120  # between a Bengali run and a Latin run inside one sentence
SENTENCE_GAP_MS = 160  # between sentences; the models end abruptly without it
TARGET_RMS = 0.08  # about -22 dBFS: comfortable on a phone line, with headroom
MAX_PEAK = 0.95
MAX_GAIN = 4.0
MIN_GAIN = 0.1
CACHE_ENTRIES = 200
CACHE_BYTES = 50 * 1024 * 1024
DEFAULT_VOICE = {"bn": "bn_female", "en": "en_female"}
MAX_TEXT_CHARS = 5000


@dataclass(frozen=True)
class VoiceInfo:
    id: str
    language: str
    name: str
    speakers: int
    sample_rate: int
    engine: str
    licence: str
    fixed_speaker: int | None = None  # Kokoro voices are one named speaker of a multi-speaker model


@dataclass(frozen=True)
class Unit:
    """One run of text for one voice: the unit of synthesis and of caching."""

    voice: str
    speaker: int
    speed: float
    text: str
    language: str

    @property
    def key(self) -> str:
        digest = hashlib.sha1(self.text.encode("utf-8")).hexdigest()
        return f"{self.voice}|{self.speaker}|{self.speed:.2f}|{digest}"


@dataclass(frozen=True)
class Sentence:
    text: str
    units: tuple[Unit, ...]


@dataclass(frozen=True)
class Plan:
    language: str
    voice: str
    speaker: int
    speed: float
    sample_rate: int
    sentences: tuple[Sentence, ...]
    cached: bool  # every unit was already in the cache when the plan was made


@dataclass
class _CacheEntry:
    audio: np.ndarray
    duration_ms: int


class TtsCache:
    """LRU by entry count and by bytes; thread-safe, since renders happen on executor threads."""

    def __init__(self, max_entries: int = CACHE_ENTRIES, max_bytes: int = CACHE_BYTES) -> None:
        self._entries: collections.OrderedDict[str, _CacheEntry] = collections.OrderedDict()
        self._bytes = 0
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> _CacheEntry | None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                self.misses += 1
                return None
            self._entries.move_to_end(key)
            self.hits += 1
            return entry

    def peek(self, key: str) -> bool:
        with self._lock:
            return key in self._entries

    def put(self, key: str, entry: _CacheEntry) -> None:
        size = entry.audio.nbytes
        if size > self._max_bytes:
            return
        with self._lock:
            old = self._entries.pop(key, None)
            if old is not None:
                self._bytes -= old.audio.nbytes
            self._entries[key] = entry
            self._bytes += size
            while self._entries and (len(self._entries) > self._max_entries or self._bytes > self._max_bytes):
                _, evicted = self._entries.popitem(last=False)
                self._bytes -= evicted.audio.nbytes

    @property
    def stats(self) -> dict[str, int]:
        with self._lock:
            return {"entries": len(self._entries), "bytes": self._bytes, "hits": self.hits, "misses": self.misses}


# The Coqui voice's character set uses the danda as its end-of-sequence symbol (eos: "।" in its
# config), so a danda inside the text is an EOS token mid-sentence: measured by ASR round trip,
# three of six sentences ending in "।" came back with a trailing vocalisation ("করুনও",
# "হবিডজ"), none did with ".". Its vocabulary also lacks ";" and ":".
_COQUI_FIXES = str.maketrans({"।": ".", ";": ",", ":": ","})


class Voice:
    def __init__(self, info: VoiceInfo, tts: sherpa_onnx.OfflineTts) -> None:
        self.info = info
        self._tts = tts

    def synthesize(self, text: str, speaker: int, speed: float) -> np.ndarray:
        sid = self.info.fixed_speaker if self.info.fixed_speaker is not None else speaker
        if self.info.engine == "vits-coqui":
            text = text.translate(_COQUI_FIXES)
        generated = self._tts.generate(text, sid=sid, speed=speed)
        audio = np.asarray(generated.samples, dtype=np.float32)
        if generated.sample_rate != self.info.sample_rate:
            audio = resample(audio, generated.sample_rate, self.info.sample_rate)
        return audio


def _require(path: Path, what: str) -> str:
    if not path.exists():
        raise ModelLoadError(f"{what} is missing: {path} (run download_models.py)")
    return str(path)


def _vits(model: Path, tokens: Path, data_dir: Path | None, threads: int, provider: str) -> sherpa_onnx.OfflineTts:
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=_require(model, "TTS model"),
                tokens=_require(tokens, "TTS tokens"),
                data_dir=_require(data_dir, "espeak-ng-data") if data_dir else "",
            ),
            num_threads=threads,
            provider=provider,
        ),
        max_num_sentences=1,
    )
    if not config.validate():
        raise ModelLoadError(f"sherpa-onnx rejected the VITS configuration for {model}")
    return sherpa_onnx.OfflineTts(config)


def _kokoro(directory: Path, model_file: str, threads: int, provider: str) -> sherpa_onnx.OfflineTts:
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=_require(directory / model_file, "Kokoro model"),
                voices=_require(directory / "voices.bin", "Kokoro voices"),
                tokens=_require(directory / "tokens.txt", "Kokoro tokens"),
                data_dir=_require(directory / "espeak-ng-data", "Kokoro espeak-ng-data"),
            ),
            num_threads=threads,
            provider=provider,
        ),
        max_num_sentences=1,
    )
    if not config.validate():
        raise ModelLoadError(f"sherpa-onnx rejected the Kokoro configuration in {directory}")
    return sherpa_onnx.OfflineTts(config)


def kokoro_speakers(model_path: Path) -> dict[str, int]:
    """The speaker table from the model's own metadata ("af->0,af_bella->1,...")."""
    import onnx

    model = onnx.load(str(model_path), load_external_data=False)
    for prop in model.metadata_props:
        if prop.key == "speaker2id":
            pairs = (item.split("->", 1) for item in prop.value.split(",") if "->" in item)
            return {name.strip(): int(index) for name, index in pairs}
    raise ModelLoadError(f"{model_path} has no speaker2id metadata")


def load_voices(paths: ModelPaths, settings: Settings) -> dict[str, Voice]:
    """Every voice, loaded once; a missing model raises so the service refuses to start."""
    threads, provider = settings.tts_threads, settings.ort_provider()
    voices: dict[str, Voice] = {}

    coqui = _vits(paths.coqui_bn_dir / "model.onnx", paths.coqui_bn_dir / "tokens.txt", None, threads, provider)
    voices["bn_female"] = Voice(VoiceInfo("bn_female", "bn", "Bengali female (studio)", 1, coqui.sample_rate, "vits-coqui", "Apache-2.0"), coqui)

    piper_bn = _vits(paths.piper_bn_dir / "bn_BD-google-medium.onnx", paths.piper_bn_dir / "tokens.txt", paths.espeak_data_dir, threads, provider)
    voices["bn_bd"] = Voice(
        VoiceInfo("bn_bd", "bn", f"Bengali, Bangladesh (Piper, {piper_bn.num_speakers} speakers)", piper_bn.num_speakers, piper_bn.sample_rate, "vits-piper", "CC-BY-SA-4.0 data / MIT"),
        piper_bn,
    )

    kokoro_dir = paths.kokoro_dir(settings.kokoro_variant)
    model_file = "model.int8.onnx" if settings.kokoro_variant == "int8" else "model.onnx"
    kokoro = _kokoro(kokoro_dir, model_file, threads, provider)
    speakers = kokoro_speakers(kokoro_dir / model_file)
    female = next((speakers[name] for name in ("af_heart", "af_bella", "af") if name in speakers), None)
    male = next((speakers[name] for name in ("am_michael", "am_adam") if name in speakers), None)
    if female is None or male is None:
        raise ModelLoadError(f"Kokoro speaker table lacks the expected voices: {sorted(speakers)}")
    female_name = next(name for name, index in speakers.items() if index == female)
    male_name = next(name for name, index in speakers.items() if index == male)
    voices["en_female"] = Voice(VoiceInfo("en_female", "en", f"English female (Kokoro {female_name})", 1, kokoro.sample_rate, "kokoro", "Apache-2.0", fixed_speaker=female), kokoro)
    voices["en_male"] = Voice(VoiceInfo("en_male", "en", f"English male (Kokoro {male_name})", 1, kokoro.sample_rate, "kokoro", "Apache-2.0", fixed_speaker=male), kokoro)

    piper_en = _vits(paths.piper_en_dir / "en_US-libritts_r-medium.onnx", paths.piper_en_dir / "tokens.txt", paths.espeak_data_dir, threads, provider)
    voices["en_piper"] = Voice(
        VoiceInfo("en_piper", "en", f"English, US (Piper LibriTTS-R, {piper_en.num_speakers} speakers)", piper_en.num_speakers, piper_en.sample_rate, "vits-piper", "CC-BY-4.0 data / MIT"),
        piper_en,
    )
    return voices


class TtsError(ValueError):
    """A request the pipeline cannot honour (unknown voice, speaker out of range)."""


@dataclass
class RenderStats:
    synth_ms: int = 0
    cached_units: int = 0
    rendered_units: int = 0
    audio_ms: int = 0
    units: list[str] = field(default_factory=list)


class TtsEngine:
    def __init__(self, voices: dict[str, Voice], cache: TtsCache | None = None) -> None:
        self.voices = voices
        self.cache = cache or TtsCache()
        for language, voice in DEFAULT_VOICE.items():
            if voice not in voices:
                raise ModelLoadError(f"default voice {voice!r} for {language} is not loaded")

    def infos(self) -> list[VoiceInfo]:
        return [voice.info for voice in self.voices.values()]

    # --- planning (text only) ---

    def plan(self, text: str, language: str, voice: str | None, speaker: int, speed: float, sample_rate: int) -> Plan:
        if language not in LANGUAGES:
            raise TtsError(f"language must be one of {LANGUAGES}")
        voice_id = voice or DEFAULT_VOICE[language]
        chosen = self.voices.get(voice_id)
        if chosen is None:
            raise TtsError(f"unknown voice {voice_id!r}")
        if chosen.info.language != language:
            raise TtsError(f"voice {voice_id!r} speaks {chosen.info.language}, not {language}")
        if chosen.info.fixed_speaker is None and not 0 <= speaker < chosen.info.speakers:
            raise TtsError(f"speakerId must be between 0 and {chosen.info.speakers - 1} for {voice_id!r}")
        if not 0.5 <= speed <= 2.0:
            raise TtsError("speed must be between 0.5 and 2.0")
        if len(text) > MAX_TEXT_CHARS:
            raise TtsError(f"text is longer than {MAX_TEXT_CHARS} characters")

        other = "en" if language == "bn" else "bn"
        voice_for = {language: voice_id, other: DEFAULT_VOICE[other]}
        speaker_for = {language: speaker, other: 0}
        sentences: list[Sentence] = []
        for sentence in split_sentences(clean_text(text, language)):
            units = []
            for run in split_script_runs(sentence, language):
                spoken = self._normalise_run(run.text, run.language)
                if spoken:
                    units.append(Unit(voice_for[run.language], speaker_for[run.language], round(speed, 2), spoken, run.language))
            if units:
                sentences.append(Sentence(sentence, tuple(units)))
        cached = bool(sentences) and all(self.cache.peek(unit.key) for sentence in sentences for unit in sentence.units)
        return Plan(language, voice_id, speaker, speed, sample_rate, tuple(sentences), cached)

    @staticmethod
    def _normalise_run(text: str, language: str) -> str:
        text = expand_hash_numbers(text, language)
        if language == "bn":
            return normalize_numbers(text).strip()
        # English runs: the taka sign and Bengali digits are the only Bengali-block characters
        # that can reach an English voice; make them readable.
        return expand_taka_for_english(text.translate(BENGALI_DIGITS)).strip()

    def cached_duration_ms(self, plan: Plan) -> int | None:
        """Total duration of a fully cached plan, or None when anything would have to be rendered."""
        total = 0
        for index, sentence in enumerate(plan.sentences):
            for position, unit in enumerate(sentence.units):
                entry = self.cache.get(unit.key)
                if entry is None:
                    return None
                total += entry.duration_ms + (RUN_GAP_MS if position else 0)
            total += SENTENCE_GAP_MS if index else 0
        return total

    # --- rendering (model work; call on the executor) ---

    def render_unit(self, unit: Unit, stats: RenderStats | None = None) -> np.ndarray:
        entry = self.cache.get(unit.key)
        voice = self.voices[unit.voice]
        if entry is None:
            started = time.monotonic()
            audio = _match_loudness(voice.synthesize(unit.text, unit.speaker, unit.speed))
            entry = _CacheEntry(audio, int(1000 * audio.size / voice.info.sample_rate))
            self.cache.put(unit.key, entry)
            if stats is not None:
                stats.synth_ms += int((time.monotonic() - started) * 1000)
                stats.rendered_units += 1
        elif stats is not None:
            stats.cached_units += 1
        if stats is not None:
            stats.audio_ms += entry.duration_ms
            stats.units.append(unit.key)
        return entry.audio

    def render_sentence(self, sentence: Sentence, sample_rate: int, first: bool, stats: RenderStats | None = None) -> np.ndarray:
        """One sentence at the requested rate, with the pause that precedes it (unless first)."""
        pieces: list[np.ndarray] = []
        if not first:
            pieces.append(silence(SENTENCE_GAP_MS, sample_rate))
        for position, unit in enumerate(sentence.units):
            if position:
                pieces.append(silence(RUN_GAP_MS, sample_rate))
            audio = self.render_unit(unit, stats)
            pieces.append(resample(audio, self.voices[unit.voice].info.sample_rate, sample_rate))
        return np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)


def _match_loudness(audio: np.ndarray) -> np.ndarray:
    if audio.size == 0:
        return audio
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
    peak = float(np.max(np.abs(audio)))
    if rms <= 1e-5 or peak <= 1e-5:
        return audio
    gain = min(max(TARGET_RMS / rms, MIN_GAIN), MAX_GAIN, MAX_PEAK / peak)
    return (audio * gain).astype(np.float32, copy=False)
