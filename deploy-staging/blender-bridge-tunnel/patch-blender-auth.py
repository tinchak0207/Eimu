#!/usr/bin/env python3
"""片W staging：blender-bridge Bearer 鉴权最小补丁（执行片专用；本片零执行，不碰现场）。

用法（落位当天，对 VPS /opt/blender-bridge/server.py 或执行片的工作副本）：
    python3 patch-blender-auth.py <server.py 路径>
原档自动备份为 server.py.bak-auth-<时间戳>。

补丁基准：bridge/blender-bridge/server.py 2026-09-06 现场 500 行版
（片K FIFO 伫列 / 片N stdout 分道 / 片Q 快照 diff 均在位，无任何鉴权层）。
补丁内容（三段，全部 assert src.count(anchor)==1 防误伤——opencode-autopsy 配方）：
  1) 常数区加 BRIDGE_TOKEN：env BLENDER_BRIDGE_TOKEN；空 = 不启用 = 本地现状零变化
     （本机 20 片交付工作流直接打 127.0.0.1:8765，不需 token，向后兼容）。
  2) Handler 加 _authorized()：恒时比较（hmac.compare_digest）。
  3) do_GET / do_POST 入口 401 守卫：先于任何 dispatch（连 health 也要求 token——
     工具层 bridgeHealth 站点需同步带 header，见 TUNNEL-PLAN.md §7 衔接节）。
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

# 锚点（对现场 500 行版各恰出现一次）
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
        assert n == 1, "anchor %s matched %d times (expected 1); server.py 漂移，停止补丁" % (name, n)

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
