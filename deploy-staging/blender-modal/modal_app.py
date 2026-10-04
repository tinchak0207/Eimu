#!/usr/bin/env python3
"""modal_app.py — blender-modal POC 主轮子（Modal 官方 examples/blender_video 整复制 + 白名单）。

轮子源：https://modal.com/docs/examples/blender_video（modal-examples 仓库，MIT）。
下方「WHEEL DIFF 白名单」列出全部偏离；未列出的骨架（单帧一函数、bytes 进出、
map 分发、临时目录写帧再回 bytes）与官方范例同构。

片 AD（2026-09-06）：单帧函数 → `@app.cls` 类形态（容器暖复用，消冷容器
著色器编译重复支付——片 X 实锤每帧 ~20s 大头在冷容器 EGL init+著色器编译）。

WHEEL DIFF 白名单（官方范例 → 本档）：
  1. app 名 "example-blender-video" → "blender-modal-poc"。
  2. Image：python_version "3.11"+bpy==4.5.0 → "3.13"+bpy==5.2.1。**现场证据
     推翻 spec 的默认**：PyPI 实测 bpy 5.2.1 仅 cp313 wheel（requires_python
     ==3.13.*，manylinux_2_28 x86_64），3.11 无轮可装；5.2.1 与本机桥同版，
     5.2 API（BLENDER_EEVEE 唯一枚举、channelbags、RT 旗标）直跑。apt 白名单：
     xorg/libxkbcommon0 官方原样保留，+ libegl1/libgl1（EGL headless，
     本机桥片A实证路径）。+ add_local_python_source("modal_common")（部署
     边界：本地 import 不自动上云，Modal 1.5.5 要求显式声明）。
  3. gpu="L40S" → env BLENDER_MODAL_GPU 可覆盖，默认 "T4"（研究片U成本
     裁定：smoke 几分钱级；Eevee EGL 若败升 L4 重判）。max_containers=10
     官方原样。timeout=120（spec 指定；官方未显式声明）。
  4. 官方 render() 只吃 blend_file → render_frame(payload: dict) 同时支持
     blend_bytes（官方轮原样）与 scene_script（本机桥 /v1/execute 的 script
     语义：bpy 内 exec、CWD 内写 out/、mtime/存在性收 artifacts）。
  5. 官方 configure_rendering（Cycles 专用）→ configure_eevee/configure_cycles：
       - Eevee 主轮：BLENDER_EEVEE（5.2 唯一枚举，TypeError 落回
         BLENDER_EEVEE_NEXT 兼容 4.x，片M 候补清单同构）+ taa_render_samples=1
         + use_raytracing=False（片M/片F 存活配方：samples=16@1280 全崩、
         samples=1+RT off 全过）；
       - Cycles 后备：官方同构（compute_device_type + get_devices + 全开 +
         device 列印 debugging snippet 原样），CUDA→OPTIX（L4/T4 均支援，
         三方桥同款），samples 128→16（POC 成本纪律，白名单）。
  6. 新增 _ensure_gpu_init()：gpu.init() EGL platform init——**片 AD 真云
     判决推翻其主路径地位**：预建 EGL context 是 Eevee 渲染崩溃源非加速器
     （三容器对照：无预建 rain 渲染成功 21s；预建×2 同场景 ~6s SIGSEGV；
     本机桥片F 同构互证；速度零贡献且冷容器上 gpu.init 本身耗 18.5s）。
     默认关闭（Eevee 自建 context），BLENDER_MODAL_GPU_INIT=1 仅作诊断开关。
     另 AD 雷区 #6b：`import gpu` 必须在 `import bpy` 之后（bpy wheel 的
     gpu 模组由 bpy 导入路径供给，裸导 No module named 'gpu' 真云实锤）。
  7. 回应形状：官方回裸 PNG bytes → bridge_envelope（{ok, artifacts:
     [{path,bytes,kind,b64}], scene_summary, stdout_tail, duration_ms,
     queued, queue_position}，与本机桥 POST /v1/execute 200 同构；b64/
     extra 栏 additive）。
  8. 新增 web endpoint POST /render-frame（官方无）：HMAC 鉴权（Secret
     blender-modal-hmac，签名基底=剥 _sig 后的 canonical JSON，
     modal_common.sign_hex 同一实现）。
  9. 新增 @app.local_entrypoint() demo：内置确定性 turntable 场景
     （modal_common.build_turntable_script，片M 全跨度配方、不触
     .fcurves 雷区）——官方范例依赖随附 IceModal.blend，POC 免外带资产。
 10. combine()：官方 glob+shell=True ffmpeg → image2 demuxer + list-form
     argv（片L 实锤 glob/concat 对 PNG 有丢帧面；片M 配方；免 shell 注入），
     fps 参数化（官方硬编 60）。
 11. （片 AD）单帧函数 render_frame → 单一 `@app.cls` 类 Renderer，同类挂
     `@modal.method()`（SDK .remote/.map 用）与 `@modal.fastapi_endpoint()`
     （web 用）——形状照抄官方 lifecycle guide（「For web functions, swap in
     @modal.fastapi_endpoint()」）+ live wheel 1.5.5 认证（cls.pyi：cls() 吃
     function 同款参数含 scaledown_window；partial_function.pyi：enter()/
     method()）。同类双修=同一暖容器池服务两通道，暖身实现只有一份。
       - `@modal.enter()` warm：只做 gpu.init()（毫秒级）。**不做暖身渲染**
         （AD 两实锤：①暖身渲染原样重付首帧编译成本 27s 纯浪费；②同进程
         跨场景切换渲染触发 SIGSEGV n=1，片 X 同场景 10 连渲零崩）——冷启
         编译由容器首帧付一次，之后同场景帧全部命中暖状态；
       - scaledown_window=60（链间请求间隔 ~1-3s 足够保温；空窗帐单上限
         60s×T4≈$0.01/容器，成本纪律明示）；web 方法经 HMAC 才能触发，
         SDK 方法由 Modal 平台鉴权，secret 挂类级无外泄面。
 12. （片 AD）场景快取：payload 场景输入（scene_script/blend_bytes+
     engine_hint）sha256 为键，命中时重用活 scene 只做 frame_set（跳过
     open_mainfile/read_factory_settings+场景构建+材质著色器重编译）；
     重用前 StructRNA touch-test（scene.render.engine 存取）防片 X 雷区
     #3「read_factory_settings 杀旧 Scene 引用」，死引用即降级重建；
     换键先置 None 再 reset，旧引用绝不触碰。

禁区声明：bridge/、src/、其他 deploy-staging/、skills/ 本片零接触。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from pathlib import Path

import modal

from modal_common import (
    artifact_entry,
    bridge_envelope,
    build_turntable_script,
    ffmpeg_image2_args,
    looks_like_png,
    sign_hex,
    tail,
)

app = modal.App("blender-modal-poc")

# ---- 官方 rendering_image 同构，仅白名单 #2/#3
rendering_image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("xorg", "libxkbcommon0", "libegl1", "libgl1")  # X11 (Unix GUI) deps + EGL headless
    .uv_pip_install("bpy==5.2.1", "fastapi[standard]")  # fastapi 显式装：1.5.5 fastapi_endpoint 硬要求（ConflictError 实锤）
    .add_local_python_source("modal_common")
)

# 研究片U 裁定：T4 起步（几分钱纪律）；Eevee EGL 若败，BLENDER_MODAL_GPU=L4 重判
GPU = os.environ.get("BLENDER_MODAL_GPU", "T4")
WITH_GPU = True

EEVEE_SAMPLES = 1    # 片M/片F 存活配方
CYCLES_SAMPLES = 16  # 官方 128 → POC 成本纪律（白名单 #5）
EEVEE_ENGINE = "BLENDER_EEVEE"  # 5.2 唯一枚举（片B/片M 实锤）
SCALEDOWN_WINDOW = 60  # 白名单 #11：保温窗（显式声明=成本上界明示）

_GPU_STATE = {"ready": False, "state": "unknown"}


def _ensure_gpu_init() -> str:
    """gpu.init() EGL platform init（默认关闭，BLENDER_MODAL_GPU_INIT=1 才启用）。

    片 AD 真云判决（2026-09-06，三容器对照）：**预建 EGL context 是 Eevee
    渲染的崩溃源，不是加速器**——
      - 容器1 gpu.init 失败（无预建）→ rain_chase 1280x720 渲染成功 21s；
      - 容器2/3 gpu.init 成功（预建）→ 同场景渲染 ~6s 处 SIGSEGV ×2；
      - 本机桥片F 同构互证：桥（gpu.init 预建）负载下崩、直连 CLI（Eevee
        自建 context）无事；
      - 速度零贡献：piece X（gpu.init 版）与容器1（无）每帧同为 ~20s，
        且 gpu.init 本身在冷容器上耗 18.5s（纯浪费）。
    保留本函数仅为诊断开关（env 显式开启）；主路径 Eevee 自建 context。
    """
    if _GPU_STATE["ready"]:
        return _GPU_STATE["state"]
    if os.environ.get("BLENDER_MODAL_GPU_INIT", "") != "1":
        _GPU_STATE["state"] = "self-init(deferred)"
        _GPU_STATE["ready"] = True
        return _GPU_STATE["state"]
    try:
        import bpy  # noqa: F401 — 必须先于 gpu（雷区 #6b）
        import gpu as bl_gpu  # Blender GPU module — headless 时走 EGL backend

        bl_gpu.init()
        _GPU_STATE["state"] = "egl"
    except Exception as exc:  # noqa: BLE001 — 判决要输出原文
        _GPU_STATE["state"] = f"cpu:{exc}"
    _GPU_STATE["ready"] = True
    print(f"[gpu-init] {_GPU_STATE['state']}")
    return _GPU_STATE["state"]


def configure_eevee(scene) -> None:
    """片M 存活配方（本机 EGL 实弹全过）：samples=1 + raytracing off。"""
    scene.eevee.taa_render_samples = EEVEE_SAMPLES
    try:
        scene.eevee.use_raytracing = False  # 5.2 新旗标；try/except 同片M
    except AttributeError:
        pass


def configure_cycles(scene) -> None:
    """官方 configure_rendering 同构（白名单 #5：CUDA→OPTIX、samples 128→16）。"""
    scene.cycles.samples = CYCLES_SAMPLES
    scene.cycles.device = "GPU"
    import bpy  # 官方路径：preferences 挂在 bpy.context，不在 scene 上

    cycles = bpy.context.preferences.addons["cycles"]
    cycles.preferences.compute_device_type = "OPTIX"
    cycles.preferences.get_devices()
    for device in cycles.preferences.devices:
        device.use = True
    for dev in cycles.preferences.devices:  # 官方 debugging snippet 原样
        print(f"ID:{dev['id']} Name:{dev['name']} Type:{dev['type']} Use:{dev['use']}")


