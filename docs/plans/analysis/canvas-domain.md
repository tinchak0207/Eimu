# 巨檔解剖報告：canvas 無限畫布域

**總結論先行**：CanvasEmbed（NEED，必拆）、use-canvas-chat（NEED，但只拆 reducer 適配層外圍）、CanvasNodeView（NICE）、CanvasImageEditorDialog（SKIP）。拆分應在設計系統遷移（rgba→token）完成後進行，否則同一批行會產生遷移衝突。

---

### 1. CanvasEmbed.tsx（2149 行，churn 5）— NEED 必拆

**職責清單（9 種）**：
- L80-187 工具函數（toDvh/formatRelative/imageUrlOf/safeFilename/fetchImageBlob/triggerDownload/buildAuthHeaders/fileToDataUrl/wouldCreateCycle）
- L97-112 `usePrefersReducedMotion` hook
- L189-212 本地 UI 類型（MenuState/EditorState/PortDragState/CreateMenuState）
- L214-243 狀態樹：21 個 useState + 15 個 useRef（含 10 個「最新值鏡像 ref」）
- L275-302 派生資料 memo（nodeById/childToParent/adjacentIds/visibleNodes 視口裁剪）
- L323-377 尺寸量測/fit-once effects
- L378-1077 交互 handlers（選取/框選/複製貼上/對齊分佈/連線/埠拖拽/右鍵選單）
- L621-1002 **生成編排**（callCanvasGenerate→generateIntoNode→handleGenerateFromNode→retryNode→upscaleNode→runAgentGeneration）——與 UI 無關的 API 編排邏輯
- L1004-1296 節點級動作（createNodeAt/importImageFiles/saveNodeAsCard/saveNodeToAssets）
- L1299-1402 鍵盤快捷鍵 + 系統剪貼簿 effects
- L1561-2149 JSX：內嵌 `<style>` 塊（L1563-1632，70 行 CSS）+ 頂欄 + 角色卡面板（L1916-1985）+ 歷史畫布（L1988-2021）+ 節點清單（L2024-2068）+ agent 確認閘（L1859-1900）+ 錯誤 toast（L1903-1913）

**結構地圖**：頂層僅 20 個聲明——L58-212 是前導（types/常量/工具），**L214-2149 是單一 1935 行函數組件**（89 個內部聲明、11 個 useEffect、52 個 useCallback/useMemo）。單函數體積就是主要問題。

**耦合**：匯出 `CanvasEmbedProps` + `CanvasEmbed`。僅 `ImagePlayground.tsx` L12 動態 import（`dynamic(..., {ssr:false})`，L721 使用）。內部依賴 10 個 canvas 子組件 + `use-canvas-chat` 的 `UseCanvasChatReturn`（37 個成員的巨型介面）+ semantic-nodes/character-cards/new-api-client。**外部依賴面窄（1 個使用點），拆分安全性高。**

**自然切割縫（建議 5 個新檔）**：
1. `src/components/canvas/embed/embed-helpers.ts` — 搬 L72-187 純函數（toDvh/formatRelative/imageUrlOf/safeFilename/fetchImageBlob/triggerDownload/buildAuthHeaders/fileToDataUrl/wouldCreateCycle）+ L189-212 四個 UI types + AGENT_AUTO_APPROVE_KEY
2. `src/components/canvas/embed/use-canvas-generation.ts` — 搬 L621-884 生成編排鏈（callCanvasGenerate/generateIntoNode/handleGenerateFromNode/stopGeneration/retryNode/upscaleNode）+ abortRef，輸入 `canvas` 物件與 refs，回傳 handlers 集合
3. `src/components/canvas/embed/use-canvas-interaction.ts` — 搬 L227-237 交互 state + L378-620/954-1077 選取/框選/連線/埠拖拽/對齊邏輯
4. `src/components/canvas/embed/use-canvas-shortcuts.ts` — 搬 L1299-1402 兩個 window effect（鍵盤+剪貼簿）
5. `src/components/canvas/embed/CanvasEmbedOverlays.tsx` — 搬 L1859-2068 agent 確認閘/角色卡面板/歷史畫布/節點清單（4 個獨立浮層，props 傳遞即可），內嵌 CSS（L1563-1632）移入 CSS module 或保留
6. L1079-1228 `menuItems`（150 行選單配置）→ `embed/context-menu-items.ts` 工廠函數

