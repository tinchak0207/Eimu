# pro-workstation 專業工作台域 — 巨檔解剖報告（只讀重構前期分析）

> 日期：2026-08-22（基於當前 working tree，僅讀取，無任何程式碼改動）
> 範圍：src/components/pro-workstation/ 全域 + 鎖定測試 ProfessionalWorkstation.test.ts
> 交接背景：另有 agent 在同批檔案做 className 設計系統遷移（rgba→token），本報告忽略 class 字串噪音，只論結構。

**總結論先行：巨檔 NEED（分 5 刀增量拆）；其餘 15 個支撐檔全數 SKIP（已是既定拆分模式的成品）；測試檔是字串 regex 契約，拆分按其內建機制加一行模組名即可續命，不會炸。**

**重要修正**：目錄中沒有 panels/ 子目錄——LoraLibraryPanel 等 4 個面板平鋪在 pro-workstation/ 根目錄。

---

## 1. InvokeInspiredWorkstation.tsx（3873 行）— NEED 拆

**匯出**：`InvokeInspiredWorkstation`（L188，唯一函數，3685 行）＋ 2 條 re-export（L184-185，ImagePlayground 依賴，必須留在入口）。
**被 import**：ImagePlayground.tsx（L48 type、L55 dynamic、L572 使用）、3 個 test 檔（ProfessionalWorkstation / ImagePlayground / PricingSync）。dynamic() 懶載入 → 入口 chunk 邊界已存在，拆出的子模組自動跟 chunk 走。
**規模**：58 useState／24 useEffect／10 useMemo／32 useEventCallback／26 useRef／1 useCallback = **151 個 hooks 單函數**；props 14 個（L188-204）。

### 1.1 職責清單（實際承擔 9 種）

| # | 職責 | 行區段 | 約行數 |
|---|------|--------|------|
| 1 | import + re-export 層 | L1-186 | 186 |
| 2 | 草稿/佈局持久化 + 模型參數收斂 effects | L205-395 | ~190 |
| 3 | LoRA 引導聯動（tour 推進/選卡完成） | L397-490 | ~95 |
| 4 | 通知系統 + 派生狀態（結果/槽位/進度/ETA） | L504-810 | ~305 |
| 5 | 生成編排（buildRunConfig/run/retry/applyScenario/undoTemplateApply/brand/regional） | L803-1234 | ~430 |
| 6 | 板夾/快照 CRUD + 匯出（boards/shots） | L1235-1455 | ~220 |
| 7 | 畫布標註引擎（paint/repaint/zoom/pan/undo/export） | L1473-1798 | ~325 |
| 8 | 溯源回填（provenance/workflow recall/歷史還原） | L1799-1968 | ~170 |
| 9 | 面板縮放引擎 + 命令派發 + 鍵盤熱鍵 | L1969-2250 | ~280 |
| 10 | 主 JSX：頂欄 L2251-2450／左欄 L2455-2994（prompt tab L2514 / assets tab L2721 / settings tab L2807）／畫布 L3011-3431／檢查器 L3432-3767（queue L3506 / gallery L3580 / history L3691）／portal L3768-3872 | L2251-3872 | **1621** |

### 1.2 最大 JSX 嵌套區段
左欄 prompt tab（L2514-2720，206 行）與畫布 actual-size 檢視（L3047-3431，384 行）為最深最長兩塊。

### 1.3 24 個 useEffect 摘要（行號 → 用途）
模型參數重置 L327｜草稿落盤 L333｜beforeunload L344｜佈局落盤 L355｜尺寸收斂 L378｜畫質收斂 L390｜LoRA tour 旗標 L397｜模型選單/tour 推進 L414｜LoRA 選卡完成 L465｜通知自動關 L515｜跑錶 L621+L629｜手機階段同步 L759｜自動選最新成片 L771｜失效選中歸位 L789｜LoRA 清理 L797｜zoom 復位 L1592+L1596｜非 passive wheel L1606｜首載 brand/boards L2069｜手機滾頂 L2076｜縮略圖並行載入 L2081｜全域熱鍵 L2196｜燈箱鍵 L2229。

