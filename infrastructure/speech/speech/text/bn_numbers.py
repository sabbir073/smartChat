"""
Digits to Bengali words, for the Bengali voices.

Neither Bengali TTS model was trained on digits: the Coqui VITS voice skips them and the piper
voice reads them as espeak's English number words, which is wrong in the middle of a Bengali
sentence ("আপনার অর্ডার one thousand five hundred টাকা"). So every number is spelled out here
before synthesis, in the Bangladeshi counting system (হাজার, লাখ, কোটি), with the readings a
customer-support agent needs: amounts of money, percentages, decimals, times, ordinals and
ranges. Identifiers - phone numbers, anything with a leading zero or more than nine digits -
are read digit by digit, the way a person would read them out.

Both ASCII (0-9) and Bengali (০-৯) digits are accepted.
"""

from __future__ import annotations

import re

# fmt: off
ONES = (
    "শূন্য", "এক", "দুই", "তিন", "চার", "পাঁচ", "ছয়", "সাত", "আট", "নয়",
    "দশ", "এগারো", "বারো", "তেরো", "চৌদ্দ", "পনেরো", "ষোলো", "সতেরো", "আঠারো", "উনিশ",
    "বিশ", "একুশ", "বাইশ", "তেইশ", "চব্বিশ", "পঁচিশ", "ছাব্বিশ", "সাতাশ", "আটাশ", "ঊনত্রিশ",
    "ত্রিশ", "একত্রিশ", "বত্রিশ", "তেত্রিশ", "চৌত্রিশ", "পঁয়ত্রিশ", "ছত্রিশ", "সাঁইত্রিশ", "আটত্রিশ", "ঊনচল্লিশ",
    "চল্লিশ", "একচল্লিশ", "বিয়াল্লিশ", "তেতাল্লিশ", "চুয়াল্লিশ", "পঁয়তাল্লিশ", "ছেচল্লিশ", "সাতচল্লিশ", "আটচল্লিশ", "ঊনপঞ্চাশ",
    "পঞ্চাশ", "একান্ন", "বাহান্ন", "তিপ্পান্ন", "চুয়ান্ন", "পঞ্চান্ন", "ছাপ্পান্ন", "সাতান্ন", "আটান্ন", "ঊনষাট",
    "ষাট", "একষট্টি", "বাষট্টি", "তেষট্টি", "চৌষট্টি", "পঁয়ষট্টি", "ছেষট্টি", "সাতষট্টি", "আটষট্টি", "ঊনসত্তর",
    "সত্তর", "একাত্তর", "বাহাত্তর", "তিয়াত্তর", "চুয়াত্তর", "পঁচাত্তর", "ছিয়াত্তর", "সাতাত্তর", "আটাত্তর", "ঊনআশি",
    "আশি", "একাশি", "বিরাশি", "তিরাশি", "চুরাশি", "পঁচাশি", "ছিয়াশি", "সাতাশি", "আটাশি", "ঊননব্বই",
    "নব্বই", "একানব্বই", "বিরানব্বই", "তিরানব্বই", "চুরানব্বই", "পঁচানব্বই", "ছিয়ানব্বই", "সাতানব্বই", "আটানব্বই", "নিরানব্বই",
)
# fmt: on
HUNDREDS = ("", "একশো", "দুইশো", "তিনশো", "চারশো", "পাঁচশো", "ছয়শো", "সাতশো", "আটশো", "নয়শো")
THOUSAND, LAKH, CRORE = "হাজার", "লাখ", "কোটি"
POINT, PERCENT, TAKA, PAISA, MINUS, TO, O_CLOCK = "দশমিক", "শতাংশ", "টাকা", "পয়সা", "মাইনাস", "থেকে", "টা"
ORDINALS = {
    "1": "প্রথম",
    "2": "দ্বিতীয়",
    "3": "তৃতীয়",
    "4": "চতুর্থ",
    "5": "পঞ্চম",
    "6": "ষষ্ঠ",
    "7": "সপ্তম",
    "8": "অষ্টম",
    "9": "নবম",
    "10": "দশম",
}
MAX_WORDS_VALUE = 999_999_999

BENGALI_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")

# A number as it appears in prose: optional thousands separators (Western 1,500,000 or Indian
# 15,00,000), optional decimals. Commas are only separators when followed by 2-3 digits.
_NUM = r"\d+(?:,\d{2,3})*(?:\.\d+)?"
_CURRENCY_PREFIX = r"(?:৳|BDT|Tk\.?|Taka|টাকা)"
_CURRENCY_SUFFIX = r"(?:৳|BDT|Tk\.?|Taka|taka|টাকা)"

