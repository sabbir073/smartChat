"""Sentence splitting and script runs: the units of synthesis."""

from __future__ import annotations

from speech.text.sentences import MAX_SENTENCE_CHARS, Run, script_of, split_script_runs, split_sentences


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
