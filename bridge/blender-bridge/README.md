# blender-bridge（headless Blender 沙箱執行器）

Image Studio 3D 導演工作站 P0-2。輪子：[ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp)（27k★）addon 逐行複製改白名單（見 `blender_addon.py` 內 `[image-studio bridge whitelist …]` 標註），socket 服務/線程模型/JSON 協議一行未動。

## 檔案

- `blender_addon.py` — blender-mcp addon 整份複製（基準 4164 行），白名單外唯一偏離：`start()` 的 `bpy.app.background` 擋刀註釋化（實測 Blender 5.2.1 `-b` 模式 `bpy.app.timers` 零觸發，改由 bootstrap 主線程直接幫浦 `_drain_command_queue`，語義等價）
- `launcher.py` — 起 `blender --background --factory-startup`（優先 `unshare -rn` 網路隔離），等 socket 握手，可單獨跑：`python3 bridge/blender-bridge/launcher.py`
- `server.py` — stdlib ThreadingHTTPServer，127.0.0.1:8765，HTTP 契約見下

## 一行起全棧

```bash
python3 /home/lenovo/Desktop/image-app/bridge/blender-bridge/server.py
```

（server 內建 supervisor：首個請求自動拉起 Blender；也可先手動 `python3 …/launcher.py` 預熱）

環境變數：

| 變數 | 默認 | 說明 |
|---|---|---|
| `BLENDER_BIN` | 抓 `/home/lenovo/Applications/blender-5.2*-linux-x64/blender` | blender 執行檔 |
| `BLENDER_WORK` | repo 根 `.blender-work/`（已入 `.gitignore`） | job 工作目錄 / `out/` 產物根 / `blender.log`（引擎日誌，launch 時輪轉留一代 `.1`）與 `job-output.log`（Python 層輸出）所在 |
| `BLENDER_BRIDGE_CONCURRENCY` | `1` | 執行槽數（同時跑幾個腳本；>1 時多 job 會打進同一 blender 進程，addon 幫浦單線程天然串行，健康檢查/GPU 探針會與執行互搶，建議保持 1） |
| `BLENDER_BRIDGE_QUEUE_DEPTH` | `16` | 排隊深度上限，滿了立即 429 `queue_full` |

## 健康檢查

```bash
curl -s http://127.0.0.1:8765/v1/health
# → {"ok": true, "blender_version": "5.2.1", "gpu": "egl"|"cpu", "workdir": "…/.blender-work",
#    "queue_depth": 0, "concurrency": 1}
```

`gpu` 判法：在 Blender 內 `import gpu` + 建 16x16 GPUOffScreen 成功 = `egl`（RTX 5070 EGL headless），失敗 = `cpu`。`queue_depth` = 正在排隊的 job 數（執行中不計）；`concurrency` = 執行槽數（env）。

## 執行腳本

```bash
curl -s -X POST http://127.0.0.1:8765/v1/execute \
  -H 'Content-Type: application/json' \
  -d '{"script":"import bpy\nprint(\"hi\")","timeout_ms":120000}'
```

- 腳本 CWD = `$BLENDER_WORK`；產物落 `$BLENDER_WORK/out/`（job 起始時對 out/ 做快照、結束時 diff——新增或 mtime 變化才算本 job 產物，無任何時間戳容差；kind 按副檔名：blend/png/mp4/glb/other）
- `stdout_tail` ≤2000 字：**腳本 print 輸出（走 `execute_code` 的 stdout 捕獲，保證佔有窗口，不會被擠掉）+ 剩餘預算的本 job Python 層輸出增量**（`$BLENDER_WORK/job-output.log`，從 job 起始 offset 讀起；job 無新增輸出時回退 `blender.log` 尾段）
- 日誌分道：`blender.log` 只收 Blender C 層引擎輸出（含 native crash dump），每次 blender (re)launch 輪轉為 `blender.log.1`（只留一代，保留上次崩潰證據）；Python 層輸出（bootstrap 標記、幫浦錯誤、逃出捕獲的 print）走 `$BLENDER_WORK/job-output.log`
- 成功回應新增欄位：`queued`（是否排過隊）+ `queue_position`（入隊瞬間的 1-based 位次；未排隊 = 0）
- timeout 到點 SIGKILL 整個進程組（blender+子進程），回 500；下次請求自動重啟全新 factory-startup 實例