### 1.4 自然切割縫（沿既有模式：hooks→.ts、面板→props 驅動 memo 元件、資料重面板→dynamic()）

新檔按建議拆出順序：

1. **`src/components/pro-workstation/use-canvas-annotation.ts`**（~340 行）
   搬：L492-533 相關 refs（strokesRef / currentStrokeRef / canvasSizeRef / isDrawingRef / hasAnnotationRef / lastPointRef / annotationCanvasRef / baseImageRef / canvasViewportRef）＋ L1473-1798 全部標註/縮放/平移函數（paintStroke / repaintAnnotations / syncAnnotationCanvasSize / annotationPoint / zoomAtPointer / resetZoom / startPan / movePan / endPan / drawAnnotationSegment / handleAnnotationPointerDown/Move/Up / undoAnnotation / clearAnnotation / canvasToBlob / exportAnnotationToReference）＋ effects L1592-1612。
   形式：custom hook，回傳 API 物件（handlers + zoom state）。

2. **`src/components/pro-workstation/use-panel-resize.ts`**（~160 行）
   搬：panelResizeRef（L286）、L1969-2104（startPanelResize / handlePanelResize / endPanelResize / nudgePanel / resetPanel / handleResizeKeyDown）＋佈局落盤 effect L355-366 與 readLayoutPrefs/writeLayoutPrefs 接線。

3. **`src/components/pro-workstation/use-boards-library.ts`**（~300 行）
   搬：L1235-1455（refreshBoards / handleCreateBoard / handleDeleteBoard / handleDeleteActiveBoard / saveResultToBoard / handleMoveShot / handleToggleStar / handleDeleteShot / downloadShot / handleExportBoard）＋ L2081-2104 縮略圖並行載入 effect ＋ shotUrls / shotUrlPendingRef 狀態。
   消費端：BoardsPanel 已存在於 workstation-subcomponents.tsx。

4. **`src/components/pro-workstation/workstation-recall.ts`**（~180 行）
   搬：L1799-1968（buildProvenanceConfig / copyProvenanceConfig / applyWorkflowRecallConfig / restoreProvenanceConfig / restoreProvenanceConfigFromPng / restoreHistoryEntry）。
   解耦方式：以 setter 物件參數化（模型/提示詞/參數回寫）。

5. **`src/components/pro-workstation/panels/`** 新目錄（沿用根目錄平鋪亦可）：
   - `WorkstationTopbar.tsx` ← L2251-2450（~200 行）
   - `LeftPromptTab.tsx` ← L2514-2720（~206 行）
   - `LeftSettingsTab.tsx` ← L2807-2994（含模型列 / LoRA / 張數）
   - `CanvasStage.tsx` ← L3011-3431（消費 hook #1 的 API）
   - `InspectorPanel.tsx` ← L3432-3767（queue / gallery / history 三 tab）

   全部 props 驅動 + memo，照 HistoryInspectorPanel 模板寫。

6. **舊檔保留**：props 解構、未被搬走的狀態聲明、派生值（L534-810）、生成編排（L803-1234 職責 5——閉包跨越 15+ 狀態，最後拆或不拆）、executeCommand（L2129-2195 引用 20+ handler，可先留）、主 JSX 組裝骨架、re-export L184-185。
   預估入口降至 ~1200-1500 行。

---

## 2. 既有拆分模式檔案群 — 全部 SKIP