def _resolve_engine(scene, engine_hint: str) -> str:
    """engine 解析：hint 胜（同一脚本可双跑）；未给则尊重 blend 内建。"""
    if engine_hint == "cycles":
        scene.render.engine = "CYCLES"
    elif engine_hint == "eevee":
        try:
            scene.render.engine = EEVEE_ENGINE
        except TypeError:
            scene.render.engine = "BLENDER_EEVEE_NEXT"  # 4.x 兼容（片M 候补清单同构）
    return str(scene.render.engine)


def _scene_key(scene_script: str | None, blend_bytes: bytes | None, engine_hint: str) -> str:
    """白名单 #12：场景输入指纹（快取键）。res/frame 不入键（逐帧便宜、按呼叫设）。"""
    h = hashlib.sha256()
    h.update(b"v1|")
    h.update((scene_script or "").encode("utf-8"))
    h.update(b"|")
    h.update(blend_bytes or b"")
    h.update(f"|{engine_hint}".encode("utf-8"))
    return h.hexdigest()


# ---- 白名单 #8：HMAC Secret（web 鉴权；类级挂载，SDK 方法由平台鉴权）
hmac_secret = modal.Secret.from_name("blender-modal-hmac")


@app.cls(
    image=rendering_image,
    gpu=GPU if WITH_GPU else None,
    secrets=[hmac_secret],
    max_containers=10,                  # 官方 free-tier 同值
    timeout=120,                        # 白名单 #3
    scaledown_window=SCALEDOWN_WINDOW,  # 白名单 #11
)
class Renderer:
    """暖复用渲染容器：容器进程内 bpy import/EGL context/著色器编译天然驻留
    （模组级+GPU 进程级状态），本类把它显式化：
      - @modal.enter() 只做 GPU 状态记录（gpu.init 默认关闭，见 #6）——
        **不做暖身渲染**，两个实锤：
        ①暖身渲染把首帧本要付的编译成本原样重付（320x180 cube 实测 27s，
        纯浪费）；②同进程跨场景切换渲染（小暖身场景→重 blend）触发
        SIGSEGV（AD 真云 n=1；片 X 同场景 10 连渲零崩）——场景切换面
        只留给场景快取 miss（必要路径），绝不无故多制造一次。
      - 场景快取（_scene_key）让同场景后续帧跳过重建+重编译；
      - scaledown_window 让 HTTP 链的逐帧请求落在同一暖容器上。
    片 X 实证基线：同场景容器上逐帧 0.5-2.5s（smoke4 web 链 10/10 零崩）。"""

    # 类属性槽（Modal 对自订 __init__ 发 DeprecationError——改类属性，实例首次赋值即遮蔽）
    _scene = None
    _scene_key: str | None = None
    warm_ms = 0
    warm_state = "not-run"

    @modal.enter()
    def warm(self) -> None:
        """容器启动一次：GPU 状态记录（gpu.init 默认关闭=延迟自建，见
        _ensure_gpu_init 判决；渲染冷启大头由首个真实请求付一次，之后
        同场景帧全部命中暖状态）。"""
        t0 = time.monotonic()
        self.warm_state = _ensure_gpu_init()
        self.warm_ms = int((time.monotonic() - t0) * 1000)
        print(f"[warm] state={self.warm_state} warm_ms={self.warm_ms}")

    def _ensure_scene(self, bpy, key: str, scene_script: str | None,
                      blend_bytes: bytes | None, engine_hint: str, logs: list):
        """白名单 #12：场景快取（hit → frame_set 即用；miss → 重建）。

        雷区 #3 防线：重用前 touch-test；换键先置 None 再 reset——旧 Scene
        引用在 reset 后绝不触碰（StructRNA of type Scene has been removed）。
        """
        scene = self._scene
        if key == self._scene_key and scene is not None:
            try:
                _ = scene.render.engine  # StructRNA touch-test
                logs.append("scene:cache-hit")
                return scene
            except ReferenceError:
                logs.append("scene:cache-dead")
        self._scene = None
        self._scene_key = None

        work = "/tmp/render"
        os.makedirs(work, exist_ok=True)
        if blend_bytes:
            input_path = os.path.join(work, "input.blend")
            Path(input_path).write_bytes(blend_bytes)
            bpy.ops.wm.open_mainfile(filepath=input_path)
            logs.append("scene:rebuild")
            logs.append("scene:blend_bytes")
        elif scene_script:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            exec(compile(scene_script, "<modal-scene-script>", "exec"), {"__name__": "__main__"})  # noqa: S102 — 桥 /v1/execute 同语义
            logs.append("scene:rebuild")
            logs.append("scene:scene_script")
        else:
            raise ValueError("payload 需 blend_b64 或 scene_script 择一")

        scene = bpy.context.scene
        engine = _resolve_engine(scene, engine_hint)
        logs.append(f"engine={engine}")
        if engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
            configure_eevee(scene)
        elif engine == "CYCLES":
            configure_cycles(scene)
        self._scene = scene
        self._scene_key = key
        return scene

    def _render_png_bytes(self, scene_script: str | None, blend_bytes: bytes | None,
                          frame: int, res: list | None, engine_hint: str) -> tuple[bytes, str]:
        """单帧渲染核心：场景快取命中 → frame_set 即渲；未命中 → 重建后渲。"""
        import bpy

        logs: list[str] = [f"gpu_ctx={_ensure_gpu_init()}",
                           f"warm={self.warm_state}@{self.warm_ms}ms",
                           f"pid={os.getpid()} host={os.uname().nodename}"]
        key = _scene_key(scene_script, blend_bytes, engine_hint)
        scene = self._ensure_scene(bpy, key, scene_script, blend_bytes, engine_hint, logs)

        if res and len(res) == 2:
            scene.render.resolution_x = int(res[0])
            scene.render.resolution_y = int(res[1])
            scene.render.resolution_percentage = 100

        scene.frame_set(frame)
        work = "/tmp/render"
        os.makedirs(work, exist_ok=True)
        output_path = os.path.join(work, f"output-{frame}.png")
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = output_path
        t_render = time.monotonic()
        bpy.ops.render.render(write_still=True)
        png = Path(output_path).read_bytes()
        logs.append(f"render_ms={int((time.monotonic() - t_render) * 1000)} "
                    f"png_bytes={len(png)} magic_ok={looks_like_png(png)}")
        return png, tail(" | ".join(logs))

    def _render_one(self, payload: dict) -> dict:
        """bridge 契约单帧渲染（web endpoint 与 @modal.method 共用的纯方法）。"""
        t0 = time.monotonic()
        frame = int(payload.get("frame", 1))
        blend_b64 = payload.get("blend_b64")
        scene_script = payload.get("scene_script")
        blend_bytes = base64.b64decode(blend_b64) if blend_b64 else None
        engine_hint = str(payload.get("engine_hint", "")).lower()
        try:
            png, log = self._render_png_bytes(scene_script, blend_bytes, frame,
                                              payload.get("res"), engine_hint)
            if not looks_like_png(png):
                raise RuntimeError("render wrote no valid PNG")
            return bridge_envelope(
                ok=True,
                artifacts=[artifact_entry(f"out/frame_{frame:04d}.png", len(png), png)],
                scene_summary=f"frame={frame} engine_hint={engine_hint or 'scene'} res={payload.get('res')}",
                stdout_tail=log,
                duration_ms=int((time.monotonic() - t0) * 1000),
                extra={"frame": frame},
            )
        except Exception as exc:  # noqa: BLE001 — 结构化错误面（桥 500 同构，additive）
            return bridge_envelope(
                ok=False,
                artifacts=[],
                stdout_tail=tail(f"{type(exc).__name__}: {exc}"),
                duration_ms=int((time.monotonic() - t0) * 1000),
                error=f"{type(exc).__name__}: {exc}",
            )

    @modal.method()
    def render_frame(self, payload: dict) -> dict:
        """白名单 #4/#7/#11：单帧一次调用（.remote/.map 用），bridge 契约同构回应。"""
        return self._render_one(payload)

    @modal.fastapi_endpoint(method="POST", label="blender-modal-poc-render")  # 1.5.5: web_endpoint 已死（2025-03-05 更名，硬 DeprecationError 实锤）
    def render_frame_web(self, payload: dict) -> dict:
        """POST /render-frame：HMAC 验签（_sig 内嵌通道）→ 同容器单帧渲染。

        签名基底 = 剥 _sig 后 canonical JSON（sort_keys, 紧凑分隔符），
        worker 端 modal_common.sign_hex 同一实现——同构验证点。
        """
        t0 = time.monotonic()
        payload = dict(payload)
        sig = str(payload.pop("_sig", ""))
        key = os.environ.get("BLENDER_MODAL_HMAC_KEY", "")
        body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        if not key or not sig or not _consteq(sign_hex(key, body), sig):
            return bridge_envelope(ok=False, artifacts=[], error="hmac_rejected",
                                   duration_ms=int((time.monotonic() - t0) * 1000))
        return self._render_one(payload)


