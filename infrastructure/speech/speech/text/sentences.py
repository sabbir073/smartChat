"""
Sentences and script runs: the units the TTS pipeline synthesises.

A reply is spoken sentence by sentence so the first audio reaches the caller while the rest is
still being synthesised, and each sentence is split further into runs of Bengali script and
Latin script, because the Bengali voices cannot say English words and vice versa. A run made of
nothing but digits and punctuation belongs to whichever neighbour it touches.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

MAX_SENTENCE_CHARS = 300
MIN_SENTENCE_CHARS = 2

# A sentence ends at a danda, full stop, question or exclamation mark (any number of them,
# optionally followed by a closing quote or bracket) that is followed by whitespace, or at a
# newline. "1.5" never splits because no whitespace follows its dot.
_SENTENCE_END_RE = re.compile(r"(?<=[।.?!])[\"'”’)\]]*\s+|\n+")
_CLAUSE_SPLIT_RE = re.compile(r"(?<=[,;:،])\s+")
_ABBREVIATION_RE = re.compile(r"(?:^|\s)(?:Dr|Mr|Mrs|Ms|Prof|St|No|vs|etc|e\.g|i\.e|approx|Tk|Rs|ডা|মো|মোঃ|জনাব)\.$", re.IGNORECASE)
_SPEAKABLE_RE = re.compile(r"[^\W_]", re.UNICODE)

_BENGALI_RANGE = ("ঀ", "৿")
# Currency signs and digits in the Bengali block are not "Bengali text": "৳250" in an English
# sentence must stay with the English run, where it becomes "250 taka".
_NEUTRAL_BENGALI = {"৲", "৳", "৴", "৵", "৶", "৷", "৸", "৹", "৺", "৻"}
_BENGALI_DIGITS = set("০১২৩৪৫৬৭৮৯")


@dataclass(frozen=True)
class Run:
    language: str  # "bn" or "en"
    text: str


def split_sentences(text: str, max_chars: int = MAX_SENTENCE_CHARS) -> list[str]:
    """Sentences of at least two speakable characters, none longer than `max_chars`."""
    sentences: list[str] = []
    for raw in _SENTENCE_END_RE.split(text):
        candidate = raw.strip()
        if not candidate:
            continue
        # "Dr. Rahman" and "e.g. this": the dot after an abbreviation is not a sentence end.
        if sentences and _ABBREVIATION_RE.search(sentences[-1]):
            sentences[-1] = f"{sentences[-1]} {candidate}"
            continue
        sentences.append(candidate)
    out: list[str] = []
    for sentence in sentences:
        if len(sentence) < MIN_SENTENCE_CHARS or not _SPEAKABLE_RE.search(sentence):
            continue
        out.extend(_cap(sentence, max_chars))
    return out


def _cap(sentence: str, max_chars: int) -> list[str]:
    """Split an over-long sentence at commas, then at spaces, keeping every piece under the cap."""
    if len(sentence) <= max_chars:
        return [sentence]
    pieces: list[str] = []
    current = ""
    for clause in _CLAUSE_SPLIT_RE.split(sentence):
        if current and len(current) + 1 + len(clause) > max_chars:
            pieces.append(current)
            current = clause
        else:
            current = f"{current} {clause}".strip()
    if current:
        pieces.append(current)
    out: list[str] = []
    for piece in pieces:
        while len(piece) > max_chars:
            cut = piece.rfind(" ", 0, max_chars)
            if cut < max_chars // 2:
                cut = max_chars
            out.append(piece[:cut].strip())
            piece = piece[cut:].strip()
        if piece:
            out.append(piece)
    return [p for p in out if len(p) >= MIN_SENTENCE_CHARS]


def script_of(char: str) -> str | None:
    """ "bn", "en" or None for characters that belong to whichever run is next to them."""
    if _BENGALI_RANGE[0] <= char <= _BENGALI_RANGE[1]:
        if char in _NEUTRAL_BENGALI or char in _BENGALI_DIGITS:
            return None
        return "bn"
    if char.isalpha():
        # Latin, including accented letters; anything else alphabetic (Arabic, Devanagari) has no
        # voice here and goes to the English front end, which at least will not crash on it.
        return "en"
    return None


def split_script_runs(sentence: str, default_language: str) -> list[Run]:
    """
    Group a sentence into maximal runs of one script. Neutral characters (digits, punctuation,
    spaces) stick to the run before them, or to the run after them when they open the sentence.
    A sentence with no letters at all is one run in `default_language`.
    """
    runs: list[list[str]] = []
    languages: list[str] = []
    pending: list[str] = []
    for char in sentence:
        script = script_of(char)
        if script is None:
            if runs:
                runs[-1].append(char)
            else:
                pending.append(char)
            continue
        if languages and languages[-1] == script:
            runs[-1].append(char)
        else:
            runs.append(pending + [char])
            languages.append(script)
            pending = []
    if not runs:
        text = "".join(pending).strip()
        return [Run(default_language, text)] if text else []
    out: list[Run] = []
    for language, chars in zip(languages, runs, strict=True):
        text = "".join(chars).strip()
        if text:
            out.append(Run(language, text))
    return out
