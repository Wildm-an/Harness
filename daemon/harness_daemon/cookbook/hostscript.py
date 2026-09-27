"""The Cookbook script that runs on a host: the daemon computer, or a remote computer through SSH.

The daemon sends this file to ``python -`` on the host, with two lines before it:
``COMMAND = "<name>"`` and ``ARGS = {...}``. The arguments go in the script, not on the command
line, so that other users of the host cannot see a Hugging Face token in the process list.

The script needs only the standard library. The commands for models also need
``huggingface_hub`` on the host.

Output: one JSON object on each line. The last line has "result" or "error".
Events before it (for example the download progress) have "event".
"""

import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import time

COMMAND = globals().get("COMMAND", "hardware")
ARGS = globals().get("ARGS", {})

STATE_DIR = os.path.join(os.path.expanduser("~"), ".harness", "cookbook")
SERVE_DIR = os.path.join(STATE_DIR, "serves")
MODEL_SUFFIXES = (".gguf", ".safetensors")


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def run(argv, timeout=15):
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return proc.stdout if proc.returncode == 0 else None


# -- hardware ---------------------------------------------------------------------------------


def nvidia_gpus():
    out = run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"])
    gpus = []
    for line in (out or "").strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 3:
            try:
                gpus.append({"name": parts[0], "vendor": "nvidia", "vram_total": int(float(parts[1])) * 1024 ** 2,
                             "vram_used": int(float(parts[2])) * 1024 ** 2})
            except ValueError:
                continue
    return gpus


def amd_gpus():
    out = run(["rocm-smi", "--showproductname", "--showmeminfo", "vram", "--json"])
    if not out:
        return []
    try:
        data = json.loads(out)
    except ValueError:
        return []
    gpus = []
    for card, info in data.items():
        if not isinstance(info, dict):
            continue
        total = next((v for k, v in info.items() if "VRAM Total Memory" in k), None)
        used = next((v for k, v in info.items() if "VRAM Total Used" in k), None)
        name = info.get("Card series") or info.get("Card model") or card
        try:
            gpus.append({"name": str(name), "vendor": "amd", "vram_total": int(total or 0), "vram_used": int(used or 0)})
        except ValueError:
            continue
    return gpus


def ram_total():
    try:
        if sys.platform == "win32":
            import ctypes

            class Status(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong),
                            ("avail", ctypes.c_ulonglong), ("page_total", ctypes.c_ulonglong),
                            ("page_avail", ctypes.c_ulonglong), ("virt_total", ctypes.c_ulonglong),
                            ("virt_avail", ctypes.c_ulonglong), ("ext", ctypes.c_ulonglong)]

            status = Status()
            status.length = ctypes.sizeof(Status)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
            return int(status.total)
        if sys.platform == "darwin":
            return int(run(["sysctl", "-n", "hw.memsize"]) or 0)
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) * 1024
    except Exception:  # noqa: BLE001
        pass
    return 0


def llama_server_argv():
    """The llama-server command: a path, a name on the PATH, or a command with arguments."""
    configured = (ARGS.get("llama_server") or "llama-server").strip()
    if os.path.isfile(os.path.expanduser(configured)):
        return [os.path.expanduser(configured)]
    import shlex
    parts = [p.strip('"') for p in shlex.split(configured, posix=sys.platform != "win32")]
    if not parts:
        return None
    first = shutil.which(os.path.expanduser(parts[0])) or (parts[0] if os.path.isfile(os.path.expanduser(parts[0])) else None)
    return [first, *parts[1:]] if first else None


def llama_server_path():
    argv = llama_server_argv()
    return " ".join(argv) if argv else None


def hub_version():
    try:
        import huggingface_hub
        return huggingface_hub.__version__
    except ImportError:
        return None


def cmd_hardware():
    gpus = nvidia_gpus() or amd_gpus()
    return {
        "hostname": socket.gethostname(),
        "platform": f"{platform.system()} {platform.release()}",
        "gpus": gpus,
        "ram_total": ram_total(),
        "cpu_cores": os.cpu_count() or 0,
        "python": platform.python_version(),
        "huggingface_hub": hub_version(),
        "llama_server": llama_server_path(),
        "tmux": shutil.which("tmux") is not None,
        "hf_cache": hf_cache_dir(),
    }


# -- models ----------------------------------------------------------------------------------------


def hf_cache_dir():
    try:
        from huggingface_hub import constants
        return constants.HF_HUB_CACHE
    except ImportError:
        home = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
        return os.path.join(home, "hub")


def repo_folder(repo_id):
    return os.path.join(hf_cache_dir(), "models--" + repo_id.replace("/", "--"))


