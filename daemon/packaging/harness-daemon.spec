# PyInstaller spec for the daemon sidecar (SPEC.md section 10, phase 13).
#
# Build with scripts/build_sidecar.py. The result is a folder (PyInstaller "onedir"):
# build/sidecar/dist/harness-daemon/, with the executable harness-daemon (.exe on Windows) and the
# _internal folder. A onefile executable unpacks all its files to a temporary folder at each start,
# which took about 4 seconds of the 7 seconds before the daemon was ready.

import os
import sys

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

DAEMON = os.path.dirname(SPECPATH)  # SPECPATH is the folder of this file.
PLUGIN_HOST = os.path.join(os.path.dirname(DAEMON), "plugin-host")

hiddenimports = [
    # The daemon: the tools and the Cookbook modules. hostscript.py is also a data file,
    # because the daemon sends its text to a Python process (see cookbook/hosts.py).
    *collect_submodules("harness_daemon"),
    # uvicorn and websockets select their implementations at run time.
    *collect_submodules("uvicorn"),
    *collect_submodules("websockets"),
    # mcp.cli needs typer, and the daemon does not use it.
    *collect_submodules("mcp", filter=lambda name: not name.startswith("mcp.cli")),
    # The terminal pane on Windows (ConPTY). terminal.py imports it in a function.
    *(["winpty"] if sys.platform == "win32" else []),
]

datas = [
    (os.path.join(DAEMON, "harness_daemon", "cookbook", "hostscript.py"), "harness_daemon/cookbook"),
    # The Playwright driver: node and the Playwright package. Chromium is not in the
    # bundle. harness-daemon --install-browser installs it.
    *collect_data_files("playwright", include_py_files=False),
    # The Node plugin host for DeepSeek Harness plugins (plugins/dsh.py). It runs on the Node of
    # the Playwright driver. build_sidecar.py installs its packages first.
    (os.path.join(PLUGIN_HOST, "package.json"), "plugin-host"),
    (os.path.join(PLUGIN_HOST, "src"), "plugin-host/src"),
    (os.path.join(PLUGIN_HOST, "node_modules"), "plugin-host/node_modules"),
]

binaries = []
if sys.platform == "win32":
    # The terminal pane: pywinpty starts these helper programs from its package folder.
    import winpty

    WINPTY = os.path.dirname(winpty.__file__)
    binaries += [(os.path.join(WINPTY, name), "winpty") for name in ("OpenConsole.exe", "winpty-agent.exe")]


def windows_version_info():
    """The version resource of harness-daemon.exe: the product name, the version, and the copyright.

    Code signing (SignPath) checks that each signed file has the product name and the version of the
    release. The version comes from pyproject.toml, the copyright from tauri.conf.json.
    """
    import json
    import tomllib

    from PyInstaller.utils.win32.versioninfo import (FixedFileInfo, StringFileInfo, StringStruct, StringTable,
                                                     VarFileInfo, VarStruct, VSVersionInfo)

    with open(os.path.join(DAEMON, "pyproject.toml"), "rb") as f:
        version = tomllib.load(f)["project"]["version"]
    tauri_conf = os.path.join(os.path.dirname(DAEMON), "client", "src-tauri", "tauri.conf.json")
    with open(tauri_conf, encoding="utf-8") as f:
        conf = json.load(f)
    numbers = tuple(int(n) for n in version.split(".")[:3]) + (0,)
    strings = [
        StringStruct("CompanyName", conf["bundle"]["publisher"]),
        StringStruct("FileDescription", f"{conf['productName']} daemon"),
        StringStruct("FileVersion", version),
        StringStruct("InternalName", "harness-daemon"),
        StringStruct("LegalCopyright", conf["bundle"]["copyright"]),
        StringStruct("OriginalFilename", "harness-daemon.exe"),
        StringStruct("ProductName", conf["productName"]),
        StringStruct("ProductVersion", version),
    ]
    return VSVersionInfo(
        ffi=FixedFileInfo(filevers=numbers, prodvers=numbers),
        kids=[
            StringFileInfo([StringTable("040904B0", strings)]),  # US English, Unicode.
            VarFileInfo([VarStruct("Translation", [0x0409, 1200])]),
        ],
    )


a = Analysis(
    [os.path.join(SPECPATH, "entry.py")],
    pathex=[DAEMON],
    hiddenimports=hiddenimports,
    datas=datas,
    binaries=binaries,
    excludes=["tkinter", "pytest", "_pytest", "IPython", "matplotlib", "numpy.tests"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # onedir: the binaries and the data files go in the folder (COLLECT).
    name="harness-daemon",
    console=True,  # The client starts it with no window (CREATE_NO_WINDOW on Windows).
    version=windows_version_info() if sys.platform == "win32" else None,
    upx=False,
    strip=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name="harness-daemon",
    upx=False,
    strip=False,
)
