# blender-modal POC — Modal 雲端 Blender 渲染節點（片 X 交付，片 AD 收尾）

研究片 U 結論（Modal 免費節點 9/10 勝出）的可執行轉化。**真雲 smoke 已全綠收官（2026-09-06），Eevee EGL on serverless 已實證可用**——研究唯一未證項轉已證。
**片 AD（同日）已收掉片 X 兩個 pending + 一個槓桿**：`@app.cls` 暖復用上線、blend_bytes 路徑真幀實彈、暖/冷性能對比實測（見下方片 AD 節）。

## 檔案

| 檔案 | 角色 |
|---|---|
| `modal_app.py` | Modal 應用：bpy 5.2.1 單幀渲染 + ffmpeg 合片 + HMAC web endpoint + local demo 入口 |
| `modal_worker.py` | 本機/VPS 側觸發器：bridge `/v1/execute` 同構 client（單幀循環 + 本地 ffmpeg 合片備選），**可直接當 bridge 的雲端執行後端替身** |
| `modal_common.py` | 純邏輯層（stdlib only，本地可單測）：場景腳本生成 / ffmpeg 參數 / HMAC / bridge envelope |
| `smoke_modal.sh` | 一行 smoke：本地驗證 → 單幀 Eevee（EGL 生死）→（條件）Cycles 後備 → 10 幀鏈合片 → web endpoint 鏈路 |

## 三步啟動（已完成，留檔配方）

```bash
# 0. token（已就位 ~/.modal.toml，帳號 verenowo；CLI=/home/lenovo/.venvs/modal/bin/modal）
#    若重建：pip install modal && modal setup

# 1. HMAC secret（值即 worker 的 BLENDER_MODAL_HMAC_KEY）
openssl rand -hex 32 > out/.hmac_key && chmod 600 out/.hmac_key
modal secret create blender-modal-hmac BLENDER_MODAL_HMAC_KEY=$(cat out/.hmac_key)

# 2. deploy（web endpoint 穩定 URL）+ smoke 一行
modal deploy modal_app.py        # → https://verenowo--blender-modal-poc-render.modal.run
./smoke_modal.sh                 # 全流程三連（本 smoke 已實彈跑過，見下方實測）

# 3. 交互用法
modal run modal_app.py::demo --engine eevee --mode still --frame 1
modal run modal_app.py::demo --engine eevee --mode chain --frames 10 --fps 30
BLENDER_MODAL_ENDPOINT=https://verenowo--blender-modal-poc-render.modal.run \
BLENDER_MODAL_HMAC_KEY=$(cat out/.hmac_key) \
python3 modal_worker.py still --engine eevee --frame 1
```

## 片 AD 收尾（2026-09-06）：暖復用 + blend_bytes 實彈

### 架構變更（modal_app.py 白名單 #11/#12）

- 單幀函數 → 單一 `@app.cls` 類 `Renderer`：同類掛 `@modal.method()`（SDK `.remote`/`.map`）與 `@modal.fastapi_endpoint()`（HMAC web，label 不變故 URL 不變）——同一暖容器池服務兩通道。形狀照抄官方 lifecycle guide + live wheel 1.5.5 認證（`cls()` 吃 function 同款參數含 `scaledown_window`）。
- 場景快取：payload 場景輸入（scene_script/blend_bytes+engine_hint）sha256 為鍵，命中時重用活 scene 只做 `frame_set`（跳過 open_mainfile/場景構建/材質著色器重編譯）；重用前 StructRNA touch-test 防片 X 雷區 #3。
- `scaledown_window=60`：HTTP 逐幀鏈的請求間隔 ~1-3s，60s 保溫窗足夠；空窗帳單上界 60s×T4≈$0.01/容器。
- Modal 對自訂 `__init__` 發 DeprecationError → 改類屬性槽（`_scene`/`warm_state` 等）。

### 片 AD 實測（真雲，T4，2026-09-06）

