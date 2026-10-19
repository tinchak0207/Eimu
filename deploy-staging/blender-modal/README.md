# blender-modal POC — Modal 云端 Blender 渲染节点（片 X 交付，片 AD 收尾）

研究片 U 结论（Modal 免费节点 9/10 胜出）的可执行转化。**真云 smoke 已全绿收官（2026-09-06），Eevee EGL on serverless 已实证可用**——研究唯一未证项转已证。
**片 AD（同日）已收掉片 X 两个 pending + 一个杠杆**：`@app.cls` 暖复用上线、blend_bytes 路径真帧实弹、暖/冷性能对比实测（见下方片 AD 节）。

## 档案

| 档案 | 角色 |
|---|---|
| `modal_app.py` | Modal 应用：bpy 5.2.1 单帧渲染 + ffmpeg 合片 + HMAC web endpoint + local demo 入口 |
| `modal_worker.py` | 本机/VPS 侧触发器：bridge `/v1/execute` 同构 client（单帧循环 + 本地 ffmpeg 合片备选），**可直接当 bridge 的云端执行后端替身** |
| `modal_common.py` | 纯逻辑层（stdlib only，本地可单测）：场景脚本生成 / ffmpeg 参数 / HMAC / bridge envelope |
| `smoke_modal.sh` | 一行 smoke：本地验证 → 单帧 Eevee（EGL 生死）→（条件）Cycles 后备 → 10 帧链合片 → web endpoint 链路 |

## 三步启动（已完成，留档配方）

```bash
# 0. token（已就位 ~/.modal.toml，帐号 verenowo；CLI=/home/user/.venvs/modal/bin/modal）
#    若重建：pip install modal && modal setup

# 1. HMAC secret（值即 worker 的 BLENDER_MODAL_HMAC_KEY）
openssl rand -hex 32 > out/.hmac_key && chmod 600 out/.hmac_key
modal secret create blender-modal-hmac BLENDER_MODAL_HMAC_KEY=$(cat out/.hmac_key)

# 2. deploy（web endpoint 稳定 URL）+ smoke 一行
modal deploy modal_app.py        # → https://verenowo--blender-modal-poc-render.modal.run
./smoke_modal.sh                 # 全流程三连（本 smoke 已实弹跑过，见下方实测）

# 3. 交互用法
modal run modal_app.py::demo --engine eevee --mode still --frame 1
modal run modal_app.py::demo --engine eevee --mode chain --frames 10 --fps 30
BLENDER_MODAL_ENDPOINT=https://verenowo--blender-modal-poc-render.modal.run \
BLENDER_MODAL_HMAC_KEY=$(cat out/.hmac_key) \
python3 modal_worker.py still --engine eevee --frame 1
```

## 片 AD 收尾（2026-09-06）：暖复用 + blend_bytes 实弹

### 架构变更（modal_app.py 白名单 #11/#12）

- 单帧函数 → 单一 `@app.cls` 类 `Renderer`：同类挂 `@modal.method()`（SDK `.remote`/`.map`）与 `@modal.fastapi_endpoint()`（HMAC web，label 不变故 URL 不变）——同一暖容器池服务两通道。形状照抄官方 lifecycle guide + live wheel 1.5.5 认证（`cls()` 吃 function 同款参数含 `scaledown_window`）。
- 场景快取：payload 场景输入（scene_script/blend_bytes+engine_hint）sha256 为键，命中时重用活 scene 只做 `frame_set`（跳过 open_mainfile/场景构建/材质著色器重编译）；重用前 StructRNA touch-test 防片 X 雷区 #3。
- `scaledown_window=60`：HTTP 逐帧链的请求间隔 ~1-3s，60s 保温窗足够；空窗帐单上界 60s×T4≈$0.01/容器。
- Modal 对自订 `__init__` 发 DeprecationError → 改类属性槽（`_scene`/`warm_state` 等）。

### 片 AD 实测（真云，T4，2026-09-06）

