#!/usr/bin/env python3
"""FlowMusic2API session watchdog.

每 10 分钟（systemd timer）检查帐号池的 expires_at：
- 新鲜 → 记一笔 healthy 离开（绝不消费活 token）。
- 停滞 → 先用 classify_session() 判读；已知死讯（reuse / bearer 401）直接写结构化
  CHAIN_DEAD.json＋stderr ERROR（journald -p err 可抓），不再盲目打 grant。
  - 其余停滞 → 用库内 refresh_token 做 Supabase refresh grant：
    - 成功 → PUT 写回（自动抢救，service ticker 停摆/丢失轮换可自愈）。
    - refresh_token_already_used → classify_session() 判为 chain_dead → 写
      CHAIN_DEAD.json（侦测时间／last_sign_in_at／判读／建议动作）＋CHAIN_DEAD 文字标记
      （music-tools probeFlowMusic 读此档）＋stderr ERROR。
- 任何判定链活著的出口（healthy／误报／抢救成功）→ 残留 CHAIN_DEAD／CHAIN_DEAD.json
  归档为 .resolved-<UTC>，否则 music_gen 探针会把已救回的通路持续判成
  「需人工登录」（2026-10-01 实锤）。
- 健康噪音 supabase_refresh_no_provider_token 归 healthy（09-30 §4 定案），不误报。
"""
import base64
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

ENV_PATH = "/opt/flowmusic2api/.env"
DEAD_MARKER = "/opt/flowmusic2api/CHAIN_DEAD"
DEAD_MARKER_JSON = "/opt/flowmusic2api/CHAIN_DEAD.json"

# 讯号常数（classify_session 的判读依据；09-30 §4／09-11 实锤）
SIG_REUSE = "refresh_token_already_used"
SIG_BEARER_401 = "bearer update failed"
SIG_HEALTH_NOISE = "supabase_refresh_no_provider_token"
# Supabase 对被吊销 family 的 refresh_token 回 4xx，错误码形如
# refresh_token_not_found / refresh_token_expired …（长度不一，用前缀比对）。
_REFRESH_TOKEN_ERR_RE = re.compile(r"refresh_token_[a-z][a-z_]*")
JUDGEMENT = "疑似浏览器第二消费者抢轮换"
SUGGESTED_ACTION = "请暴君关闭并清除该 profile 后重新导出 cookie"
SIGNAL_HINT = {
    "second_consumer_reuse_detected": "refresh_token_already_used",
    "supabase_refresh_token_revoked": "supabase refresh_token_* 4xx",
    "provider_bearer_401": "provider_token bearer 401",
}


def log(msg):
    print(msg, flush=True)


def log_error(msg):
    # systemd stdout/stderr 连接器解析 kmsg 风格 "<N>" 前缀 → priority=N。
    # 2026-10-02 实测：plain stderr 只记成 info(6)；加 "<3>" 才落 err(3)，
    # journalctl -u flowmusic-watchdog -p err 才抓得到。故显式加前缀。
    print("<3>ERROR " + msg, file=sys.stderr, flush=True)


def classify_session(last_st_refresh_result, expires_at, now=None):
    """纯函数：由 last_st_refresh_result 全文 + expires_at 判读链状态（无 I/O、可单测）。

    输出 {"state","reason","action"}：
      - state=chain_dead：链已死，需人工换血。
      - state=healthy  ：链活著或仅为已知健康噪音。
      - state=stale     ：凭证过期但无已知死讯，可尝试 grant 抢救。
    判读优先序：
      1. refresh_token_already_used → chain_dead（Supabase reuse detection）
      2. Supabase refresh_token_* 4xx（含 refresh_token_not_found）→ chain_dead
         （**必须排在 provider 401 之前**：P1 修复后 Supabase 真错误会与
         provider fallback 的 401 串接在同一行，顺序反了会继续误判成
         provider_bearer_401 —— 2026-10-03 实锤教训）
      3. provider bearer update failed … 401 → chain_dead（provider_token 死讯）
      4. supabase_refresh_no_provider_token → healthy（健康噪音，非死讯）
      5. expires_at 未过期 → healthy
      6. 其他过期 → stale
    """
    text = last_st_refresh_result or ""
    if SIG_REUSE in text:
        return {"state": "chain_dead", "reason": "second_consumer_reuse_detected", "action": "reimport_cookie"}
    if "400" in text and _REFRESH_TOKEN_ERR_RE.search(text):
        return {"state": "chain_dead", "reason": "supabase_refresh_token_revoked", "action": "reimport_cookie"}
    if SIG_BEARER_401 in text and "401" in text:
        return {"state": "chain_dead", "reason": "provider_bearer_401", "action": "reimport_cookie"}
    if SIG_HEALTH_NOISE in text:
        return {"state": "healthy", "reason": "health_noise:supabase_refresh_no_provider_token", "action": "none"}
    now = now or datetime.now(timezone.utc)
    try:
        fresh = parse_ts(expires_at) > now
    except Exception:
        fresh = False
    if fresh:
        return {"state": "healthy", "reason": "expires_at_fresh", "action": "none"}
    return {"state": "stale", "reason": "expired_no_known_error", "action": "rescue_refresh"}


