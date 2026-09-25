# AID 對稱差吞併：只做一半的完整審計（2026-09-16）

> 定性：**修復**（審計已交付卻未閉環的刀）——保守紀律適用
> 觸發：暴君指出「我們之前 AID 併入對稱差時只做了一半，你發現的前端缺失只是冰山一角」
> 方法：不找新缺口，而是拿 PRD 自己寫的「全鏈生效定義」逐環對賬

---

## 0. 核心發現：這是一個系統性模式，不是個別疏漏

**每一刀都停在「型別 + 清洗 + 單元測試」三件事，消費端一律缺席。**

統一判據：`grep -rln "<資產>" src/components/ src/app/ --include=*.tsx` → 渲染層消費數。

| 刀 | 資產 | 後端寫入 | 清洗/型別 | 單元測試 | **渲染層消費** |
|---|---|---|---|---|---|
| 1 | `CanvasEpisode` / `currentStep` | ✅ | ✅ | ✅ 14 綠 | **0** |
| 2 | `storyboardShot` / `storyboardScene` | ✅ 3 處 | ✅ 雙白名單 | ✅ 23 綠 | **0** |
| 4 | `masterExport` 產物索引 | ✅ 讀取端 | ✅ | ✅ 15 綠 | **0**（且無 producer） |
| 5 | `lens-language-library` | n/a（資料） | ✅ | ✅ 9 綠 | **0** |
| 5 | `agent-prompt-contracts` | n/a（資料） | ✅ | ✅ | **0**（且無 gateway 側） |
| 5 | `aid-enums`（37 enum） | n/a（資料） | ✅ | ✅ 47 綠 | **0**（無任何 import） |
| 3 | 音色庫 | — | — | — | 已由暴君裁定移除 |

---

## 1. 逐刀對賬（PRD「全鏈生效定義」原文 vs 實況）

### 刀 1：作品/劇集實體鏈

**PRD 定義**（`docs/symdiff-aid-swallow-prd.md:143`）：
> 劇集實體 Blob 可讀 + canvas 面板可見 + agent 調用 `canvas_apply_ops` 寫入 episode 節點成功 + 重新整理仍在

| 環 | 實況 | 判據 |
|---|---|---|
| Blob 可讀 | ✅ | `src/app/api/canvas/projects/route.ts:65` |
| **canvas 面板可見** | ❌ **0** | `grep CanvasEpisode src/components/ --include=*.tsx` → 0 |
| **agent 寫入 episode** | ❌ | `CanvasAgentOp` 8 op 全清單：`add_node`/`update_node`/`delete_nodes`/`connect_nodes`/`delete_connections`/`select_nodes`/`set_viewport`/`run_generation` —— **無任何 project 級 op**。而 `CanvasProject.currentStep/episodes` 在 project 頂層，8 op 無一可達 |
| 重新整理仍在 | ✅（Blob） | 持久化通道已驗 |

**關鍵事實**：`use-canvas-chat.ts:515` 已把 `episodes` **導出**，`setProjectMeta` 已是**唯一寫入口**——但：
- **無任何 `.tsx` 渲染它**（`episodes`/`currentStep`/`projectType` 在 `.tsx` 消費數皆為 **0**）
- **無任何 UI 呼叫 `setProjectMeta`**（唯一呼叫者是 `CanvasAgentOp`，而它沒有對應 op）

即：**通道兩端都通了，中間沒有界面。**

### 刀 2：分鏡實體 + 21 欄契約

**PRD 定義**（`:165`）：
> agent 產出 21 欄分鏡 → `storyboard_qc_17` 回 `passed:true` 17/17 → 寫入 canvas 節點 → 前端可見 → 刷新後仍在

| 環 | 實況 |
|---|---|
| 21 欄契約 | ✅ `storyboard-contract.ts`（23 測試綠） |
| 雙白名單同步 | ✅ `toNodeMetadata` + `compactMetadataForAgent` |
| 寫入 canvas 節點 | ✅ 型別可寫（`Partial<CanvasNodeMetadata>`） |
| **前端可見** | ❌ **0**（`grep storyboardShot\|storyboardScene src/components/` → 0） |
| **門禁輸入 schema 對齊** | ❌ **0**（VPS `storyboard_qc_17.ts` 無 `shotNumber`/`scriptContent` 任何命中） |

**刀 2 自己已誠實聲明**（見其交付報告）：
> 門禁 `storyboard_qc_17` 期望的是**成片階段口徑**（`shotId`/`prompt`/`durationSeconds`/`characterCardIds`/`sceneId`/`keyframeId`…），AID 21 欄是**編劇階段口徑**。**兩套欄名完全同名者為零**。

即：**21 欄契約與門禁之間缺一個橋接層**。`storyboardQcShots` 已寫了橋（缺者回 `missing[]`），但門禁側沒有對應消費。

### 刀 4：成片產物索引