| 檔案 | 行數 | 內容地圖 | 判定 |
|------|------|----------|------|
| workstation-constants.ts | 341 | types L23-31/217/243/295/310、選項表 L52-206、localStorage 讀寫 L225-272、useEventCallback L320、waitForSelector L327 | **SKIP**（大而內聚）。小瑕疵：useEventCallback/waitForSelector 是執行期工具混在常量檔，屬 NICE 級可挪走，不急 |
| workstation-subcomponents.tsx | 433 | dynamic() 包裝 L18/L38、StyleGrid L47、DraggableReferenceTile L174、QueueSlotList L244、BoardsPanel L294、共用 types L120/L145/L235 | **SKIP**——這就是「共享葉元件 + 懶載入面板」模式本體；新面板勿塞進來，另起 panels/ |
| workstation-tours.ts | 523 | createWorkstationTours 工廠 L36（driver.js 引導） | **SKIP** 已內聚 |
| workstation-sources.ts | 88 | 純資料（開源授權歸屬），零邏輯 | **SKIP** |
| workstation-cursor-demo.ts | 165 | 假滑鼠演示 runner，純邏輯無 UI | **SKIP** |
| workstation.css | 7 | @import 入口（part-01..05） | **SKIP** 模式正確 |
| workstation-part-01~05.css | 754-912/檔 | 純選擇器資料，無邏輯；按層疊順序切分 | **SKIP** 已是成品；part-06 檔名已被測試預留（existsSync 跳過不存在檔） |

### 面板 4 檔

| 檔案 | 行數 | 結構 | 判定 |
|------|------|------|------|
| LoraLibraryPanel.tsx | 390 | 自帶 types L8-45、分頁/排序常量 L47-54、主元件 L65 | **SKIP** |
| TemplatePanel.tsx | 296 | 自帶 types L19-44、default export L46 | **SKIP** |
| CreatorResourcePanel.tsx | 210 | 純模板過濾/展示邏輯 L14-48、memo 元件 L48 | **SKIP** |
| HistoryInspectorPanel.tsx | 215 | 適配函數 L42-63、memo 包裝 L215 | **SKIP** |

各自自帶 types + 本地 state + props 介面；CreatorResource/Template 走 dynamic()。均低於 400 行且模板成熟——**巨檔拆出的新面板直接抄這個模板**。

### 外部耦合警示

- `src/components/canvas/CanvasNodeView.tsx L18` import 了 workstation-constants 的 REFERENCE_IMAGE_ROLES——**constants 檔不可改名/搬路徑**，否則炸畫布域。
- 入口 re-export（L184-185）被 ImagePlayground type import 依賴，必須留在入口檔。

---

## 3. ProfessionalWorkstation.test.ts（939 行）— 拆分的護欄而非炸彈

**性質：100% 原始碼字串斷言，零渲染零 mock**。node:test + readFileSync；30 個 test、498 條斷言（436 assert.match／45 doesNotMatch／10 ok／7 equal）。斷言對象：中文文案契約、禁用詞表、CSS 選擇器與 grid 模板、JS 符號存在性（applyCreatorResource / renderBoardsPanel / saveResultToBoard…）。

### 3.1 內建拆分容錯（L11-37 註釋明說設計意圖）

- `read(入口)` = 入口 + WORKSTATION_TSX_MODULES 5 檔（entry / constants / subcomponents / tours / cursor-demo）按序拼接；CSS 同理（workstation.css + part-01..06，不存在的 part-06 自動跳過）。
- **拆分行為契約：每拆一個新 tsx/ts 檔 → 在 WORKSTATION_TSX_MODULES 數組加一行路徑（新 CSS 加進 CSS 數組），斷言即繼續覆蓋新檔，一字不改。**
- 順序敏感斷言（跨行 `[\\s\\S]`）：L613（assets tab 在 ReferenceImageUpload 前）、L706（run() → setInspectorExpanded(true)）、L707、L766、L772（pro-left-panel → pro-model-row → pro-prompt-input → pro-run-bar 相對順序）、L846。**入口恆排第一**，只要被斷言的兩段程式碼相對先後不倒轉即安全；把 JSX 區段搬到 panels/ 時保持同序追加即可。
- 符號名即契約：搬函數**不得改名**（renderBoardsPanel L447、run L706、applyCreatorResource L96-98 等被逐名斷言）。

### 3.2 測試現況與拆分後的跟法

