"""
From the assistant's reply to something a voice can say.

The language model writes for a chat window: markdown emphasis, bullet lists, links, the odd
emoji. None of that is speakable, so it is stripped before synthesis. URLs become "our website"
(the caller cannot click a link; the agent's prompt tells it to offer to send one), and the
taka sign is written out for the English voices, whose phonemiser has never seen it.
"""

from __future__ import annotations

import html
import re
import unicodedata

WEBSITE_PHRASE = {"bn": "আমাদের ওয়েবসাইট", "en": "our website"}
NUMBER_PHRASE = {"bn": "নম্বর ", "en": "number "}

_CODE_FENCE_RE = re.compile(r"```[^\n]*\n?(.*?)```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`([^`\n]*)`")
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_AUTOLINK_RE = re.compile(r"<(https?://[^>\s]+)>")
_HTML_TAG_RE = re.compile(r"</?[A-Za-z][^>]*>")
_URL_RE = re.compile(
    r"(?:https?://|www\.)[^\s<>()\"']+"
    r"|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|site|app|dev|co|bd|in|uk|xyz|info|biz|me)\b(?:/[^\s<>()\"']*)?",
    re.IGNORECASE,
)
_HEADING_RE = re.compile(r"^[ \t]*#{1,6}[ \t]+", re.MULTILINE)
_BULLET_RE = re.compile(r"^[ \t]*(?:[-*+•▪◦●]|\d{1,2}[.)])[ \t]+", re.MULTILINE)
_QUOTE_RE = re.compile(r"^[ \t]*>[ \t]?", re.MULTILINE)
_RULE_RE = re.compile(r"^[ \t]*(?:[-*_][ \t]*){3,}$", re.MULTILINE)
_TABLE_ROW_RE = re.compile(r"^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$", re.MULTILINE)
_BOLD_RE = re.compile(r"\*\*|__")
_STAR_RE = re.compile(r"\*")
_UNDERSCORE_RE = re.compile(r"(?<!\w)_+(?=\w)|(?<=\w)_+(?!\w)|(?<!\w)_+(?!\w)")
_TILDE_RE = re.compile(r"~~")
# Emoji and pictographs, which no voice can say and which the piper front end reads as names.
_EMOJI_RE = re.compile(
    "["
    "\U0001f000-\U0001faff"  # pictographs, emoticons, symbols, flags
    "\u2600-\u27bf"  # miscellaneous symbols and dingbats
    "\u2b00-\u2bff"  # arrows and shapes
    "\u2300-\u23ff"  # technical symbols (hourglass, clocks)
    "\ufe0f\u200d"  # variation selector and zero-width joiner that glue emoji together
    "]+"
)
_HASH_NUMBER_RE = re.compile(r"#\s*(?=\d)")
_STRAY_HASH_RE = re.compile(r"#(?!\d)")
_STRAY_SYMBOLS_RE = re.compile(r"[*_~^`<>{}\[\]\\]+")
_AMOUNT = r"\d+(?:,\d+)*(?:\.\d+)?"
_TAKA_EN_RE = re.compile(rf"(?:৳|\bBDT\b|\bTk\.?(?=\s*\d))\s*({_AMOUNT})")
_TAKA_EN_SUFFIX_RE = re.compile(rf"({_AMOUNT})\s*(?:৳|\bBDT\b|\bTk\b\.?)")
_SPACE_RE = re.compile("[ \t\u00a0\u200b\u200c]+")
_BLANK_LINES_RE = re.compile(r"\n{2,}")


def strip_markdown(text: str) -> str:
    text = _CODE_FENCE_RE.sub(lambda m: m.group(1), text)
    text = _INLINE_CODE_RE.sub(lambda m: m.group(1), text)
    text = _IMAGE_RE.sub(lambda m: m.group(1), text)
    text = _AUTOLINK_RE.sub(lambda m: m.group(1), text)
    text = _LINK_RE.sub(lambda m: m.group(1), text)
    text = _HTML_TAG_RE.sub(" ", text)
    text = _TABLE_ROW_RE.sub("", text)
    text = _RULE_RE.sub("", text)
    text = _HEADING_RE.sub("", text)
    text = _BULLET_RE.sub("", text)
    text = _QUOTE_RE.sub("", text)
    text = _BOLD_RE.sub("", text)
    text = _STAR_RE.sub("", text)
    text = _UNDERSCORE_RE.sub("", text)
    text = _TILDE_RE.sub("", text)
    return text.replace("|", " ")


def replace_urls(text: str, language: str) -> str:
    phrase = WEBSITE_PHRASE.get(language, WEBSITE_PHRASE["en"])

    def swap(match: re.Match[str]) -> str:
        # "see https://x.com/p." - the full stop ends the sentence, not the URL.
        url = match.group(0)
        trailing = len(url) - len(url.rstrip(".,;:!?)\"'"))
        return phrase + (url[-trailing:] if trailing else "")

    return _URL_RE.sub(swap, text)


def expand_hash_numbers(text: str, language: str) -> str:
    """ "order #1500" -> "order number 1500" / "order নম্বর 1500"."""
    return _HASH_NUMBER_RE.sub(NUMBER_PHRASE.get(language, NUMBER_PHRASE["en"]), text)


def expand_taka_for_english(text: str) -> str:
    """ "৳1,500" / "BDT 1500" / "Tk 20" -> "1,500 taka": the English phonemisers do not know the sign."""
    text = _TAKA_EN_RE.sub(lambda m: f"{m.group(1)} taka", text)
    text = _TAKA_EN_SUFFIX_RE.sub(lambda m: f"{m.group(1)} taka", text)
    return text.replace("৳", " taka ")


def clean_text(text: str, language: str) -> str:
    """
    Markdown, links and emoji out; whitespace collapsed; one line per paragraph. Newlines that
    survive are sentence boundaries for the splitter, so this never joins two lines.
    """
    text = unicodedata.normalize("NFC", html.unescape(text or ""))
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = strip_markdown(text)
    text = replace_urls(text, language)
    text = _EMOJI_RE.sub(" ", text)
    # "#1500" keeps its hash for expand_hash_numbers() to read in the language of its own run;
    # any other symbol no voice can say is dropped.
    text = _STRAY_HASH_RE.sub(" ", text)
    text = _STRAY_SYMBOLS_RE.sub(" ", text)
    if language == "en":
        text = expand_taka_for_english(text)
    text = _SPACE_RE.sub(" ", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    text = _BLANK_LINES_RE.sub("\n", text)
    return text.strip()
