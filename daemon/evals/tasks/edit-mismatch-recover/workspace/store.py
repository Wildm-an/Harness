import json
import os


def load(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if not text.strip():
        return None
    return json.loads(text)


def load_backup(path):
    if not os.path.exists(path + ".bak"):
        return None
    return load(path + ".bak")
