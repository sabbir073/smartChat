"""Sentence splitting and script runs: the units of synthesis."""

from __future__ import annotations

from speech.text.sentences import FIRST_PIECE_CHARS, MAX_SENTENCE_CHARS, Run, script_of, split_script_runs, split_sentences


def test_splits_on_danda_full_stop_question_exclamation_and_newlines() -> None:
    text = "হ্যালো, স্বাগতম। আমি কীভাবে সাহায্য করতে পারি? Your order is ready. Great!\nNew line here"
    assert split_sentences(text) == [
        "হ্যালো, স্বাগতম।",
        "আমি কীভাবে সাহায্য করতে পারি?",
        "Your order is ready.",
        "Great!",
        "New line here",
    ]


def test_decimals_and_abbreviations_do_not_split() -> None:
    assert split_sentences("It weighs 1.5 kg. Dr. Rahman agreed, e.g. yesterday.") == ["It weighs 1.5 kg.", "Dr. Rahman agreed, e.g. yesterday."]


def test_drops_fragments_without_speakable_characters() -> None:
    assert split_sentences("... !!! a. ok.") == ["a.", "ok."]
    assert split_sentences("") == []


def test_long_sentences_are_capped_at_commas() -> None:
    clauses = [f"clause number {i} with a few words" for i in range(30)]
    pieces = split_sentences(", ".join(clauses) + ".")
    assert len(pieces) > 1
    assert all(len(p) <= MAX_SENTENCE_CHARS for p in pieces)
    assert " ".join(pieces) == ", ".join(clauses) + "."


def test_long_sentence_without_commas_is_cut_at_spaces() -> None:
    words = " ".join(["word"] * 120)
    pieces = split_sentences(words)
    assert len(pieces) == 2
    assert all(len(p) <= MAX_SENTENCE_CHARS for p in pieces)
    assert " ".join(pieces) == words


def test_a_long_opening_sentence_starts_with_a_short_piece_cut_at_a_comma() -> None:
    # A real answer from the live service: 212 characters, one sentence, nine seconds of
    # rendering before the caller heard a word. Now the first piece is a clause.
    answer = (
        "Smart Lab Global offers a wide range of services, including custom software development, "
        "artificial intelligence solutions, cloud solutions, AR and VR experiences, and digital "
        "marketing to help businesses grow."
    )
    pieces = split_sentences(answer)
    assert pieces[0] == "Smart Lab Global offers a wide range of services,"
    assert len(pieces[0]) <= FIRST_PIECE_CHARS
    assert all(len(piece) <= MAX_SENTENCE_CHARS for piece in pieces)
    assert " ".join(pieces) == answer


def test_a_long_opening_without_commas_breaks_before_a_phrase() -> None:
    text = (
        "Smart Lab Global offers custom software development and AI solutions for businesses of "
        "all sizes across Bangladesh and the world. We also build mobile apps."
    )
    pieces = split_sentences(text)
    assert pieces[0] == "Smart Lab Global offers custom software development and AI solutions"
    assert pieces[1] == "for businesses of all sizes across Bangladesh and the world."
    assert pieces[2] == "We also build mobile apps."


def test_short_sentences_and_bengali_clauses() -> None:
    assert split_sentences("Sure. Our office is in Dhaka. You can visit us any weekday.") == [
        "Sure.",
        "Our office is in Dhaka.",
        "You can visit us any weekday.",
    ]
    bengali = "স্মার্ট ল্যাব গ্লোবাল কাস্টম সফটওয়্যার ডেভেলপমেন্ট, কৃত্রিম বুদ্ধিমত্তা সমাধান, ক্লাউড সমাধান এবং ডিজিটাল মার্কেটিং সেবা দেয়।"
    pieces = split_sentences(bengali)
    assert pieces[0] == "স্মার্ট ল্যাব গ্লোবাল কাস্টম সফটওয়্যার ডেভেলপমেন্ট,"
    assert " ".join(pieces) == bengali


def test_no_piece_is_left_too_short_to_stand_alone() -> None:
    # Breaking at the comma would leave three words to be spoken on their own after a pause.
    text = "We build websites, mobile apps and custom software for companies of every size, mostly."
    assert all(len(piece) >= 20 for piece in split_sentences(text))


def test_script_of() -> None:
    assert script_of("ক") == "bn"
    assert script_of("a") == "en"
    assert script_of("é") == "en"
    assert script_of("1") is None
    assert script_of("৳") is None
    assert script_of("৫") is None
    assert script_of("।") is None
    assert script_of(" ") is None


def test_runs_alternate_by_script_and_neutral_text_sticks_to_the_previous_run() -> None:
    runs = split_script_runs("GetChat এ স্বাগতম, your order #1500 is ready।", "bn")
    assert runs == [
        Run("en", "GetChat"),
        Run("bn", "এ স্বাগতম,"),
        Run("en", "your order #1500 is ready।"),
    ]


def test_leading_neutral_text_joins_the_first_run() -> None:
    assert split_script_runs("৳250 is the price", "bn") == [Run("en", "৳250 is the price")]
    assert split_script_runs("1500 টাকা", "en") == [Run("bn", "1500 টাকা")]


def test_neutral_only_sentence_uses_the_default_language() -> None:
    assert split_script_runs("1500", "bn") == [Run("bn", "1500")]
    assert split_script_runs("1500", "en") == [Run("en", "1500")]
    assert split_script_runs("   ", "en") == []


def test_single_script_sentences_are_one_run() -> None:
    assert split_script_runs("আপনার অর্ডার নিশ্চিত হয়েছে।", "en") == [Run("bn", "আপনার অর্ডার নিশ্চিত হয়েছে।")]
    assert split_script_runs("Hello there.", "bn") == [Run("en", "Hello there.")]
