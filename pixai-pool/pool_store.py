"""號池存儲：pool.json（Sub2API accounts 兼容欄位 + 號池管理欄位）。

欄位對齊 Sub2API data bundle 帳號核心欄位，接入時可無損映射。
"""
import json
import os
import threading
import time


class PoolStore:
    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()

    def load(self):
        if not os.path.exists(self.path):
            return []
        with open(self.path, encoding="utf-8") as f:
            return json.load(f)

    def save(self, accounts):
        with self._lock:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(accounts, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)

    def get(self, email):
        for acc in self.load():
            if acc.get("email") == email:
                return acc
        return None

    def upsert(self, account):
        accounts = self.load()
        for i, acc in enumerate(accounts):
            if acc.get("email") == account.get("email"):
                accounts[i] = {**acc, **account}
                self.save(accounts)
                return accounts[i]
        accounts.append(account)
        self.save(accounts)
        return account

    def add(self, account):
        accounts = self.load()
        accounts.append(account)
        self.save(accounts)

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
