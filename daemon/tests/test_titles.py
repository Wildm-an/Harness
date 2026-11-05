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


def test_title_request_has_the_system_prompt_and_the_message_frame():
    from harness_daemon.titles import title_messages

    system, user = title_messages("  fix the login bug  ")
    assert system["role"] == "system" and system["content"].startswith("You name coding sessions")
    assert user["role"] == "user" and "<message>\nfix the login bug\n</message>" in user["content"]


def test_pick_small_takes_the_best_family_and_its_newest_model():
    from harness_daemon.titles import pick_small

    models = ["claude-opus-5-5", "claude-haiku-4-5", "claude-haiku-5-5", "gemini-2.5-flash"]
    assert pick_small(models, "claude-opus-5-5") == "claude-haiku-5-5"
    assert pick_small(["gpt-5", "gpt-4o-mini-tts", "o4-mini", "gpt-5-mini"], "gpt-5") == "gpt-5-mini"
    assert pick_small(["google/gemini-2.5-flash-lite", "google/gemini-2.5-flash"], "x") == "google/gemini-2.5-flash-lite"
    assert pick_small(["big-model"], "big-model") is None
    assert pick_small(["claude-haiku-5-5"], "gemini-2.5-flash") == "gemini-2.5-flash"  # The session model is small.


def test_a_local_provider_keeps_the_session_model():
    from harness_daemon.providers import ModelClient, Provider
    from harness_daemon.titles import is_local

    def local(url: str, **kw) -> bool:
        return is_local(ModelClient(Provider(name="p", base_url=url, **kw), "m"))

    assert local("http://127.0.0.1:1234/v1") and local("http://localhost:8080/v1")
    assert local("http://192.168.1.5:8000/v1") and local("http://gpu-box:8000/v1")
    assert local("https://api.example.com/v1", kind="ollama")
    assert not local("https://openrouter.ai/api/v1") and not local("https://api.anthropic.com/v1")


def test_summarize_title_uses_the_session_model_when_the_small_model_fails(monkeypatch):
    import asyncio

    from harness_daemon import titles
    from harness_daemon.providers import ModelClient, ModelError, Provider

    asked: list[str] = []

    async def fake_stream(self, messages, tools, on_text, **kw):
        asked.append(self.model)
        if self.model == "small":
            raise ModelError("The small model failed.")
        return type("R", (), {"text": "Login bug fix"})()

    async def fake_small(client):
        return "small"

    monkeypatch.setattr(ModelClient, "stream", fake_stream)
    monkeypatch.setattr(titles, "small_model", fake_small)
    client = ModelClient(Provider(name="p", base_url="https://api.example.com/v1"), "big")
    assert asyncio.run(titles.summarize_title(client, "fix the login bug")) == "Login bug fix"
    assert asked == ["small", "big"]