def _consteq(a: str, b: str) -> bool:
    import hmac as _hmac

    return _hmac.compare_digest(a, b)


# ---- 官方 combination_image 同构（白名单 #10）
@app.function(image=modal.Image.debian_slim().apt_install("ffmpeg").add_local_python_source("modal_common"),
              timeout=300)
def combine(payload: dict) -> dict:
    """PNG 序列→mp4：image2 demuxer + list-form argv（片L/片M 实锤配方）。"""
    import subprocess
    import tempfile

    t0 = time.monotonic()
    try:
        frames = payload.get("frames_b64", [])  # [{path, b64}]
        fps = int(payload.get("fps", 30))
        if not frames:
            raise ValueError("frames_b64 空")
        proc_stdout = ""
        with tempfile.TemporaryDirectory() as tmpdir:
            frame_dir = os.path.join(tmpdir, "frames")
            os.makedirs(frame_dir)
            for i, fr in enumerate(frames):
                png = base64.b64decode(fr["b64"])
                if not looks_like_png(png):
                    raise ValueError(f"frame[{i}] 非 PNG")
                with open(os.path.join(frame_dir, f"frame_{i:04d}.png"), "wb") as fh:
                    fh.write(png)
            out_path = os.path.join(tmpdir, "output.mp4")
            proc = subprocess.run(ffmpeg_image2_args(frame_dir, fps, out_path),
                                  capture_output=True, text=True)
            proc_stdout = proc.stdout or ""
            if proc.returncode != 0:
                raise RuntimeError(f"ffmpeg rc={proc.returncode}: {tail(proc.stderr, 400)}")
            mp4 = Path(out_path).read_bytes()
        return bridge_envelope(
            ok=True,
            artifacts=[artifact_entry("out/turntable.mp4", len(mp4), mp4)],
            scene_summary=f"mp4 h264 {fps}fps x{len(frames)} frames",
            stdout_tail=tail(proc_stdout),
            duration_ms=int((time.monotonic() - t0) * 1000),
            extra={"frame_count": len(frames), "fps": fps},
        )
    except Exception as exc:  # noqa: BLE001
        return bridge_envelope(
            ok=False,
            artifacts=[],
            stdout_tail=tail(f"{type(exc).__name__}: {exc}"),
            duration_ms=int((time.monotonic() - t0) * 1000),
            error=f"{type(exc).__name__}: {exc}",
        )


