# 巨檔重構實施方案（>1000 行檔案治理）

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 6 個 NEED 級巨型檔案按既有拆分模式增量拆解，消除改動摩擦與合併衝突熱點，全程零 API 變化、測試護欄全綠。

**Architecture:** 三層既定模式貫穿全程——lib 純函數（資料分片 + barrel）→ hooks 組裝（職責域拆 hook）→ components 呈現（props 驅動 memo 面板）。舊檔一律保留為匯出點（barrel / re-export），54 個 importer 零改動。

**Tech Stack:** Next.js 15 App Router、React 19、TypeScript、node:test 契約測試（讀源碼 regex 斷言）。

**依據:** `docs/plans/analysis/{canvas,workstation,core,input}-domain.md`（4 份解剖報告，含行級結構地圖與符號清單）。

---

## 前置條件（Phase 0）

1. rgba→token 設計系統遷移（3 個 subagent 進行中）**已落庫並部署**——重構與遷移觸同一批行，順序顛倒= rebase 地獄。
2. 基線全綠：`npx tsc --noEmit` && `npm test`（747 test）&& `npm run build`。記下基線測試數，每個 Task 收尾必須回到同數或更多。
3. 全程約束（每個 Task 都適用）：
   - 符號名即契約：搬運**不得改名**（ProfessionalWorkstation.test.ts 逐名斷言 498 條）。
   - 路徑凍結：`workstation-constants.ts` 不可搬/改名（canvas/CanvasNodeView.tsx L18 跨域 import REFERENCE_IMAGE_ROLES）；`generation-model-catalog.ts`、`use-cases.ts`、`use-canvas-chat.ts` 檔名保留作 barrel。
   - CRLF 檔案（use-cases / catalog / openapi route）搬移時保持行尾一致，否則 git diff 整檔標紅。
   - 每個 Task = 一個 commit；commit 前跑該 Task 的測試命令 + `npx tsc --noEmit`。

## 優先級矩陣

| 檔案 | 行數 | churn | 判定 | 工作量 | Task |
|---|---|---|---|---|---|
| src/lib/use-cases.ts | 5396 | 3 | NEED | S | 1 |
| src/lib/generation-model-catalog.ts | 1331 | 7 | NEED | M | 2 |
| src/components/PromptInput.tsx | 1207 | 7 | NEED | S→S-M→M | 3/6/9 |
| src/components/pro-workstation/InvokeInspiredWorkstation.tsx | 3873 | 2 | NEED | S/M/M/M/L | 4 |
| src/hooks/use-canvas-chat.ts | 1417 | 3 | NEED | M | 5 |
| src/components/canvas/CanvasEmbed.tsx | 2149 | 5 | NEED | M | 7 |
| src/components/canvas/CanvasNodeView.tsx | 1044 | 4 | NICE | S-M | 11 |
| src/components/ImagePlayground.tsx | 921 | — | NICE | M | 10 |

**SKIP 清單（明確不拆，拆了是負價值）:** CanvasImageEditorDialog.tsx（五模式共享底座，像素純函數已外移）、openapi.json/route.ts（單一 spec 字面量+讀源碼測試耦合，端點翻倍再議）、workstation 15 個支撐檔（既定模式成品）、use-agent-chat（邊界乾淨）。**重訪觸發器:** SKIP 檔 churn 翻倍或單模式膨脹時重評。

---

## Phase 1：純資料分片（零風險，兩 Task 可並行）

### Task 1: use-cases.ts 按域分片（S，半天）

**Files:**
- Create: `src/lib/use-cases/types.ts`（L8-55 六個 interface）、`src/lib/use-cases/base-<domain>.ts` × 17（anime/architecture/automotive/content/design/ecommerce/education/fashion/finance/gaming/health/marketing/personal/photography/training/travel/ui，每片 6 條 entry 約 310 行）
- Modify: `src/lib/use-cases.ts` → 瘦身為 40 行 index（import 全部分片 + USE_CASES 聚合 L5363-5371 + getUseCase/relatedUseCases/replaceAuthorUrl L5373-5396）

