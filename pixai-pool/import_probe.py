"""將已驗證的 probe 號導入 pool.json（含 password/token/claim 狀態）。"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pool_store import PoolStore

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = r"C:\Users\lenovo\AppData\Local\Temp\opencode\probe_result.json"

with open(PROBE, encoding="utf-8") as f:
    probe = json.load(f)

store = PoolStore(os.path.join(HERE, "pool.json"))
acc = store.get(probe["email"])
entry = {
    "email": probe["email"],
    "password": probe["password"],
    "token": probe["token"],
    "user_id": "",
    "email_verified": False,
    "status": "active",
    "priority": 1000,
    "pool": "pixai",
    "platform": "pixai",
    "type": "oauth",
    "created_at": probe.get("time") or time.strftime("%Y-%m-%dT%H:%M:%S"),
    "last_claim_date": "",
    "last_claim_amount": 0,
    "token_expires_at": "",
    "remark": "probe-verified",
}
if acc:
    store.upsert({**acc, **entry})
    print(f"updated: {probe['email']}")
else:
    store.add(entry)
    print(f"added: {probe['email']}")

for a in store.load():
    print(" ", a["email"], a["status"], a["remark"])
