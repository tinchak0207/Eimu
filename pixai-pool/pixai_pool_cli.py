"""PixAI 號池主控：register / claim / status / refresh。

用法：
  python pixai_pool_cli.py register <N>          # 註冊 N 個新號並入池
  python pixai_pool_cli.py claim                 # 全池簽到（未領取的號）
  python pixai_pool_cli.py status                # 池統計
  python pixai_pool_cli.py refresh               # 7 天 token 到期前重登入
  python pixai_pool_cli.py verify <email>        # 測試單號登入（token 有效性）
"""
import json
import os
import sys
import time

from pixai_client import (CaptchaError, PixaiError, YesCaptcha, claim_daily,
                          claim_status, gen_email, gen_password, sign_in_email)
from pool_store import PoolStore

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")

UA = "webstar/5.0"


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_client_key(cfg):
    key_file = cfg["yescaptcha"]["client_key_file"]
    with open(key_file) as f:
        return f.read().strip()


def new_account_entry(email, password, auth_token, result, user):
    return {
        "email": email,
        "password": password,
        "token": auth_token,
        "user_id": user.get("id", ""),
        "email_verified": user.get("emailVerified", False),
        "status": "active",
        "priority": 1000,
        "pool": "pixai",
        "platform": "pixai",
        "type": "oauth",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "last_claim_date": "",
        "last_claim_amount": 0,
        "token_expires_at": "",
        "remark": "",
    }


def register_one(cfg, captcha, store):
    email = gen_email(cfg["pool"]["email_domain"])
    password = gen_password()
    recaptcha = captcha.recaptcha_v3()
    token, result, user = sign_in_email(recaptcha, email, password, UA)
    if not token:
        raise PixaiError(0, "NO_TOKEN", f"sign-in ok but no token for {email}")
    acc = new_account_entry(email, password, token, result, user)
    store.add(acc)
    return acc


def cmd_register(cfg, captcha, store, n):
    interval = cfg["pool"]["register_interval_sec"]
    ok = 0
    for i in range(n):
        try:
            acc = register_one(cfg, captcha, store)
            print(f"[register] #{i+1}/{n} OK {acc['email']} user={acc['user_id']}")
            ok += 1
        except PixaiError as e:
            print(f"[register] #{i+1}/{n} FAIL {e}")
            if e.status == 429:
                print(f"[register] 429 rate limit, wait {interval}s")
                time.sleep(interval)
                continue
        except CaptchaError as e:
            print(f"[register] #{i+1}/{n} CAPTCHA FAIL {e}")
        if i < n - 1:
            time.sleep(interval)


def cmd_claim(cfg, captcha, store):
    today = time.strftime("%Y-%m-%d")
    accounts = [a for a in store.load()
                if a.get("status") == "active" and a.get("last_claim_date") != today]
    if not accounts:
        print("[claim] no account needs claiming today")
        return
    interval = cfg["pool"]["claim_interval_sec"]
    ok = 0
    for acc in accounts:
        email = acc["email"]
        try:
            tok = captcha.turnstile_managed()
            result = claim_daily(acc["token"], tok)
            amount = result.get("amount", 0)
            acc["last_claim_date"] = today
            acc["last_claim_amount"] = amount
            store.upsert(acc)
            print(f"[claim] OK {email} +{amount} pts")
            ok += 1
        except PixaiError as e:
            print(f"[claim] FAIL {email}: {e}")
            if e.status == 429:
                time.sleep(cfg["pool"]["claim_retry_429_wait_sec"])
        except CaptchaError as e:
            print(f"[claim] CAPTCHA FAIL {email}: {e}")
        time.sleep(interval)
    print(f"[claim] done {ok}/{len(accounts)}")


def cmd_status(cfg, store):
    stats = store.stats()
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    for acc in store.load():
        print(f"  {acc.get('email')} status={acc.get('status')} "
              f"last_claim={acc.get('last_claim_date')} amount={acc.get('last_claim_amount')} "
              f"user={acc.get('user_id')}")


def cmd_refresh(cfg, captcha, store):
    """JWT 7 天過期前 refresh_before_expiry_hours 小時重登入換 token。"""
    before_h = cfg["pool"]["refresh_before_expiry_hours"]
    now = time.time()
    refreshed = 0
    for acc in store.load():
        if acc.get("status") != "active":
            continue
        exp = acc.get("token_expires_at") or ""
        email = acc["email"]
        try:
            tok = captcha.recaptcha_v3()
            new_token, result, user = sign_in_email(tok, email, acc["password"], UA)
            acc["token"] = new_token
            acc["email_verified"] = user.get("emailVerified", acc.get("email_verified", False))
            store.upsert(acc)
            print(f"[refresh] OK {email} result={result}")
            refreshed += 1
        except PixaiError as e:
            print(f"[refresh] FAIL {email}: {e}")
        except CaptchaError as e:
            print(f"[refresh] CAPTCHA FAIL {email}: {e}")
        time.sleep(30)
    print(f"[refresh] done {refreshed}")


def cmd_verify(cfg, store, email):
    acc = store.get(email)
    if not acc:
        print(f"[verify] account not found: {email}")
        return 1
    try:
        st = claim_status(acc["token"])
        print(f"[verify] OK {email} canClaim={st.get('canClaim')} "
              f"amount={st.get('amount')} emailVerifyDue={st.get('emailVerificationRequiredSince')}")
        return 0
    except PixaiError as e:
        print(f"[verify] FAIL {email}: {e}")
        return 1


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    cfg = load_config()
    store = PoolStore(os.path.join(HERE, cfg["pool"]["pool_file"]))
    captcha = YesCaptcha(load_client_key(cfg))
    if cmd == "register":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 1
        return cmd_register(cfg, captcha, store, n)
    if cmd == "claim":
        return cmd_claim(cfg, captcha, store)
    if cmd == "status":
        return cmd_status(cfg, store)
    if cmd == "refresh":
        return cmd_refresh(cfg, captcha, store)
    if cmd == "verify":
        return cmd_verify(cfg, store, sys.argv[2] if len(sys.argv) > 2 else "")
    print(f"unknown command: {cmd}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
