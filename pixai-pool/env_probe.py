import sys, os, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from envbrowser_api import EnvBrowser, wait_actions

with open(r"C:\Users\lenovo\Documents\trae_projects\AICoach\.codex-tmp\turb-gpt-free-register-review\.data\envbrowser_api_key.txt") as f:
    key = f.read().strip()

env = EnvBrowser(key)
mode = sys.argv[1] if len(sys.argv) > 1 else "create"

if mode == "create":
    for i in range(3):
        r = env.create_browser(name=f"pixai-reg-{i+1}")
        print("create:", r)
    print("usage:", env.window_usage())

elif mode == "probe":
    envs = env.list_browsers()
    eid = envs[0]["env_nanoid"]
    print("open:", envs[0].get("name"), eid)
    info = env.open_browser(eid)
    print("run info:", {k: info.get(k) for k in ("status", "cdp", "window_id", "env_nanoid") if k in info})
    cdp = info.get("cdp") or {}
    print("cdp keys:", list(cdp.keys()))
    resp = wait_actions(env, eid, [
        {"type": "page.open", "url": "https://pixai.art/en/login", "wait": "load", "timeout_ms": 60000},
        {"type": "wait.timeout", "timeout_ms": 8000},
        {"type": "page.snapshot", "max_depth": 4, "timeout_ms": 30000},
    ])
    with open("login_snapshot.json", "w", encoding="utf-8") as f:
        json.dump(resp, f, ensure_ascii=False, indent=1)
    print("snapshot saved, result keys:", (resp.get("results") or resp.get("result") or {}).keys() if isinstance(resp.get("results") or resp.get("result"), dict) else type(resp))