def extract_last_sign_in_at(google_cookies):
    """从 google_cookies（`name=value; name=value`）解出 Supabase session 的 last_sign_in_at。

    只读 .0/.1 两 chunk（.0 去 `base64-` 前缀）→ 拼接 → 严格 UTF-8 解 → user.last_sign_in_at。
    任何解析失败回 None（不抛、不影响看门狗主流程）。
    """
    try:
        parts = {}
        for seg in (google_cookies or "").split(";"):
            seg = seg.strip()
            if "=" not in seg:
                continue
            k, v = seg.split("=", 1)
            parts[k.strip()] = v.strip()
        v0 = parts.get("sb-sb-auth-token.0", "")
        v1 = parts.get("sb-sb-auth-token.1", "")
        if v0.startswith("base64-"):
            v0 = v0[len("base64-"):]
        raw = v0 + v1
        if not raw:
            return None
        raw += "=" * ((4 - len(raw) % 4) % 4)
        sess = json.loads(base64.b64decode(raw, validate=True).decode("utf-8"))
        return (sess.get("user") or {}).get("last_sign_in_at")
    except Exception:
        return None


def write_chain_dead_json(acct, cls, detected_at=None):
    """写结构化 CHAIN_DEAD.json（治本：判读机器可读 + 人话建议动作）。"""
    # 首次侦测优先：已存在（未归档）就不覆写，保留最初死讯时间
    if os.path.exists(DEAD_MARKER_JSON):
        try:
            with open(DEAD_MARKER_JSON) as f:
                return json.load(f)
        except Exception:
            pass
    detected = (detected_at or datetime.now(timezone.utc))
    detected = detected.isoformat() if hasattr(detected, "isoformat") else str(detected)
    payload = {
        "detected_at": detected,
        "state": cls.get("state"),
        "reason": cls.get("reason"),
        "judgement": JUDGEMENT,
        "account_email": acct.get("email"),
        "expires_at": acct.get("expires_at"),
        "last_st_refresh_result": acct.get("last_st_refresh_result"),
        "last_sign_in_at": extract_last_sign_in_at(acct.get("google_cookies", "")),
        "suggested_action": SUGGESTED_ACTION,
    }
    with open(DEAD_MARKER_JSON, "w") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return payload


def mark_chain_dead(acct, cls):
    """死讯出口：文字标记（probeFlowMusic 相容）＋结构化 JSON＋stderr ERROR。"""
    now = datetime.now(timezone.utc).isoformat()
    with open(DEAD_MARKER, "w") as f:
        f.write("%s %s（%s；%s）\n" % (now, cls.get("reason"), SIGNAL_HINT.get(cls.get("reason"), ""), JUDGEMENT))
    payload = write_chain_dead_json(acct, cls, now)
    log_error("CHAIN_DEAD reason=%s email=%s last_sign_in_at=%s → %s"
              % (cls.get("reason"), acct.get("email"), payload.get("last_sign_in_at"), SUGGESTED_ACTION))
    return payload


def clear_dead_marker():
    """链存活出口：把残留的 CHAIN_DEAD 与 CHAIN_DEAD.json 一并归档 .resolved-<UTC>。"""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    cleared = []
    for p in (DEAD_MARKER, DEAD_MARKER_JSON):
        if os.path.exists(p):
            dst = "%s.resolved-%s" % (p, stamp)
            os.rename(p, dst)
            cleared.append(os.path.basename(dst))
    if cleared:
        log("CHAIN_DEAD_CLEARED 链已存活 → 标记归档 %s" % ", ".join(cleared))


def getenv(key):
    out = subprocess.run(
        ["grep", "^%s=" % key, ENV_PATH], capture_output=True, text=True, check=True
    ).stdout
    lines = [l for l in out.splitlines() if l.startswith(key + "=")]
    return lines[-1].split("=", 1)[1].strip()


