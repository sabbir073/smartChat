"""The Bengali number normaliser: digits to words, in the forms a support agent says them."""

from __future__ import annotations

import pytest

from speech.text.bn_numbers import integer_to_words, normalize_numbers, number_to_words


@pytest.mark.parametrize(
    ("value", "words"),
    [
        (0, "শূন্য"),
        (7, "সাত"),
        (19, "উনিশ"),
        (21, "একুশ"),
        (42, "বিয়াল্লিশ"),
        (99, "নিরানব্বই"),
        (100, "একশো"),
        (105, "একশো পাঁচ"),
        (250, "দুইশো পঞ্চাশ"),
        (1000, "এক হাজার"),
        (1500, "এক হাজার পাঁচশো"),
        (2024, "দুই হাজার চব্বিশ"),
        (20000, "বিশ হাজার"),
        (100000, "এক লাখ"),
        (123456, "এক লাখ তেইশ হাজার চারশো ছাপ্পান্ন"),
        (2500000, "পঁচিশ লাখ"),
        (10000000, "এক কোটি"),
        (999999999, "নিরানব্বই কোটি নিরানব্বই লাখ নিরানব্বই হাজার নয়শো নিরানব্বই"),
    ],
)
def test_integers(value: int, words: str) -> None:
    assert integer_to_words(value) == words


def test_beyond_range_is_read_digit_by_digit() -> None:
    assert integer_to_words(1_000_000_000) == "এক শূন্য শূন্য শূন্য শূন্য শূন্য শূন্য শূন্য শূন্য শূন্য"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1.5", "এক দশমিক পাঁচ"),
        ("3.14", "তিন দশমিক এক চার"),
        ("12%", "বারো শতাংশ"),
        ("12.5%", "বারো দশমিক পাঁচ শতাংশ"),
        ("৳250", "দুইশো পঞ্চাশ টাকা"),
        ("৳ 1,500", "এক হাজার পাঁচশো টাকা"),
        ("BDT 250", "দুইশো পঞ্চাশ টাকা"),
        ("250 টাকা", "দুইশো পঞ্চাশ টাকা"),
        ("৳12.50", "বারো টাকা পঞ্চাশ পয়সা"),
        ("1,50,000", "এক লাখ পঞ্চাশ হাজার"),
        ("১৫০০", "এক হাজার পাঁচশো"),
        ("01712345678", "শূন্য এক সাত এক দুই তিন চার পাঁচ ছয় সাত আট"),
        ("10:30", "দশটা ত্রিশ"),
        ("10:00", "দশটা"),
        ("১ম", "প্রথম"),
        ("5-10", "পাঁচ থেকে দশ"),
        ("-5", "মাইনাস পাঁচ"),
    ],
)
def test_prose_forms(text: str, expected: str) -> None:
    assert normalize_numbers(text) == expected


def test_sentence_with_amount() -> None:
    assert normalize_numbers("আপনার অর্ডার নম্বর ১৫০০ টাকায় নিশ্চিত হয়েছে।") == "আপনার অর্ডার নম্বর এক হাজার পাঁচশো টাকায় নিশ্চিত হয়েছে।"


def test_text_without_digits_is_untouched() -> None:
    text = "কোনো সংখ্যা নেই, শুধু কথা।"
    assert normalize_numbers(text) is text


def test_digits_glued_to_latin_identifier() -> None:
    assert normalize_numbers("AB123") == "AB এক দুই তিন"


def test_number_token_variants() -> None:
    assert number_to_words("007") == "শূন্য শূন্য সাত"
    assert number_to_words(".5") == "শূন্য দশমিক পাঁচ"