**Steps:**
1. 先寫匯總契約測試 `src/lib/use-cases.test.ts`：總數 ≥102、slug 全域唯一、getUseCase/relatedUseCases 行為不變（這是搬移正確性的釘子）。跑一次綠（對舊檔）。
2. 機械搬移：每域 6 條 entry → base-<domain>.ts，型別改從 `./use-cases/types` 引。`BASE_USE_CASES` 無外部引用，各分片直接匯出各自陣列。
3. 舊檔改 index，匯出面完全不變（6 interface + USE_CASES + 3 函數）。3 個真實消費者（use-cases/[slug]/page.tsx、sitemap.ts、UseCaseLinks.tsx）零改動。
4. reddit-* 分片的 `import type { UseCase } from "./use-cases"` 不動（type-only 循環無害）。
5. 驗證：`npx tsx --test src/lib/use-cases.test.ts src/lib/reddit-use-cases.test.ts` + tsc。全綠 commit：`refactor: split use-cases.ts into 17 domain shards (5396→40 lines)`。

### Task 2: generation-model-catalog 六模組切分（M，1 天）

**Files:**
- Create: `src/lib/generation-model-catalog/{types,catalog,pricing-overrides,capabilities,pricing,resolution}.ts`
  - types.ts ← L56-167（型別 + 比例常量，`as const` readonly 推導原樣保留）
  - catalog.ts ← L169-831（46 模型定義）+ L1-3 build-cache-bust 註解隨遷（Vercel stale 快取繞過，刻意保留）
  - pricing-overrides.ts ← L846-990（**唯一全域狀態擁有者**：effectiveCatalog/activeOverrides/pricingRevision/pricingListeners + apply/subscribe）
  - capabilities.ts ← L992-1180（20+ 查詢/投影/normalize，**單向 import pricing-overrides**，嚴禁循環）
  - pricing.ts ← L1184-1244（generationCredits/generationCoins/modelPriceLabel）
  - resolution.ts ← L1245-1331（resolve*/SUPPORTED_IMAGE_SIZES/換算）
- Modify: `src/lib/generation-model-catalog.ts` → 純 re-export barrel（57 個 export 原名原路徑；IMAGE_MODEL_IDS 等 3 個轉發 L833-835 留在 barrel）

**Steps:**
1. 搬 types.ts → catalog.ts → pricing-overrides.ts → capabilities.ts（單向依賴鏈依序落地，每步 tsc）。
2. **最大雷自查**：grep 確認 `effectiveCatalog` 只在 pricing-overrides.ts 出現模組級聲明——兩份真相= admin 改價後計費與選單分裂。
3. barrel 化，54 個 importer 一行不改。測試 import 帶 `.ts` 副檔名，實跑確認解析。
4. 驗證：`npx tsx --test src/lib/generation-model-catalog.test.ts src/lib/generation-model-catalog.pricing.test.ts src/lib/generation-core/batch-service.test.ts src/components/PromptInput.test.ts src/app/api/admin/model-pricing/route.test.ts` + tsc。commit：`refactor: split generation-model-catalog into 6 modules with barrel (54 importers untouched)`。

---

## Phase 2：hooks 抽取（無 JSX 移動，測試影響最小；Task 3/4/5 不同檔案可並行）

### Task 3: PromptInput 抽 3 個 hooks（S，半天）

**Files:**
- Create: `src/components/prompt-input/use-pixai-tools-panel.ts`（PIXAI_RATIO_* 常量 L142-149 + edit/upscale 10 state + pickSourceFile/handleEditSubmit/handleUpscaleSubmit L414-494 → 收斂成 usePixaiEdit()/usePixaiUpscale()）、`use-agent-hint.ts`（AGENT_HINT_SEEN_KEY + 3 state + timer + 3 effect L312-360）、`use-height-lock.ts`（contentRef/contentHeight/measureContentHeight + 2 effect L264-293）
- Modify: `src/components/PromptInput.tsx`（殼接線；**AgentChatSurface 懶載入必須留在本檔**，L70-71 註解明載；高度鎖測量根必須仍是包含所有模式面的同一 section DOM 節點）

