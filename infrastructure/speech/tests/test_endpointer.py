"""The endpointer state machine, driven by made-up probabilities (no VAD model)."""

from __future__ import annotations

import numpy as np

from speech.vad import WINDOW, Endpointer, EndpointerConfig, SpeechCancel, SpeechEnd, SpeechStart

WINDOW_MS = 32


def drive(endpointer: Endpointer, probabilities: list[float]) -> list[object]:
    events: list[object] = []
    for index, probability in enumerate(probabilities):
        window = np.full(WINDOW, index + 1, dtype=np.float32)  # distinct per window, to check the cut
        events.extend(endpointer.feed(window, probability))
    return events


def windows(ms: int) -> int:
    return ms // WINDOW_MS


def test_speech_start_is_immediate_and_end_waits_for_min_silence() -> None:
    config = EndpointerConfig(min_silence_ms=550, min_speech_ms=250, prefix_padding_ms=300)
    endpointer = Endpointer(config)
    events = drive(endpointer, [0.0] * windows(1000) + [0.9] * windows(2000) + [0.0] * windows(1000))
    assert isinstance(events[0], SpeechStart)
    assert events[0].t_ms == windows(1000) * WINDOW_MS
    assert isinstance(events[1], SpeechEnd)
    end = events[1]
    assert end.start_ms == events[0].t_ms
    assert abs(end.duration_ms - 2000) <= WINDOW_MS
    assert end.t_ms - (end.start_ms + end.duration_ms) >= 550
    assert not end.cut
    # padding + speech + tail, and the audio starts with the padding windows
    audio_ms = 1000 * end.audio.size / 16000
    assert 2000 + 300 + config.tail_ms - 2 * WINDOW_MS <= audio_ms <= 2000 + 300 + config.tail_ms + WINDOW_MS
    assert end.audio[0] == windows(1000) - windows(300) + 1  # the first padding window


def test_short_blip_is_cancelled_not_transcribed() -> None:
    endpointer = Endpointer(EndpointerConfig(min_speech_ms=250, cancel_silence_ms=200))
    events = drive(endpointer, [0.0] * 10 + [0.9] * 3 + [0.0] * 30)
    assert [type(e) for e in events] == [SpeechStart, SpeechCancel]
    cancel = events[1]
    assert isinstance(cancel, SpeechCancel)
    assert 200 <= cancel.t_ms - (10 + 3) * WINDOW_MS <= 200 + WINDOW_MS


def test_hysteresis_keeps_confirmed_speech_open_through_brief_dips() -> None:
    endpointer = Endpointer(EndpointerConfig(threshold=0.5, neg_threshold=0.35, min_silence_ms=550))
    speech = [0.9] * windows(600) + [0.4] * windows(300) + [0.9] * windows(600)
    events = drive(endpointer, speech + [0.0] * windows(700))
    assert [type(e) for e in events] == [SpeechStart, SpeechEnd]
    assert events[1].duration_ms == len(speech) * WINDOW_MS


def test_max_speech_cuts_and_continues() -> None:
    endpointer = Endpointer(EndpointerConfig(max_speech_ms=2000))
    total = windows(5000)
    events = drive(endpointer, [0.9] * total)
    events.extend(endpointer.flush())
    kinds = [type(e) for e in events]
    assert kinds == [SpeechStart, SpeechEnd, SpeechStart, SpeechEnd, SpeechStart, SpeechEnd]
    first, second, last = events[1], events[3], events[5]
    assert first.cut and second.cut and not last.cut
    assert abs(first.duration_ms - 2000) <= WINDOW_MS
    assert events[2].t_ms == first.t_ms
    assert last.duration_ms == (total - 2 * windows(2000 + WINDOW_MS)) * WINDOW_MS


def test_flush_ends_confirmed_speech_and_cancels_unconfirmed() -> None:
    endpointer = Endpointer(EndpointerConfig(min_speech_ms=250))
    drive(endpointer, [0.9] * windows(1000))
    flushed = endpointer.flush()
    assert [type(e) for e in flushed] == [SpeechEnd]
    assert not endpointer.speaking

    endpointer = Endpointer(EndpointerConfig(min_speech_ms=250))
    drive(endpointer, [0.9] * 2)
    assert [type(e) for e in endpointer.flush()] == [SpeechCancel]
    assert endpointer.flush() == []


def test_advance_keeps_the_clock_running_while_muted() -> None:
    endpointer = Endpointer(EndpointerConfig())
    for _ in range(windows(1000)):
        endpointer.advance(np.zeros(WINDOW, dtype=np.float32))
    events = drive(endpointer, [0.9] * 3)
    assert isinstance(events[0], SpeechStart)
    assert events[0].t_ms == windows(1000) * WINDOW_MS


def test_second_utterance_after_the_first() -> None:
    endpointer = Endpointer(EndpointerConfig())
    probabilities = [0.9] * windows(1000) + [0.0] * windows(1000) + [0.9] * windows(1000) + [0.0] * windows(1000)
    events = drive(endpointer, probabilities)
    assert [type(e) for e in events] == [SpeechStart, SpeechEnd, SpeechStart, SpeechEnd]
    assert events[2].t_ms == windows(2000) * WINDOW_MS