| 項目 | 片 X 冷版 | 片 AD 暖版（同容器） | 倍率 |
|---|---|---|---|
| blend 路徑單幀（rain_chase_final.blend 141KB 上傳→1280x720） | 20.8-22.7s（scene rebuild+編譯+渲染） | **0.4-1.8s**（cache-hit，9/10 幀） | **~12-50x** |
| blend 10 幀鏈（worker 逐幀 HTTP，順序） | 10 容器 × ~20s ≈ 200 GPU-s | 103s 牆鐘 / ~60 GPU-s（含一次 37.5s 容器級重建） | ~3x 省 GPU 秒 |
| scene_script 10 幀鏈（SDK `.map()` 併發） | 10/10、56s 牆鐘（10 冷容器） | 10/10、43s 牆鐘（8 冷容器 + 1 容器連吃 2 input：第 2 個 322/425ms） | 牆鐘近似；省在 input>容器數時 |

證據：`out/ad1_blend_still.log`（PIL 亮度方差 7038>50）、`out/ad2_blend_chain.log`（warm_tags 9/10 cache-hit）、`out/ad3_sdk_chain.log`、`out/blend_chain.mp4`（ffprobe h264 1280x720 30fps nb_frames=10；首末幀差分 7.79% 真動畫）。

### 片 AD 兩顆新雷區（真雲實錘，已寫入 modal_app.py 註釋）

1. **雷區 #6b：`import gpu` 必須在 `import bpy` 之後**——bpy wheel 的 gpu 模組由 bpy 導入路徑供給，裸導 = `No module named 'gpu'`。片 X 沒踩中是因為其調用點恰在 import bpy 之後；`@modal.enter()` 先跑 gpu init 就翻車。
2. **雷區 #7：`gpu.init()` 預建 EGL context 是 Eevee 渲染的崩潰源，不是加速器**——三容器對照：無預建 → rain_chase 1280x720 渲染成功 21s；預建 ×2 → 同場景 ~6s 處 SIGSEGV ×2。本機橋片 F 同構互證（橋 gpu.init 預建=崩、直連 CLI 自建 context=穩）；速度零貢獻（片 X gpu.init 版與無版每幀同為 ~20s），且 gpu.init 本身在冷容器上耗 18.5s。**主路徑改 Eevee 自建 context，`BLENDER_MODAL_GPU_INIT=1` 僅作診斷開關。**
3. **暖身渲染是純浪費+風險源（已拆除）**：它把首幀本要付的編譯成本原樣重付（320x180 cube 實測 27s），且「小暖身場景→重 blend」跨場景切換觸發 SIGSEGV（n=1；片 X 同場景 10 連渲零崩）。暖復用正確形態=容器首幀付一次編譯，之後同場景幀全部命中。

### 片 AD 成本實帳（Modal dashboard 為準，此為估算）

- 兩輪 SIGSEGV 排障（D2/D3）≈ $0.04；blend still+鏈 ≈ $0.04；SDK demo map 一輪 ≈ $0.10+——**map 模式 9-10 容器各帶 60s scaledown 空窗是燒錢大頭**（10 input 併發 → 每容器 lifetime ≈ spin+20s+60s 空窗）。總計 ≈ **$0.20-0.25，超出片預算上限 $0.10**，超支主因=崩潰排障兩輪 + map 空窗帳。教訓已沉澱：跑分/排障用順序鏈（1 容器）最省；map 突發後建議 `modal app stop` 或調短 scaledown_window。
- 本片結束後 app 保留 deployed（無請求=0 容器=零計費），endpoint https://verenowo--blender-modal-poc-render.modal.run 存活。

## 片 X 原始實測數據（2026-09-06 真雲，T4，turntable Suzanne 1280x720）