**Steps:**
1. 逐 hook 抽取（pixai → hint → height-lock），每抽一個跑 `npx tsx --test src/components/PromptInput.test.ts`（19 test 讀源碼 regex——**純邏輯符號搬家斷言多半仍指向舊檔**，把測試 read 路徑改成新檔+舊檔拼接，語義不放寬）。
2. agentHintSuppressed 被 generate/edit/upscale 三條送出路徑閉包共享——hook 回傳 suppress() 統一下發。
3. tsc + PromptInput 測試綠 → commit：`refactor: extract 3 hooks from PromptInput (state/logic layer)`。

### Task 4: InvokeInspiredWorkstation 前 4 刀（S+M+M+M，每刀獨立 commit）

**Files（依刀序）:**
1. `src/components/pro-workstation/use-panel-resize.ts`（~160 行）← panelResizeRef L286 + L1969-2104 六個 resize 函數 + 佈局落盤 effect L355-366 + read/writeLayoutPrefs 接線。最自閉、零測試符號耦合，先做。
2. `src/components/pro-workstation/use-canvas-annotation.ts`（~340 行）← 9 個 refs（L492-533 strokesRef 等）+ L1473-1798 全部標註/縮放/平移函數 + effects L1592-1612。回傳 API 物件（handlers + zoom state）。
3. `src/components/pro-workstation/use-boards-library.ts`（~300 行）← L1235-1455 板夾/快照 CRUD + 匯出 + L2081-2104 縮略圖 effect + shotUrls/shotUrlPendingRef。BoardsPanel 已存在，直接消費。
4. `src/components/pro-workstation/workstation-recall.ts`（~180 行）← L1799-1968（buildProvenanceConfig/applyWorkflowRecallConfig/restore* 系列），setter 物件參數化解耦。

**Steps（每刀相同節奏）:**
1. 搬碼：refs+effects+handlers **整組搬**（漏搬一個 ref = 閉包失效，症狀是標註錯位/縮放殘留）；useEventCallback 繼續包裝回調（穩定引用，下游 effect 依賴行為不變）。
2. useEffect 聲明順序保持原相對順序（L327 模型重置 → L378 尺寸 → L390 畫質收斂鏈）。
3. **測試護欄**：新檔加進 `ProfessionalWorkstation.test.ts` 的 WORKSTATION_TSX_MODULES 數組（一行），30 test 必須全綠——這是設計來陪拆分長大的機制，漏加會紅燈（不會靜默漏檢）。
4. `npx tsx --test src/components/ProfessionalWorkstation.test.ts` + tsc → commit（如 `refactor: extract use-canvas-annotation from workstation (cut 2/5)`）。

### Task 5: use-canvas-chat 外圍搬遷（M，1 天）——在 Task 7 之前定型介面

**Files:**
- Create: `src/hooks/canvas/canvas-chat-types.ts`（L385-459 卡片/專案類型 + L460-541 UseCanvasChatReturn 37 成員介面）、`canvas-reducer-adapter.ts`（L62-360 CanvasAction + canvasReducer，19 種 action 純函數）、`canvas-project-sync.ts`（L954/991/1015 三個持久化 effect + refs）、`use-canvas-cards.ts`（L603-735 角色卡域）、`canvas-event-settler.ts`（L752-953 settle 對賬邏輯）
- Modify: `src/hooks/use-canvas-chat.ts` 保留主體 + **re-export 全部原匯出**（37 成員 return 是隱式合約，ImagePlayground L132 等解構多）

**Steps:**
1. 先搬 types（零風險），舊檔 re-export。
2. 搬 reducer-adapter 後**補 adapter 測試**（19 種 action 逐種驅動斷言 state 轉移——這是本 Task 唯一新增測試）。
3. 搬 project-sync（L1010 的 eslint-disable exhaustive-deps 依賴語義原樣保留，註解隨遷）、cards、event-settler。
4. `canvasRef.current = canvas` 同步 ref 模式：拆出 hook 回傳 getter 或接收 ref 物件。
5. `npx tsx --test src/lib/canvas/*.test.ts` + 新 adapter 測試 + tsc → commit：`refactor: extract canvas-chat types/reducer-adapter/sync/cards/settler`。

