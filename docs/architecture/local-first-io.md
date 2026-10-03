# 本地優先 I/O 與重算本地化（W1–W6）

> 2026-10-04 文件化。**本檔只描述、不改碼**——裁定來源＝`mem show 2026-10-04-desktop-localization-assessment.md`：
> 「T1（網頁層 File System Access＋WebCodecs）→ T2（桌面殼本機媒體工人），T3（agent 搬本機）押後」。
> 本輪落地＝W1 本機影片前處理、W3 桌面殼本地能力契約、W4 重算卸載 adapter、W5 計費/額度/冪等、W6 device bridge。
> 薄殼欽定（`mem show electron-desktop-packaging-assessment-0916.md`「方案①、不想雙端維護」，`desktop/main.js:3` 自述「明確不做本地起 Next server」）
> **未被推翻**——本地能力是漸進增強，不是第二條分支。

## 0. 一句話切線

**推理、付費生成、計費帳本、畫布 world1 狀態留在雲端；素材入庫、產物落地、本機重算下放到使用者機器。**
本機能力偵測一律走「端點/API 是否存在」，不是 UA 字串（`src/lib/local-save.ts:3-7`）；任一能力缺席即回落今天的雲端路徑，站點與薄殼行為不變。

## 1. 能力清單

| 能力 | 入口檔案 | 生效條件 | 缺席時的行為（回落） |
|---|---|---|---|
| 影片本機前處理（抽關鍵幀＋poster＋probe，只上行衍生小檔） | `src/lib/local-media-ingest.ts:440`（`ingestMediaLocally`，契約「永不拋出」見檔頭 :10）；呼叫端 `src/components/agent-chat/AgentComposer.tsx:564` | 瀏覽器可解碼該影片且衍生檔 ≤ `MAX_DERIVED_UPLOAD_BYTES` 4MB（:43） | 逐級回落：衍生檔上傳失敗→原片直傳（`AgentComposer.tsx:595` uploadVideoDirect）→再失敗→舊抽幀路徑（:606） |
| 直傳物件存儲（本站不經手位元組） | `src/lib/direct-upload-client.ts:243`（`uploadDirect`）；消費端 `src/components/canvas/embed/use-canvas-interaction.ts:531` | `/api/uploads/sign` 回可直傳的 `uploadUrl`；`file.size ≤ 回應 maxBytes`（:9-13） | 後端不支援帶 headers 的 PUT 時拋 `UNSUPPORTED_BACKEND_CODE`（:33），呼叫端自走舊路徑 |
| 產物直寫本機目錄（File System Access API） | `src/lib/local-save.ts:78` `saveBlobLocally`／:116 `saveManyLocally`；消費端 `src/lib/image-helpers.ts:138`、`src/lib/export-zip.ts:66`、`src/lib/history-export.ts:11` | 端點 `showSaveFilePicker`/`showDirectoryPicker` 存在（:70 `hasLocalFileSave`） | 回 `"unsupported"`（:11），呼叫端回落 blob＋`<a download>`；桌面殼的 `will-download` 攔截仍是那條落地面（`desktop/main.js:257`） |
| 本機重算卸載 adapter（probe/抽幀/轉碼走桌面殼 ffmpeg） | `src/lib/local-media-worker.ts:143` `hasLocalMediaWorker`／:157／:171／:188 | 頁面存在 `window.eimuLocal` 且 `capabilities().ffmpeg === true`（:14-19） | 一律回 `{ok:false, reason}`，**不 throw**（檔頭 :10-12）；純瀏覽器＝`no_local_worker` |
| 桌面殼本地能力通道（原生挑檔／ffprobe／ffmpeg） | `desktop/preload.js`（暴露 `window.eimuLocal`）→ `desktop/local-worker.js`（主進程授權閘） | `main.js:224` 注入 preload；僅 `eimu.dev` 頂層 frame；逐次 pickFiles 授權 | 非授權來源/路徑回 `E_*` 錯誤（契約見 `desktop/LOCAL-CAPABILITIES.md:32`） |
| Device bridge（雲端 agent 經本機出站連線讀已授權檔） | 雲端 `deploy-staging/gateway/device-bridge.ts`；本機 `desktop/device-bridge-client.js` | `EIMU_DEVICE_BRIDGE=1` 且能取得憑證（見 §3、§6） | 閘道 `router.ts:375` 前綴閘不進；本機停 `off`，一位元組不出網（`desktop/device-bridge-client.js:16-17`） |

## 2. 兩份契約（指引，不複製）

- 桌面殼本地能力（`window.eimuLocal` 介面、錯誤碼、denylist、驗證邊界）：`desktop/LOCAL-CAPABILITIES.md`（W3）。
- Device bridge 本機側（出站協議、工具白名單、預設 OFF、憑證缺口）：`desktop/DEVICE-BRIDGE.md`（W6b）；雲端半邊檔頭契約＝`deploy-staging/gateway/device-bridge.ts:1-38`。
  兩份是**各自唯一真源**，本檔只指向，不抄全文。

