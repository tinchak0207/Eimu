#!/usr/bin/env python3
"""modal_app.py — blender-modal POC 主輪子（Modal 官方 examples/blender_video 整複製 + 白名單）。

輪子源：https://modal.com/docs/examples/blender_video（modal-examples 倉庫，MIT）。
下方「WHEEL DIFF 白名單」列出全部偏離；未列出的骨架（單幀一函數、bytes 進出、
map 分發、臨時目錄寫幀再回 bytes）與官方範例同構。

片 AD（2026-09-06）：單幀函數 → `@app.cls` 類形態（容器暖復用，消冷容器
著色器編譯重複支付——片 X 實錘每幀 ~20s 大頭在冷容器 EGL init+著色器編譯）。

WHEEL DIFF 白名單（官方範例 → 本檔）：
  1. app 名 "example-blender-video" → "blender-modal-poc"。
  2. Image：python_version "3.11"+bpy==4.5.0 → "3.13"+bpy==5.2.1。**現場證據
     推翻 spec 的默認**：PyPI 實測 bpy 5.2.1 僅 cp313 wheel（requires_python
     ==3.13.*，manylinux_2_28 x86_64），3.11 無輪可裝；5.2.1 與本機橋同版，
     5.2 API（BLENDER_EEVEE 唯一枚舉、channelbags、RT 旗標）直跑。apt 白名單：
     xorg/libxkbcommon0 官方原樣保留，+ libegl1/libgl1（EGL headless，
     本機橋片A實證路徑）。+ add_local_python_source("modal_common")（部署
     邊界：本地 import 不自動上雲，Modal 1.5.5 要求顯式聲明）。
  3. gpu="L40S" → env BLENDER_MODAL_GPU 可覆蓋，默認 "T4"（研究片U成本
     裁定：smoke 幾分錢級；Eevee EGL 若敗升 L4 重判）。max_containers=10
     官方原樣。timeout=120（spec 指定；官方未顯式聲明）。
  4. 官方 render() 只吃 blend_file → render_frame(payload: dict) 同時支持
     blend_bytes（官方輪原樣）與 scene_script（本機橋 /v1/execute 的 script
     語義：bpy 內 exec、CWD 內寫 out/、mtime/存在性收 artifacts）。
  5. 官方 configure_rendering（Cycles 專用）→ configure_eevee/configure_cycles：
       - Eevee 主輪：BLENDER_EEVEE（5.2 唯一枚舉，TypeError 落回
         BLENDER_EEVEE_NEXT 兼容 4.x，片M 候補清單同構）+ taa_render_samples=1
         + use_raytracing=False（片M/片F 存活配方：samples=16@1280 全崩、
         samples=1+RT off 全過）；
       - Cycles 後備：官方同構（compute_device_type + get_devices + 全開 +
         device 列印 debugging snippet 原樣），CUDA→OPTIX（L4/T4 均支援，
         三方橋同款），samples 128→16（POC 成本紀律，白名單）。
  6. 新增 _ensure_gpu_init()：gpu.init() EGL platform init——**片 AD 真雲
     判決推翻其主路徑地位**：預建 EGL context 是 Eevee 渲染崩潰源非加速器
     （三容器對照：無預建 rain 渲染成功 21s；預建×2 同場景 ~6s SIGSEGV；
     本機橋片F 同構互證；速度零貢獻且冷容器上 gpu.init 本身耗 18.5s）。
     默認關閉（Eevee 自建 context），BLENDER_MODAL_GPU_INIT=1 僅作診斷開關。
     另 AD 雷區 #6b：`import gpu` 必須在 `import bpy` 之後（bpy wheel 的
     gpu 模組由 bpy 導入路徑供給，裸導 No module named 'gpu' 真雲實錘）。
  7. 回應形狀：官方回裸 PNG bytes → bridge_envelope（{ok, artifacts:
     [{path,bytes,kind,b64}], scene_summary, stdout_tail, duration_ms,
     queued, queue_position}，與本機橋 POST /v1/execute 200 同構；b64/
     extra 欄 additive）。
  8. 新增 web endpoint POST /render-frame（官方無）：HMAC 鑑權（Secret
     blender-modal-hmac，簽名基底=剝 _sig 後的 canonical JSON，
     modal_common.sign_hex 同一實現）。
  9. 新增 @app.local_entrypoint() demo：內置確定性 turntable 場景
     （modal_common.build_turntable_script，片M 全跨度配方、不觸
     .fcurves 雷區）——官方範例依賴隨附 IceModal.blend，POC 免外帶資產。
 10. combine()：官方 glob+shell=True ffmpeg → image2 demuxer + list-form
     argv（片L 實錘 glob/concat 對 PNG 有丟幀面；片M 配方；免 shell 注入），
     fps 參數化（官方硬編 60）。
 11. （片 AD）單幀函數 render_frame → 單一 `@app.cls` 類 Renderer，同類掛
     `@modal.method()`（SDK .remote/.map 用）與 `@modal.fastapi_endpoint()`
     （web 用）——形狀照抄官方 lifecycle guide（「For web functions, swap in
     @modal.fastapi_endpoint()」）+ live wheel 1.5.5 認證（cls.pyi：cls() 吃
     function 同款參數含 scaledown_window；partial_function.pyi：enter()/
     method()）。同類雙修=同一暖容器池服務兩通道，暖身實現只有一份。
       - `@modal.enter()` warm：只做 gpu.init()（毫秒級）。**不做暖身渲染**
         （AD 兩實錘：①暖身渲染原樣重付首幀編譯成本 27s 純浪費；②同進程
         跨場景切換渲染觸發 SIGSEGV n=1，片 X 同場景 10 連渲零崩）——冷啟
         編譯由容器首幀付一次，之後同場景幀全部命中暖狀態；
       - scaledown_window=60（鏈間請求間隔 ~1-3s 足夠保溫；空窗帳單上限
         60s×T4≈$0.01/容器，成本紀律明示）；web 方法經 HMAC 才能觸發，
         SDK 方法由 Modal 平台鑑權，secret 掛類級無外洩面。
 12. （片 AD）場景快取：payload 場景輸入（scene_script/blend_bytes+
     engine_hint）sha256 為鍵，命中時重用活 scene 只做 frame_set（跳過
     open_mainfile/read_factory_settings+場景構建+材質著色器重編譯）；
     重用前 StructRNA touch-test（scene.render.engine 存取）防片 X 雷區
     #3「read_factory_settings 殺舊 Scene 引用」，死引用即降級重建；
     換鍵先置 None 再 reset，舊引用絕不觸碰。

禁區聲明：bridge/、src/、其他 deploy-staging/、skills/ 本片零接觸。
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

# ---- 官方 rendering_image 同構，僅白名單 #2/#3
rendering_image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("xorg", "libxkbcommon0", "libegl1", "libgl1")  # X11 (Unix GUI) deps + EGL headless
    .uv_pip_install("bpy==5.2.1", "fastapi[standard]")  # fastapi 顯式裝：1.5.5 fastapi_endpoint 硬要求（ConflictError 實錘）
    .add_local_python_source("modal_common")
)

# 研究片U 裁定：T4 起步（幾分錢紀律）；Eevee EGL 若敗，BLENDER_MODAL_GPU=L4 重判
GPU = os.environ.get("BLENDER_MODAL_GPU", "T4")
WITH_GPU = True

EEVEE_SAMPLES = 1    # 片M/片F 存活配方
CYCLES_SAMPLES = 16  # 官方 128 → POC 成本紀律（白名單 #5）
EEVEE_ENGINE = "BLENDER_EEVEE"  # 5.2 唯一枚舉（片B/片M 實錘）
SCALEDOWN_WINDOW = 60  # 白名單 #11：保溫窗（顯式聲明=成本上界明示）

_GPU_STATE = {"ready": False, "state": "unknown"}


def _ensure_gpu_init() -> str:
    """gpu.init() EGL platform init（默認關閉，BLENDER_MODAL_GPU_INIT=1 才啟用）。

    片 AD 真雲判決（2026-09-06，三容器對照）：**預建 EGL context 是 Eevee
    渲染的崩潰源，不是加速器**——
      - 容器1 gpu.init 失敗（無預建）→ rain_chase 1280x720 渲染成功 21s；
      - 容器2/3 gpu.init 成功（預建）→ 同場景渲染 ~6s 處 SIGSEGV ×2；
      - 本機橋片F 同構互證：橋（gpu.init 預建）負載下崩、直連 CLI（Eevee
        自建 context）無事；
      - 速度零貢獻：piece X（gpu.init 版）與容器1（無）每幀同為 ~20s，
        且 gpu.init 本身在冷容器上耗 18.5s（純浪費）。
    保留本函數僅為診斷開關（env 顯式開啟）；主路徑 Eevee 自建 context。
    """
    if _GPU_STATE["ready"]:
        return _GPU_STATE["state"]
    if os.environ.get("BLENDER_MODAL_GPU_INIT", "") != "1":
        _GPU_STATE["state"] = "self-init(deferred)"
        _GPU_STATE["ready"] = True
        return _GPU_STATE["state"]
    try:
        import bpy  # noqa: F401 — 必須先於 gpu（雷區 #6b）
        import gpu as bl_gpu  # Blender GPU module — headless 時走 EGL backend

        bl_gpu.init()
        _GPU_STATE["state"] = "egl"
    except Exception as exc:  # noqa: BLE001 — 判決要輸出原文
        _GPU_STATE["state"] = f"cpu:{exc}"
    _GPU_STATE["ready"] = True
    print(f"[gpu-init] {_GPU_STATE['state']}")
    return _GPU_STATE["state"]


def configure_eevee(scene) -> None:
    """片M 存活配方（本機 EGL 實彈全過）：samples=1 + raytracing off。"""
    scene.eevee.taa_render_samples = EEVEE_SAMPLES
    try:
        scene.eevee.use_raytracing = False  # 5.2 新旗標；try/except 同片M
    except AttributeError:
        pass


def configure_cycles(scene) -> None:
    """官方 configure_rendering 同構（白名單 #5：CUDA→OPTIX、samples 128→16）。"""
    scene.cycles.samples = CYCLES_SAMPLES
    scene.cycles.device = "GPU"
    import bpy  # 官方路徑：preferences 掛在 bpy.context，不在 scene 上

    cycles = bpy.context.preferences.addons["cycles"]
    cycles.preferences.compute_device_type = "OPTIX"
    cycles.preferences.get_devices()
    for device in cycles.preferences.devices:
        device.use = True
    for dev in cycles.preferences.devices:  # 官方 debugging snippet 原樣
        print(f"ID:{dev['id']} Name:{dev['name']} Type:{dev['type']} Use:{dev['use']}")