---

## Phase 3：JSX 面板抽取（Task 6/7/8 不同檔案可並行）

### Task 6: PromptInput 抽 EditPanel + UpscalePanel（S-M）

**Files:**
- Create: `src/components/prompt-input/EditPanel.tsx`（L855-937）、`UpscalePanel.tsx`（L939-1027）——自帶 state+JSX 三元組最乾淨的兩塊，消費 Task 3 的 hooks。
- Modify: `src/components/PromptInput.tsx`（模式面分發）

**Steps:** 搬 JSX + 對應 handlers（props 驅動）；textarea 消散/重組 class 邏輯（prevDisplayModeRef）**保留在父層**——它依賴「切走時 state 未清」的單組件事實；PromptInput.test.ts 的 JSX 類斷言（chip 尺寸/無分隔線/斷點）read 路徑同步。測試+tsc 綠 commit。

### Task 7: CanvasEmbed 拆 embed/ 域（M，1 天）

**Files:**
- Create: `src/components/canvas/embed/embed-helpers.ts`（L72-212 純函數+UI types+AGENT_AUTO_APPROVE_KEY）、`use-canvas-generation.ts`（L621-1002 生成編排鏈 + abortRef）、`use-canvas-interaction.ts`（L227-237+L378-620/954-1077 選取/框選/連線/埠拖拽/對齊）、`use-canvas-shortcuts.ts`（L1299-1402 鍵盤+剪貼簿 effects）、`CanvasEmbedOverlays.tsx`（L1859-2068 四個浮層：agent 確認閘/角色卡/歷史/節點清單）、`context-menu-items.ts`（L1079-1228 menuItems 工廠）
- Modify: `src/components/canvas/CanvasEmbed.tsx` 保留組件殼+節點掛載+頂欄（預估 2149→~600 行）

**Steps:**
1. 先搬 helpers（零風險）→ shortcuts → interaction → generation → overlays，每步 tsc。
2. 52 個 useCallback 鏈：依賴陣列整組隨函數搬遷；10 個「最新值鏡像 ref」（L250-266）改由 hook 回傳。
3. L1563-1632 內嵌 `<style>` 的 `.ce-embed-*` 選擇器與浮層同遷移（漏搬=樣式失效）。
4. menuItems 工廠化後顯式傳參（原 useMemo 閉包捕獲 20+ handlers）。
5. 唯一使用點是 ImagePlayground 的 dynamic import——路徑不變則零影響。驗證：`npx tsx --test src/components/ImagePlayground.test.ts`（11 test 只測 shell，不渲染內部）+ tsc → commit。

### Task 8: workstation panels/ 五面板（L，2 天+，最大單 Task）

**Files:**
- Create: `src/components/pro-workstation/panels/{WorkstationTopbar,LeftPromptTab,LeftSettingsTab,CanvasStage,InspectorPanel}.tsx` ← 分別對應 L2251-2450 / L2514-2720 / L2807-2994 / L3011-3431 / L3432-3767
- Modify: `InvokeInspiredWorkstation.tsx` 保留 props 解構+未搬 hooks+派生值+生成編排（L803-1234 閉包跨 15+ 狀態，最後拆或不拆）+executeCommand+JSX 組裝骨架+re-export L184-185（ImagePlayground type import 依賴）。入口預估 3873→~1200-1500 行。

**Steps:**
1. 照 HistoryInspectorPanel 模板寫（props 驅動 + memo）；CanvasStage 消費 Task 4 刀 2 的 annotation API。
2. **順序敏感斷言護欄**：跨行 `A 在 B 前` 斷言（L613/706/707/766/772/846 共 7 處）——入口恆排第一，JSX 區段搬出時保持相對先後（leftPanel 鏈：pro-left-panel→pro-model-row→pro-prompt-input→pro-run-bar）。
3. 每個面板落地下下來就加進 WORKSTATION_TSX_MODULES + 跑 30 test。
4. `.pro-*` 全域類名 45+ 條樣式斷言釘死——className 逐一保留。
5. 五個面板各自獨立 commit，任一紅燈停手回滾該面板。

---

