#!/usr/bin/env python3
"""
Laya 判定服务 — jev-gate.ts 的开源兜底后端。

用途：把 `laya` Python 套件（convaiinnovations/laya，Apache-2.0）包成
gateway 可直接 fetch 的 HTTP 端点。契约与 Jev 对齐：

    POST /predict  {"state": <any>, "questions": {<qid>: {...}}}
      -> {"answers": {<qid>: {"type":"noul","noul":0.97} | {"type":"choice","choice":"music",...} | {"type":"score",...}}}

    GET  /healthz  -> 200 {"ok":true,"model":...,"loaded":true}

设计要点（实测 2026-09-20，2 执行绪模拟免费层 2 vCPU）：
- 冷启动载入 ~18s、峰值 RSS ~4.4GB（multilingual checkpoint）。
  → **必须常驻**，不可 per-request 载入；启动时 preload 并用 lazy lock 挡并发。
- warm predict p50 ~170ms；输入上限 model max_len=1024 tokens（超出自动截断）。
- **必用 subfolder="multilingual"**：root（英文）checkpoint 对中文输入校准崩坏。
  实测 multilingual：benign 0.00–0.04、jailbreak 攻击 0.996（分离度完好）；
  公开 demo Space 跑的 checkpoint 校准已坏（benign 被判 0.9999），切勿沿用。

执行：python3 server.py    （环境变数 LAYA_PORT 预设 8082、LAYA_SUBFOLDER 预设 multilingual）
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SUBFOLDER = os.environ.get("LAYA_SUBFOLDER", "multilingual")
PORT = int(os.environ.get("LAYA_PORT", "8082"))
HOST = os.environ.get("LAYA_HOST", "0.0.0.0")

_agent = None
_lock = threading.Lock()


def get_agent():
    """惰性载入＋单次锁：首个请求触发载入，其余并发请求等待同一份模型。"""
    global _agent
    if _agent is not None:
        return _agent
    with _lock:
        if _agent is None:
            import torch

            torch.set_num_threads(int(os.environ.get("LAYA_THREADS", "2")))
            import laya

            t0 = time.time()
            kw = {"subfolder": SUBFOLDER} if SUBFOLDER else {}
            _agent = laya.load("convaiinnovations/laya", **kw)
            print(f"[laya-server] loaded subfolder={SUBFOLDER!r} in {time.time()-t0:.1f}s", flush=True)
    return _agent


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[laya-server] {self.address_string()} {fmt % args}", flush=True)

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/healthz"):
            self._send(200, {"ok": True, "loaded": _agent is not None, "subfolder": SUBFOLDER})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/predict"):
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            req = json.loads(raw.decode("utf-8"))
            state = req.get("state", {})
            questions = req.get("questions", {})
            if not isinstance(questions, dict) or not questions:
                self._send(400, {"error": "questions required"})
                return

            # state 可为物件或字串：物件序列化成 JSON 字串喂给模型（与 jev-gate 一致）。
            state_text = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)

            agent = get_agent()
            result = agent.predict(state_text, questions)
            answers = result.get("answers", {}) if isinstance(result, dict) else {}

            # 只回契约栏位；confidence 缺席时补算（choice 有 probabilities 可推）。
            out = {}
            for qid, a in answers.items():
                if not isinstance(a, dict):
                    continue
                clean = {"type": a.get("type")}
                for k in ("noul", "choice", "confidence", "score", "probabilities", "legend"):
                    if k in a:
                        clean[k] = a[k]
                out[qid] = clean
            self._send(200, {"answers": out})
        except Exception as exc:  # 判定层永不让呼叫端崩：一律 200 + 空 answers 以外的明确错误
            print(f"[laya-server] predict error: {type(exc).__name__}: {exc}", flush=True)
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})


def main():
    print(f"[laya-server] listening on {HOST}:{PORT} subfolder={SUBFOLDER}", flush=True)
    if os.environ.get("LAYA_PRELOAD", "true").lower() == "true":
        try:
            get_agent()
        except Exception as exc:
            print(f"[laya-server] preload failed (will retry per request): {exc}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
