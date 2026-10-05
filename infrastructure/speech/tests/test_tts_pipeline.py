"""The TTS pipeline around the voices: planning, script runs, caching, loudness. No models."""

from __future__ import annotations

import numpy as np
import pytest

from speech.tts import RUN_GAP_MS, SENTENCE_GAP_MS, TARGET_RMS, TtsCache, TtsEngine, TtsError, Voice, VoiceInfo, _CacheEntry, _match_loudness


class FakeTts:
    """Stands in for sherpa_onnx.OfflineTts: 100 ms of noise per 10 characters, at a fixed rate."""

    def __init__(self, sample_rate: int, speakers: int = 1) -> None:
        self.sample_rate = sample_rate
        self.num_speakers = speakers
        self.calls: list[tuple[str, int, float]] = []

    def generate(self, text: str, sid: int = 0, speed: float = 1.0) -> FakeAudio:
        self.calls.append((text, sid, speed))
        n = int(self.sample_rate * max(1, len(text)) / 100)
        rng = np.random.default_rng(len(text))
        return FakeAudio(rng.uniform(-0.2, 0.2, n).astype(np.float32).tolist(), self.sample_rate)


class FakeAudio:
    def __init__(self, samples: list[float], sample_rate: int) -> None:
        self.samples = samples
        self.sample_rate = sample_rate


def make_engine() -> tuple[TtsEngine, dict[str, FakeTts]]:
    fakes = {
        "bn_female": FakeTts(22050),
        "bn_bd": FakeTts(22050, speakers=16),
        "en_female": FakeTts(24000, speakers=11),
        "en_male": FakeTts(24000, speakers=11),
        "en_piper": FakeTts(22050, speakers=904),
    }
    voices = {
        "bn_female": Voice(VoiceInfo("bn_female", "bn", "f", 1, 22050, "fake", "x"), fakes["bn_female"]),
        "bn_bd": Voice(VoiceInfo("bn_bd", "bn", "bd", 16, 22050, "fake", "x"), fakes["bn_bd"]),
        "en_female": Voice(VoiceInfo("en_female", "en", "ef", 1, 24000, "fake", "x", fixed_speaker=1), fakes["en_female"]),
        "en_male": Voice(VoiceInfo("en_male", "en", "em", 1, 24000, "fake", "x", fixed_speaker=6), fakes["en_male"]),
        "en_piper": Voice(VoiceInfo("en_piper", "en", "ep", 904, 22050, "fake", "x"), fakes["en_piper"]),
    }
    return TtsEngine(voices, TtsCache(max_entries=4, max_bytes=10_000_000)), fakes


def test_plan_bengali_with_numbers_and_markdown() -> None:
    engine, _ = make_engine()
    plan = engine.plan("**হ্যালো!** আপনার অর্ডার ১৫০০ টাকায় নিশ্চিত হয়েছে। দেখুন https://x.com", "bn", None, 0, 1.0, 24000)
    assert plan.voice == "bn_female" and plan.cached is False
    assert [s.text for s in plan.sentences] == ["হ্যালো!", "আপনার অর্ডার ১৫০০ টাকায় নিশ্চিত হয়েছে।", "দেখুন আমাদের ওয়েবসাইট"]
    assert plan.sentences[1].units[0].text == "আপনার অর্ডার এক হাজার পাঁচশো টাকায় নিশ্চিত হয়েছে।"
    assert all(unit.voice == "bn_female" for s in plan.sentences for unit in s.units)


def test_plan_mixed_scripts_uses_a_voice_per_run() -> None:
    engine, _ = make_engine()
    plan = engine.plan("GetChat এ স্বাগতম, your order #1500 is ready।", "bn", "bn_bd", 3, 1.0, 16000)
    units = plan.sentences[0].units
    assert [(u.voice, u.language, u.speaker) for u in units] == [("en_female", "en", 0), ("bn_bd", "bn", 3), ("en_female", "en", 0)]
    assert units[2].text == "your order number 1500 is ready।"
    plan_en = engine.plan("Your bill is ৳250, ধন্যবাদ।", "en", "en_male", 0, 1.2, 24000)
    units = plan_en.sentences[0].units
    assert [(u.voice, u.text) for u in units] == [("en_male", "Your bill is 250 taka,"), ("bn_female", "ধন্যবাদ।")]
    assert units[0].speed == 1.2


def test_plan_rejects_bad_requests() -> None:
    engine, _ = make_engine()
    with pytest.raises(TtsError):
        engine.plan("hi", "en", "bn_female", 0, 1.0, 24000)  # voice of the wrong language
    with pytest.raises(TtsError):
        engine.plan("hi", "bn", "nope", 0, 1.0, 24000)
    with pytest.raises(TtsError):
        engine.plan("hi", "bn", "bn_bd", 16, 1.0, 24000)  # 16 speakers: 0-15
    with pytest.raises(TtsError):
        engine.plan("hi", "en", None, 0, 3.0, 24000)
    assert engine.plan("", "en", None, 0, 1.0, 24000).sentences == ()
    assert engine.plan("🎉", "en", None, 0, 1.0, 24000).sentences == ()


