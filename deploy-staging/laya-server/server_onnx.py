#!/usr/bin/env python3
"""
Laya 判定服务（ONNX 轻量版）— jev-gate.ts 的开源兜底后端。

与 server.py（torch 版）的差异：**为 VPS 3.7GB 小机而生**。
- torch 版 RSS ~2.84GB（PyTorch runtime + fp32 模型），VPS 塞不下；
  ONNX 版实测 **1.61GB**（onnxruntime + tokenizers 直读，无 torch）。
- 校准与 torch 版逐位吻合（2026-09-20 实锤：同序列 logits 一致到小数后 5 位；
  注入分离 攻击 0.99 / benign 0.001–0.02）。

契约（与 server.py 完全一致）：
    POST /predict  {"state": <any>, "questions": {<qid>: {...}}}
      -> {"answers": {<qid>: {"type":"noul","noul":0.97} | {"type":"choice",...} | {"type":"score",...}}}
    GET  /healthz  -> 200 {"ok":true,...}

模型档（与本档同目录）：
- laya_ml_fp32_v18.onnx  multilingual checkpoint 的 fp32 ONNX 汇出（opset 18）
- multilingual-tokenizer.json  mmBERT tokenizer（**必须配 multilingual**；root 的
  英文 tokenizer喂它=校准全毁，2026-09-20 实锤 benign 被判 0.999）

汇出配方（升级 laya 版本时重跑）：见 export-onnx.md。

关键实现细节（都是 2026-09-20 踩过的雷）：
- graph_optimization_level=ORT_DISABLE_ALL + enable_mem_pattern=False：
  预设优化会复制一份 fp32 图 → RSS 从 1.6GB 涨到 3.2GB。
- special token ids 硬编码 2/1/4/0（<bos>/<eos>/<mask>/<pad>）：
  tokenizers 的 token_to_id("<s>") 回 vocab 内另一个同文字串（204），
  必须用 transformers 语义的 added_tokens 位。抽 tokenizer.json 的
  added_tokens[0..4] 亦可，这里直接钉死并加启动自检。
- int8/fp16 量化都会打坏 multilingual 校准（benign→0.99+），只能 fp32。

执行：python3 server_onnx.py（env LAYA_PORT=8082）
依赖：onnxruntime、tokenizers（见 requirements-onnx.txt）
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

from common_pure import QTYPES, build_sequence, confidence_from_probs

PORT = int(os.environ.get("LAYA_PORT", "8082"))
HOST = os.environ.get("LAYA_HOST", "0.0.0.0")
BASE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(BASE, "laya_ml_fp32_v18.onnx")
TOKENIZER = os.path.join(BASE, "multilingual-tokenizer.json")

# transformers 语义的 special ids（mmBERT added_tokens 0..4：<pad>/<eos>/<bos>/<unk>/<mask>）
CLS_ID, SEP_ID, MASK_ID, PAD_ID = 2, 1, 4, 0

_session = None
_tok = None
_lock = threading.Lock()


def _load():
    global _session, _tok
    so = ort.SessionOptions()
    so.intra_op_num_threads = int(os.environ.get("LAYA_THREADS", "2"))
    so.inter_op_num_threads = 1
    # 雷：预设图优化会复制整份 fp32 图（RSS 1.6→3.2GB），必须全关
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    so.enable_mem_pattern = False
    _session = ort.InferenceSession(MODEL, so, providers=["CPUExecutionProvider"])
    _tok = Tokenizer.from_file(TOKENIZER)
    # 启动自检：tokenizer 的 added_tokens 特殊位必须与硬编码一致
    for expect, tid in (("<pad>", PAD_ID), ("<eos>", SEP_ID), ("<bos>", CLS_ID), ("<mask>", MASK_ID)):
        got = _tok.token_to_id(expect)
        if got != tid:
            raise RuntimeError(f"tokenizer special mismatch: {expect!r} id={got} expect={tid}")
    print(f"[laya-server-onnx] model+tokenizer loaded ({MODEL})", flush=True)


def get_runtime():
    global _session, _tok
    if _session is not None:
        return _session, _tok
    with _lock:
        if _session is None:
            _load()
    return _session, _tok


class _TokShim:
    """tokenizers.Tokenizer → laya build_sequence 期待的 transformers 介面。"""

    def __init__(self, t):
        self._t = t

    cls_token_id = CLS_ID
    sep_token_id = SEP_ID
    mask_token_id = MASK_ID
    pad_token_id = PAD_ID
    mask_token = "<mask>"

    def __call__(self, s, add_special_tokens=False):
        return {"input_ids": self._t.encode(s, add_special_tokens=add_special_tokens).ids}


def _run_one(state, internal_q):
    """单题前向：build_sequence → ONNX → softmax（与 laya Agent.system_one 同构）。"""
    sess, raw_tok = get_runtime()
    tok = _TokShim(raw_tok)
    max_len, head_max_len = 1024, 256  # multilingual cfg（rl_agent_config.json）
    seq, markers = build_sequence(tok, state, internal_q, max_len, head_max_len)
    if len(markers) == 0:
        raise ValueError("no markers fit in head budget")
    logits = _session.run(
        None,
        {
            "input_ids": np.array([seq], dtype=np.int64),
            "attention_mask": np.ones((1, len(seq)), dtype=np.int64),
            "marker_pos": np.array([markers], dtype=np.int64),
            "marker_mask": np.ones((1, len(markers)), dtype=bool),
            "qtype": np.array([internal_q["qt"]], dtype=np.int64),
        },
    )[0][0]
    z = logits[: len(markers)]
    p = np.exp(z - z.max())
    return p / p.sum()


def _to_internal(qdef):
    t = qdef.get("type")
    crit = qdef.get("criteria")
    if t == "choice" and isinstance(crit, list):
        crit = {c: None for c in crit}
    ins = qdef.get("instructions", "")
    if not isinstance(ins, str):
        ins = json.dumps(ins)
    return {"t": t, "ins": ins, "crit": crit, "qt": QTYPES.get(t, 2)}


def system_one(state, questions):
    """与 laya Agent.predict 同构的回答组装（choice/score/noul）。"""
    answers = {}
    for qid, qdef in questions.items():
        internal = _to_internal(qdef)
        p = _run_one(state, internal)
        k = len(p)
        conf = round(confidence_from_probs(p, k), 4)
        t = internal["t"]
        if t == "choice":
            keys = list((internal["crit"] or {}).keys()) or [str(i) for i in range(k)]
            answers[qid] = {
                "type": "choice",
                "choice": keys[int(np.argmax(p))],
                "probabilities": {kk: round(float(v), 4) for kk, v in zip(keys, p)},
                "confidence": conf,
            }
        elif t == "score":
            answers[qid] = {
                "type": "score",
                "score": round(float((np.arange(k) * p).sum()), 4),
                "legend": {str(i): c for i, c in enumerate(internal["crit"] or [])},
                "probabilities": {str(i): round(float(v), 4) for i, v in enumerate(p)},
                "confidence": conf,
            }
        else:
            answers[qid] = {
                "type": "noul",
                "noul": round(float(p[1]) if k > 1 else float(p[0]), 4),
                "confidence": round(max(float(p[1]), 1.0 - float(p[1])) if k > 1 else float(p[0]), 4),
            }
    return {"model": "laya-onnx-multilingual", "answers": answers, "usage": {"output_tokens": 0}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[laya-server-onnx] {self.address_string()} {fmt % args}", flush=True)

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/healthz"):
            self._send(200, {"ok": True, "loaded": _session is not None, "model": "onnx-multilingual"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/predict"):
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length) if length else b"{}")
            state = req.get("state", {})
            questions = req.get("questions", {})
            if not isinstance(questions, dict) or not questions:
                self._send(400, {"error": "questions required"})
                return
            if not isinstance(state, str):
                pass  # dict/list 交给 serialize_state 处理
            self._send(200, system_one(state, questions))
        except Exception as exc:
            print(f"[laya-server-onnx] predict error: {type(exc).__name__}: {exc}", flush=True)
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})


def main():
    print(f"[laya-server-onnx] listening on {HOST}:{PORT}", flush=True)
    if os.environ.get("LAYA_PRELOAD", "true").lower() == "true":
        try:
            get_runtime()
        except Exception as exc:
            print(f"[laya-server-onnx] preload failed (will retry per request): {exc}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
