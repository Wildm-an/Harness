# PyInstaller spec for the daemon sidecar (SPEC.md section 10, phase 13).
#
# Build with scripts/build_sidecar.py. The result is one executable:
# build/sidecar/dist/harness-daemon (.exe on Windows).

import os

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

a = Analysis(
    [os.path.join(SPECPATH, "entry.py")],
    pathex=[DAEMON],
    hiddenimports=hiddenimports,
    datas=datas,
    excludes=["tkinter", "pytest", "_pytest", "IPython", "matplotlib", "numpy.tests"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name="harness-daemon",
    console=True,  # The client starts it with no window (CREATE_NO_WINDOW on Windows).
    upx=False,
    strip=False,
)