_CURRENCY_RE = re.compile(rf"(?<![\w.])(?:{_CURRENCY_PREFIX}\s*({_NUM})|({_NUM})\s*{_CURRENCY_SUFFIX})(?![\w.])", re.IGNORECASE)
_PERCENT_RE = re.compile(rf"(?<![\w.])({_NUM})\s*(?:%|শতাংশ|percent)(?![\w%])", re.IGNORECASE)
_TIME_RE = re.compile(r"(?<![\w.:])(\d{1,2}):(\d{2})(?![\w:])")
_ORDINAL_RE = re.compile(r"(?<![\w.])(\d{1,2})(?:ম|য়|র্থ|ষ্ঠ)(?!\w)")
_RANGE_RE = re.compile(rf"(?<![\w.-])({_NUM})\s*[-–]\s*({_NUM})(?![\w.-])")
_SIGNED_RE = re.compile(rf"(?<![\w.,-])-({_NUM})(?![\w.])")
_PLAIN_RE = re.compile(rf"(?<![\w.])({_NUM})(?![\w.])")
_DIGITS_RE = re.compile(r"\d")


def integer_to_words(value: int) -> str:
    """0 <= value <= 999999999 in the হাজার/লাখ/কোটি system; larger values are read digit by digit."""
    if value < 0:
        return f"{MINUS} {integer_to_words(-value)}"
    if value > MAX_WORDS_VALUE:
        return digits_to_words(str(value))
    if value < 100:
        return ONES[value]
    parts: list[str] = []
    crore, rest = divmod(value, 10_000_000)
    lakh, rest = divmod(rest, 100_000)
    thousand, rest = divmod(rest, 1_000)
    hundred, units = divmod(rest, 100)
    if crore:
        parts.append(f"{ONES[crore]} {CRORE}")
    if lakh:
        parts.append(f"{ONES[lakh]} {LAKH}")
    if thousand:
        parts.append(f"{ONES[thousand]} {THOUSAND}")
    if hundred:
        parts.append(HUNDREDS[hundred])
    if units or not parts:
        parts.append(ONES[units])
    return " ".join(parts)


def digits_to_words(digits: str) -> str:
    """Each digit on its own, for identifiers and the fractional part of decimals."""
    return " ".join(ONES[int(d)] for d in digits if d.isdigit())


def number_to_words(token: str) -> str:
    """
    A single numeric token ("1500", "1,50,000", "1.5", "01712345678") to words. Leading zeros
    and very long runs mark an identifier, which is read digit by digit.
    """
    token = token.translate(BENGALI_DIGITS).replace(",", "")
    whole, _, fraction = token.partition(".")
    if not whole:
        whole = "0"
    if (len(whole) > 1 and whole[0] == "0") or len(whole) > 9:
        words = digits_to_words(whole)
    else:
        words = integer_to_words(int(whole))
    if fraction:
        words = f"{words} {POINT} {digits_to_words(fraction)}"
    return words


def _currency(match: re.Match[str]) -> str:
    token = (match.group(1) or match.group(2)).translate(BENGALI_DIGITS).replace(",", "")
    whole, _, fraction = token.partition(".")
    if fraction and len(fraction) == 2 and whole.isdigit() and len(whole) <= 9 and not (len(whole) > 1 and whole[0] == "0"):
        words = f"{integer_to_words(int(whole))} {TAKA}"
        paisa = int(fraction)
        if paisa:
            words = f"{words} {integer_to_words(paisa)} {PAISA}"
        return words
    return f"{number_to_words(token)} {TAKA}"


def _time(match: re.Match[str]) -> str:
    hours, minutes = int(match.group(1)), int(match.group(2))
    if hours > 24 or minutes > 59:
        return f"{integer_to_words(hours)} {integer_to_words(minutes)}"
    if minutes == 0:
        return f"{ONES[hours]}{O_CLOCK}"
    return f"{ONES[hours]}{O_CLOCK} {ONES[minutes]}"


def _ordinal(match: re.Match[str]) -> str:
    number = match.group(1).lstrip("0") or "0"
    return ORDINALS.get(number, f"{integer_to_words(int(number))} তম")


def normalize_numbers(text: str) -> str:
    """Replace every digit sequence in `text` with Bengali words; text without digits is returned as is."""
    if not _DIGITS_RE.search(text.translate(BENGALI_DIGITS)):
        return text
    text = text.translate(BENGALI_DIGITS)
    text = _CURRENCY_RE.sub(_currency, text)
    text = _PERCENT_RE.sub(lambda m: f"{number_to_words(m.group(1))} {PERCENT}", text)
    text = _TIME_RE.sub(_time, text)
    text = _ORDINAL_RE.sub(_ordinal, text)
    text = _RANGE_RE.sub(lambda m: f"{number_to_words(m.group(1))} {TO} {number_to_words(m.group(2))}", text)
    text = _SIGNED_RE.sub(lambda m: f"{MINUS} {number_to_words(m.group(1))}", text)
    text = _PLAIN_RE.sub(lambda m: number_to_words(m.group(1)), text)
    # Whatever digits survive (inside identifiers like AB123) are read one by one.
    text = re.sub(r"\d+", lambda m: f" {digits_to_words(m.group(0))} ", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()