**PRD 定義**（`:216`）：
> 分鏡 → 時間線（clips 有 sceneId/shotSize）→ `check` `ok:true` → `export` 出 mp4 → `ffprobe` 解析度/時長/音軌符合 preset

| 環 | 實況 |
|---|---|
| 時間線 | ✅ `timeline.ts` op DSL（VPS 活躍） |
| master 閘 | ✅ `master.ts` + `MASTER_PRESETS` + `probeRenderedVideo` |
| 產物索引讀取端 | ✅ `master-artifact-index.ts`（15 測試綠） |
| **producer（寫入端）** | ❌ **無呼叫者**（`grep buildMasterArtifactMetadata` 排除自身 → 0） |

**刀 4 自己已誠實聲明**：
> VPS gateway **全檔零 DB 存取** → 導出鏈不回寫 DB，**今日 DB 裡不可能有索引行**。

即：**索引端建好了，沒有任何東西會寫進去。**

### 刀 5：方法論資產

**PRD 定義**（`:237`）：
> 詞庫可搜尋（≥143 條）→ 選中詞條注入分鏡 prompt → 生成結果可見；契約修改後 agent 實際調用行為改變（可 grep VPS）

| 資產 | 實況 |
|---|---|
| `lens-language-library.ts`（142 條） | ✅ 入庫；**唯一 import 者是自己的測試**；前端選詞入口 **0** |
| `agent-prompt-contracts.ts`（8 Expert 契約） | ✅ 入庫；**唯一消費者是 `agent-prompt-contract-check.ts`**，而後者本身無生產呼叫者；**gateway 側 0** |
| `aid-enums`（37 enum / 1670 行） | ✅ 入庫；**全倉 0 import**（刀 5 自己聲明「本目錄尚無消費端」） |

刀 0 已部分補救：`lens-language` 已做成 skill 並在 VPS 拉起（調用 0→1），但**那是 agent 側**，**前端仍無選詞入口**。

---

## 2. 已驗證成功的接線先例（證明我方會做，不是不會）

**`director` 元數據是真接完整的**：
- `AgentDirectorCard.tsx` + `director-mini/DirectorMiniViewport.tsx` 真的渲染 `topViewSvg`/`cameraViewSvg`
- 記憶檔 `canvas-snapshot-compressor-director-whitelist-fix.md` 記載：該欄位族曾因白名單漏同步而空殼，修好後**有前端消費**

**對照**：刀 1/刀 2 的新欄位族**只做了白名單，沒做渲染元件**。同一個 repo，同樣的欄位族機制，一個接完整、一個接一半。

---

## 3. 根因（不是「忘了」，是流程缺一環）

審視五刀的交付報告，共同的完成標準是：
> 「tsc 0 + N 例測試綠 + 雙白名單同步」

而 PRD 寫的全鏈生效定義是：
> 「…→ **前端可見** → 刷新後仍在」

**兩者差了「前端可見」與「消費端」兩段。** 各刀把「型別可寫 + 測試綠」當成了完成，因為那是**可機器驗證的**；「前端可見」需要真的開瀏覽器看，**不可機器驗證**，於是被系統性跳過。

**這與刀 0 的發現同源**：刀 0 是「貨架長草」（工具裝了沒人用），這裡是「資產入庫了沒人讀」。同一個病：**只建供給側，不建需求側。**

---

## 4. 缺口清單（按修復成本排序）

| # | 缺口 | 修法 | 成本 | 依賴 |
|---|---|---|---|---|
| **G1** | `CanvasAgentOp` 無 project 級 op | 加 `set_project_meta` op | 小 | 無 |
| **G2** | 劇集面板（渲染 `episodes` + `currentStep`） | 新元件掛 canvas-workstation | 中 | G1 |
| **G3** | 分鏡節點渲染（`storyboardShot`） | 擴 `NodeBody.tsx` | 小 | 無（有先例） |
| **G4** | `masterExport` producer | gateway 或控制面寫入 | 中 | 需跨服務設計 |
| **G5** | 21 欄 ↔ 門禁欄名橋接 | 門禁側吃 21 欄，或前端補 `production.*` | 中 | 需先定口徑 |
| **G6** | `aid-enums` 消費端 | 讓生成管線/前端真吃這些值 | 中 | 需逐個定用途 |
| **G7** | 前端詞庫選詞入口 | canvas 面板加詞庫選擇器 | 小 | 無（skill 已通） |
| **G8** | agent 契約接 gateway | 契約文字入 VPS 提示詞 | 中 | VPS 改動 |

---

## 5. 未觀察項聲明

- 本審計為**靜態 grep 對賬**，未逐刀跑真實端到端（如真開瀏覽器看 canvas 面板是否存在但隱藏）
- `src/components/**` 的 glob 在某些 shell 下不展開，已用 `grep -rln` 遞迴方式複驗（結論一致）
- 刀 3 音色庫已按暴君裁定移除，不在本審計範圍
- 未審計 `deploy-staging/` 與 `src/vendor-bridges/`（前者 gitignore，後者 VPS 執行碼本地副本）