| 項目 | 實測 |
|---|---|
| Eevee EGL 判決 | **活**：`gpu.init()` 回 egl context（Modal T4 serverless），真 PNG 驗真 + 亮度方差 3826（片F 健康帶 1336-7153 內） |
| 單幀 in-container | ~20s/幀（EGL init + 著色器編譯 + 渲染；冷容器每幀重付） |
| 10 幀鏈（`.map()` 併發，max_containers=10） | 10/10 成功，牆鐘 56s，合片 630ms |
| 產物 | h264 1280x720 30fps nb_frames=10（ffprobe 驗真） |
| smoke 全程花費 | **$0.036**（220s 牆鐘全按 GPU 秒計的保守估算；T4 列表價 $0.59/h 基準，以 Modal 定價頁為準） |

### 成本表（研究片 U 數據引用 + 本 POC 實測）

| 口徑 | 數值 | 來源 |
|---|---|---|
| 96 幀鏈 | $0.18-0.27 | 研究片 U |
| $30 免費額度 | ≈100-160 條 96 幀鏈/月 | 研究片 U |
| 本 smoke（still 1 + 鏈 10 + web 鏈 10，共 21 幀 + 冷啟） | $0.036 | 本 POC 實測 |
| 成本槓桿（下一格） | 每幀 20s 大頭是冷容器著色器編譯——換 `@app.cls` 容器暖復用可壓數倍；L4 換檔看畫質需求 | 本 POC 推斷 |

## 風險節

1. ~~Eevee EGL on serverless~~ **已證**（唯一未證項，一次 smoke 判生死：活）。敗時退路原樣保留：engine 參數換 `cycles` 即一行退（Cycles 路徑官方同構 + OptiX）。
2. **執行器多幀單進程風險**：本 POC 主路徑=單幀一次調用（片 L 實錘「單幀 job 才是安全單位」），Modal 容器天然隔離，崩了即換新容器，無橋的持續進程污染面。`modal_common.build_turntable_script` 不觸 `.fcurves`/`file_format="FFMPEG"`/`EEVEE_NEXT`（5.2 三雷區，片 M 清單）。
3. **timeout=120s/幀帽**：T4 實測 20s/幀，餘量 6x；4K 或高 samples 場景需重估，超帽結構化報錯不掛死。
4. **HMAC secret**：`blender-modal-hmac` 只存 Modal Secret 與本目錄 `out/.hmac_key`（600，已 gitignore）；key 永不入 log/commit。secret 已存在時 `modal secret create` 失敗非致命（沿用現值，401 才需刪重建）。
5. ~~每幀冷啟成本~~ **片 AD 已收**：`@app.cls` 暖復用 + 場景快取 + scaledown_window=60 上線，同容器暖幀實測 0.4-1.8s（見片 AD 節）。注意新風險面：①同進程多幀渲染存在間歇 SIGSEGV（片 AD blend 鏈 f2 重建一次 37.5s；與本機橋片 F 同構、非確定性），Modal 上代價=一次冷重建後自愈，worker 重試 ≤2 可覆蓋；②`gpu.init()` 預建 EGL context 放大崩潰面（雷區 #7），保持默認關閉。

## 輪子 diff 對照表（官方 examples/blender_video → modal_app.py）

主輪子逐行同構處：單幀一函數、blend bytes 進/裸檔出、`max_containers=10`、X11 apt 依賴（xorg/libxkbcommon0）、臨時目錄寫幀再回 bytes、`.map()` 分發後合片（官方 starmap→dict 參數改 map，TypeError 實錘）、官方 Cycles device 列印 debugging snippet 原樣。

白名單偏離（全部有據）：

