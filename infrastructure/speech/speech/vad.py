"""
Voice activity detection and endpointing.

Silero VAD gives one speech probability per 32 ms window; the `Endpointer` turns that stream of
probabilities into utterances. sherpa-onnx has its own VAD wrapper, but it reports speech only
after min_speech_duration has passed, and this service must tell the agent the moment the caller
starts talking (so it can stop its own playback), then take the event back if it was a false
alarm. Running the Silero graph directly with onnxruntime gives that control; the model is
tiny and the per-window cost is well under a millisecond.

The endpointer is pure Python with no model inside, so the protocol tests drive it with made-up
probabilities.
"""

from __future__ import annotations

import collections
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import onnxruntime as ort

SAMPLE_RATE = 16_000
WINDOW = 512  # samples: the only window Silero accepts at 16 kHz
WINDOW_MS = 1000 * WINDOW / SAMPLE_RATE  # 32 ms


class VadModelError(RuntimeError):
    pass


@dataclass
class VadState:
    """Recurrent state for one audio stream; a session owns one and hands it to every call."""

    h: np.ndarray | None = None  # v4: two LSTM tensors
    c: np.ndarray | None = None
    state: np.ndarray | None = None  # v5: one combined tensor


class SileroVad:
    """
    One onnxruntime session shared by every call leg (Run() is thread-safe), with the recurrent
    state passed in and out per stream. Accepts both graph layouts in circulation: v4 from the
    sherpa-onnx releases (inputs x/h/c) and v5 from the upstream repository (input/state/sr).
    """

    def __init__(self, path: Path, threads: int = 1, arena: bool = False) -> None:
        if not path.exists():
            raise VadModelError(f"VAD model missing: {path}")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        # The per-window tensors are tiny; the arena would only pin memory (speech/memory.py).
        options.enable_cpu_mem_arena = arena
        self.session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
        names = {i.name for i in self.session.get_inputs()}
        if {"x", "h", "c"} <= names:
            self.version = 4
        elif {"input", "state", "sr"} <= names:
            self.version = 5
        else:
            raise VadModelError(f"{path} is not a Silero VAD graph (inputs: {sorted(names)})")
        self._sr = np.array(SAMPLE_RATE, dtype=np.int64)
        self.path = path

    def new_state(self) -> VadState:
        if self.version == 4:
            return VadState(h=np.zeros((2, 1, 64), dtype=np.float32), c=np.zeros((2, 1, 64), dtype=np.float32))
        return VadState(state=np.zeros((2, 1, 128), dtype=np.float32))

    def probability(self, state: VadState, window: np.ndarray) -> float:
        """Speech probability for one 512-sample window; updates `state` in place."""
        if window.shape != (WINDOW,):
            raise ValueError(f"VAD window must be {WINDOW} samples, got {window.shape}")
        x = window.reshape(1, WINDOW).astype(np.float32, copy=False)
        if self.version == 4:
            prob, state.h, state.c = self.session.run(None, {"x": x, "h": state.h, "c": state.c})
        else:
            prob, state.state = self.session.run(None, {"input": x, "state": state.state, "sr": self._sr})
        return float(prob[0, 0])


@dataclass(frozen=True)
class EndpointerConfig:
    threshold: float = 0.5
    # Hysteresis: once open, speech continues while the probability stays above this.
    neg_threshold: float = 0.35
    min_silence_ms: int = 550
    min_speech_ms: int = 250
    max_speech_ms: int = 30_000
    prefix_padding_ms: int = 300
    # Trailing silence kept on an utterance: the recognisers finish the last word more reliably
    # with a little room after it, and the caller never hears this audio anyway.
    tail_ms: int = 240
    # A start that was never confirmed (shorter than min_speech_ms) is withdrawn after this much
    # silence instead of the full min_silence_ms, so a cough costs the agent only a brief pause.
    cancel_silence_ms: int = 200


@dataclass(frozen=True)
class SpeechStart:
    t_ms: int


@dataclass(frozen=True)
class SpeechCancel:
    t_ms: int


@dataclass(frozen=True)
class SpeechEnd:
    t_ms: int
    start_ms: int
    duration_ms: int
    audio: np.ndarray = field(repr=False)
    cut: bool = False  # True when max_speech_ms forced the end and speech continues


Event = SpeechStart | SpeechCancel | SpeechEnd


