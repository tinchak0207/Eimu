# R7 — 野獸模式提示詞系統全面探測與根治（注入管線審計）

日期：2026-09-10。暴君裁定「底層有問題，到處都有問題」，本片為注入管線的系統性深挖，不是打補丁。
執行範圍：VPS `/opt/agent-harness/gateway/`（index.ts / subagent.ts / expert/）＋本地契約 `src/lib/orchestrator-beast-frame.ts`＋真源 `deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md`。

## 0. 起點根因鏈（前情，已實錘）

beast ON 發大電影 prompt，模型思維鏈：「Orchestrator manual says use subagents... But that's gated on BEAST_MODE=ON. There's no explicit indication BEAST_MODE=ON」→ 走保守路徑不派研究軍團。

## 1. 探測結論（逐項證據）

### 1.1 注入管線全貌

| 注入點 | 位置 | R7 前行為 | 判定 |
|---|---|---|---|
| 主 prompt（playbook+digest） | `index.ts` beast 段（L4183-4208） | `readFileSync` 原文注入，`[playbook.trimEnd(), digest.trimEnd(), "---", system]` 拼接 | **無註釋剝離、無狀態聲明** |
| 子會話任務書（憲法） | `subagent.ts` dispatchAttempt（L280-288） | `readFileSync` 原文前綴＋`---` | **同樣無剝離無狀態聲明** |
| digest 生成器 | 本地 `buildExpertRegistryDigest()` | 頭行僅「Expert 注册表（能力断路真源…）」 | 生成器本身**無**元數據頭 |
| digest 落地檔 | VPS `expert/registry-digest.txt` | 頭部第二行「生成日期 2026-09-10（由…生成…）」 | **上傳時手加的元數據污染**（生成器從不寫這行） |

DB 實錘（修復前）：`opencode.db` msg_087b3a3f（10507 字 system）**開頭即 HTML 註釋**：`version: 1.5 / source / injection / gate: 僅在 BEAST_MODE=ON 時由 VPS gateway 注入；BEAST_MODE=OFF 本檔完全不生效`。開發者元數據對模型是毒：模型看到 gate 聲明但 prompt 裡無處聲明「當前就是 ON」→ 合理懷疑 gate 未滿足 → 保守直調。

### 1.2 opencode 顯示層副作用（記錄，不修）

R1 實錘「上游只回传了参数摘要，可能不完整」＝前端把 dispatch 的 prompt 截斷顯示給用戶（暴君看到的「画面描述」卡）。UI 層問題，運行時語義正確，本片不改。

### 1.3 多系統 prompt 源衝突（四源逐條）

| 源 | 注入位置 | 內容性質 | 衝突點 |
|---|---|---|---|
| workspace AGENTS.md（22874 字） | opencode 原生 instructions | 路由表（生影片→`workflow_*` 直調）、§3.8.6 Orchestrator 律令（必派 subagent、**並發上限 3**）、誠實三鐵律、扣費規則 | 路由表教「video 直調 workflow_*」，playbook 教「一切派遣」——模型無裁決依據 |
| playbook v1.6（派遣手冊） | system 頭部（beast ON） | 軍團範式、三軍 spec 模板、**常態 ≥3 並發** | 與 AGENTS.md 無職能邊界聲明；R7 前其 HTML 頭還攜帶 gate 毒點 |
| 憲法（Expert 六條） | 子會話任務書頭部（beast ON dispatch） | 誠實鐵律/工具域斷路/配方優先/記憶紀律/停止上報/自檢門禁 | 與 AGENTS.md 誠實條款同源一致，無實衝突 |
| registry-digest | system 頭部（playbook 之後） | 七行 Expert 路由表 | 靜態稿漂移（見 1.5）；「能力断路真源」聲明與物理現狀不符（見 1.4） |

R7 前模型的實際裁決規則＝「看 digest 未啟用就直調」——靜態稿說了算，是錯的。R7 後：playbook 頭部新增「職能邊界」裁決段（見 §2.4）。

### 1.4 誠實鐵律衝突點

- 「註冊無上游真名可映射（硬映射=造假名）」的行為來源＝憲法第一條（不宣稱未驗證的成功；橘貓事故/假殼事故逐字在案）＋第五條（停止與上報）。這是**正確泛化**。
- 過度泛化檢查：本次實彈思維鏈顯示模型主動查輪子（mv2026 既有研究素材「可復用…指定為 wheel-source」）、派 wave 1、對缺記憶庫如實聲明「此節豁免」——**沒有**泛化成「拒絕一切不確定」。不確定處理遵循「標未實證降級使用」。
- 真正的不實聲明在注入幀自己：digest 頭行「域外工具不存在于该 Expert 的工具表」——gateway 現階段無 per-subagent 工具白名單掛點（index.ts 註釋自認「物理斷路留樁，先靠 prompt 約束」）。屬契約宣言而非事實描述，已列入【工具語義】工單不動正文（改了會動 expert-registry 契約，禁碰清單）。

### 1.5 提示詞系統結構問題清單（五類歸檔）

