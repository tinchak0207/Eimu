# Device Bridge（本機側客戶端，W6b）

讓雲端 agent 透過使用者機器的**出站連線**讀取「已授權」的本機檔案。方向永遠是本機
主動註冊／心跳／長輪詢，雲端永不 inbound 打使用者機器。

## 檔案
- `device-bridge-client.js`（主進程）：**只做連線與編排**（register/heartbeat/poll/result）。
- `lib/bridge-executor.js`（可測執行器）：四個唯讀工具的實際檔案存取與安全閘（注入 fs）。
- `lib/bridge-executor.test.js`：`node:test`，真正執行危險路徑（空 allowlist、家目錄外敏感、
  遞迴剪枝、單檔大小上限、`path="/"`）。跑 `npx --yes tsx --test desktop/lib/bridge-executor.test.js`。
- `lib/bridge-protocol.js`（純函式）：工具白名單、參數淨化、`max_file_bytes` 夾制、256KB 夾制＋截斷標記、退避。
- **denylist 唯一真源**＝雲端 `deploy-staging/gateway/device-bridge-policy.vectors.json`；本機不再自帶
  `lib/denylist-vectors.json`（已刪）。`policy.test.js` 以 `fs.readFileSync` 直接載入雲端那份的
  `sensitive` 段落逐條斷言；本機刻意更嚴的加固項顯式列在測試內。
- `lib/policy.test.js` / `lib/bridge-protocol.test.js`：純函式層測試。


## 端點（逐欄對齊 `deploy-staging/gateway/device-bridge.ts`）
`POST /agent/v1/device-bridge/{register,heartbeat,poll,result}`，鑑權＝既有 Bearer `sk-biz-*`。
`/invoke` 是雲端 agent 發起，本客戶端不呼叫。

## 預設 OFF
`main.js` 以 `enabled: process.env.EIMU_DEVICE_BRIDGE === "1"` 啟動；未設＝停在 `off`，
一個位元組不出網。開啟且 `online`/`reconnecting` 時，視窗標題顯示
「Eimu · 本機檔案橋接已開啟」（`page-title-updated` 期間維持，避免被遠端 `<title>` 蓋掉）。

**開啟後仍會被授權根閘擋下**：allowlist 必填（見下）。目前殼內尚無「為 bridge 挑選根目錄」
的 UI，且 bridge 與 W3 共用同一份 `authorizedRoots`（由 `window.eimuLocal.pickFiles` 登記）。
故在尚未 pickFiles 前開啟 bridge，狀態會停在 `no_authorized_roots` 並**拒絕服務**——
這是刻意、正確的結果（寧可不可用，也不退回「只驗 denylist」的危險語義）。

## 憑證缺口（未解，如實記錄）
閘道鑑權沿用既有 `sk-biz-*`（`auth-gw.ts`）。桌面殼載入遠端頁面、**只有 session，沒有 biz key**；
本模組**不**自造鑑權、**不**在殼內硬編任何 key。憑證由 `credentialProvider()` 注入；回
`null`/空字串時 bridge **不啟動**，狀態回報 `credentials_unavailable`。`main.js` 目前恆回 `null`。

**建議補法（尚未實作，勿當已存在）**：由「已登入的網頁」向服務端換一張**短效、限 device-bridge
scope 的 device token**（TTL 分鐘級、可撤銷），經窄 IPC 交給主進程當 Bearer 用；或維持由使用者
手動提供一次性憑證。任何方案都必須是短效、可撤回、不入 log／memory／commit。

## 安全模型
1. 工具白名單＝`list_dir`/`read_file`/`grep`/`stat`，**無任何寫入／刪除／執行命令**。
2. 路徑先 `realpath` 解 symlink，再過 `lib/policy.js` 的 `isSensitivePath`（denylist 單一真源，
   不另造第二份）：**掃描所有路徑段**（不限 `$HOME`）、一律轉小寫、fail-closed；涵蓋
   `.ssh`/`.aws`/`.gnupg`/`.kube`/`.docker`、憑證檔、瀏覽器 profile（Linux 與 macOS）。
3. **allowlist 必填**：授權根讀 `local-worker.js` 的**同一份** `authorizedRoots`
   （使用者以 `pickFiles` 顯式挑選的根），不另造第二套授權機制。授權根空集 ⇒ **整條 bridge
   拒絕服務**（狀態 `no_authorized_roots`）、執行器亦一律拒（`no_authorized_roots`）；
   **不得**退回「只驗 denylist」。
4. **檔案系統根**（`/`、`C:\`）一律拒（`path_is_root`），避免整盤掃描。
5. `grep` **逐檔先 `stat` 再決定讀取**；單檔上限＝`min(雲端下發 max_file_bytes, MAX_GREP_FILE_BYTES)`
   （`MAX_GREP_FILE_BYTES`＝1MB＝雲端契約上限，本機只能更嚴不得更鬆），超過者跳過並以
   `skipped_large_files` 計數（不整檔入記憶體）。不跟 symlink、有深度/檔數/行數/每行長上限。
   另回報 `sensitive_path_touched`／`excluded_sensitive_count`（H2 契約：遞迴/列舉碰到敏感段即計數，
   雲端 `sensitiveResultProblem` 據此整筆拒絕）。
6. 回傳前 `clampResult` 夾 256KB（與雲端 `MAX_READ_BYTES` 同值）＋ `…[truncated N bytes]` 標記，UTF-8 邊界安全。
7. `consent_token` 執行前驗形狀/有效期；**成功與錯誤回報都帶票**（閘道 result 一律先 `consume`，
   缺票必得 `consent_token_not_found` 並吃滿逾時）。
8. 逾時與連線失敗以指數退避重連（`nextBackoff`，封頂 30s）。
9. log 只寫狀態與錯誤碼，**永不**寫憑證或檔案內容。

## 已知差異（來源備註）
`policy.js` 的 denylist 與雲端 `device-bridge-policy.ts` **同一語義**（掃所有路徑段、一律小寫、
fail-closed）。兩者跨 runtime（Electron CJS ↔ bun TS）無法共用模組，故以**雲端向量表**
`deploy-staging/gateway/device-bridge-policy.vectors.json` 為唯一真源（本機測試直接載入它，
不再自帶第二份 JSON）。本機是保守超集（額外 `.mozilla` 段、`.config/{gcloud,gh,git,code,electron}`
序列、`.python_history`），只多擋不鬆綁——這些加固項顯式列在 `policy.test.js`，不進真源檔。

## 未驗證
真裝置／真閘道／真 agent 呼叫未跑（無顯示環境，且無 biz key 無法連閘道）。純函式層由
`policy.test.js` / `bridge-protocol.test.js` 覆蓋；**執行器（真正讀檔的危險路徑）由
`bridge-executor.test.js` 覆蓋**（空 allowlist、家目錄外敏感、遞迴剪枝、單檔上限、`path="/"`）。
連線迴圈（register/heartbeat/poll/result）與 `main.js` 的 protocol 閘僅經 `node --check` 語法檢與
`tsc`；未做真閘道 E2E。