**舊檔保留**：組件殼 + JSX 組裝（visibleNodes.map 的 CanvasNodeView 掛載 L1678-1731）+ 頂欄。

**風險**：①52 個 useCallback 鏈彼此引用，抽 hook 時依賴陣列需整組搬遷；②10 個「最新值鏡像 ref」（L250-266）模式被鍵盤 effect 依賴，拆開後 ref 生命週期須由 hook 回傳；③L1563 內嵌 `<style>` 的 `.ce-embed-*` 選擇器與浮層同遷移，漏搬會樣式失效；④`menuItems` useMemo 閉包捕獲 20+ handlers，改工廠後須顯式傳參；⑤唯一使用點是 dynamic import，路徑別名不變則安全。

**測試**：`ImagePlayground.test.ts`（11 個 test）覆蓋 shell 行為（overlay/expand/composer 位置），不直接渲染 CanvasEmbed 內部——重構可全走現有測試+ tsc + build 驗證，無需新增測試即可安全搬遷。

**工作量 M（1 天）**。建議順序 ①：churn 最高、單函數 1935 行已超可維護閾值，先拆。

---

### 2. use-canvas-chat.ts（1417 行，churn 3）— NEED（有限拆分）

**職責清單（7 種）**：
- L62-360 `CanvasAction` union + `canvasReducer` 適配器（273 行 switch：event/load/move/resize/remove/clear/batch_*/reference/move_many/add_nodes/delete_many/connect/disconnect/rename/patch_metadata/agent_ops 共 19 種 action）
- L361-384 `normalizeAgentNode`
- L385-431 卡片/專案類型（CanvasPlanCard/CanvasDeriveCard/CanvasBudget/CanvasProjectSummary/toProjectSummaries）
- L432-459 `compactMetadataForAgent` + 常量
- L460-541 `UseCanvasChatReturn` 介面（37 成員）
- L543-1417 hook 本體：**6 個域**——卡片管理（L603-735）、SSE 事件入口/最終一致性收斂（L750-953）、專案持久化 debounce（L976-1012）、快照上行（L1015+）、undo/redo 快照棧（L736-749）、視口/flyTo 動畫、40+ 個動作 callbacks

**耦合**：匯出 canvasReducer/CanvasAction/UseCanvasChatReturn/各卡類型/useCanvasChat。被 ImagePlayground.tsx（L132）、CanvasEmbed.tsx、CanvasSidePanel.tsx（type-only）import。底層已正確委託 `src/lib/canvas/`（reducer/layout/client/character-card-client）——**純函數層已存在，hook 只是組裝**。

**自然切割縫**：
1. `src/hooks/canvas/canvas-reducer-adapter.ts` — 搬 L62-360（CanvasAction + canvasReducer，純函數可直接加測試）
2. `src/hooks/canvas/canvas-project-sync.ts` — 搬持久化三 effect（列表載入 L954/儲存 debounce L991/快照上行 L1015）+ buildProject/saveTimer/hydrated/everHadNodes refs
3. `src/hooks/canvas/use-canvas-cards.ts` — 搬 L603-735 角色卡域（characterCards/activeCardIds state + upsert/remove/toggle + 載入 effect）
4. `src/hooks/canvas/canvas-event-settler.ts` — 搬 L752-953 `handleCanvasEvent` 內的 settle 邏輯（isPendingSettledNode/settleNodeWithUrl/settleCandidateNode + imageDoneQueueRef 對賬）
5. 類型搬 `src/hooks/canvas/canvas-chat-types.ts`（L385-459），舊檔 re-export 保持相容

**舊檔保留**：useCanvasChat 主體 + 視口/undo/動作 callbacks + return 物件。

**測試**：lib/canvas 已有 reducer.test.ts/layout.test.ts/project-store.test.ts。canvasReducer 適配器搬出後可在 `src/hooks/canvas/` 加 adapter 測試驅動 19 種 action；其餘搬遷不破壞現有測試（路徑 re-export 相容）。

**風險**：①`canvasRef.current = canvas` 等同步 ref 模式遍布——拆出的 hook 必須回傳 getter 或接收 ref 物件；②持久化 effect 的 eslint-disable exhaustive-deps（L1010）搬遷時依賴語義易錯；③return 物件 37 成員是隱式合約，消費端（ImagePlayground L132）解構多，**保留 `use-canvas-chat.ts` 作為唯一匯出點 + re-export** 可消解。

