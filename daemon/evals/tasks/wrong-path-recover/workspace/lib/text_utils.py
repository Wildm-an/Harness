import re


def slugify(text):
    text = re.sub(r"[^a-z0-9]+", "-", text.lower())
    return text.strip("-")


def title_case(text):
    return " ".join(word.capitalize() for word in text.split())
