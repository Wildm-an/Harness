"""Delete a file or a folder for the editor (the "Delete" item of the file tree).

On Windows the item goes to the Recycle Bin, so the user can get it back. Other systems have no
standard trash that a daemon can use, so there the delete is permanent. A symbolic link is
removed as a link: its target stays.
"""

from __future__ import annotations

import os
import shutil
import stat
import sys
from pathlib import Path


def _recycle_windows(path: Path) -> bool:
    """Move a file or a folder to the Recycle Bin with SHFileOperationW. False if it failed."""
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", ctypes.c_uint16),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    FO_DELETE = 3
    FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI = 0x4, 0x10, 0x40, 0x400
    op = SHFILEOPSTRUCTW()
    op.wFunc = FO_DELETE
    op.pFrom = str(path) + "\0"  # The list of paths ends with two null characters.
    op.fFlags = FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI
    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    return result == 0 and not op.fAnyOperationsAborted and not os.path.lexists(path)


def _writable(func, p, _exc) -> None:  # git and some tools make read-only files on Windows.
    os.chmod(p, stat.S_IWRITE)
    func(p)


def delete(path: Path) -> bool:
    """Delete a file, a folder with its contents, or a link. Return True if the item went to the
    Recycle Bin, False if the delete is permanent. Raise OSError if the delete failed."""
    if sys.platform == "win32" and not path.is_symlink() and _recycle_windows(path):
        return True
    if path.is_symlink() or not path.is_dir():
        try:
            path.unlink()
        except PermissionError:
            os.chmod(path, stat.S_IWRITE)
            path.unlink()
    elif sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=_writable)
    else:
        shutil.rmtree(path, onerror=_writable)
    return False