| 類別 | 問題 | 根治狀態 |
|---|---|---|
| 【注入管線】 | 兩個注入點 readFileSync 原文注入，無剝離、無當前狀態聲明 | **R7 已修**（index.ts＋subagent.ts 同款 strip＋狀態行） |
| 【元數據污染】 | 檔頭 HTML 註釋（version/source/gate）原樣進上下文；digest 日期行手加污染 | **R7 已修**（注入前剝離＋digest 頭收進註釋）；治本＝元數據只存檔頭註釋，注入端永不透傳 |
| 【源衝突】 | AGENTS.md 路由表 vs playbook 派遣制無裁決；並發語義兩源各說（上限 3 vs ≥3 常態，實為相容但無聲明） | **R7 已修**（playbook 職能邊界裁決段：執行細節聽 AGENTS.md 配方，指揮權聽本手冊） |
| 【工具語義】 | ① subagent_dispatch 同步阻塞鎖死軍團範式（R4 實錘）② digest「物理斷路」聲明無白名單掛點撐腰 ③ 前端 dispatch prompt 截斷顯示 | ① R6 已修（async=true＋終態喚醒，本次實彈實證 async wave 1 並發 3）② 工單（per-subagent 工具表掛點，動 expert-registry 禁碰範圍）③ UI 層記錄不修 |
| 【靜態稿漂移】 | digest 靜態檔與 EXPERT_REGISTRY 漂移（R4 實錘「video-director 未启用→直調」誤導） | 本片重生成七行全激活（R4 已做）；**治本工單（R5 候選）：gateway 每次注入前從 registry 現算 digest，廢靜態檔** |

## 2. 修復清單（全部落地＋驗證）

1. **index.ts beast 段**：新增 `stripProvenanceHeader`（剝檔頭 HTML 註釋，剝後空檔同樣 503 拒裸奔）＋主 prompt 幀首插入狀態聲明：「【野獸模式：已啟用】…BEAST_MODE 現在就是 ON，以下全部條款立即生效，無需質疑、無需再確認任何 gate 條件。」
2. **subagent.ts 憲法注入段**：同款 strip＋子會話狀態聲明行。
3. **registry-digest.txt**：「生成日期…」元數據行收進 HTML 註釋頭（磁盤保留溯源，注入端剝離）。
4. **playbook v1.6 + R7 裁決段**（雙端 md5 `131b0ace7fffeffb7eec797f1aa11b07`）：「職能邊界（與 AGENTS.md 的分工裁決）…執行細節聽 AGENTS.md 配方，指揮權聽本手冊。」
5. **本地契約同步**：`orchestrator-beast-frame.ts` 導出 `stripProvenanceHeader`/`BEAST_MODE_STATE_LINE`，`buildOrchestratorFrame` 同構（狀態行→剝離後 playbook→digest→---→原文）；測試 8/8 綠（含 gate 元數據絕跡斷言）。

## 3. 實彈驗證取證（2026-09-10 04:03-04:05 CST）

- 部署：bun build 門禁 EXIT=0 → `systemctl restart agent-gateway opencode-server` → 雙 active＋SSE connected。
- 流程：beast_mode=true（settings API）→ 新會話發「秦始皇骑北极熊穿越赛博东京的大电影（2026日本動漫風格片頭曲MV规格）」→ 取證 → abort → DELETE（part 級聯清零）→ beast_mode=false 復原。
- **system 六項檢查**（10677 字，v1.5 時代為 10507）：
  `HTML-comment:0 gate-clause:0 date-meta:0 state-line:1 arbitration:1 version-meta:0`＋digest 頭在位。幀首逐字＝狀態聲明行。
- **模型思維鏈第一段**：「This is exactly the kind of OP beast-mode scenario — the standard operational paradigm in the orchestrator manual is literally written for… I'm the orchestrator: I write the spec and assemble the expert army via subagent_dispatch (async, concurrent, cap 3). I don't generate content myself.」→「no explicit indication BEAST_MODE=ON」**絕跡**；行為鏈：查輪子（mv2026 素材指定 wheel-source）→ 建項目目錄 → wave 1 async 並發派遣。

## 4. 併發事件記錄

R6（agent_c7d8e8ed，subagent async 手術）於本片探測與修復之間（03:56 CST）完成部署（playbook v1.6 雙端同 md5、subagent async、index.ts wakeParent×3、服務重啟）。本片備份 .bak-r7-0910 已**重拍**捕獲 R6 後基線（md5：index `1a37b4c6` / subagent `2410ee27`），R7 補丁錨點在 R6 後代碼上驗證唯一命中。

## 5. 回滾方法

- `sudo cp /opt/agent-harness/gateway/{index,subagent}.ts.bak-r7-0910 <原檔>`＋`registry-digest.txt.bak-r7-0910` → bun build → restart。
- playbook 回滾＝刪除「**職能邊界（與 AGENTS.md 的分工裁決，R7）**」整段（錨點唯一）。
- 本地：`git checkout src/lib/orchestrator-beast-frame.ts src/lib/orchestrator-beast-frame.test.ts deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md`。

## 6. 遺留工單（未動，等裁決）

1. digest 改為 gateway 注入時從 registry 現算（治靜態稿漂移本）。
2. per-subagent 工具白名單掛點（讓 digest「能力断路」聲明從 prompt 約束升級為物理事實）。
3. 前端 dispatch prompt 截斷顯示（UI 層）。