def need_hub():
    try:
        import huggingface_hub  # noqa: F401
    except ImportError:
        raise RuntimeError("huggingface_hub is not installed on this host. Install it with: pip install huggingface_hub")


def cmd_download():
    """Download files into the Hugging Face cache. A stopped download continues from its .incomplete file."""
    os.environ["HF_HUB_DISABLE_XET"] = "1"  # Plain HTTP downloads can continue after a pause.
    os.environ.pop("HF_HUB_DISABLE_PROGRESS_BARS", None)  # It also turns off the progress class below.
    need_hub()
    from huggingface_hub import constants, hf_hub_download
    from tqdm.auto import tqdm

    # The progress updates come once for each chunk. The default chunk is 10 MB.
    constants.DOWNLOAD_CHUNK_SIZE = 1024 * 1024

    token = ARGS.get("token") or None
    files = ARGS["files"]
    state = {"file": None, "done": 0, "last": 0.0}

    class Progress(tqdm):
        def __init__(self, *a, **kw):
            kw["disable"] = False
            kw["file"] = open(os.devnull, "w")
            super().__init__(*a, **kw)

        def update(self, n=1):
            super().update(n)
            now = time.monotonic()
            if now - state["last"] >= 0.25:
                state["last"] = now
                emit({"event": "progress", "file": state["file"], "done": int(self.n), "total": int(self.total or 0)})

    paths = []
    for name in files:
        state["file"] = name
        emit({"event": "file", "file": name})
        path = hf_hub_download(ARGS["repo_id"], name, token=token, tqdm_class=Progress)
        paths.append(path)
        emit({"event": "file_done", "file": name, "size": os.path.getsize(path)})
    return {"paths": paths}


def cmd_cleanup():
    """Remove the unfinished downloads of a repository (after a cancel)."""
    blobs = os.path.join(repo_folder(ARGS["repo_id"]), "blobs")
    removed = 0
    if os.path.isdir(blobs):
        for name in os.listdir(blobs):
            if name.endswith(".incomplete"):
                try:
                    os.remove(os.path.join(blobs, name))
                    removed += 1
                except OSError:
                    pass
    return {"removed": removed}


def cmd_installed():
    """The model files in the Hugging Face cache, for each repository."""
    root = hf_cache_dir()
    repos = []
    if not os.path.isdir(root):
        return {"repos": repos, "cache": root}
    for folder in sorted(os.listdir(root)):
        if not folder.startswith("models--"):
            continue
        repo_id = folder[len("models--"):].replace("--", "/")
        snapshots = os.path.join(root, folder, "snapshots")
        files = {}
        for dirpath, _dirs, names in os.walk(snapshots):
            for name in names:
                if not name.endswith(MODEL_SUFFIXES):
                    continue
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, snapshots).replace("\\", "/").split("/", 1)[-1]
                try:
                    size = os.path.getsize(path)  # The size of the blob for a link.
                except OSError:
                    continue
                files[rel] = {"name": rel, "size": size, "path": path}
        if files:
            items = sorted(files.values(), key=lambda f: f["name"])
            repos.append({"repo_id": repo_id, "files": items, "size": sum(f["size"] for f in items)})
    return {"repos": repos, "cache": root}


def cmd_delete():
    """Delete model files of a repository. A blob goes too when no other file uses it."""
    folder = repo_folder(ARGS["repo_id"])
    snapshots = os.path.join(folder, "snapshots")
    wanted = set(ARGS["files"])
    deleted = []
    for dirpath, _dirs, names in os.walk(snapshots):
        for name in names:
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, snapshots).replace("\\", "/").split("/", 1)[-1]
            if rel not in wanted:
                continue
            blob = os.path.realpath(path) if os.path.islink(path) else None
            os.remove(path)
            deleted.append(rel)
            if blob and os.path.isfile(blob) and not _blob_used(snapshots, blob):
                os.remove(blob)
    # A repository with no model files left goes away.
    if not any(n.endswith(MODEL_SUFFIXES) for _d, _s, names in os.walk(snapshots) for n in names):
        shutil.rmtree(folder, ignore_errors=True)
    return {"deleted": deleted}


def _blob_used(snapshots, blob):
    for dirpath, _dirs, names in os.walk(snapshots):
        for name in names:
            path = os.path.join(dirpath, name)
            if os.path.islink(path) and os.path.realpath(path) == blob:
                return True
    return False


def cmd_resolve():
    """The local path of a downloaded file, or null."""
    need_hub()
    from huggingface_hub import try_to_load_from_cache
    path = try_to_load_from_cache(ARGS["repo_id"], ARGS["file"])
    return {"path": path if isinstance(path, str) and os.path.isfile(path) else None}