def _resolve_engine(scene, engine_hint: str) -> str:
    """engine 解析：hint 勝（同一腳本可雙跑）；未給則尊重 blend 內建。"""
    if engine_hint == "cycles":
        scene.render.engine = "CYCLES"
    elif engine_hint == "eevee":
        try:
            scene.render.engine = EEVEE_ENGINE
        except TypeError:
            scene.render.engine = "BLENDER_EEVEE_NEXT"  # 4.x 兼容（片M 候補清單同構）
    return str(scene.render.engine)


def _scene_key(scene_script: str | None, blend_bytes: bytes | None, engine_hint: str) -> str:
    """白名單 #12：場景輸入指紋（快取鍵）。res/frame 不入鍵（逐幀便宜、按呼叫設）。"""
    h = hashlib.sha256()
    h.update(b"v1|")
    h.update((scene_script or "").encode("utf-8"))
    h.update(b"|")
    h.update(blend_bytes or b"")
    h.update(f"|{engine_hint}".encode("utf-8"))
    return h.hexdigest()


# ---- 白名單 #8：HMAC Secret（web 鑑權；類級掛載，SDK 方法由平台鑑權）
hmac_secret = modal.Secret.from_name("blender-modal-hmac")


@app.cls(
    image=rendering_image,
    gpu=GPU if WITH_GPU else None,
    secrets=[hmac_secret],
    max_containers=10,                  # 官方 free-tier 同值
    timeout=120,                        # 白名單 #3
    scaledown_window=SCALEDOWN_WINDOW,  # 白名單 #11
)
class Renderer:
    """暖復用渲染容器：容器進程內 bpy import/EGL context/著色器編譯天然驻留
    （模組級+GPU 進程級狀態），本類把它顯式化：
      - @modal.enter() 只做 GPU 狀態記錄（gpu.init 默認關閉，見 #6）——
        **不做暖身渲染**，兩個實錘：
        ①暖身渲染把首幀本要付的編譯成本原樣重付（320x180 cube 實測 27s，
        純浪費）；②同進程跨場景切換渲染（小暖身場景→重 blend）觸發
        SIGSEGV（AD 真雲 n=1；片 X 同場景 10 連渲零崩）——場景切換面
        只留給場景快取 miss（必要路徑），絕不無故多製造一次。
      - 場景快取（_scene_key）讓同場景後續幀跳過重建+重編譯；
      - scaledown_window 讓 HTTP 鏈的逐幀請求落在同一暖容器上。
    片 X 實證基線：同場景容器上逐幀 0.5-2.5s（smoke4 web 鏈 10/10 零崩）。"""

    # 類屬性槽（Modal 對自訂 __init__ 發 DeprecationError——改類屬性，實例首次賦值即遮蔽）
    _scene = None
    _scene_key: str | None = None
    warm_ms = 0
    warm_state = "not-run"

    @modal.enter()
    def warm(self) -> None:
        """容器啟動一次：GPU 狀態記錄（gpu.init 默認關閉=延遲自建，見
        _ensure_gpu_init 判決；渲染冷啟大頭由首個真實請求付一次，之後
        同場景幀全部命中暖狀態）。"""
        t0 = time.monotonic()
        self.warm_state = _ensure_gpu_init()
        self.warm_ms = int((time.monotonic() - t0) * 1000)
        print(f"[warm] state={self.warm_state} warm_ms={self.warm_ms}")

    def _ensure_scene(self, bpy, key: str, scene_script: str | None,
                      blend_bytes: bytes | None, engine_hint: str, logs: list):
        """白名單 #12：場景快取（hit → frame_set 即用；miss → 重建）。

        雷區 #3 防線：重用前 touch-test；換鍵先置 None 再 reset——舊 Scene
        引用在 reset 後絕不觸碰（StructRNA of type Scene has been removed）。
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
            exec(compile(scene_script, "<modal-scene-script>", "exec"), {"__name__": "__main__"})  # noqa: S102 — 橋 /v1/execute 同語義
            logs.append("scene:rebuild")
            logs.append("scene:scene_script")
        else:
            raise ValueError("payload 需 blend_b64 或 scene_script 擇一")

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
        """單幀渲染核心：場景快取命中 → frame_set 即渲；未命中 → 重建後渲。"""
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
        """bridge 契約單幀渲染（web endpoint 與 @modal.method 共用的純方法）。"""
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
        except Exception as exc:  # noqa: BLE001 — 結構化錯誤面（橋 500 同構，additive）
            return bridge_envelope(
                ok=False,
                artifacts=[],
                stdout_tail=tail(f"{type(exc).__name__}: {exc}"),
                duration_ms=int((time.monotonic() - t0) * 1000),
                error=f"{type(exc).__name__}: {exc}",
            )

    @modal.method()
    def render_frame(self, payload: dict) -> dict:
        """白名單 #4/#7/#11：單幀一次調用（.remote/.map 用），bridge 契約同構回應。"""
        return self._render_one(payload)

    @modal.fastapi_endpoint(method="POST", label="blender-modal-poc-render")  # 1.5.5: web_endpoint 已死（2025-03-05 更名，硬 DeprecationError 實錘）
    def render_frame_web(self, payload: dict) -> dict:
        """POST /render-frame：HMAC 驗簽（_sig 內嵌通道）→ 同容器單幀渲染。

        簽名基底 = 剝 _sig 後 canonical JSON（sort_keys, 緊湊分隔符），
        worker 端 modal_common.sign_hex 同一實現——同構驗證點。
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


# ---- 官方 combination_image 同構（白名單 #10）
@app.function(image=modal.Image.debian_slim().apt_install("ffmpeg").add_local_python_source("modal_common"),
              timeout=300)
def combine(payload: dict) -> dict:
    """PNG 序列→mp4：image2 demuxer + list-form argv（片L/片M 實錘配方）。"""
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
    mode: str = "still",  # "still" 單幀 | "chain" map 分發+合片
):
    """白名單 #9：內置確定性 turntable 場景 smoke（免外帶 .blend）。

    modal run modal_app.py::demo --engine eevee --mode still --frame 1
    modal run modal_app.py::demo --engine eevee --mode chain --frames 10
    注意：chain 以 map 分發；收工後容器保溫窗最長 60s（成本上界明示）。
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

    # chain：map 分發（map：單 dict 參數逐個派發；starmap 只吃 tuple，實錘 TypeError）→ combine 合片
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