| # | 偏離 | 依據 |
|---|---|---|
| 1 | `bpy==4.5.0/py3.11` → `bpy==5.2.1/py3.13` | PyPI 實證：5.2.1 僅 cp313 wheel（`requires_python ==3.13.*`）；與本機橋同版 |
| 2 | apt + `libegl1/libgl1` | Eevee EGL headless（本機橋片 A 實證路徑；真雲實錘 `[gpu-init] egl`） |
| 3 | `gpu="L40S"` → `T4`（env 可覆蓋） | 研究片 U 成本裁定（幾分錢紀律） |
| 4 | `timeout=120` | spec 指定；T4 實測 20s/幀餘量 6x |
| 5 | Eevee 主輪：`BLENDER_EEVEE`（唯一枚舉）+ `taa_render_samples=1` + `use_raytracing=False` | 片 M/片 F 存活配方（samples=16@1280 全崩、1+RT off 全過）；真雲真幀驗證 |
| 6 | Cycles：CUDA→OPTIX、samples 128→16 | 三方橋同款降級；POC 成本紀律 |
| 7 | `render()` 回 bridge envelope（不回裸 bytes） | bridge `/v1/execute` 契約同構（spec 交付 #1） |
| 8 | 輸入增 `scene_script`（bpy 內 exec） | 橋 script 語義；免外帶 .blend 即 smoke（官方依賴 IceModal.blend） |
| 9 | combine：glob+shell → image2 demuxer + list-form | 片 L 實錘 glob/concat 對 PNG 丟幀；片 M 配方；免 shell 注入 |
| 10 | 新增 web endpoint POST /render-frame（HMAC） | spec 指定；`@modal.web_endpoint` 已死（1.5.5 硬改名 `fastapi_endpoint` + Image 顯式裝 `fastapi[standard]`，ConflictError 實錘） |
| 11 | `add_local_python_source("modal_common")` | 1.5.5 部署邊界：本地 import 不自動上雲 |

三方橋借鑑：`liqi155134/blender_modal_bridge` 的 farm_common 純函數分層（→ modal_common.py）與 web 端點形態；`stoicsuffering/distributed-blender-render-modal` 的「先小幀集試跑再全量」紀律（→ smoke 順序設計）。該橋 Cycles-only（Eevee 直接禁提交）——本 POC 以 EGL 實證推翻其「Eevee 無頭需 GPU context 不可行」前提。

## bridge 契約同構證明（欄位一一對應）

真源：`bridge/blender-bridge/server.py` L14-19（additive-only）。

| bridge `/v1/execute` 200 | worker/modal_app 回應 | 狀態 |
|---|---|---|
| `ok: bool` | 同 | 逐字同構 |
| `artifacts: [{path, bytes, kind}]` | 同 + additive `b64` 欄（雲端傳輸必需） | additive |
| `scene_summary: string` | 同（frame/engine/gpu_ctx/res） | 逐字同構 |
| `stdout_tail: string(≤2000)` | 同（`modal_common.tail` 同語義） | 逐字同構 |
| `duration_ms: number` | 同 | 逐字同構 |
| `queued: bool` | 恆 `false`（Modal 平台調度，無應用層佇列） | 語義等價 |
| `queue_position: int` | 恆 `0` | 語義等價 |
| 429 `{ok:false,error:"queue_full"}` | 不存在（平台彈性併發） | N/A |
| 500 `{ok:false,error,stdout_tail,queued,queue_position}` | 同形（error+stdout_tail+queued/position 恆在） | 同構 |
| `kind` 枚舉 `blend|png|mp4|glb|other` | `modal_common.kind_from_path` 同枚舉 | 逐字同構 |

web 鏈路實測回應（真雲）：`{"ok": true, "artifacts": [{"path": "out/frame_0001.png", "bytes": 812270, "kind": "png", "b64": "iVBOR…"}], "scene_summary": …, "stdout_tail": …, "duration_ms": …, "queued": false, "queue_position": 0}`。

worker 併發/重試語義同構：每幀重試 ≤2（2s cooldown，片 M）、retriable 分類同名、`ffmpeg_unavailable` 結構化報錯、artifacts path 相對 `out/`（片 M 口徑）。

## 待辦（下一格）

- ~~容器暖復用（`@app.cls`）~~ **片 AD 已交付**（實測暖幀 0.4-1.8s）。
- ~~blend_bytes 路徑實彈~~ **片 AD 已交付**（rain_chase_final.blend 真幀，方差 7038，mp4 首末差分 7.79%）。
- 接 `src/lib/blender-tools.ts`：worker 回應已同構，工具層換 endpoint 即吃。
- 持久部署：`modal deploy --detached`（現為普通 deploy，CLI 進程結束即收）。