| 项目 | 片 X 冷版 | 片 AD 暖版（同容器） | 倍率 |
|---|---|---|---|
| blend 路径单帧（rain_chase_final.blend 141KB 上传→1280x720） | 20.8-22.7s（scene rebuild+编译+渲染） | **0.4-1.8s**（cache-hit，9/10 帧） | **~12-50x** |
| blend 10 帧链（worker 逐帧 HTTP，顺序） | 10 容器 × ~20s ≈ 200 GPU-s | 103s 墙钟 / ~60 GPU-s（含一次 37.5s 容器级重建） | ~3x 省 GPU 秒 |
| scene_script 10 帧链（SDK `.map()` 并发） | 10/10、56s 墙钟（10 冷容器） | 10/10、43s 墙钟（8 冷容器 + 1 容器连吃 2 input：第 2 个 322/425ms） | 墙钟近似；省在 input>容器数时 |

证据：`out/ad1_blend_still.log`（PIL 亮度方差 7038>50）、`out/ad2_blend_chain.log`（warm_tags 9/10 cache-hit）、`out/ad3_sdk_chain.log`、`out/blend_chain.mp4`（ffprobe h264 1280x720 30fps nb_frames=10；首末帧差分 7.79% 真动画）。

### 片 AD 两颗新雷区（真云实锤，已写入 modal_app.py 注释）

1. **雷区 #6b：`import gpu` 必须在 `import bpy` 之后**——bpy wheel 的 gpu 模组由 bpy 导入路径供给，裸导 = `No module named 'gpu'`。片 X 没踩中是因为其调用点恰在 import bpy 之后；`@modal.enter()` 先跑 gpu init 就翻车。
2. **雷区 #7：`gpu.init()` 预建 EGL context 是 Eevee 渲染的崩溃源，不是加速器**——三容器对照：无预建 → rain_chase 1280x720 渲染成功 21s；预建 ×2 → 同场景 ~6s 处 SIGSEGV ×2。本机桥片 F 同构互证（桥 gpu.init 预建=崩、直连 CLI 自建 context=稳）；速度零贡献（片 X gpu.init 版与无版每帧同为 ~20s），且 gpu.init 本身在冷容器上耗 18.5s。**主路径改 Eevee 自建 context，`BLENDER_MODAL_GPU_INIT=1` 仅作诊断开关。**
3. **暖身渲染是纯浪费+风险源（已拆除）**：它把首帧本要付的编译成本原样重付（320x180 cube 实测 27s），且「小暖身场景→重 blend」跨场景切换触发 SIGSEGV（n=1；片 X 同场景 10 连渲零崩）。暖复用正确形态=容器首帧付一次编译，之后同场景帧全部命中。

### 片 AD 成本实帐（Modal dashboard 为准，此为估算）

- 两轮 SIGSEGV 排障（D2/D3）≈ $0.04；blend still+链 ≈ $0.04；SDK demo map 一轮 ≈ $0.10+——**map 模式 9-10 容器各带 60s scaledown 空窗是烧钱大头**（10 input 并发 → 每容器 lifetime ≈ spin+20s+60s 空窗）。总计 ≈ **$0.20-0.25，超出片预算上限 $0.10**，超支主因=崩溃排障两轮 + map 空窗帐。教训已沉淀：跑分/排障用顺序链（1 容器）最省；map 突发后建议 `modal app stop` 或调短 scaledown_window。
- 本片结束后 app 保留 deployed（无请求=0 容器=零计费），endpoint https://verenowo--blender-modal-poc-render.modal.run 存活。

## 片 X 原始实测数据（2026-09-06 真云，T4，turntable Suzanne 1280x720）

