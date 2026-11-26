"""Cross-process transactions for the existing JSON state files."""
from .i18n import source_message
from contextlib import contextmanager
import os
from pathlib import Path
import threading
import time

_locks: dict[str, threading.RLock] = {}
_guard = threading.Lock()


@contextmanager
def file_lock(path: Path, timeout: float = 5.0):
    """Hold the thread and OS lock across a whole read/modify/replace operation."""
    name = os.path.normcase(str(path.resolve()))
    with _guard:
        lock = _locks.setdefault(name, threading.RLock())
    if not lock.acquire(timeout=timeout):
        raise TimeoutError(source_message('State file is busy; retry the operation.'))
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path.with_name(path.name + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
        with os.fdopen(fd, "r+b", buffering=0) as stream:
            deadline = time.monotonic() + timeout
            while True:
                try:
                    stream.seek(0)
                    if os.name == "nt":
                        import msvcrt
                        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(source_message('State file is busy; retry the operation.')) from None
                    time.sleep(0.02)
            try:
                if not os.fstat(stream.fileno()).st_size:
                    stream.write(b"\0")
                yield
            finally:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    finally:
        lock.release()
