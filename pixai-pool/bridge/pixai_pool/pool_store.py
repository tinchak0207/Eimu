"""號池存儲：pool.json（Sub2API accounts 兼容欄位 + 號池管理欄位）。

欄位對齊 Sub2API data bundle 帳號核心欄位，接入時可無損映射。

=== 安全寫入模式 ===
- 原子寫：mkstemp → write → fsync → os.replace（避免寫半截損壞）
- 跨進程鎖：fcntl.flock（POSIX）/ msvcrt.locking（Windows）
- 線程鎖：同進程多線程共搶同一 path 時序列化
"""
import json
import os
import tempfile
import threading
import time

try:
    import fcntl
except ImportError:
    fcntl = None

try:
    import msvcrt
except ImportError:
    msvcrt = None


class PoolStore:
    def __init__(self, path):
        self.path = path
        self._thread_lock = threading.RLock()
        self._lock_path = os.path.join(
            os.path.dirname(path),
            "." + os.path.basename(path) + ".lock",
        )

    # ── 公開 API（與舊版相容） ──────────────────────────────────────

    def load(self):
        if not os.path.exists(self.path):
            return []
        with self._locked():
            with open(self.path, encoding="utf-8") as f:
                return json.load(f)

    def save(self, accounts):
        with self._locked():
            self._atomic_write(accounts)

    def get(self, email):
        for acc in self.load():
            if acc.get("email") == email:
                return acc
        return None

    def upsert(self, account):
        with self._locked():
            accounts = self._read_unlocked()
            for i, acc in enumerate(accounts):
                if acc.get("email") == account.get("email"):
                    accounts[i] = {**acc, **account}
                    self._atomic_write(accounts)
                    return accounts[i]
            accounts.append(account)
            self._atomic_write(accounts)
            return account

    def add(self, account):
        with self._locked():
            accounts = self._read_unlocked()
            accounts.append(account)
            self._atomic_write(accounts)

    def all_active(self):
        return [a for a in self.load() if a.get("status") == "active"]

    def stats(self):
        accounts = self.load()
        by_status = {}
        for a in accounts:
            s = a.get("status", "unknown")
            by_status[s] = by_status.get(s, 0) + 1
        claimed_today = sum(1 for a in accounts
                            if a.get("last_claim_date") == time.strftime("%Y-%m-%d"))
        return {
            "total": len(accounts),
            "by_status": by_status,
            "claimed_today": claimed_today,
            "path": self.path,
        }

    # ── 內部實現 ────────────────────────────────────────────────────

    def _locked(self):
        """返回上下文管理器：線程鎖 + OS 文件鎖（雙層防護）。"""
        class _LockContext:
            def __init__(self, outer):
                self.outer = outer
            def __enter__(self):
                self.outer._thread_lock.acquire()
                self._fd = os.open(
                    self.outer._lock_path,
                    os.O_RDWR | os.O_CREAT,
                    0o600,
                )
                if fcntl is not None:
                    fcntl.flock(self._fd, fcntl.LOCK_EX)
                elif msvcrt is not None:
                    os.lseek(self._fd, 0, os.SEEK_SET)
                    msvcrt.locking(self._fd, msvcrt.LK_LOCK, 1)
            def __exit__(self, *exc):
                if fcntl is not None:
                    try:
                        fcntl.flock(self._fd, fcntl.LOCK_UN)
                    except OSError:
                        pass
                elif msvcrt is not None:
                    try:
                        os.lseek(self._fd, 0, os.SEEK_SET)
                        msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
                    except OSError:
                        pass
                os.close(self._fd)
                self.outer._thread_lock.release()
        return _LockContext(self)

    def _read_unlocked(self):
        if not os.path.exists(self.path):
            return []
        with open(self.path, encoding="utf-8") as f:
            return json.load(f)

    def _atomic_write(self, accounts):
        """原子寫入：mkstemp → write → fsync → os.replace。"""
        dirpath = os.path.dirname(self.path)
        fd, tmp_name = tempfile.mkstemp(
            prefix="." + os.path.basename(self.path) + ".",
            suffix=".tmp",
            dir=dirpath,
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
                json.dump(accounts, f, ensure_ascii=False, indent=2)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
            os.replace(tmp_name, self.path)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        except BaseException:
            try:
                if os.path.exists(tmp_name):
                    os.unlink(tmp_name)
            except OSError:
                pass
            raise