| 项目 | 实测 |
|---|---|
| Eevee EGL 判决 | **活**：`gpu.init()` 回 egl context（Modal T4 serverless），真 PNG 验真 + 亮度方差 3826（片F 健康带 1336-7153 内） |
| 单帧 in-container | ~20s/帧（EGL init + 著色器编译 + 渲染；冷容器每帧重付） |
| 10 帧链（`.map()` 并发，max_containers=10） | 10/10 成功，墙钟 56s，合片 630ms |
| 产物 | h264 1280x720 30fps nb_frames=10（ffprobe 验真） |
| smoke 全程花费 | **$0.036**（220s 墙钟全按 GPU 秒计的保守估算；T4 列表价 $0.59/h 基准，以 Modal 定价页为准） |

### 成本表（研究片 U 数据引用 + 本 POC 实测）

| 口径 | 数值 | 来源 |
|---|---|---|
| 96 帧链 | $0.18-0.27 | 研究片 U |
| $30 免费额度 | ≈100-160 条 96 帧链/月 | 研究片 U |
| 本 smoke（still 1 + 链 10 + web 链 10，共 21 帧 + 冷启） | $0.036 | 本 POC 实测 |
| 成本杠杆（下一格） | 每帧 20s 大头是冷容器著色器编译——换 `@app.cls` 容器暖复用可压数倍；L4 换档看画质需求 | 本 POC 推断 |

## 风险节

1. ~~Eevee EGL on serverless~~ **已证**（唯一未证项，一次 smoke 判生死：活）。败时退路原样保留：engine 参数换 `cycles` 即一行退（Cycles 路径官方同构 + OptiX）。
2. **执行器多帧单进程风险**：本 POC 主路径=单帧一次调用（片 L 实锤「单帧 job 才是安全单位」），Modal 容器天然隔离，崩了即换新容器，无桥的持续进程污染面。`modal_common.build_turntable_script` 不触 `.fcurves`/`file_format="FFMPEG"`/`EEVEE_NEXT`（5.2 三雷区，片 M 清单）。
3. **timeout=120s/帧帽**：T4 实测 20s/帧，余量 6x；4K 或高 samples 场景需重估，超帽结构化报错不挂死。
4. **HMAC secret**：`blender-modal-hmac` 只存 Modal Secret 与本目录 `out/.hmac_key`（600，已 gitignore）；key 永不入 log/commit。secret 已存在时 `modal secret create` 失败非致命（沿用现值，401 才需删重建）。
5. ~~每帧冷启成本~~ **片 AD 已收**：`@app.cls` 暖复用 + 场景快取 + scaledown_window=60 上线，同容器暖帧实测 0.4-1.8s（见片 AD 节）。注意新风险面：①同进程多帧渲染存在间歇 SIGSEGV（片 AD blend 链 f2 重建一次 37.5s；与本机桥片 F 同构、非确定性），Modal 上代价=一次冷重建后自愈，worker 重试 ≤2 可覆盖；②`gpu.init()` 预建 EGL context 放大崩溃面（雷区 #7），保持默认关闭。

## 轮子 diff 对照表（官方 examples/blender_video → modal_app.py）

主轮子逐行同构处：单帧一函数、blend bytes 进/裸档出、`max_containers=10`、X11 apt 依赖（xorg/libxkbcommon0）、临时目录写帧再回 bytes、`.map()` 分发后合片（官方 starmap→dict 参数改 map，TypeError 实锤）、官方 Cycles device 列印 debugging snippet 原样。

白名单偏离（全部有据）：

