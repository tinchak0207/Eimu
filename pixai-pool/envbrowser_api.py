"""EnvBrowser UserAPI 驅動：環境生命週期 + 頁面自動化。

基於 127.0.0.1:28173/userapi（X-EnvBrowser-Local-API-Key 認證）。
"""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:28173/userapi"


class EnvBrowserError(Exception):
    pass


class EnvBrowser:
    def __init__(self, api_key, base=BASE):
        self.api_key = api_key
        self.base = base

    def _call(self, path, payload=None, method=None):
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            method=method or ("POST" if payload is not None else "GET"),
            headers={"X-EnvBrowser-Local-API-Key": self.api_key,
                     "Content-Type": "application/json"} if payload is not None
            else {"X-EnvBrowser-Local-API-Key": self.api_key},
        )
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read().decode())

    def window_usage(self):
        return self._call("/window-usage")

    def list_browsers(self):
        return self._call("/browsers").get("browsers", [])

    def create_browser(self, name=None):
        payload = {}
        if name:
            payload["name"] = name
        return self._call("/browsers", payload)

    def delete_browser(self, env_nanoid):
        return self._call("/browsers/delete", {"env_nanoid": env_nanoid})

    def close_browser(self, env_nanoid):
        return self._call("/browsers/close", {"env_nanoid": env_nanoid})

    def open_browser(self, env_nanoid):
        return self._call("/browsers/open/run", {"env_nanoid": env_nanoid})

    def update_settings(self, env_nanoid, **fields):
        return self._call("/browsers/settings", {"env_nanoid": env_nanoid, **fields})

    def run_actions(self, env_nanoid, actions):
        return self._call("/browsers/actions/run", {"env_nanoid": env_nanoid, "actions": actions})


def wait_actions(env, env_nanoid, actions, interval=3, timeout=180):
    """執行 actions，等非 pending 結果。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = env.run_actions(env_nanoid, actions)
        if resp.get("status") not in ("pending", "running"):
            return resp
        time.sleep(interval)
    raise EnvBrowserError(f"actions timeout: {[a.get('type') for a in actions]}")


def action_seq(actions):
    """包裝單一動作列表。"""
    return actions


def list_envs(api_key):
    env = EnvBrowser(api_key)
    return env.list_browsers()


def cleanup_all(api_key):
    env = EnvBrowser(api_key)
    deleted = []
    for b in env.list_browsers():
        try:
            env.delete_browser(b["env_nanoid"])
            deleted.append(b["env_nanoid"])
        except Exception as e:
            print(f"delete {b['env_nanoid']} failed: {e}")
    return deleted


if __name__ == "__main__":
    import sys
    sys.path.insert(0, __file__ and ".")
    with open(r"C:\Users\lenovo\Documents\trae_projects\AICoach\.codex-tmp\turb-gpt-free-register-review\.data\envbrowser_api_key.txt") as f:
        key = f.read().strip()
    env = EnvBrowser(key)
    print("usage:", env.window_usage())
    for b in env.list_browsers():
        print("env:", b["env_nanoid"], b.get("name"), b.get("status"))
