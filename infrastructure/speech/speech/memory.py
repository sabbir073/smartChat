"""
Keeping the resident set flat.

The first deployment grew from 2.4 GB to 3.6 GB in a quarter of an hour and was OOM-killed.
None of it was a Python-level leak (tracemalloc showed the bounded TTS cache and nothing
else); it was native memory that is never handed back:

1. ONNX Runtime's CPU memory arena. Every sherpa-onnx session owns one, and it only grows: a
   long sentence through a VITS vocoder allocates activations of tens of MB, the arena keeps
   that high-water mark for ever, and five voices and three recognisers each keep their own.
   Measured on the two piper voices alone: +245 MB after 300 sentences with the arena, +50 MB
   (the TTS cache filling) without it. sherpa-onnx accepts a provider string of the form
   "cpu:<config file>" whose `EnableCpuMemArena=0` disables the arena; `ort_provider()` writes
   that file. The VAD session is created by us and gets the same option directly.
2. glibc. Without the arena ORT mallocs its tensors per run; glibc's dynamic mmap threshold
   then keeps multi-MB chunks on the heap, where they fragment, and each worker thread gets
   its own heap. `MALLOC_ARENA_MAX=2` (set in the image and again here through mallopt) caps
   the per-thread heaps, and `release_heap()` - malloc_trim(0), 2-3 ms, called after every
   model call - returns the free pages. Pinning MALLOC_MMAP_THRESHOLD_ instead also kept memory
   flat but made synthesis 40% slower (every large tensor page-faulted in fresh).

With both in place, 300 TTS sentences, 200 utterances and 300 LID calls each stay within the
cache's 50 MB of their starting RSS.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import os
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

from speech import logs

log = logs.get("speech.memory")
T = TypeVar("T")

M_ARENA_MAX = -8
ARENA_MAX = 2
TRIM_MIN_INTERVAL_S = 0.05

_libc: ctypes.CDLL | None = None
_lock = threading.Lock()
_last_trim = 0.0
_trim_enabled = True


def _glibc() -> ctypes.CDLL | None:
    global _libc
    if _libc is not None:
        return _libc
    name = ctypes.util.find_library("c") or "libc.so.6"
    try:
        libc = ctypes.CDLL(name)
        libc.malloc_trim.argtypes = [ctypes.c_size_t]
        libc.malloc_trim.restype = ctypes.c_int
        libc.mallopt.argtypes = [ctypes.c_int, ctypes.c_int]
        libc.mallopt.restype = ctypes.c_int
    except (OSError, AttributeError):
        return None
    _libc = libc
    return libc


def configure(trim: bool = True) -> None:
    """Cap glibc's per-thread heaps; call before the thread pool and torch exist."""
    global _trim_enabled
    _trim_enabled = trim
    libc = _glibc()
    if libc is None:
        return
    if not os.environ.get("MALLOC_ARENA_MAX"):
        libc.mallopt(M_ARENA_MAX, ARENA_MAX)


def release_heap() -> None:
    """Return freed heap pages to the kernel; rate-limited so a burst of finishing calls trims once."""
    global _last_trim
    libc = _glibc()
    if libc is None or not _trim_enabled:
        return
    now = time.monotonic()
    with _lock:
        if now - _last_trim < TRIM_MIN_INTERVAL_S:
            return
        _last_trim = now
    libc.malloc_trim(0)


def after_inference(fn: Callable[..., T], *args: Any) -> T:
    """Run one model call on an executor thread, then give its scratch memory back."""
    try:
        return fn(*args)
    finally:
        release_heap()


def ort_provider(provider: str, arena: bool, directory: Path) -> str:
    """
    The provider string handed to every sherpa-onnx model. With the arena off it points at a
    small config file (sherpa-onnx's "provider:config_path" form); a provider that already
    carries a config, or a non-CPU provider, is passed through untouched.
    """
    if arena or ":" in provider or provider != "cpu":
        return provider
    content = "# written by the speech service at start; see speech/memory.py\nEnableCpuMemArena=0\n"
    # The models directory first (it is the volume we own), the temp directory when that is
    # mounted read-only; only if neither can be written does the arena stay on.
    for candidate in (directory / "ort-session.cfg", Path(tempfile.gettempdir()) / f"speech-ort-session-{os.getuid()}.cfg"):
        try:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            if not candidate.exists() or candidate.read_text() != content:
                candidate.write_text(content)
        except OSError:
            continue
        return f"{provider}:{candidate}"
    log.warning("cannot write the ONNX Runtime session config anywhere; the CPU arena stays on", extra={"event": "ort_config_failed", "directory": str(directory)})
    return provider


def rss_mb() -> int:
    """Resident set size of this process in MB, from /proc (0 where that is unavailable)."""
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) // 1024
    except (OSError, ValueError):
        pass
    return 0
