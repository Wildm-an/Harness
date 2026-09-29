"""Rank the DeepSeek Harness plugins on npm by downloads in the last month."""

import json
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

SEARCH = "https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=250&from={}&popularity=1.0&quality=0.0&maintenance=0.0"
names: set[str] = set()
for start in (0, 250, 500, 750):
    with urllib.request.urlopen(SEARCH.format(start), timeout=60) as r:
        data = json.load(r)
    names.update(o["package"]["name"] for o in data["objects"])
print("names", len(names))


def downloads(name: str) -> tuple[str, int]:
    url = "https://api.npmjs.org/downloads/point/last-month/" + urllib.parse.quote(name, safe="@")
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return name, int(json.load(r).get("downloads", 0))
    except Exception:  # noqa: BLE001
        return name, -1


with ThreadPoolExecutor(12) as pool:
    ranked = sorted(pool.map(downloads, sorted(names)), key=lambda x: -x[1])
json.dump(ranked, open("ranked.json", "w", encoding="utf-8"), indent=1)
for name, n in ranked[:40]:
    print(n, name)