@app.local_entrypoint()
def demo(
    engine: str = "eevee",
    frames: int = 10,
    fps: int = 30,
    frame: int = 1,
    mode: str = "still",  # "still" 单帧 | "chain" map 分发+合片
):
    """白名单 #9：内置确定性 turntable 场景 smoke（免外带 .blend）。

    modal run modal_app.py::demo --engine eevee --mode still --frame 1
    modal run modal_app.py::demo --engine eevee --mode chain --frames 10
    注意：chain 以 map 分发；收工后容器保温窗最长 60s（成本上界明示）。
    """
    script = build_turntable_script(1, max(frames, 10), fps)
    renderer = Renderer()
    t0 = time.monotonic()
    if mode == "still":
        resp = renderer.render_frame.remote({
            "scene_script": script, "frame": frame,
            "engine_hint": engine, "res": [1280, 720],
        })
        print(json.dumps({k: v for k, v in resp.items() if k != "artifacts"}, ensure_ascii=False))
        for art in resp.get("artifacts", []):
            png = base64.b64decode(art.get("b64", "")) if art.get("b64") else b""
            out = Path(f"out/demo_{engine}_f{frame}.png")
            out.write_bytes(png)
            print(f"artifact {art['path']} bytes={len(png)} magic_ok={looks_like_png(png)} saved={out}")
        print(f"wall_ms={int((time.monotonic() - t0) * 1000)}")
        return

    # chain：map 分发（map：单 dict 参数逐个派发；starmap 只吃 tuple，实锤 TypeError）→ combine 合片
    payloads = [{"scene_script": script, "frame": f, "engine_hint": engine, "res": [1280, 720]}
                for f in range(1, frames + 1)]
    results = list(renderer.render_frame.map(payloads))
    pngs, ok_count, per_frame_ms = [], 0, []
    for r in results:
        per_frame_ms.append(int(r.get("duration_ms", 0)))
        arts = r.get("artifacts") or []
        b64 = arts[0].get("b64") if arts else None
        if r.get("ok") and b64:
            ok_count += 1
            pngs.append({"path": arts[0]["path"], "b64": b64})
        else:
            print(f"frame fail: {r.get('error')} tail={r.get('stdout_tail', '')[:200]}")
    print(f"frames ok={ok_count}/{frames} per_frame_ms={per_frame_ms}")
    if not pngs:
        print("chain failed: no frames")
        return
    combined = combine.remote({"frames_b64": pngs, "fps": fps})
    print(json.dumps({k: v for k, v in combined.items() if k != "artifacts"}, ensure_ascii=False))
    for art in combined.get("artifacts", []):
        mp4 = base64.b64decode(art.get("b64", "")) if art.get("b64") else b""
        out = Path(f"out/demo_{engine}_chain.mp4")
        out.write_bytes(mp4)
        print(f"artifact {art['path']} bytes={len(mp4)} saved={out}")
    print(f"wall_ms={int((time.monotonic() - t0) * 1000)}")
