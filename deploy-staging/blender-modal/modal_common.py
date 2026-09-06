#!/usr/bin/env python3
"""modal_common.py — blender-modal POC 純邏輯層（stdlib only，本地可單測）。

分層輪子：liqi155134/blender_modal_bridge 的 farm_common.py（「pure protocol
functions ... unit-tested」）同構——Modal 容器內與本機 worker 共用的純函數
全部收在本檔，Modal 邊界（import modal）只許出現在 modal_app.py / worker 的
執行路徑，不進本檔，保證本地可跑。

內容：
  - build_turntable_script(): 確定性場景構建腳本生成（片M 存活配方：pivot
    全跨度關鍵幀、不觸 .fcurves 5.2 雷區、無隨機無環境依賴）
  - ffmpeg_image2_args(): PNG 序列→mp4 參數（片L 實錘：image2 demuxer；
    片M 配方；list-form 免 shell 注入面）
  - HMAC 簽名/驗證（web endpoint 鑑權，X-Render-Signature）
  - kind_from_path() / tail() / bridge_envelope(): bridge 契約欄位同構件
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from typing import Any, Dict, List, Optional

# bridge server.py 契約的 kind 枚舉（additive-only，枚舉面不得自創）
BRIDGE_KINDS = ("blend", "png", "mp4", "glb", "other")
# 與本機橋 test/smoke 同名頭；worker 與 endpoint 兩端共用此常量
SIGNATURE_HEADER = "X-Render-Signature"


# ---------------------------------------------------------------- 場景構建


def build_turntable_script(
    first_frame: int = 1,
    last_frame: int = 96,
    fps: int = 30,
    radius: float = 4.2,
    height: float = 1.6,
) -> str:
    """生成確定性 turntable 場景構建腳本（單次 exec 進 bpy 即得完整場景）。

    片M 存活配方約束：
      - pivot/關鍵幀按「全跨度」一次算好——任何單幀調用重建出的場景逐位相同
        （serverless 每幀一個新容器，場景無法跨調用駐留，確定性=正確性）；
      - 只用 keyframe_insert，不觸 action.fcurves（5.2 slotted action 雷區，
        片M/片C 實錘；插值走默認 Bezier，POC 可接受）；
      - 腳本自含、無隨機、無環境依賴。
    """
    return f"""# Auto-generated deterministic turntable scene (blender-modal POC)
# full-span keyframes per 2026-09-06 片M survival recipe; no .fcurves access (5.2 minefield)
import bpy, math

bpy.ops.wm.read_factory_settings(use_empty=True)  # 必須先重置再抓 scene 引用——否則 StructRNA of type Scene has been removed（真雲實錘）

scene = bpy.context.scene
scene.frame_start = {first_frame}
scene.frame_end = {last_frame}
scene.render.fps = {fps}

# ground
bpy.ops.mesh.primitive_plane_add(size=12.0, location=(0.0, 0.0, 0.0))
ground = bpy.context.active_object
ground_mat = bpy.data.materials.new("ground_mat")
ground_mat.use_nodes = True
ground_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.35, 0.35, 0.38, 1.0)
ground.data.materials.append(ground_mat)

# lights: sun key + area fill
bpy.ops.object.light_add(type='SUN', location=(4.0, -4.0, 8.0))
sun = bpy.context.active_object
sun.data.energy = 3.0
bpy.ops.object.light_add(type='AREA', location=(-4.0, -3.0, 4.0))
fill = bpy.context.active_object
fill.data.energy = 40.0
fill.data.size = 6.0

# subject: suzanne on a turntable pivot
bpy.ops.mesh.primitive_monkey_add(location=(0.0, 0.0, 1.0))
subject = bpy.context.active_object
subject.scale = (0.9, 0.9, 0.9)

bpy.ops.object.empty_add(type='PLAIN_AXES', location=(0.0, 0.0, 0.0))
pivot = bpy.context.active_object
pivot.name = "turntable_pivot"
subject.parent = pivot

# static camera, track-to pivot
bpy.ops.object.camera_add(location=(0.0, -{radius}, {height}))
cam = bpy.context.active_object
track = cam.constraints.new(type='TRACK_TO')
track.target = pivot
track.track_axis = 'TRACK_NEGATIVE_Z'
track.up_axis = 'UP_Y'
scene.camera = cam