def parse_ts(s):
    # Go RFC3339Nano：小数秒可达 9 位，Python fromisoformat 只收 6 位 → 截断
    m = re.match(r"(.*\.\d{6})\d*(Z|[+-]\d{2}:\d{2})$", s or "")
    if m:
        s = m.group(1) + m.group(2)
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def api(method, path, body=None, tok=None, timeout=60):
    req = urllib.request.Request("http://127.0.0.1:8000" + path, method=method)
    req.add_header("Content-Type", "application/json")
    if tok:
        req.add_header("Authorization", "Bearer " + tok)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:300]}


def get_account(tok):
    r = api("GET", "/api/tokens/1", tok=tok)
    return r.get("token") if isinstance(r, dict) and "token" in r else None


def main():
    user = getenv("FLOWMUSIC_ADMIN_USER")
    pw = getenv("FLOWMUSIC_ADMIN_PASSWORD")
    anon = getenv("FLOWMUSIC_SUPABASE_ANON_KEY")
    sb_base = getenv("FLOWMUSIC_SUPABASE_BASE_URL")

    login = api("POST", "/api/admin/login", {"username": user, "password": pw})
    tok = login.get("token")
    if not tok:
        log_error("WATCHDOG_FAIL admin login: %s" % json.dumps(login)[:200])
        return 2
    acct = get_account(tok)
    if not acct:
        log_error("WATCHDOG_FAIL cannot read account")
        return 2

    expires = parse_ts(acct.get("expires_at"))
    now = datetime.now(timezone.utc)
    if expires > now:
        cls = classify_session(acct.get("last_st_refresh_result"), acct.get("expires_at"), now=now)
        log("healthy expires_at=%s (余 %.0f 分钟) judge=%s/%s"
            % (acct["expires_at"], (expires - now).total_seconds() / 60, cls["state"], cls["reason"]))
        clear_dead_marker()
        return 0

    # 停滞：先纯函数判读，已知死讯不再盲目打 grant
    cls0 = classify_session(acct.get("last_st_refresh_result"), acct.get("expires_at"), now=now)
    if cls0["state"] == "chain_dead":
        log("STALE 且已知死讯 judge=%s/%s → 直接归档死讯（不打 grant）" % (cls0["state"], cls0["reason"]))
        mark_chain_dead(acct, cls0)
        return 1

    log("STALE expires_at=%s judge=%s/%s → 尝试抢救" % (acct["expires_at"], cls0["state"], cls0["reason"]))
    rt = acct.get("refresh_token", "")
    req = urllib.request.Request(
        sb_base + "/auth/v1/token?grant_type=refresh_token",
        data=json.dumps({"refresh_token": rt}).encode(),
        headers={"apikey": anon, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            sess = json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:300]
        # 复查：可能 service ticker 刚好在我们读取后自己恢复了
        acct2 = get_account(tok)
        if acct2 and parse_ts(acct2.get("expires_at")) > datetime.now(timezone.utc):
            log("STALE 误报：service 已自行恢复 expires_at=%s" % acct2["expires_at"])
            clear_dead_marker()
            return 0
        cls = classify_session(body, acct.get("expires_at"))
        if cls["state"] == "chain_dead":
            mark_chain_dead(acct, cls)
        else:
            log_error("RESCUE_FAIL http %s judge=%s/%s body=%s" % (e.code, cls["state"], cls["reason"], body))
        return 1

    # 抢救成功 → PUT 写回；写回前复查仍停滞（防与 service ticker 竞态覆写新 token）
    acct2 = get_account(tok)
    if acct2 and parse_ts(acct2.get("expires_at")) > datetime.now(timezone.utc):
        log("STALE 误报：service 已自行恢复 expires_at=%s" % acct2["expires_at"])
        clear_dead_marker()
        return 0
    payload = {
        "email": acct["email"], "name": acct.get("name", ""), "remark": acct.get("remark", ""),
        "is_active": True, "protocol_mode": "refresh_token",
        "refresh_token": sess["refresh_token"],
        "access_token": sess["access_token"],
        "provider_token": ((sess.get("user") or {}).get("user_metadata") or {}).get("provider_token") or acct.get("provider_token", ""),
        "provider_refresh_token": acct.get("provider_refresh_token", ""),
        "auto_refresh_enabled": True, "refresh_interval_minutes": 30,
    }
    res = api("PUT", "/api/tokens/1", payload, tok=tok)
    ok = isinstance(res, dict) and res.get("success")
    after = get_account(tok) or {}
    log("RESCUE_%s put=%s new expires_at=%s" % ("OK" if ok else "FAIL", ok, after.get("expires_at")))
    if ok:
        clear_dead_marker()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