def test_render_concatenates_runs_with_gaps_and_resamples() -> None:
    engine, fakes = make_engine()
    plan = engine.plan("Hello there. আপনাকে স্বাগতম।", "en", None, 0, 1.0, 16000)
    first = engine.render_sentence(plan.sentences[0], 16000, first=True)
    second = engine.render_sentence(plan.sentences[1], 16000, first=False)
    assert first.dtype == np.float32
    # "Hello there." is 12 chars -> 120 ms at 24 kHz from the fake, resampled to 16 kHz
    assert abs(first.size - int(16000 * 0.12)) <= 32
    assert second.size >= int(16000 * SENTENCE_GAP_MS / 1000)
    assert np.all(second[: int(16000 * SENTENCE_GAP_MS / 1000) - 1] == 0)
    mixed = engine.plan("Hi বন্ধু", "en", None, 0, 1.0, 16000)
    audio = engine.render_sentence(mixed.sentences[0], 16000, first=True)
    gap = int(16000 * RUN_GAP_MS / 1000)
    assert audio.size >= gap + int(16000 * 0.02) + int(16000 * 0.05)
    assert fakes["en_female"].calls[-1][0] == "Hi" and fakes["bn_female"].calls[-1][0] == "বন্ধু"


def test_cache_hits_by_voice_speaker_speed_and_text() -> None:
    engine, fakes = make_engine()
    plan = engine.plan("Hold on please.", "en", None, 0, 1.0, 24000)
    assert not plan.cached
    engine.render_sentence(plan.sentences[0], 24000, first=True)
    assert len(fakes["en_female"].calls) == 1
    again = engine.plan("Hold on please.", "en", None, 0, 1.0, 24000)
    assert again.cached is True
    assert engine.cached_duration_ms(again) == int(1000 * len("Hold on please.") / 100)
    engine.render_sentence(again.sentences[0], 24000, first=True)
    assert len(fakes["en_female"].calls) == 1  # served from the cache
    assert engine.cache.stats["hits"] >= 1
    # a different speed, speaker or voice is a different entry
    assert engine.plan("Hold on please.", "en", None, 0, 1.1, 24000).cached is False
    assert engine.plan("Hold on please.", "en", "en_male", 0, 1.0, 24000).cached is False
    bd = engine.plan("ধন্যবাদ", "bn", "bn_bd", 2, 1.0, 24000)
    engine.render_sentence(bd.sentences[0], 24000, first=True)
    assert fakes["bn_bd"].calls[-1][1] == 2
    assert engine.plan("ধন্যবাদ", "bn", "bn_bd", 3, 1.0, 24000).cached is False
    assert engine.plan("ধন্যবাদ", "bn", "bn_bd", 2, 1.0, 24000).cached is True


def test_cache_is_bounded() -> None:
    cache = TtsCache(max_entries=2, max_bytes=1000)
    cache.put("a", _CacheEntry(np.zeros(100, dtype=np.float32), 1))
    cache.put("b", _CacheEntry(np.zeros(100, dtype=np.float32), 1))
    cache.put("c", _CacheEntry(np.zeros(100, dtype=np.float32), 1))
    assert cache.peek("a") is False and cache.peek("b") and cache.peek("c")
    cache.put("big", _CacheEntry(np.zeros(1000, dtype=np.float32), 1))  # 4000 bytes: never stored
    assert cache.peek("big") is False
    cache.put("d", _CacheEntry(np.zeros(200, dtype=np.float32), 1))  # 800 bytes evicts the rest
    assert cache.stats["entries"] == 1 and cache.stats["bytes"] == 800


def test_loudness_matching() -> None:
    quiet = np.full(1000, 0.01, dtype=np.float32) * np.sign(np.sin(np.arange(1000)))
    loud = np.full(1000, 0.5, dtype=np.float32) * np.sign(np.sin(np.arange(1000)))
    matched_quiet = _match_loudness(quiet)
    matched_loud = _match_loudness(loud)
    assert abs(float(np.sqrt(np.mean(matched_quiet**2))) - 0.04) < 0.001  # capped at MAX_GAIN (4x)
    assert abs(float(np.sqrt(np.mean(matched_loud**2))) - TARGET_RMS) < 0.001
    assert float(np.max(np.abs(matched_loud))) <= 0.95
    assert _match_loudness(np.zeros(10, dtype=np.float32)).size == 10