# -- serve -------------------------------------------------------------------------------------------


def state_path(name):
    return os.path.join(SERVE_DIR, name + ".json")


def port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def pid_alive(pid):
    if not pid:
        return False
    if sys.platform == "win32":
        out = run(["tasklist", "/FI", f"PID eq {pid}", "/NH"]) or ""
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def cmd_serve_start():
    """Start llama-server in tmux (or as a detached process), so that it continues after the daemon stops."""
    name = ARGS["name"]
    binary = llama_server_argv()
    if not binary:
        raise RuntimeError(
            "llama-server is not on this host. Install llama.cpp, or set the llama-server path of the host "
            "in the Cookbook.")
    if port_open(ARGS["port"]):
        raise RuntimeError(f"Port {ARGS['port']} is in use on this host.")
    os.makedirs(SERVE_DIR, exist_ok=True)
    log = os.path.join(SERVE_DIR, name + ".log")
    argv = [*binary, "-m", ARGS["model_path"], "--host", "127.0.0.1", "--port", str(ARGS["port"]),
            "-c", str(ARGS["context"]), "-ngl", str(ARGS["gpu_layers"]), "--alias", ARGS["alias"], "--jinja",
            *[str(a) for a in ARGS.get("extra") or []]]
    state = {"name": name, "port": ARGS["port"], "model_path": ARGS["model_path"], "alias": ARGS["alias"],
             "context": ARGS["context"], "gpu_layers": ARGS["gpu_layers"], "log": log, "started": time.time(),
             "repo_id": ARGS.get("repo_id"), "file": ARGS.get("file")}
    with open(log, "a") as f:
        f.write(f"\n$ {' '.join(argv)}\n")
    if shutil.which("tmux") and sys.platform != "win32":
        import shlex
        session = "harness-" + name
        command = " ".join(shlex.quote(a) for a in argv) + " >> " + shlex.quote(log) + " 2>&1"
        subprocess.run(["tmux", "new-session", "-d", "-s", session, command], check=True)
        state["tmux"] = session
    else:
        out = open(log, "a")
        kwargs = {"stdout": out, "stderr": subprocess.STDOUT, "stdin": subprocess.DEVNULL}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000008 | 0x08000000  # DETACHED, NO_WINDOW
        else:
            kwargs["start_new_session"] = True
        state["pid"] = subprocess.Popen(argv, **kwargs).pid
    with open(state_path(name), "w") as f:
        json.dump(state, f)
    return state


def serve_alive(state):
    if state.get("tmux"):
        return subprocess.run(["tmux", "has-session", "-t", state["tmux"]], capture_output=True).returncode == 0
    return pid_alive(state.get("pid"))


def cmd_serve_status():
    items = []
    if os.path.isdir(SERVE_DIR):
        for name in sorted(os.listdir(SERVE_DIR)):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(SERVE_DIR, name)) as f:
                    state = json.load(f)
            except (OSError, ValueError):
                continue
            state["alive"] = serve_alive(state)
            state["ready"] = state["alive"] and port_open(state["port"])
            items.append(state)
    return {"serves": items}


def cmd_serve_stop():
    path = state_path(ARGS["name"])
    try:
        with open(path) as f:
            state = json.load(f)
    except (OSError, ValueError):
        return {"stopped": False}
    if state.get("tmux"):
        subprocess.run(["tmux", "kill-session", "-t", state["tmux"]], capture_output=True)
    elif state.get("pid"):
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(state["pid"]), "/T", "/F"], capture_output=True)
        else:
            try:
                os.killpg(state["pid"], signal.SIGTERM)
            except OSError:
                pass
    os.remove(path)
    return {"stopped": True}


def cmd_serve_log():
    log = os.path.join(SERVE_DIR, ARGS["name"] + ".log")
    try:
        with open(log, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 64 * 1024))
            text = f.read().decode("utf-8", errors="replace")
    except OSError:
        return {"text": ""}
    lines = text.splitlines()[-int(ARGS.get("lines") or 200):]
    return {"text": "\n".join(lines)}


COMMANDS = {
    "hardware": cmd_hardware, "download": cmd_download, "cleanup": cmd_cleanup, "installed": cmd_installed,
    "delete": cmd_delete, "resolve": cmd_resolve, "serve-start": cmd_serve_start, "serve-status": cmd_serve_status,
    "serve-stop": cmd_serve_stop, "serve-log": cmd_serve_log,
}

if __name__ == "__main__":
    try:
        emit({"result": COMMANDS[COMMAND]()})
    except Exception as e:  # noqa: BLE001 - the daemon shows the message.
        emit({"error": f"{type(e).__name__}: {e}" if not isinstance(e, RuntimeError) else str(e)})
