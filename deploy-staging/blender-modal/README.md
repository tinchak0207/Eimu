# blender-modal POC — Modal 雲端 Blender 渲染節點（片 X 交付）

研究片 U 結論（Modal 免費節點 9/10 勝出）的可執行轉化。**真雲 smoke 已全綠收官（2026-09-06），Eevee EGL on serverless 已實證可用**——研究唯一未證項轉已證。

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

## 實測數據（2026-09-06 真雲，T4，turntable Suzanne 1280x720）

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
5. **每幀冷啟成本**：單幀=新容器是安全換來的代價；量產前先做容器暖復用（`@app.cls`）省著色器編譯重複支付。

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

- 容器暖復用（`@app.cls`）壓每幀冷啟 20s → 預期 2-5s/幀。
- blend_bytes 路徑實彈（本 smoke 走 scene_script；blend 路徑代碼與官方輪同構未單獨實彈）。
- 接 `src/lib/blender-tools.ts`：worker 回應已同構，工具層換 endpoint 即吃。
- 持久部署：`modal deploy --detached`（現為普通 deploy，CLI 進程結束即收）。