- 覆蓋此域的測試檔：ProfessionalWorkstation.test.ts（主）、ImagePlayground.test.ts（入口間接）、PricingSync.test.ts（入口間接）。
- 拆分後：無需改寫任何斷言；僅維護兩個模組數組。斷言是文字級的——符號名 + 文案 + CSS 規則原樣搬家即全綠。

---

## 4. 風險清單（按殺傷力排序）

1. **閉包共享**：全部 handler 閉包引用 58 state + 26 ref。拆 hooks 時必須整組搬 refs + effects，回傳 API 物件；漏搬一個 ref 即閉包失效（症狀：標註畫布錯位、縮放殘留）。
2. **useEffect 聲明順序**：React 按聲明序執行；拆成 hooks 後呼叫順序須保持原相對順序（尤其 L327 模型重置 → L378 尺寸收斂 → L390 畫質收斂鏈）。
3. **測試模組數組漏更**：新檔未加進 WORKSTATION_TSX_MODULES → 該檔內所有被斷言符號的 match 立即失敗（紅燈明顯，不會靜默漏檢——設計如此）。
4. **跨行順序斷言倒轉**：JSX 區段搬出時把「A 在 B 前」的兩段分置兩檔且順序翻轉。入口恆第一，風險係數低，但需自查 L613/L706/L707/L766/L772/L846 六條。
5. **CSS 選擇器**：.pro-* 全域類名被 45+ 條樣式斷言釘死；遷移時類名逐一保留（與並行中的 rgba→token 遷移正交，互不干擾）。
6. **useEventCallback 穩定引用**：拆出的 hooks 必須繼續用它包裝回調，否則下游 effect 依賴數組行為改變。
7. **re-export L184-185**：留在入口檔尾，ImagePlayground 的 type import 依賴它。
8. **constants 檔路徑凍結**：CanvasNodeView 外部引用，不可動。

---

## 5. 工作量與建議順序

| 刀 | 檔案 | 量級 |
|----|------|------|
| 1 | use-panel-resize.ts（最自閉、零測試符號耦合） | S（<半天） |
| 2 | use-canvas-annotation.ts（自閉但 refs 多） | M（1 天） |
| 3 | use-boards-library.ts（含 1 個 effect） | M（1 天） |
| 4 | workstation-recall.ts（setter 參數化） | M（1 天） |
| 5 | panels/ 五個 JSX 面板（量最大、機械性強） | L（2 天+） |

每刀落地 = 搬碼 + 測試數組加一行 + `node --test` 全綠才收。

---

## 6. 誠實結論（逐檔一詞）

| 檔案 | 結論 | 理由 |
|------|------|------|
| InvokeInspiredWorkstation.tsx | **NEED** | 3685 行單函數、151 hooks、9 種職責，且專案已有被測試架構明確支持的增量拆分模式，繼續膨脹只會讓每次改動都全檔重編輯 |
| workstation-constants.ts | **SKIP** | 341 行大而內聚（useEventCallback 挪走屬 NICE，不急）；且被 canvas 域外部引用，路徑凍結 |
| workstation-subcomponents.tsx | **SKIP** | 433 行，共享葉元件 + dynamic 模式本體，再拆是負價值 |
| workstation-tours.ts | **SKIP** | 523 行已內聚的引導工廠 |
| workstation-sources.ts | **SKIP** | 88 行純資料 |
| workstation-cursor-demo.ts | **SKIP** | 165 行純邏輯 runner |
| workstation.css + part-01~05.css | **SKIP** | 已按層疊序切好的純選擇器資料 |
| LoraLibraryPanel.tsx | **SKIP** | 390 行成熟面板模板 |
| TemplatePanel.tsx | **SKIP** | 296 行成熟面板模板 |
| CreatorResourcePanel.tsx | **SKIP** | 210 行成熟面板模板 |
| HistoryInspectorPanel.tsx | **SKIP** | 215 行成熟面板模板 |
| ProfessionalWorkstation.test.ts | **SKIP**（不拆不改） | 僅在每次拆分時往兩個模組數組各加一行；它是設計來陪拆分長大的 |