## 3. 開關清單

| 開關 | 預設 | 開啟方式 | 開啟後影響面 |
|---|---|---|---|
| `EIMU_DEVICE_BRIDGE` | **OFF**（非 truthy 即關，`device-bridge.ts:59-62`） | `=1`（VPS systemd gateway env；殼側 `main.js:313` 需嚴格 `"1"`） | 掛載 `/agent/v1/device-bridge/{register,heartbeat,poll,result}`（`router.ts:375`）＋殼啟動出站客戶端；**即使開啟**，殼的 `credentialProvider` 恆回 null（`main.js:314`）⇒ 只會得到 `credentials_unavailable`，橋實際不啟動 |
| `EIMU_DEVICE_BRIDGE_HEARTBEAT_TTL_MS` | 90000 | env 覆寫（`device-bridge.ts:65`） | 心跳逾時即視裝置離線，invoke 回 `device_offline` |
| `EIMU_DEVICE_BRIDGE_REQUEST_TIMEOUT_MS` | 30000 | env 覆寫（:67） | 單次呼叫等待上限，逾時回 `device_request_timeout` |
| `EIMU_DEVICE_BRIDGE_CONSENT_TTL_MS` | 45000 | env 覆寫（:69；需 ≥ 請求逾時） | 同意票有效期（逐次、單用、綁 deviceId+tool+requestId） |
| `EIMU_GATEWAY_BASE_URL` | 未設 | env 覆寫（`main.js:312`） | 殼連閘道的 base URL；未設時 bridge 連線失敗但**不影響殼啟動**（:319-321） |
| `SURGERY_QUOTA_PRECHECK` | 既有開關 | 既有機制（`quota-precheck.ts:310`） | **`budgetCapCoins` 硬停刻意排在此開關之前**（:289-290）：宣告上限不因影子期關掉而失效 |

## 4. 計費面規則（本輪重點）

1. **客戶端只算「預估」**：`src/lib/task-budget.ts:13` `estimateCoins` 由 catalog credits÷10 推導（:7），與 `/v1/quota` 同源。結算權威仍在伺服器：`account_ledger`（`src/lib/mapay-credit.ts:14`「我方帳本 account_ledger 記一筆 recharge（餘額權威）」）；`users.quota` 是內核執法點（`quota-precheck.ts:317-320`）。
2. **額度顯示三態**：`src/lib/quota-display.ts:52` `describeQuota` 收斂 authoritative／estimated／unavailable；`unavailable` **一律回「暂不可用」且 tone=unknown，永不顯示 0**（:32、檔頭 :9-12，與伺服器端 `src/app/api/v1/quota/decision.ts:56-57` 503 `quota_unavailable` 同一誠實線）。
3. **預算硬停**：呼叫端在請求體宣告 `cap_coins` → route 透傳 `budgetCapCoins`（`images/generations/route.ts:341-347`、`videos/generations/route.ts:323-329`）；超限回 **402 `task_budget_exceeded`**（`quota-precheck.ts:81-83`、guard :295-307），附 `estimated_coins`/`cap_coins`。未宣告＝零回歸（:288-290）。
4. **新增生成入口不得繞過 `enforceQuotaGate`**：現況只有 4 條對外生成路由接閘（`quota-gate-coverage.test.ts:34-39`），另有 6 條 legacy（見 §6）。守門測試 `quota-gate-coverage.test.ts` 會在「新入口沒接閘又不在白名單」時紅燈，但它**只是變更探針**（自述 :10-21）。
5. **冪等**：生成型請求帶並沿用**同一個 `X-Request-Id`**（`generation-request-headers.ts:23`、:39；MCP 冪等鍵 `mcpGenerationIdempotencyKey` :58）。直傳 PUT 重試沿用同一 `objectKey` 以保證伺服器端 `alreadyCommitted` 冪等（`direct-upload-client.ts:11-13`）。任何 log 不得含 `authorization` 值（`generation-request-headers.ts:13`）。

## 5. 驗證 oracle（「通過」長什麼樣）

- **真上傳位元組**：`/api/uploads/commit` 由**伺服器親自驗 sha256**（`direct-upload-client.ts:6`）——以真實檔案位元組跑通 sign→PUT→commit 才算。
- **真檔案 hash／真檔案落地**：本機產物以實際檔案（非 base64／記憶體）比對大小與內容（`local-save.ts:78` 回 `"saved"` 需真寫入成功）。
- **真帳本行**：402 `insufficient_balance`／`task_budget_exceeded` 必須能在 `account_ledger` 對應「本次未扣費」；權威是帳本行，不是前端數字。
- **真 VPS 計數／真上游回應**：device bridge 的離線/逾時/同意票重放錯誤碼須由真閘道＋真裝置產生；本輪**未跑**。
- **哪些不算 oracle（變更探針）**：`quota-gate-coverage.test.ts` 的 source-scan（自述 :10-21）、任何原始碼字串斷言、檔案存在、`node --check` 語法檢、HTTP 200。守門件不是 oracle（AGENTS.md 驗證鐵律）。

