"""Static survey of DeepSeek Harness plugins. It reads the package files. It runs no plugin code."""

import io
import json
import re
import sys
import tarfile
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

TOP = int(sys.argv[1]) if len(sys.argv) > 1 else 30
ranked = json.load(open("ranked.json", encoding="utf-8"))[:TOP]
root = Path("pkgs")
root.mkdir(exist_ok=True)

INJECT_RE = re.compile(r"""\binject\s*[:=]\s*(\[[^\]]*\]|\{[^}]*\})""", re.S)
QUOTED_RE = re.compile(r"""['"]([A-Za-z0-9_.$-]+)['"]""")
CTX_RE = re.compile(r"""\bctx\.([A-Za-z_$][\w$]*)""")
GET_RE = re.compile(r"""\bctx\.get\(\s*['"]([\w.]+)['"]""")
SLOT_RE = re.compile(r"""['"]((?:conversation|sidebar|settings|shell|tool\.call|tool\.view|rightbar|plugins|main|deliverables|root)(?:\.[\w-]+)*)['"]""")
EVENT_RE = re.compile(r"""\.(?:on|once|waterfall|serial|emit|bail|parallel)\(\s*['"]([a-z][\w-]*/[\w/-]+)['"]""")
IMPORT_RE = re.compile(r"""(?:from\s*|import\s*\(\s*|require\(\s*)['"](@deepseek-ai/[^'"]+)['"]""")
CTX_NOT_SERVICES = {"on", "once", "emit", "plugin", "get", "set", "provide", "effect", "inject", "extend", "isolate",
                    "root", "runtime", "registry", "events", "logger", "baseUrl", "fiber", "scope", "waterfall",
                    "serial", "parallel", "bail", "reflect", "accessor", "mixin", "then", "off", "filter", "intercept",
                    "name", "config", "call", "apply", "bind", "t", "log"}


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def analyze(name):
    meta = fetch_json("https://registry.npmjs.org/" + urllib.parse.quote(name, safe="@"))
    version = meta["dist-tags"]["latest"]
    manifest = meta["versions"][version]
    with urllib.request.urlopen(manifest["dist"]["tarball"], timeout=120) as r:
        data = r.read()
    (root / (name.replace("/", "__") + ".tgz")).write_bytes(data)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for m in tar.getmembers():
            if m.isfile() and m.size < 5_000_000:
                rel = m.name.split("/", 1)[1] if "/" in m.name else m.name
                files[rel] = tar.extractfile(m).read()
    dsh = manifest.get("dsh") or {}
    client = dsh.get("client")
    exports = manifest.get("exports")
    client_paths = set()
    if isinstance(exports, dict) and "./client" in exports:
        c = exports["./client"]
        client_paths.add(str(c if isinstance(c, str) else (c.get("default") or c.get("import") or "")).lstrip("./"))
    patches = dsh.get("bundle", {}).get("patch", [])
    patches = [patches] if isinstance(patches, str) else patches
    rows = []
    for p in patches:
        text = files.get(p.lstrip("./"), b"").decode("utf-8", "replace")
        try:
            for patch in yaml.safe_load(text) or []:
                for e in (patch.get("insert") or []) if isinstance(patch, dict) else []:
                    if isinstance(e, dict):
                        rows.append({"id": e.get("id"), "name": e.get("name"), "disabled": bool(e.get("disabled"))})
        except yaml.YAMLError as e:
            rows.append({"error": str(e)[:100]})
    host_js = [(k, v.decode("utf-8", "replace")) for k, v in files.items()
               if k.endswith((".js", ".mjs", ".cjs")) and k not in client_paths and "client" not in Path(k).stem
               and "/client/" not in k and not k.startswith(("test", "tests/", "src/"))]
    if not host_js:  # A source-only package.
        host_js = [(k, v.decode("utf-8", "replace")) for k, v in files.items() if k.endswith((".js", ".ts", ".mjs")) and "client" not in k]
    injects, used, gets, events, imports = set(), set(), set(), set(), set()
    for _, text in host_js:
        for m in INJECT_RE.finditer(text):
            injects.update(QUOTED_RE.findall(m.group(1)))
        used.update(s for s in CTX_RE.findall(text) if s not in CTX_NOT_SERVICES)
        gets.update(GET_RE.findall(text))
        events.update(EVENT_RE.findall(text))
        imports.update(IMPORT_RE.findall(text))
    slots = set()
    for k, v in files.items():
        if k.endswith((".js", ".mjs", ".cjs")) and ("client" in k or k in client_paths):
            slots.update(SLOT_RE.findall(v.decode("utf-8", "replace")))
    peers = {k: v for k, v in (manifest.get("peerDependencies") or {}).items() if k.startswith("@deepseek-ai/")}
    scripts = manifest.get("scripts") or {}
    return {
        "name": name, "version": version,
        "description": (manifest.get("description") or "")[:120],
        "bundle": bool(patches), "client": client is not None, "profile": "profile" in dsh,
        "rows": rows, "inject": sorted(injects), "ctx_used": sorted(used), "ctx_get": sorted(gets),
        "events": sorted(events), "imports": sorted({re.sub(r"^(@deepseek-ai/[^/]+).*", r"\1", i) for i in imports}),
        "peers": peers, "deps": len(manifest.get("dependencies") or {}),
        "install_scripts": sorted(k for k in scripts if k in ("preinstall", "install", "postinstall")),
        "slots": sorted(slots),
        "typescript_only": not any(k.endswith((".js", ".mjs", ".cjs")) for k in files),
        "files": len(files),
    }


results = []
for name, dl in ranked:
    try:
        r = analyze(name)
        r["downloads"] = dl
    except Exception as e:  # noqa: BLE001
        r = {"name": name, "downloads": dl, "error": f"{type(e).__name__}: {e}"}
    results.append(r)
    print(name, "ok" if "error" not in r else r["error"], flush=True)
json.dump(results, open("survey.json", "w", encoding="utf-8"), indent=1)