## 執行佇列（P1-1）

語義同構自 generation worker 併發池（`GENERATION_WORKER_CONCURRENCY` 輪子）：

```
POST /v1/execute
  → 佇列深度 < CONCURRENCY + QUEUE_DEPTH ？
      否 → 立即 429 {"ok":false,"error":"queue_full"}（不佔位）
      是 → 入 FIFO 隊尾，等執行槽
  → 拿到槽 → 執行（timeout_ms 只管執行段）→ 200/500
```

- **FIFO 嚴格**：槽釋放時只有隊頭能被晉升（`notify_all` + 頭位斷言，喚醒誰都改變不了順序）
- **超時雙層**：`timeout_ms` 只預算執行段；排隊等待不扣。總等待（排隊+執行）超過 `timeout_ms × 2` 硬殺：還在排隊的 job 直接出隊回 500 `queue hard deadline`（`queued:true`），沒跑過就不會殺 blender；已開跑的照舊 SIGKILL 進程組回 500
- **失敗自愈**：blender 進程死（被殺/崩潰）→ 執行中 job 回 500 `blender connection lost` 並釋放槽，後面的 job 由 `ensure_blender` 自動重啟後照常執行，佇列不阻塞
- **429 即答**：滿隊（running+waiting 達上限）的請求立即 429，不入隊不佔位

### 已知限制（片 A 存量，非佇列引入）

- **~~>5s 的腳本會在 addon 側斷連~~（已根治，片 O 2026-09-06）**：真因不在 addon，是 launcher bootstrap 的 unix→TCP 轉發器 `socket.create_connection(..., timeout=5)`——該 timeout 持久化在 socket 上，execute_code 主線程靜默 >5s 時轉發器 pipe 線程 recv 拋 timeout → `shutdown(SHUT_WR)` → supervisor 收到精確 5.0s EOF。修復＝addon 模組載入時（bootstrap 先 import addon 再起轉發器）對連向 addon 自身 loopback 端口的 create_connection 解除超時（`blender_addon.py` 頂部 `[image-studio bridge patch ⑤]`，純加法 +56 行）。A/B 實錘：原版 8s 腳本 5.01s EOF；修補版 8s/15s/30s 全過（HTTP 實彈 15.62s/30.10s 含 MARK）。主線程幫浦阻塞行為不變（bridge 佇列併發=1 下無影響）
- `BLENDER_BRIDGE_CONCURRENCY > 1` 時多 job 打進同一 blender 進程，addon 幫浦單線程天然串行，不會真並行加速（保留 env 是為語義齊全；健康檢查/GPU 探針會與執行互搶主線程，建議保持 1）

## 隔離模型與已知限制

- `unshare -rn`（user+netns）可用時：Blender 無外網；addon 9876 在 netns 內，經 `$BLENDER_WORK/bridge.sock`（unix socket，mode 600）跨界轉發到 host。本機實測三關全過：`unshare -rn true` OK、netns 內 lo 可 SIOCSIFFLAGS 拉起、unix→TCP 雙向轉發通。
- **殘餘風險（隔離模式下）**：無 filesystem 隔離——腳本仍可寫 host 任何用戶可寫路徑（如 /tmp）；無 GPU 隔離。低信任腳本勿直接入此通道。
- `unshare` 不可用的機器上自動裸起（無網路隔離），health 的 workdir 不變，報告需另標。
- `--factory-startup`：每次啟動乾淨偏好/插件；腳本間不共享狀態（進程被 timeout 殺掉後更是全新實例）。
- blender-mcp 的資產站命令（Poly Haven/Sketchfab/Hyper3D 等）保留原樣，隔離模式下會因無網失敗——屬預期行為。
