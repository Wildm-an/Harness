"""A Windows Job Object that stops child processes when the daemon stops.

The daemon puts a process in the job. The job has the flag KILL_ON_JOB_CLOSE, and only the daemon
has a handle to the job. When the daemon process ends (a normal exit, a crash, or a kill from the
app), Windows closes the handle and stops all processes in the job. The child processes of a
process in the job are also in the job.

Why: a local llama-server that continues after the daemon can keep DLL files of the daemon folder
open. Then the installer of the next version cannot replace the files.

On other operating systems, the functions do nothing.
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading

log = logging.getLogger(__name__)

_JOB: int | None = None
_LOCK = threading.Lock()

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9


def _create_job() -> int | None:
    import ctypes
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    # No security attributes: the handle is not inheritable, so a child process cannot keep the job open.
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        log.warning("CreateJobObject failed: error %s", ctypes.get_last_error())
        return None
    info = ExtendedLimits()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel32.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                                            ctypes.byref(info), ctypes.sizeof(info)):
        log.warning("SetInformationJobObject failed: error %s", ctypes.get_last_error())
        kernel32.CloseHandle(job)
        return None
    return job


def _job() -> int | None:
    """The job of this daemon. The first call makes it. The handle stays open until the daemon ends."""
    global _JOB
    with _LOCK:
        if _JOB is None:
            _JOB = _create_job() or 0
        return _JOB or None


def stop_with_daemon(proc: subprocess.Popen) -> bool:
    """Put a process (and its future child processes) in the job of the daemon. True if it is in the job.

    Call this before the process starts its child processes. A child process that started before
    the call is not in the job.
    """
    if os.name != "nt":
        return False
    job = _job()
    handle = getattr(proc, "_handle", None)
    if job is None or handle is None or proc.poll() is not None:
        return False
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    if not kernel32.AssignProcessToJobObject(job, int(handle)):
        log.warning("AssignProcessToJobObject failed for pid %s: error %s", proc.pid, ctypes.get_last_error())
        return False
    return True