**工作量 M（1 天）**。順序 ②。

---

### 3. CanvasNodeView.tsx（1044 行，churn 4）— NICE

**職責清單（6 種）**：L22-121 類型/標籤映射常量、L122-168 圖片 URL 工具（isUrl/thumbUrl/proxySrc/renderBrokenImage/formatProgress）、L181-502 拖拽/縮放引擎（dragRef/resizeRef/scrollDragRef 三套指標手勢）、L422-502 renderPlaceholder、L503-692 renderBody（switch node.type 渲染圖/視頻/文本/佔位）、L697-1044 節點殼 JSX（標題欄/狀態徽章/hover 工具列 L875/提示詞面板 L937）。

**耦合**：僅 CanvasEmbed import（InfiniteCanvas 只有註釋提及）。46 個 props（L181-224）是介面債，但僅一個消費端。

**切割縫**：`node-view/constants.ts`（STATUS_COLOR/STATUS_LABEL/TYPE_LABEL/RESIZE_HANDLES）、`node-view/use-node-gestures.ts`（L233-421 三套指標手勢）、`node-view/NodeBody.tsx`（renderBody+renderPlaceholder）、舊檔保留殼與頭部。

**風險**：props drilling 46 個——拆 NodeBody 需轉發 20+ props，若用 context 則 memo 失效；CanvasNodeView 未包 memo（render 每次 map 重建），手勢 hook 拆出後 pointer capture 邏輯與 JSX 綁定需同步搬。

**測試**：無直接測試檔。**工作量 S-M（半天-1 天）**。順序 ③：churn 4 但結構尚清晰，生成編排穩定後再拆。

---

### 4. CanvasImageEditorDialog.tsx（1004 行，churn 1）— SKIP

**職責清單（5 種）**：L35-103 模式/常量定義、L105-164 五模式 state 叢（22 useState）、L164-249 圖片載入/座標換算、L280-531 五模式各自交互 handlers（crop 拖框/split 線拖/mask 畫筆/rotate 角度）、L542-1004 JSX（5 個模式面板）。**所有像素操作已委託 `src/lib/canvas/image-edit.ts`（254 行，13 個匯出）**——這是五合一對話框，模式間共享 bmp/viewSize/座標系，切開會造成 5 份重複載入/量測邏輯。churn 1 證明它穩定。若未來單模式膨脹，先抽 `use-image-editor-state`（L115-160 state 叢）即可。

**工作量 S（僅 state 叢抽 hook 時）**。順序 ④（或不做）。

---

### 5. 目錄級建議（18 個中小檔歸屬判斷）

- `CanvasNodePromptPanel`（807 行）：維持獨立，NodeView 拆分時其 props 介面不動。
- `CanvasSidePanel`（約 300 行）已只做 type-only import，use-canvas-chat 類型搬遷後零影響。
- **避免重複心智模型**：生成編排（embed/use-canvas-generation）**不得**併入 `semantic-nodes.ts`（那是純函數域）；交互 hook 不得併入 `interaction.ts`（那是幾何純函數）。新目錄 `src/components/canvas/embed/` 與 `src/hooks/canvas/` 各司其職，與既有 `lib/canvas/`（純函數）形成三層：lib 純函數 → hooks 組裝 → components 呈現。

### 總順序與依賴
① CanvasEmbed 拆分（M）→ ② use-canvas-chat 外圍搬遷（M）→ ③ CanvasNodeView（S-M）→ ④ EditorDialog（SKIP/S）。①② 無相互依賴可並行，但都觸及 `UseCanvasChatReturn` 介面，建議 ② 先定型介面搬移、① 後拆。**前置條件：等 rgba→token 遷移 agent 完成後再動**，否則 L1775+ 的大量 className 行會產生 rebase 地獄。

### 誠實結論
- **CanvasEmbed：NEED** — 單函數 1935 行、9 種職責、churn 5，生成編排與 UI 殼強耦合是每次改動的實際摩擦點。
- **use-canvas-chat：NEED** — 1417 行含 273 行可獨立測試的 reducer 適配器 + 4 個可分離 effect 域，但保留原檔作唯一匯出點。
- **CanvasNodeView：NICE** — 結構清晰、單消費端，46 props 介面債值得還但非緊急。
- **CanvasImageEditorDialog：SKIP** — 大而內聚：五模式共享載入/座標/量測底座，像素純函數已外移，拆了更糟。