## Phase 4：NICE 級（時間盒允許才做）

### Task 9: PromptInput GenerateControls + ActionRow（M）
L710-853 設定 rails + L1073-1203 動作列 → 兩個面板；**同步改寫 19 個契約測試**（JSX 斷言最脆，此 Task 測試改寫量最大，故排最後）。

### Task 10: ImagePlayground 抽 CanvasChatWorkstation（M）
`src/components/canvas-workstation/CanvasChatWorkstation.tsx` ← L598-706 的 108 行 inline `<style>`（含 `.agent-composer-anchor` 跨檔作用於 AgentChatPanel——style 塊必須跟 overlay 生命週期同遷）+ L711-723 overlay + L734-872 面板殼/拖寬手柄 + `use-chat-panel.ts`；`src/hooks/use-agent-param-reflect.ts` ← L279-371 三態復原 + AGENT_PARAM_LABELS。舊檔預估 921→~420 行。**不動**模式狀態機/triggerTransition 時序/canvasHostRef 解環順序（L116-133）。

### Task 11: CanvasNodeView（S-M）
`node-view/constants.ts`（STATUS_*/TYPE_*/RESIZE_HANDLES）+ `use-node-gestures.ts`（L233-421 三套指標手勢）+ `NodeBody.tsx`（renderBody+renderPlaceholder）。props drilling 46 個介面債順手還；不引入 context（避免 memo 失效）。

---

## 執行順序總覽

```
Phase 0: lg-* 遷移落庫部署 + 基線綠（前置）
Phase 1: [Task 1 ‖ Task 2]                          （純資料，並行）
Phase 2: [Task 3 ‖ Task 4(刀1-4) ‖ Task 5]          （hooks，並行；不同檔案集）
Phase 3: [Task 6 ‖ Task 7 ‖ Task 8]                 （JSX；T5 必須先於 T7）
Phase 4: [Task 9/10/11 按餘力]                       （NICE）
```

**總工作量:** NEED 約 6-8 個工作日（1 人），並行（3 agent）約 2-3 天。每 Task 獨立 commit、獨立可回滾、獨立驗證——任何時刻中斷都不留半成品。

## 全域驗收證據（每 Task 收尾 + 最終）

- `npx tsc --noEmit` 零錯
- `npm test` 全綠且數量 ≥ 基線（747）
- `npm run build` 成功
- 每個 NEED 檔案行數對照：use-cases 5396→~40、catalog 1331→barrel、PromptInput 1207→~450、workstation 3873→~1300、use-canvas-chat 1417→~500、CanvasEmbed 2149→~600
- 最終一輪 `vercel --prod` 部署，視覺驗收歸用戶

## 風險登記冊（跨 Task 通用的十條）

1. 閉包共享：workstation 58 state/26 ref、CanvasEmbed 52 callback 鏈——搬遷整組走，漏一個 ref 即行為異常
2. useEffect 聲明序 = 執行序，hooks 化後呼叫順序保持原相對順序
3. 契約測試讀源碼：搬家即紅——read 路徑同步是每個 Task 的必修步，語義禁止放寬
4. pricing-overrides 單一狀態擁有者，capabilities 單向 import，禁止循環
5. 路徑凍結：workstation-constants / 三個 barrel 檔名
6. 符號名凍結：被逐名斷言的函數（renderBoardsPanel/run/applyCreatorResource…）
7. 內嵌 `<style>` 選擇器與其作用 DOM 同遷移（.ce-embed-*、.agent-composer-anchor）
8. CRLF 行尾檔案搬移保持一致
9. build-cache-bust 註解隨 catalog.ts 保留
10. 動態 import 邊界（dynamic() 懶載入）是天然 chunk 邊界，新路徑不改 import 方式

---

**Plan complete. Two execution options:**
1. **Subagent-Driven（本 session）** — 我每 Task 派 fresh subagent，Task 間審查，快速迭代
2. **Parallel Session（獨立 session）** — 新 session 用 executing-plans 逐 Task 執行，批量推進

（建議：Phase 1 兩個純資料 Task 先走 Subagent-Driven 試水，模式驗證後其餘批量。）
