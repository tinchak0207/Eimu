#!/usr/bin/env python3
"""classify_session 純函數真值表測試（無 I/O、不打 Supabase grant、不碰活 token）。

執行：`python3 test_watchdog_classify.py`（全綠 = 所有例子的 state/reason 都符）。

重點案例（Case 1）是 P1 修復後生產上 `last_st_refresh_result` 的**真實字串**：
Supabase 的真錯誤（refresh_token_not_found，HTTP 400）與 provider fallback 的 401
**串接在同一行**，必須判成 chain_dead/supabase_refresh_token_revoked，
**不是** provider_bearer_401——舊碼把 401 規則排在前面，所以一直誤判（2026-10-03 教訓）。
"""
import sys
from datetime import datetime, timezone

from watchdog import classify_session

NOW = datetime(2026, 10, 3, 0, 0, 0, tzinfo=timezone.utc)
FRESH = "2026-10-03T06:00:00Z"   # > NOW
EXPIRED = "2026-10-02T12:06:19.208755522Z"  # < NOW

# P1 之前生產帳號留下的假線索（Supabase 真錯誤被 provider 401 覆蓋）——不該再出現，
# 但若歷史殘留也必須判死。
PROVIDER_401_ONLY = (
    "provider_token FlowMusic bearer update failed: POST "
    "https://www.flowmusic.app/__api/auth/google/save: HTTP 401 {\"detail\":\"Unauthorized\"}"
)

# Case 1 的真實字串（VPS /api/tokens/1 的 last_st_refresh_result，2026-10-03 實查原文）
P1_REAL = (
    "supabase refresh failed: POST https://sb.flowmusic.app/auth/v1/token?grant_type=refresh_token: "
    "HTTP 400 {\"code\":\"refresh_token_not_found\",\"message\":\"Invalid Refresh Token: Refresh Token Not Found\"}; "
    "provider fallback failed: provider_token FlowMusic bearer update failed: POST "
    "https://www.flowmusic.app/__api/auth/google/save: HTTP 401 {\"detail\":\"Unauthorized\"}"
)

# (name, last_st_refresh_result, expires_at, expected_state, expected_reason)
CASES = [
    (
        "P1 串接真字串：Supabase 400 not_found ＋ provider 401",
        P1_REAL, EXPIRED,
        "chain_dead", "supabase_refresh_token_revoked",
    ),
    (
        "Supabase reuse detection（already_used）",
        "supabase refresh failed: HTTP 400 {\"code\":\"refresh_token_already_used\"}",
        EXPIRED,
        "chain_dead", "second_consumer_reuse_detected",
    ),
    (
        "健康噪音 no_provider_token（不是死訊）",
        "supabase_refresh_no_provider_token",
        EXPIRED,
        "healthy", "health_noise:supabase_refresh_no_provider_token",
    ),
    (
        "單純 provider bearer 401（無 Supabase 訊號）",
        PROVIDER_401_ONLY, EXPIRED,
        "chain_dead", "provider_bearer_401",
    ),
    (
        "expires_at 未過期、無錯誤 → healthy",
        "", FRESH,
        "healthy", "expires_at_fresh",
    ),
    (
        "其他過期、無已知死訊 → stale",
        "some transient network error", EXPIRED,
        "stale", "expired_no_known_error",
    ),
    (
        "任何 refresh_token_ 前綴 4xx（expired 變體）",
        "supabase refresh failed: HTTP 400 {\"code\":\"refresh_token_expired\"}",
        EXPIRED,
        "chain_dead", "supabase_refresh_token_revoked",
    ),
    (
        "reuse 與 provider 401 同時出現 → reuse 優先",
        "refresh_token_already_used; " + PROVIDER_401_ONLY,
        EXPIRED,
        "chain_dead", "second_consumer_reuse_detected",
    ),
]


def main():
    failures = 0
    for name, text, expires, want_state, want_reason in CASES:
        got = classify_session(text, expires, now=NOW)
        ok = got["state"] == want_state and got["reason"] == want_reason
        mark = "PASS" if ok else "FAIL"
        print("[%s] %s" % (mark, name))
        print("       got  = %s/%s" % (got["state"], got["reason"]))
        if not ok:
            print("       want = %s/%s" % (want_state, want_reason))
            failures += 1

    print("----")
    print("%d/%d passed" % (len(CASES) - failures, len(CASES)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
