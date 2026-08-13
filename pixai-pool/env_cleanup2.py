import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from envbrowser_api import EnvBrowser

with open(r"C:\Users\lenovo\Documents\trae_projects\AICoach\.codex-tmp\turb-gpt-free-register-review\.data\envbrowser_api_key.txt") as f:
    key = f.read().strip()

env = EnvBrowser(key)
for b in env.list_browsers():
    eid = b["env_nanoid"]
    print(f"--- {eid} {b.get('name')} status={b.get('status')}")
    try:
        r = env.close_browser(eid)
        print("close:", r)
    except Exception as e:
        print("close failed:", e)
    time.sleep(2)
    try:
        r = env.delete_browser(eid)
        print("delete:", r)
    except Exception as e:
        print("delete failed:", e)
print("usage:", env.window_usage())