# full-span orbit keyframes (0 -> 360deg across [first, last])
pivot.rotation_euler = (0.0, 0.0, 0.0)
pivot.keyframe_insert(data_path="rotation_euler", frame={first_frame})
pivot.rotation_euler = (0.0, 0.0, math.radians(360.0))
pivot.keyframe_insert(data_path="rotation_euler", frame={last_frame})

print("SCENE_BUILT frames={first_frame}-{last_frame} fps={fps} subject=suzanne")
"""


# ---------------------------------------------------------------- ffmpeg


def ffmpeg_image2_args(
    frame_dir: str,
    fps: int,
    out_path: str,
    pattern: str = "frame_%04d.png",
    start_number: int = 0,
    ffmpeg_bin: Optional[str] = None,
) -> List[str]:
    """PNG 序列→h264 mp4 參數（list-form，無 shell）。

    白名單偏離主輪子（官方 blender_video 用 glob+shell=True）的理由：
      - 片L 實錘 concat 對 PNG 丟幀、image2 demuxer 才是可靠通道（本機
        ffmpeg 9.0.1 + 片M 96 幀 30fps 實彈驗證過同一參數形）；
      - list-form 免 shell 注入面（片M：spawn 不走 shell）。
    """
    return [
        ffmpeg_bin or os.environ.get("BLENDER_FFMPEG_BIN", "ffmpeg"),
        "-y",
        "-framerate", str(int(fps)),
        "-start_number", str(int(start_number)),
        "-i", os.path.join(frame_dir, pattern),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        out_path,
    ]


# ---------------------------------------------------------------- HMAC


def sign_hex(key: str, body: bytes) -> str:
    """HMAC-SHA256(key, body).hexdigest —— worker 與 endpoint 兩端同一實現。"""
    return hmac.new(key.encode("utf-8"), body, hashlib.sha256).hexdigest()


def verify_signature(key: str, body: bytes, signature: str) -> bool:
    if not key or not signature:
        return False
    return hmac.compare_digest(sign_hex(key, body), signature)


# ---------------------------------------------------------------- bridge 契約同構件


def kind_from_path(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return {
        ".blend": "blend",
        ".png": "png",
        ".mp4": "mp4",
        ".glb": "glb",
        ".gltf": "glb",
    }.get(ext, "other")


def tail(text: str, limit: int = 2000) -> str:
    """bridge stdout_tail 語義：最後 ≤2000 字符。"""
    text = text or ""
    return text[-limit:]


def bridge_envelope(
    *,
    ok: bool,
    artifacts: List[Dict[str, Any]],
    scene_summary: str = "",
    stdout_tail: str = "",
    duration_ms: int = 0,
    error: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """組裝 bridge /v1/execute 同構回應。

    契約基準（bridge/blender-bridge/server.py L14-19，additive-only）：
      200 {ok, artifacts:[{path,bytes,kind}], scene_summary, stdout_tail,
           duration_ms, queued, queue_position}
    本 POC 恆為「有槽即跑」：queued=false, queue_position=0（Modal 併發
    由平台調度，應用層無佇列）。artifacts 條目附加 b64 欄（雲端產物傳輸
    必需）與 extra 欄位——均為 additive，不動既有欄位語義。
    """
    resp: Dict[str, Any] = {
        "ok": bool(ok),
        "artifacts": artifacts,
        "scene_summary": scene_summary,
        "stdout_tail": tail(stdout_tail),
        "duration_ms": int(duration_ms),
        "queued": False,
        "queue_position": 0,
    }
    if error is not None:
        resp["error"] = error
    if extra:
        resp.update(extra)
    return resp


def artifact_entry(path: str, size: int, data: Optional[bytes] = None) -> Dict[str, Any]:
    """構造 bridge 形 artifacts 條目；data 給出時附 b64（additive 欄）。"""
    entry: Dict[str, Any] = {
        "path": path,
        "bytes": int(size),
        "kind": kind_from_path(path),
    }
    if data is not None:
        entry["b64"] = base64.b64encode(data).decode("ascii")
    return entry


# ---------------------------------------------------------------- 自測（本地跑）


def _self_test() -> int:
    failures = []

    # 1. 場景構建腳本：確定性 + 全跨度關鍵幀 + 禁區未觸
    s1 = build_turntable_script(1, 96, 30)
    s2 = build_turntable_script(1, 96, 30)
    if s1 != s2:
        failures.append("build_turntable_script 非確定性")
    for marker in ("frame_start = 1", "frame_end = 96", "render.fps = 30",
                   "keyframe_insert", "turntable_pivot", "TRACK_NEGATIVE_Z"):
        if marker not in s1:
            failures.append(f"場景腳本缺 marker: {marker}")
    for banned in (".fcurves", 'file_format="FFMPEG"', "BLENDER_EEVEE_NEXT"):
        # 只掃代碼行（註釋裡的「no .fcurves」是警示不是觸雷）
        code = "\n".join(l for l in s1.splitlines() if not l.lstrip().startswith("#"))
        if banned in code:
            failures.append(f"場景腳本觸 5.2 雷區: {banned}")
    s3 = build_turntable_script(10, 25, 24)
    if "frame_start = 10" not in s3 or "frame_end = 25" not in s3 or "render.fps = 24" not in s3:
        failures.append("參數未注入場景腳本")

    # 2. ffmpeg 參數形（片M 同構）
    args = ffmpeg_image2_args("/tmp/out", 30, "/tmp/out/a.mp4", ffmpeg_bin="ffx")
    want = ["ffx", "-y", "-framerate", "30", "-start_number", "0",
            "-i", "/tmp/out/frame_%04d.png", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "/tmp/out/a.mp4"]
    if args != want:
        failures.append(f"ffmpeg 參數形不符: {args}")
    args2 = ffmpeg_image2_args("/o", 24, "/o/b.mp4", start_number=11, ffmpeg_bin=None)
    if args2[0] != os.environ.get("BLENDER_FFMPEG_BIN", "ffmpeg") or "-start_number" not in args2:
        failures.append("ffmpeg 預設 bin / start_number 異常")

    # 3. HMAC
    k = "unit-test-key"
    sig = sign_hex(k, b"hello")
    if not verify_signature(k, b"hello", sig) or verify_signature(k, b"hello2", sig) \
            or verify_signature("bad", b"hello", sig) or verify_signature(k, b"hello", ""):
        failures.append("HMAC 簽驗迴路失敗")

    # 4. kind/tail/envelope
    if [kind_from_path("out/a.png"), kind_from_path("out/b.mp4"), kind_from_path("c.blend"),
            kind_from_path("d.glb"), kind_from_path("e.txt")] != ["png", "mp4", "blend", "glb", "other"]:
        failures.append("kind_from_path 枚舉錯")
    if tail("x" * 3000) != "x" * 2000:
        failures.append("tail 語義錯")
    env = bridge_envelope(ok=True, artifacts=[artifact_entry("out/frame_0001.png", 123, b"PNG")],
                          scene_summary="s", stdout_tail="t" * 2500, duration_ms=7,
                          extra={"frame_count": 1})
    for field in ("ok", "artifacts", "scene_summary", "stdout_tail", "duration_ms",
                  "queued", "queue_position"):
        if field not in env:
            failures.append(f"bridge_envelope 缺契約欄位 {field}")
    if env["artifacts"][0] != {"path": "out/frame_0001.png", "bytes": 123, "kind": "png",
                               "b64": base64.b64encode(b"PNG").decode("ascii")}:
        failures.append("artifact_entry 形狀錯")
    if len(env["stdout_tail"]) != 2000 or env["queued"] is not False or env["queue_position"] != 0:
        failures.append("envelope tail/queued 語義錯")

    # 5. PNG 簽名驗真 helper（worker 用）
    if not looks_like_png(b"\x89PNG\r\n\x1a\n" + b"0" * 16) or looks_like_png(b"JFIF-not-png"):
        failures.append("looks_like_png 判定錯")

    if failures:
        for f in failures:
            print("FAIL:", f)
        return 1
    print("modal_common self-test: 5/5 PASS (scene-script / ffmpeg-args / hmac / bridge-envelope / png-check)")
    return 0


def looks_like_png(data: bytes) -> bool:
    return data[:8] == b"\x89PNG\r\n\x1a\n"


if __name__ == "__main__":
    raise SystemExit(_self_test())
