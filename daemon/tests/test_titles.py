from __future__ import annotations

from harness_daemon.titles import TITLE_CHARS, clean_title


def test_clean_title_removes_reasoning_quotes_and_markdown():
    assert clean_title("<think>The user wants labels.</think>\n\n\"QR Label Scraper Script\".") == "QR Label Scraper Script"
    assert clean_title("**Title:** Fix the login bug") == "Fix the login bug"
    assert clean_title("# Add dark mode\n\nMore text.") == "Add dark mode"


def test_clean_title_gives_none_for_no_text():
    assert clean_title("") is None
    assert clean_title("<think>only reasoning") is None
    assert clean_title("  \n ") is None


def test_clean_title_cuts_a_long_title_at_a_word():
    title = clean_title("word " * 40)
    assert title is not None and len(title) <= TITLE_CHARS and not title.endswith(" ")
