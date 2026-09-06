#!/usr/bin/env python3
"""modal_worker.py — 本機/VPS 側觸發器（bridge 雲端執行後端替身）。

職責（spec 交付 #2）：
  - 調 Modal web endpoint POST /render-frame（HMAC 鑑權），單幀循環 +
    分塊 + ffmpeg 本地合成備選；
  - 輸出形狀 = bridge /v1/execute 回應同構（modal_common.bridge_envelope）：
    {ok, artifacts:[{path,bytes,kind}], scene_summary, stdout_tail,
    duration_ms, queued, queue_position} —— 可直接當橋的雲端執行後端替身，
    工具層（src/lib/blender-tools.ts）只認這個形狀。
  - 片M/片K/L 存活語義同構：分塊、每塊重試 ≤2、retriable 分類、
    ffmpeg_unavailable 結構化報錯、PNG 驗真（差異：塊=單幀，片L 實錘
    單幀 job 才是安全單位；崩潰由 Modal 容器隔離天然自愈）。

片 AD（2026-09-06）：
  - 新增 `blend` 子命令：本機 .blend → base64 上傳（141KB 級輕資產，
    Volume 是殺雞牛刀）→ 雲端 open_mainfile → 渲染 → PNG 回——bridge
    真實工作流（本機建場景→雲渲染）的關鍵路徑實彈通道；
  - 逐幀迴圈抽 `_render_frames_http`（scene_script/blend 兩路共用），
    每幀提取 warm 證據標籤（scene:cache-hit|rebuild + pid）入 envelope。

CLI:
  python modal_worker.py still   --engine eevee --frame 1
  python modal_worker.py chain   --engine eevee --frames 10 --fps 30
                                 [--combine local] [--endpoint URL] [--key KEY]
  python modal_worker.py blend   --blend path/to/x.blend [--frames 1|10]
                                 [--start-frame 0] [--fps 30] [--out out/x.mp4]

endpoint/key 解析順序：CLI > env BLENDER_MODAL_ENDPOINT / BLENDER_MODAL_HMAC_KEY
> ~/.modal.toml 的 endpoint 註冊表（deploy 後手動填，見 README）。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from modal_common import (  # noqa: E402
    SIGNATURE_HEADER,
    artifact_entry,
    bridge_envelope,
    build_turntable_script,
    ffmpeg_image2_args,
    looks_like_png,
    sign_hex,
    tail,
)

RETRIABLE = ("blender_script_error", "bridge_unavailable", "bridge_http_error",
             "bridge_bad_response", "URLError", "HTTPError", "TimeoutError",
             "RuntimeError", "ConnectionError")
DEFAULT_TIMEOUT_S = 120


# ---------------------------------------------------------------- endpoint 解析


def resolve_endpoint(explicit: str | None = None) -> str:
    if explicit:
        return explicit.rstrip("/")
    env = os.environ.get("BLENDER_MODAL_ENDPOINT", "").rstrip("/")
    if env:
        return env
    toml = Path.home() / ".modal.toml"
    if toml.exists():
        for line in toml.read_text().splitlines():
            s = line.strip()
            if s.startswith("endpoint") and "=" in s:  # worker 註冊表（deploy 後手動填）
                return s.split("=", 1)[1].strip().strip('"').rstrip("/")
    raise SystemExit("endpoint 未配置：--endpoint 或 env BLENDER_MODAL_ENDPOINT（見 README 第 3 步）")


def resolve_key(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    key = os.environ.get("BLENDER_MODAL_HMAC_KEY", "")
    if key:
        return key
    raise SystemExit("HMAC key 未配置：--key 或 env BLENDER_MODAL_HMAC_KEY（modal secret 建立時的值）")


# ---------------------------------------------------------------- HTTP


def call_endpoint(endpoint: str, key: str, payload: dict, timeout_s: int = DEFAULT_TIMEOUT_S) -> dict:
    """簽名（canonical JSON 基底，與 endpoint 端同構）+ POST + 解析回應。"""
    import hmac as _hmac

    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    sig = sign_hex(key, body)
    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json", SIGNATURE_HEADER: sig},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read().decode("utf-8"))


def call_endpoint_signed_payload(endpoint: str, key: str, payload: dict, timeout_s: int) -> dict:
    """endpoint 端以 body 內 _sig 驗簽（fastapi_endpoint 不透傳自定義 header 時的通道）。"""
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    payload = dict(payload)
    payload["_sig"] = sign_hex(key, body)
    return call_endpoint(endpoint, key, payload, timeout_s)


# ---------------------------------------------------------------- 合成（本地備選）


def ensure_ffmpeg() -> str:
    bin_ = os.environ.get("BLENDER_FFMPEG_BIN", "ffmpeg")
    if shutil.which(bin_) is None:
        try:
            subprocess.run([bin_, "-version"], capture_output=True, check=True)
        except Exception:
            raise SystemExit(
                f"ffmpeg_unavailable: '{bin_}' 不存在。安裝指引：Arch `sudo pacman -S ffmpeg`；"
                "或 env BLENDER_FFMPEG_BIN 指向現役 ffmpeg。"
            )
    return bin_


def combine_local(png_frames: list[tuple[str, bytes]], fps: int, out_path: str) -> dict:
    """片M 同構：本機 ffmpeg image2 合片。回 bridge 形 artifact。"""
    ffmpeg = ensure_ffmpeg()
    tmp = tempfile.mkdtemp(prefix="bmodal-frames-")
    frame_dir = os.path.join(tmp, "frames")
    os.makedirs(frame_dir)
    try:
        for i, (_, png) in enumerate(png_frames):
            with open(os.path.join(frame_dir, f"frame_{i:04d}.png"), "wb") as fh:
                fh.write(png)
        t0 = time.monotonic()
        proc = subprocess.run(
            ffmpeg_image2_args(frame_dir, fps, out_path),
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg rc={proc.returncode}: {tail(proc.stderr, 400)}")
        size = os.path.getsize(out_path)
        return artifact_entry(out_path, size)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- 逐幀迴圈（共用）


_WARM_RE = re.compile(r"scene:(cache-hit|cache-dead|rebuild)")
_PID_RE = re.compile(r"pid=(\d+)")


def _render_frames_http(endpoint: str, key: str, base_payload: dict,
                        first_frame: int, frames_n: int, timeout_s: int):
    """逐幀循環（片L：單幀 job 是安全單位）→ 每幀重試 ≤2（片M 語義）。

    回 (png_frames, per_frame_ms, fails, warm_tags)；warm_tags=每幀
    「f{n}:scene狀態/pid」——暖復用證據（同 pid 連續=同容器；cache-hit=場景
    快取命中，片 AD 契約）。
    """
    png_frames: list[tuple[str, bytes]] = []
    per_frame_ms: list[int] = []
    fails: list[str] = []
    warm_tags: list[str] = []
    for offset in range(frames_n):
        frame = first_frame + offset
        payload = dict(base_payload, frame=frame)
        got = None
        for attempt in (1, 2, 3):  # 初次 + 重試 ≤2（片M 語義）
            try:
                got = call_endpoint_signed_payload(endpoint, key, payload, timeout_s=timeout_s)
                if got.get("ok"):
                    break
                if not any(tag in str(got.get("error", "")) for tag in RETRIABLE):
                    break  # 非瞬態（如 hmac_rejected）：不重試
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                got = {"ok": False, "error": f"URLError: {exc}"}
            time.sleep(2.0)  # 片M cooldown
        dur = int(got.get("duration_ms", 0)) if got else 0
        per_frame_ms.append(dur)
        tail_txt = str((got or {}).get("stdout_tail", ""))
        m_warm, m_pid = _WARM_RE.search(tail_txt), _PID_RE.search(tail_txt)
        warm_tags.append(f"f{frame}:{m_warm.group(1) if m_warm else 'n/a'}"
                         f"/{m_pid.group(1) if m_pid else '-'}")
        art = (got or {}).get("artifacts") or []
        b64 = art[0].get("b64") if art else None
        if got and got.get("ok") and b64:
            png = base64.b64decode(b64)
            if not looks_like_png(png):
                fails.append(f"frame {frame}: 非 PNG 回應")
                continue
            png_frames.append((f"frame_{frame:04d}.png", png))
        else:
            fails.append(f"frame {frame}: {(got or {}).get('error', 'no response')}")
    return png_frames, per_frame_ms, fails, warm_tags


# ---------------------------------------------------------------- 主流程


def run_chain(args) -> dict:
    """scene_script 路徑 10 幀小鏈 + 合片（local）。輸出=bridge_envelope。"""
    t0 = time.monotonic()
    endpoint, key = resolve_endpoint(args.endpoint), resolve_key(args.key)
    frames_n = int(args.frames)
    fps = int(args.fps)
    script = build_turntable_script(1, max(frames_n, 10), fps)
    base = {"scene_script": script, "engine_hint": args.engine,
            "res": [args.width, args.height]}
    png_frames, per_frame_ms, fails, warm_tags = _render_frames_http(
        endpoint, key, base, 1, frames_n, args.timeout)

    if not png_frames:
        return bridge_envelope(
            ok=False, artifacts=[],
            stdout_tail=tail("; ".join(fails)),
            duration_ms=int((time.monotonic() - t0) * 1000),
            error="all_frames_failed",
        )

    if args.combine == "remote":
        raise SystemExit("remote combine 走 modal run modal_app.py::demo --mode chain（web endpoint 稿僅單幀）")
    out_path = os.path.abspath(args.out)
    try:
        mp4 = combine_local(png_frames, fps, out_path)
    except SystemExit as exc:  # ffmpeg_unavailable 結構化（片M 同構）
        return bridge_envelope(
            ok=False, artifacts=[],
            stdout_tail=tail("; ".join(fails)),
            duration_ms=int((time.monotonic() - t0) * 1000),
            error=str(exc),
        )
    return bridge_envelope(
        ok=True,
        artifacts=[mp4],
        scene_summary=f"turntable {args.engine} {len(png_frames)}f@{fps} png + ffmpeg image2 local",
        stdout_tail=tail(f"frames_ok={len(png_frames)}/{frames_n} fails={fails or 'none'} "
                         f"per_frame_ms={per_frame_ms} warm={warm_tags}"),
        duration_ms=int((time.monotonic() - t0) * 1000),
        extra={"frame_count": len(png_frames), "fps": fps, "per_frame_ms": per_frame_ms,
               "warm_tags": warm_tags},
    )


def run_blend(args) -> dict:
    """blend_bytes 路徑（片 AD）：本機 .blend → b64 → 雲端 open_mainfile → 渲染。

    frames=1 → still（存 PNG 驗真）；>1 → 逐幀鏈 + 本地 ffmpeg 合片。
    同一 blend 逐幀重發，雲端場景快取連續命中（暖復用主路徑）。
    """
    t0 = time.monotonic()
    endpoint, key = resolve_endpoint(args.endpoint), resolve_key(args.key)
    blend_path = Path(args.blend).expanduser()
    if not blend_path.exists():
        raise SystemExit(f"blend 不存在: {blend_path}")
    blend_bytes = blend_path.read_bytes()
    blend_b64 = base64.b64encode(blend_bytes).decode("ascii")
    frames_n = int(args.frames)
    fps = int(args.fps)
    start = int(args.start_frame)
    base = {"blend_b64": blend_b64, "engine_hint": args.engine,
            "res": [args.width, args.height]}

    if frames_n == 1:  # still：run_still 同輸出形（存 PNG 驗真）
        payload = dict(base, frame=start)
        try:
            resp = call_endpoint_signed_payload(endpoint, key, payload, timeout_s=args.timeout)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            resp = bridge_envelope(ok=False, artifacts=[], error=f"URLError: {exc}")
        art = (resp.get("artifacts") or [None])[0]
        if resp.get("ok") and art and art.get("b64"):
            png = base64.b64decode(art["b64"])
            out = Path(f"out/blend_f{start}.png")
            out.write_bytes(png)
            resp["stdout_tail"] = tail(f"{resp.get('stdout_tail', '')} | saved={out} "
                                       f"bytes={len(png)} magic_ok={looks_like_png(png)}")
        print(json.dumps(resp, ensure_ascii=False))
        return resp

    png_frames, per_frame_ms, fails, warm_tags = _render_frames_http(
        endpoint, key, base, start, frames_n, args.timeout)
    if not png_frames:
        resp = bridge_envelope(
            ok=False, artifacts=[],
            stdout_tail=tail("; ".join(fails)),
            duration_ms=int((time.monotonic() - t0) * 1000),
            error="all_frames_failed",
        )
        print(json.dumps(resp, ensure_ascii=False))
        return resp
    out_path = os.path.abspath(args.out)
    try:
        mp4 = combine_local(png_frames, fps, out_path)
    except SystemExit as exc:
        resp = bridge_envelope(
            ok=False, artifacts=[],
            stdout_tail=tail("; ".join(fails)),
            duration_ms=int((time.monotonic() - t0) * 1000),
            error=str(exc),
        )
        print(json.dumps(resp, ensure_ascii=False))
        return resp
    resp = bridge_envelope(
        ok=True,
        artifacts=[mp4],
        scene_summary=(f"blend {blend_path.name} {args.engine} {len(png_frames)}f@{fps} "
                       f"start={start} + ffmpeg image2 local"),
        stdout_tail=tail(f"frames_ok={len(png_frames)}/{frames_n} fails={fails or 'none'} "
                         f"per_frame_ms={per_frame_ms} warm={warm_tags}"),
        duration_ms=int((time.monotonic() - t0) * 1000),
        extra={"frame_count": len(png_frames), "fps": fps, "per_frame_ms": per_frame_ms,
               "warm_tags": warm_tags},
    )
    print(json.dumps(resp, ensure_ascii=False))
    return resp


def run_still(args) -> dict:
    """單幀 Eevee/Cycles——EGL 生死判定步。輸出=bridge_envelope。"""
    t0 = time.monotonic()
    endpoint, key = resolve_endpoint(args.endpoint), resolve_key(args.key)
    script = build_turntable_script(1, 10, 30)
    payload = {"scene_script": script, "frame": int(args.frame),
               "engine_hint": args.engine, "res": [args.width, args.height]}
    try:
        resp = call_endpoint_signed_payload(endpoint, key, payload, timeout_s=args.timeout)
    except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
        resp = bridge_envelope(ok=False, artifacts=[], error=f"URLError: {exc}")
    # artifact 落盤（驗真）
    art = (resp.get("artifacts") or [None])[0]
    if resp.get("ok") and art and art.get("b64"):
        png = base64.b64decode(art["b64"])
        out = Path(f"out/still_{args.engine}_f{args.frame}.png")
        out.write_bytes(png)
        resp["stdout_tail"] = tail(f"{resp.get('stdout_tail', '')} | saved={out} "
                                   f"bytes={len(png)} magic_ok={looks_like_png(png)}")
    print(json.dumps(resp, ensure_ascii=False))
    return resp


def main() -> int:
    p = argparse.ArgumentParser(description="blender-modal worker（bridge 同構 client）")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("--engine", choices=["eevee", "cycles"], default="eevee")
        sp.add_argument("--endpoint", default=None)
        sp.add_argument("--key", default=None)
        sp.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_S)
        sp.add_argument("--width", type=int, default=1280)
        sp.add_argument("--height", type=int, default=720)

    sp1 = sub.add_parser("still", help="單幀渲染（EGL 生死判定步）")
    common(sp1)
    sp1.add_argument("--frame", type=int, default=1)
    sp1.set_defaults(func=run_still)

    sp2 = sub.add_parser("chain", help="10 幀小鏈 + ffmpeg 合片")
    common(sp2)
    sp2.add_argument("--frames", type=int, default=10)
    sp2.add_argument("--fps", type=int, default=30)
    sp2.add_argument("--combine", choices=["local"], default="local")
    sp2.add_argument("--out", default="out/turntable.mp4")
    sp2.set_defaults(func=run_chain)

    sp3 = sub.add_parser("blend", help="blend_bytes 路徑：本機 .blend 上傳→雲端渲染（--frames 1=still）")
    common(sp3)
    sp3.add_argument("--blend", required=True)
    sp3.add_argument("--frames", type=int, default=1)
    sp3.add_argument("--start-frame", type=int, default=0)
    sp3.add_argument("--fps", type=int, default=30)
    sp3.add_argument("--out", default="out/blend_chain.mp4")
    sp3.set_defaults(func=run_blend)

    args = p.parse_args()
    resp = args.func(args)
    if args.cmd == "chain":  # still/blend 已在函數內打印；chain 統一在此打印
        print(json.dumps(resp, ensure_ascii=False))
    return 0 if resp.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