class Endpointer:
    """
    Utterance boundaries from per-window speech probabilities.

      idle ──prob ≥ threshold──▶ speaking (SpeechStart at once)
      speaking ──silence ≥ cancel_silence_ms before min_speech_ms──▶ idle (SpeechCancel)
      speaking ──silence ≥ min_silence_ms──▶ idle (SpeechEnd with padding + speech + tail)
      speaking ──max_speech_ms reached──▶ speaking (SpeechEnd(cut) then SpeechStart)

    Time is counted in windows from the first sample fed, in milliseconds.
    """

    def __init__(self, config: EndpointerConfig, sample_rate: int = SAMPLE_RATE, window: int = WINDOW) -> None:
        self.config = config
        self.sample_rate = sample_rate
        self.window = window
        self.window_ms = 1000.0 * window / sample_rate
        padding_windows = max(1, int(round(config.prefix_padding_ms / self.window_ms)))
        self._padding: collections.deque[np.ndarray] = collections.deque(maxlen=padding_windows)
        self._utterance: list[np.ndarray] = []
        self._windows_fed = 0
        self.speaking = False
        self._start_ms = 0
        self._last_speech_ms = 0  # end time of the last window that counted as speech
        self._confirmed = False

    @property
    def now_ms(self) -> int:
        return int(round(self._windows_fed * self.window_ms))

    def feed(self, window: np.ndarray, prob: float) -> list[Event]:
        events: list[Event] = []
        t_start = self.now_ms
        self._windows_fed += 1
        t_end = self.now_ms
        cfg = self.config

        if not self.speaking:
            if prob < cfg.threshold:
                self._padding.append(window)
                return events
            self.speaking = True
            self._confirmed = False
            self._start_ms = t_start
            self._last_speech_ms = t_end
            self._utterance = list(self._padding) + [window]
            self._padding.clear()
            events.append(SpeechStart(t_start))
            return events

        self._utterance.append(window)
        is_speech = prob >= (cfg.neg_threshold if self._confirmed else cfg.threshold)
        if is_speech:
            self._last_speech_ms = t_end
            if not self._confirmed and t_end - self._start_ms >= cfg.min_speech_ms:
                self._confirmed = True
        silence_ms = t_end - self._last_speech_ms

        if not self._confirmed and silence_ms >= cfg.cancel_silence_ms:
            events.append(SpeechCancel(t_end))
            self._reset_after(keep_padding=True)
            return events
        if self._confirmed and silence_ms >= cfg.min_silence_ms:
            events.append(self._end(t_end, cut=False))
            self._reset_after(keep_padding=True)
            return events
        if t_end - self._start_ms >= cfg.max_speech_ms:
            events.append(self._end(t_end, cut=True))
            # Speech goes on: start the next piece immediately, with the last window as context.
            self._start_ms = t_end
            self._last_speech_ms = t_end
            self._confirmed = True
            self._utterance = [window]
            events.append(SpeechStart(t_end))
        return events

    def advance(self, window: np.ndarray) -> None:
        """A window that was heard but not judged (the session is muted): keep the clock and the
        padding buffer moving. Any open utterance must have been flushed first."""
        self._windows_fed += 1
        if not self.speaking:
            self._padding.append(window)

    def flush(self) -> list[Event]:
        """The stream is ending (stop, mute, disconnect): close any open utterance."""
        if not self.speaking:
            return []
        t_end = self.now_ms
        events: list[Event]
        if self._confirmed:
            events = [self._end(t_end, cut=False)]
        else:
            events = [SpeechCancel(t_end)]
        self._reset_after(keep_padding=False)
        return events

    def _end(self, t_end: int, cut: bool) -> SpeechEnd:
        cfg = self.config
        audio = np.concatenate(self._utterance) if self._utterance else np.zeros(0, dtype=np.float32)
        # Drop the silence past the tail, so a 550 ms endpoint does not become 550 ms of trailing
        # audio the recogniser must wade through. The array is [padding | speech | silence]; the
        # padding is whatever was buffered before the start (less than prefix_padding_ms at the
        # very beginning of a stream).
        speech_end_ms = self._last_speech_ms if not cut else t_end
        since_start = int((t_end - self._start_ms) * self.sample_rate / 1000)
        padding_samples = max(0, audio.size - since_start)
        keep = padding_samples + int((speech_end_ms - self._start_ms + cfg.tail_ms) * self.sample_rate / 1000)
        audio = audio[: min(audio.size, keep)]
        duration_ms = max(0, speech_end_ms - self._start_ms)
        return SpeechEnd(t_ms=t_end, start_ms=self._start_ms, duration_ms=duration_ms, audio=audio, cut=cut)

    def _reset_after(self, keep_padding: bool) -> None:
        if keep_padding:
            # The last windows of the utterance (silence) seed the padding for the next one.
            for window in self._utterance[-self._padding.maxlen :]:
                self._padding.append(window)
        else:
            self._padding.clear()
        self._utterance = []
        self.speaking = False
        self._confirmed = False
