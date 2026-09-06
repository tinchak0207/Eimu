#!/usr/bin/env python3
"""片W staging：blender-bridge Bearer 鑑權最小補丁（執行片專用；本片零執行，不碰現場）。

用法（落位當天，對 VPS /opt/blender-bridge/server.py 或執行片的工作副本）：
    python3 patch-blender-auth.py <server.py 路徑>
原檔自動備份為 server.py.bak-auth-<時間戳>。

補丁基準：bridge/blender-bridge/server.py 2026-09-06 現場 500 行版
（片K FIFO 佇列 / 片N stdout 分道 / 片Q 快照 diff 均在位，無任何鑑權層）。
補丁內容（三段，全部 assert src.count(anchor)==1 防誤傷——opencode-autopsy 配方）：
  1) 常數區加 BRIDGE_TOKEN：env BLENDER_BRIDGE_TOKEN；空 = 不啟用 = 本地現狀零變化
     （本機 20 片交付工作流直接打 127.0.0.1:8765，不需 token，向後兼容）。
  2) Handler 加 _authorized()：恆時比較（hmac.compare_digest）。
  3) do_GET / do_POST 入口 401 守衛：先於任何 dispatch（連 health 也要求 token——
     工具層 bridgeHealth 站點需同步帶 header，見 TUNNEL-PLAN.md §7 銜接節）。
"""
import sys
import time

AUTH_CONST = '''# Bearer auth for tunnel mode (piece-W staging). Unset/empty = open
# (local-mode backward compat: direct localhost callers need no token).
BRIDGE_TOKEN = os.getenv("BLENDER_BRIDGE_TOKEN", "")
import hmac as _hmac

'''

AUTH_METHOD = '''    def _authorized(self):
        if not BRIDGE_TOKEN:
            return True  # token not configured: behavior unchanged
        auth = self.headers.get("Authorization", "")
        return _hmac.compare_digest(auth, "Bearer " + BRIDGE_TOKEN)

'''

GUARD = '''        if not self._authorized():
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
'''

# 錨點（對現場 500 行版各恰出現一次）
ANCHOR_CONST = ('CONCURRENCY = _env_int("BLENDER_BRIDGE_CONCURRENCY", DEFAULT_CONCURRENCY)\n'
                'QUEUE_DEPTH = _env_int("BLENDER_BRIDGE_QUEUE_DEPTH", DEFAULT_QUEUE_DEPTH)\n')
ANCHOR_GET = '    def do_GET(self):\n        if self.path == "/v1/health":'
ANCHOR_POST = '    def do_POST(self):\n        if self.path != "/v1/execute":'
ANCHOR_METHOD = '    def do_GET(self):'


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()

    for name, anchor in (("CONST", ANCHOR_CONST), ("GET", ANCHOR_GET),
                         ("POST", ANCHOR_POST), ("METHOD", ANCHOR_METHOD)):
        n = src.count(anchor)
        assert n == 1, "anchor %s matched %d times (expected 1); server.py 漂移，停止補丁" % (name, n)

    src = src.replace(ANCHOR_CONST, ANCHOR_CONST + AUTH_CONST)
    src = src.replace(ANCHOR_METHOD, AUTH_METHOD + ANCHOR_METHOD, 1)
    src = src.replace(ANCHOR_GET, ANCHOR_GET.replace('        if self.path == "/v1/health":',
                                                     GUARD + '        if self.path == "/v1/health":'))
    src = src.replace(ANCHOR_POST, ANCHOR_POST.replace('        if self.path != "/v1/execute":',
                                                       GUARD + '        if self.path != "/v1/execute":'))

    bak = path + ".bak-auth-" + time.strftime("%Y%m%d-%H%M%S")
    with open(bak, "w", encoding="utf-8") as f:
        f.write(open(path, "r", encoding="utf-8").read())
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    print("PATCH_OK backup=%s" % bak)


if __name__ == "__main__":
    main()
