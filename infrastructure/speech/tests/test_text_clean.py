"""The text cleaner: markdown, links, emoji and currency signs out; what a voice can say in."""

from __future__ import annotations

from speech.text.clean import clean_text, expand_hash_numbers, expand_taka_for_english, replace_urls, strip_markdown


def test_strips_emphasis_and_code() -> None:
    assert strip_markdown("This is **bold**, _italic_ and `code`.") == "This is bold, italic and code."
    assert strip_markdown("a *star* and __under__ and ~~gone~~") == "a star and under and gone"


def test_keeps_underscores_inside_identifiers() -> None:
    assert strip_markdown("order_id is _ready_") == "order_id is ready"


def test_headings_bullets_quotes_rules() -> None:
    text = "# Title\n\n- one\n* two\n1. three\n> quoted\n---\n| a | b |\n|---|---|\n"
    assert clean_text(text, "en") == "Title\none\ntwo\nthree\nquoted\na b"


def test_links_images_and_html() -> None:
    assert strip_markdown("see [the page](https://x.com/p) and ![alt text](i.png) <b>bold</b>") == "see the page and alt text  bold "
    assert replace_urls("see https://x.com/p.", "en") == "see our website."


def test_urls_become_the_website_phrase() -> None:
    assert replace_urls("Go to https://getchat.site/orders?id=1 now", "en") == "Go to our website now"
    assert replace_urls("Go to www.getchat.site now", "bn") == "Go to আমাদের ওয়েবসাইট now"
    assert replace_urls("Go to getchat.site/help now", "en") == "Go to our website now"
    assert replace_urls("It costs 1.5 taka", "en") == "It costs 1.5 taka"


def test_taka_for_english() -> None:
    assert expand_taka_for_english("Pay ৳1,500 or BDT 250 or Tk 20 now") == "Pay 1,500 taka or 250 taka or 20 taka now"
    assert expand_taka_for_english("Pay 250৳ now") == "Pay 250 taka now"


def test_clean_text_en_end_to_end() -> None:
    text = "**Hello!** 🎉 Your order #1500 (৳1,500) is on https://getchat.site/track.\n\n\nThanks!"
    assert clean_text(text, "en") == "Hello! Your order #1500 (1,500 taka) is on our website.\nThanks!"
    assert expand_hash_numbers("order #1500 and # tag", "en") == "order number 1500 and # tag"
    assert expand_hash_numbers("অর্ডার #1500", "bn") == "অর্ডার নম্বর 1500"


def test_clean_text_bn_keeps_taka_sign_for_the_number_normaliser() -> None:
    assert clean_text("মোট ৳250 💸", "bn") == "মোট ৳250"


def test_whitespace_and_newlines() -> None:
    assert clean_text("a \t b\r\n\r\n\r\nc d", "en") == "a b\nc d"


def test_stray_symbols_and_empty() -> None:
    assert clean_text("{x} [y] a^b <z> # tag", "en") == "x y a b tag"
    assert clean_text("", "en") == ""
    assert clean_text("🎉🎉", "bn") == ""
