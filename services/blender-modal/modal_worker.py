#!/usr/bin/env python3
"""modal_worker.py — 本机/VPS 侧触发器（bridge 云端执行后端替身）。

职责（spec 交付 #2）：
  - 调 Modal web endpoint POST /render-frame（HMAC 鉴权），单帧循环 +
    分块 + ffmpeg 本地合成备选；
  - 输出形状 = bridge /v1/execute 回应同构（modal_common.bridge_envelope）：
    {ok, artifacts:[{path,bytes,kind}], scene_summary, stdout_tail,
    duration_ms, queued, queue_position} —— 可直接当桥的云端执行后端替身，
    工具层（src/lib/blender-tools.ts）只认这个形状。
  - 片M/片K/L 存活语义同构：分块、每块重试 ≤2、retriable 分类、
    ffmpeg_unavailable 结构化报错、PNG 验真（差异：块=单帧，片L 实锤
    单帧 job 才是安全单位；崩溃由 Modal 容器隔离天然自愈）。

片 AD（2026-09-06）：
  - 新增 `blend` 子命令：本机 .blend → base64 上传（141KB 级轻资产，
    Volume 是杀鸡牛刀）→ 云端 open_mainfile → 渲染 → PNG 回——bridge
    真实工作流（本机建场景→云渲染）的关键路径实弹通道；
  - 逐帧回圈抽 `_render_frames_http`（scene_script/blend 两路共用），
    每帧提取 warm 证据标签（scene:cache-hit|rebuild + pid）入 envelope。

CLI:
  python modal_worker.py still   --engine eevee --frame 1
  python modal_worker.py chain   --engine eevee --frames 10 --fps 30
                                 [--combine local] [--endpoint URL] [--key KEY]
  python modal_worker.py blend   --blend path/to/x.blend [--frames 1|10]
                                 [--start-frame 0] [--fps 30] [--out out/x.mp4]

endpoint/key 解析顺序：CLI > env BLENDER_MODAL_ENDPOINT / BLENDER_MODAL_HMAC_KEY
> ~/.modal.toml 的 endpoint 注册表（deploy 后手动填，见 README）。
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
            if s.startswith("endpoint") and "=" in s:  # worker 注册表（deploy 后手动填）
                return s.split("=", 1)[1].strip().strip('"').rstrip("/")
    raise SystemExit("endpoint 未配置：--endpoint 或 env BLENDER_MODAL_ENDPOINT（见 README 第 3 步）")


def resolve_key(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    key = os.environ.get("BLENDER_MODAL_HMAC_KEY", "")
    if key:
        return key
    raise SystemExit("HMAC key 未配置：--key 或 env BLENDER_MODAL_HMAC_KEY（modal secret 建立时的值）")


# ---------------------------------------------------------------- HTTP


def call_endpoint(endpoint: str, key: str, payload: dict, timeout_s: int = DEFAULT_TIMEOUT_S) -> dict:
    """签名（canonical JSON 基底，与 endpoint 端同构）+ POST + 解析回应。"""
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
    """endpoint 端以 body 内 _sig 验签（fastapi_endpoint 不透传自定义 header 时的通道）。"""
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    payload = dict(payload)
    payload["_sig"] = sign_hex(key, body)
    return call_endpoint(endpoint, key, payload, timeout_s)


# ---------------------------------------------------------------- 合成（本地备选）


def ensure_ffmpeg() -> str:
    bin_ = os.environ.get("BLENDER_FFMPEG_BIN", "ffmpeg")
    if shutil.which(bin_) is None:
        try:
            subprocess.run([bin_, "-version"], capture_output=True, check=True)
        except Exception:
            raise SystemExit(
                f"ffmpeg_unavailable: '{bin_}' 不存在。安装指引：Arch `sudo pacman -S ffmpeg`；"
                "或 env BLENDER_FFMPEG_BIN 指向现役 ffmpeg。"
            )
    return bin_


def combine_local(png_frames: list[tuple[str, bytes]], fps: int, out_path: str) -> dict:
    """片M 同构：本机 ffmpeg image2 合片。回 bridge 形 artifact。"""
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


# ---------------------------------------------------------------- 逐帧回圈（共用）


_WARM_RE = re.compile(r"scene:(cache-hit|cache-dead|rebuild)")
_PID_RE = re.compile(r"pid=(\d+)")


def _render_frames_http(endpoint: str, key: str, base_payload: dict,
                        first_frame: int, frames_n: int, timeout_s: int):
    """逐帧循环（片L：单帧 job 是安全单位）→ 每帧重试 ≤2（片M 语义）。

    回 (png_frames, per_frame_ms, fails, warm_tags)；warm_tags=每帧
    「f{n}:scene状态/pid」——暖复用证据（同 pid 连续=同容器；cache-hit=场景
    快取命中，片 AD 契约）。
    """
    png_frames: list[tuple[str, bytes]] = []
    per_frame_ms: list[int] = []
    fails: list[str] = []
    warm_tags: list[str] = []
    for offset in range(frames_n):
        frame = first_frame + offset
        payload = dict(base_payload, frame=frame)
        got = None
        for attempt in (1, 2, 3):  # 初次 + 重试 ≤2（片M 语义）
            try:
                got = call_endpoint_signed_payload(endpoint, key, payload, timeout_s=timeout_s)
                if got.get("ok"):
                    break
                if not any(tag in str(got.get("error", "")) for tag in RETRIABLE):
                    break  # 非瞬态（如 hmac_rejected）：不重试
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
                fails.append(f"frame {frame}: 非 PNG 回应")
                continue
            png_frames.append((f"frame_{frame:04d}.png", png))
        else:
            fails.append(f"frame {frame}: {(got or {}).get('error', 'no response')}")
    return png_frames, per_frame_ms, fails, warm_tags


# ---------------------------------------------------------------- 主流程


def run_chain(args) -> dict:
    """scene_script 路径 10 帧小链 + 合片（local）。输出=bridge_envelope。"""
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
        raise SystemExit("remote combine 走 modal run modal_app.py::demo --mode chain（web endpoint 稿仅单帧）")
    out_path = os.path.abspath(args.out)
    try:
        mp4 = combine_local(png_frames, fps, out_path)
    except SystemExit as exc:  # ffmpeg_unavailable 结构化（片M 同构）
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
    """blend_bytes 路径（片 AD）：本机 .blend → b64 → 云端 open_mainfile → 渲染。

    frames=1 → still（存 PNG 验真）；>1 → 逐帧链 + 本地 ffmpeg 合片。
    同一 blend 逐帧重发，云端场景快取连续命中（暖复用主路径）。
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

    if frames_n == 1:  # still：run_still 同输出形（存 PNG 验真）
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
    """单帧 Eevee/Cycles——EGL 生死判定步。输出=bridge_envelope。"""
    t0 = time.monotonic()
    endpoint, key = resolve_endpoint(args.endpoint), resolve_key(args.key)
    script = build_turntable_script(1, 10, 30)
    payload = {"scene_script": script, "frame": int(args.frame),
               "engine_hint": args.engine, "res": [args.width, args.height]}
    try:
        resp = call_endpoint_signed_payload(endpoint, key, payload, timeout_s=args.timeout)
    except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
        resp = bridge_envelope(ok=False, artifacts=[], error=f"URLError: {exc}")
    # artifact 落盘（验真）
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
    p = argparse.ArgumentParser(description="blender-modal worker（bridge 同构 client）")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("--engine", choices=["eevee", "cycles"], default="eevee")
        sp.add_argument("--endpoint", default=None)
        sp.add_argument("--key", default=None)
        sp.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_S)
        sp.add_argument("--width", type=int, default=1280)
        sp.add_argument("--height", type=int, default=720)

    sp1 = sub.add_parser("still", help="单帧渲染（EGL 生死判定步）")
    common(sp1)
    sp1.add_argument("--frame", type=int, default=1)
    sp1.set_defaults(func=run_still)

    sp2 = sub.add_parser("chain", help="10 帧小链 + ffmpeg 合片")
    common(sp2)
    sp2.add_argument("--frames", type=int, default=10)
    sp2.add_argument("--fps", type=int, default=30)
    sp2.add_argument("--combine", choices=["local"], default="local")
    sp2.add_argument("--out", default="out/turntable.mp4")
    sp2.set_defaults(func=run_chain)

    sp3 = sub.add_parser("blend", help="blend_bytes 路径：本机 .blend 上传→云端渲染（--frames 1=still）")
    common(sp3)
    sp3.add_argument("--blend", required=True)
    sp3.add_argument("--frames", type=int, default=1)
    sp3.add_argument("--start-frame", type=int, default=0)
    sp3.add_argument("--fps", type=int, default=30)
    sp3.add_argument("--out", default="out/blend_chain.mp4")
    sp3.set_defaults(func=run_blend)

    args = p.parse_args()
    resp = args.func(args)
    if args.cmd == "chain":  # still/blend 已在函数内打印；chain 统一在此打印
        print(json.dumps(resp, ensure_ascii=False))
    return 0 if resp.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