## 6. 已知缺口與未驗證項（照實）

1. **device bridge 缺憑證來源**：殼只載遠端頁面、只有 session，無 biz key；`credentialProvider` 恆回 null（`desktop/main.js:306-314`）⇒ 即使 `EIMU_DEVICE_BRIDGE=1`，橋得到 `credentials_unavailable` 不啟動。補法（短效 device token 經窄 IPC 注入）**尚未實作**（`desktop/DEVICE-BRIDGE.md:32-39`）。**未驗證**。
2. **`cap_coins` 前端未接**：全站 UI 無任何元件送 `cap_coins`（grep 命中僅 images/videos route 與測試）；「使用者如何在 UI 設預算」未定。後端有能力，**前端未接、未驗證**。
3. **6 條 legacy 生成入口不經 precheck（既有狀況，非本輪引入）**：`batches`／`generation-jobs`／`upscale`／`storyboard-voiceover`／`sku/run-service`／`generation-core/canary-service`（明文白名單＋各自收費依據見 `quota-gate-coverage.test.ts:45-52`）。它們走 legacy reserve/sync-charge（有實際扣費），但確實不經 `enforceQuotaGate`。
4. **`db/migrations/036_generation_attempt_source.sql.pending` 刻意未套用**：`tools/migrate-generation-db.ts:9` 只收 `.sql` 結尾檔，故以 `.pending` 副檔名擋住（檔頭自述）。**未對任何真實 DB 執行**。
5. **桌面殼 GUI E2E 尚未跑**（無顯示環境）：挑檔對話框、真 ffmpeg 抽幀/轉碼、origin 拒絕、IPC 串接、device bridge 真連線均未驗（`desktop/LOCAL-CAPABILITIES.md:43`、`desktop/DEVICE-BRIDGE.md:69-74`）。
6. **W4 本機重算 adapter 無生產消費者**：`local-media-worker.ts` 僅有自身與 `local-media-worker.test.ts`，無 route/元件 import（grep 實查）。lib＋單元測試已交付，**尚未接線**。已確認無適用接點：前端發起的媒體重算僅 `AgentComposer.tsx`／`local-media-ingest.ts` 兩處（已由 W1 覆蓋，見 §1），canvas 路徑吃遠端 https，本機 worker 契約不適用。
7. **額度三態顯示已接 UI（原缺口解除）**：`src/components/WalletBadge.tsx:8` import `describeQuota`、`:106` 呼叫消費（`quotaState ?? derivedQuotaState`），不再是「僅 lib＋測試」。三態呈現（`WalletBadge.tsx:82-112`）：① 有有限讀數 ⇒ `authoritative`，直接顯示帳本權威值（含真實的 0）；② 讀不到但有上次成功讀數 ⇒ `estimated`，顯示「约 N」並以 `stale` 標已過期、tone 依時效 `ok`/`warn`；③ 完全讀不到 ⇒ `unavailable`，顯示「暂不可用」、tone=`unknown`，**永不畫假 0**。`quotaToneClass`（:107-112）對應 tone 上色。純顯示層收斂，未改任何取餘額 API／資料層；真帳本 E2E 仍未跑。

## 7. 不做什麼

- **不搬 agent loop**：推理與工具編排在 VPS opencode-server；T3（agent 打包進 App）押後（assessment 建議）。
- **不下發上游付費 key**：付費生成仍回雲端（AGENTS.md「付費上游呼叫硬閘」）。
- **不放寬 Electron 安全邊界**：`nodeIntegration:false`、`contextIsolation:true`、`webSecurity:true` 均未放寬（`desktop/main.js:216-219`）；preload 無 `exec`/`spawn`/`shell`/`fs`（`desktop/preload.js:8-11`）。
- **不新增寫入/刪除/執行類本機能力**：device bridge 工具面只有 `list_dir`/`read_file`/`grep`/`stat`（`device-bridge-policy.ts:14`）。

## 8. 複核用命令

```bash
# 能力入口與開關
grep -n "ingestMediaLocally" src/components/agent-chat/AgentComposer.tsx          # W1 呼叫點
grep -n "EIMU_DEVICE_BRIDGE" desktop/main.js deploy-staging/gateway/device-bridge.ts deploy-staging/gateway/router.ts
grep -n "enforceQuotaGate\|budgetCapCoins" src/lib/generation-core/quota-precheck.ts

# 計費三態與預算閘
grep -n "QUOTA_UNAVAILABLE_LABEL\|describeQuota" src/lib/quota-display.ts
grep -n "exceedsBudget" src/lib/task-budget.ts

# 繞過預檢清單（變更探針，非 oracle）
grep -n "RESERVE_PATH_ALLOWLIST\|GATED_FILES" src/lib/generation-core/quota-gate-coverage.test.ts

# 桌面殼 E2E（無顯示環境時不跑）
npx --yes tsx --test desktop/lib/*.test.js
```
