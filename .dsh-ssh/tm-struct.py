#!/usr/bin/env python3
"""帳號級 vs IP 級 408 判定（v3）：直接看 token_mgr 內部結構拿活躍 token。"""
import sys, json
sys.path.insert(0, "/app")
from core.token_mgr import token_manager

# tokens 是屬性還是方法？
t = token_manager.tokens
if callable(t):
    t = t()
print(type(t))
if isinstance(t, list):
    print("count:", len(t))
    for i, item in enumerate(t):
        if isinstance(item, dict):
            print(i, {k: (str(v)[:24] if k != "value" else str(v)[:20] + "...") for k, v in item.items() if k in ("token_id", "token_account_id", "status", "state", "source", "valid", "error_count", "value", "expires_at")})
        else:
            print(i, str(item)[:60])
elif isinstance(t, dict):
    print("keys:", list(t.keys())[:10])