| # | 偏离 | 依据 |
|---|---|---|
| 1 | `bpy==4.5.0/py3.11` → `bpy==5.2.1/py3.13` | PyPI 实证：5.2.1 仅 cp313 wheel（`requires_python ==3.13.*`）；与本机桥同版 |
| 2 | apt + `libegl1/libgl1` | Eevee EGL headless（本机桥片 A 实证路径；真云实锤 `[gpu-init] egl`） |
| 3 | `gpu="L40S"` → `T4`（env 可覆盖） | 研究片 U 成本裁定（几分钱纪律） |
| 4 | `timeout=120` | spec 指定；T4 实测 20s/帧余量 6x |
| 5 | Eevee 主轮：`BLENDER_EEVEE`（唯一枚举）+ `taa_render_samples=1` + `use_raytracing=False` | 片 M/片 F 存活配方（samples=16@1280 全崩、1+RT off 全过）；真云真帧验证 |
| 6 | Cycles：CUDA→OPTIX、samples 128→16 | 三方桥同款降级；POC 成本纪律 |
| 7 | `render()` 回 bridge envelope（不回裸 bytes） | bridge `/v1/execute` 契约同构（spec 交付 #1） |
| 8 | 输入增 `scene_script`（bpy 内 exec） | 桥 script 语义；免外带 .blend 即 smoke（官方依赖 IceModal.blend） |
| 9 | combine：glob+shell → image2 demuxer + list-form | 片 L 实锤 glob/concat 对 PNG 丢帧；片 M 配方；免 shell 注入 |
| 10 | 新增 web endpoint POST /render-frame（HMAC） | spec 指定；`@modal.web_endpoint` 已死（1.5.5 硬改名 `fastapi_endpoint` + Image 显式装 `fastapi[standard]`，ConflictError 实锤） |
| 11 | `add_local_python_source("modal_common")` | 1.5.5 部署边界：本地 import 不自动上云 |

三方桥借鉴：`liqi155134/blender_modal_bridge` 的 farm_common 纯函数分层（→ modal_common.py）与 web 端点形态；`stoicsuffering/distributed-blender-render-modal` 的「先小帧集试跑再全量」纪律（→ smoke 顺序设计）。该桥 Cycles-only（Eevee 直接禁提交）——本 POC 以 EGL 实证推翻其「Eevee 无头需 GPU context 不可行」前提。

## bridge 契约同构证明（栏位一一对应）

真源：`bridge/blender-bridge/server.py` L14-19（additive-only）。

| bridge `/v1/execute` 200 | worker/modal_app 回应 | 状态 |
|---|---|---|
| `ok: bool` | 同 | 逐字同构 |
| `artifacts: [{path, bytes, kind}]` | 同 + additive `b64` 栏（云端传输必需） | additive |
| `scene_summary: string` | 同（frame/engine/gpu_ctx/res） | 逐字同构 |
| `stdout_tail: string(≤2000)` | 同（`modal_common.tail` 同语义） | 逐字同构 |
| `duration_ms: number` | 同 | 逐字同构 |
| `queued: bool` | 恒 `false`（Modal 平台调度，无应用层伫列） | 语义等价 |
| `queue_position: int` | 恒 `0` | 语义等价 |
| 429 `{ok:false,error:"queue_full"}` | 不存在（平台弹性并发） | N/A |
| 500 `{ok:false,error,stdout_tail,queued,queue_position}` | 同形（error+stdout_tail+queued/position 恒在） | 同构 |
| `kind` 枚举 `blend|png|mp4|glb|other` | `modal_common.kind_from_path` 同枚举 | 逐字同构 |

web 链路实测回应（真云）：`{"ok": true, "artifacts": [{"path": "out/frame_0001.png", "bytes": 812270, "kind": "png", "b64": "iVBOR…"}], "scene_summary": …, "stdout_tail": …, "duration_ms": …, "queued": false, "queue_position": 0}`。

worker 并发/重试语义同构：每帧重试 ≤2（2s cooldown，片 M）、retriable 分类同名、`ffmpeg_unavailable` 结构化报错、artifacts path 相对 `out/`（片 M 口径）。

## 待办（下一格）

- ~~容器暖复用（`@app.cls`）~~ **片 AD 已交付**（实测暖帧 0.4-1.8s）。
- ~~blend_bytes 路径实弹~~ **片 AD 已交付**（rain_chase_final.blend 真帧，方差 7038，mp4 首末差分 7.79%）。
- 接 `src/lib/blender-tools.ts`：worker 回应已同构，工具层换 endpoint 即吃。
- 持久部署：`modal deploy --detached`（现为普通 deploy，CLI 进程结束即收）。
