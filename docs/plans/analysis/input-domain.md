# 主畫布輸入域解剖報告（只讀分析，未動任何檔案）

**結論先行：PromptInput = NEED（必須拆，9 種職責）；ImagePlayground = NICE（唯一乾淨縫是畫布工作站）；兩者邊界「沒有糊掉」——是父子狀態分工，真正的重複心智模型是「兩條並存的生成管線」（父層 useImageGeneration 佇列 vs 子層直連 PixAI API），但這是註解明載的刻意設計（ImagePlayground L103-104）。**

最大隱性風險（先講，因為它改變拆分成本）：**兩檔的測試全是「讀原始碼文字 + regex 斷言」的契約測試**（`readFileSync(join(process.cwd(), "src/components/PromptInput.tsx"))` 後 `assert.match(source, /handleStyleChange/)`，PromptInput.test.ts L6-17；ImagePlayground.test.ts 同款 L11/31/73）。任何符號搬家 = 測試同步改讀取路徑，共 19+11 個 test 全數受影響。

---

## 一、src/components/PromptInput.tsx（1207 行）

### 1. 職責清單（實際 9 種）
1. 型別與 props 契約：L44-114（`PromptInputMode` 匯出型別 L49、30 個 props 的 interface L51-114）
2. 常量與 dynamic import 層：L116-200（`LABEL_CLASS/RAIL_CLASS/ROW_CLASS` L120-138、PixAI 比例常量 L142-149、`AGENT_HINT_SEEN_KEY` L139、`ReferenceImageUpload`/`AgentChatSurface` 懶載入 L161-188、**死碼 `AGENT_SURFACE_HEIGHT` L197**——僅註解引用）
3. 高度鎖測量系統：L264-293（實測 generate/edit 自然高並鎖為全模式外框高，含 resize 監聽）
4. D-24 漸進披露提示：L312-360（3 state + timer ref + sessionStorage，與送出路徑交叉抑制）
5. **改圖完整管線**：L248-252 state + L414-426 選檔 + L428-462 `handleEditSubmit`（uploadMedia→runEdit→結果）
6. **放大完整管線**：L253-257 state + L464-494 `handleUpscaleSubmit`
7. 參考圖拖拽/粘貼入口：L515-560（dragDepthRef 深度計數 + Ctrl+V 攔截）
8. generate 設定 rails：L710-853（示例/模型/比例/畫質/時長/音訊/風格，~143 行 JSX）
9. 模式面 JSX + 動作列：edit 面 L855-937、upscale 面 L939-1027、agent 面宿主 L1038-1059、底部模式切換/CTA 列 L1073-1203（~130 行）

### 2. 內部結構地圖
| 行區段 | 區塊 |
|---|---|
| L1-42 | imports（22 個內部模組） |
| L44-114 | types（`PromptInputMode`、`PromptInputProps`） |
| L116-200 | 常量 + 2 個 dynamic import |
| L202-566 | 單一巨型組件主體（hooks + handlers，無子組件函數） |
| L568-1207 | JSX（640 行，最大巢狀區 = generate 設定區 L710-853，5 層） |

### 3. 耦合
- 匯出：`PromptInput`、`PromptInputMode`。Importers：**僅 ImagePlayground.tsx**（單一消費者，無 barrel）
- 關鍵內部依賴：pixai-tools/shared（直連 API）、generation-model-catalog、prompt-compose、agent-chat-types
- **邊界事實：10 個 props 是純導管**（`onParamsReflected/onImageResult/onCanvasEvent/canvasStateProvider/onSessionChange/agentSeed/chatHeaderExtra/fillAvailableHeight/currentModelId` 等，L84-113 → L1045-1057 原樣轉發 AgentChatSurface）——PromptInput 是 agent 聊天 plumbing 的 pass-through 層
- CSS 耦合：`dust-exit/dust-enter/dust-enter-kf` 在 globals.css；`--agent-surface-height`（globals.css L905/910）的對應常量已死

### 4. Hooks/state
17 useState、7 useEffect、7 useCallback、5 useRef、1 useMemo（共 37 個 hook 呼叫）。useEffect 清單：displayMode 鏡像 L260、高度測量 L286/L289、externalPrompt 注入 L306、agentHint sessionStorage L323、agentHint 計時 L332、suppress 解除 L348。

### 6. 自然切割縫（新路徑 + 搬運清單）
| 新檔 | 搬什麼 | 舊檔保留 |
|---|---|---|
| `src/components/prompt-input/use-pixai-tools-panel.ts` | `PixaiRatioKey/PixaiStage/PIXAI_RATIO_SIZES/PIXAI_RATIO_CHIPS`（L142-149）、edit/upscale 10 個 state、`pickSourceFile/handleEditSubmit/handleUpscaleSubmit`（L414-494）→ 收斂成 `usePixaiEdit()` / `usePixaiUpscale()` | props 介面與結果回呼接線 |
| `src/components/prompt-input/use-agent-hint.ts` | `AGENT_HINT_SEEN_KEY`、`agentHintOpen/Spent/Suppressed` 3 state + timer ref + `spendAgentHint` + 3 個 effect（L312-360） | 送出處呼叫 `suppress()` |
| `src/components/prompt-input/use-height-lock.ts` | `contentRef/contentHeight/measureContentHeight` + 2 effect（L264-293） | section 上的 ref/style 綁定 |
| `src/components/prompt-input/EditPanel.tsx` | edit 面 JSX L855-937 | — |
| `src/components/prompt-input/UpscalePanel.tsx` | upscale 面 JSX L939-1027 | — |
| `src/components/prompt-input/GenerateControls.tsx` | L710-853（示例/模型/比例/畫質/時長/音訊/風格 rails） | — |
| `src/components/prompt-input/ActionRow.tsx` | 底部模式切換/已套用風格/專業模式 toggle/CTA L1073-1203 | — |
| 舊檔 PromptInput.tsx | — | 保留：殼 + 高度鎖綁定 + 模式面分發 + AgentChatSurface 宿主（懶載入必須留在這，L70-71 註解明載）+ 預期 ~450 行 |

### 7. 測試現況
PromptInput.test.ts：19 個 test 全讀 `src/components/PromptInput.tsx` 原文做 regex 斷言（如 L27 `onChange={handleStyleChange}`、L51-71 的 className 約束）。拆分後：讀取路徑需按符號新家改多檔讀取；**最省事順序 = 先抽 hooks（純邏輯層）再動 JSX**——JSX 類斷言（chip 尺寸、無分隔線、斷點）最脆。

### 8. 風險
1. 契約測試文字斷言：搬家即紅（上述 19 test）
2. `agentHintSuppressed` 被三條送出路徑（generate/edit/upscale）閉包共享寫入——拆成三個面板後 suppress 邏輯跨檔，需經 props 或 context 下發
3. 高度鎖測量根必須是包含所有模式面的同一 DOM 節點（L579 `ref={contentRef}` 的 section）——模式面抽成子組件不能改變測量根
4. `prevDisplayModeRef` 驅動的 textarea 消散/重組 class（L299-304）依賴「切走時 state 未清」的單組件事實——拆分需保持 input state 在父層
5. `fillAvailableHeight` 分支滲透 5 處（L274/584/601/700/1043）——工作站立場是隱式全局旗標，跨檔後易漏

### 9-10. 工作量與結論
**NEED。** 順序：①hooks 三連抽（S，半天，測試影響最小）→ ②EditPanel/UpscalePanel（S-M，自帶 state+JSX 三元組最乾淨）→ ③GenerateControls/ActionRow（M，含 19 test 改寫）。理由：1207 行裡 640 行 JSX、9 種職責、churn 7；edit/upscale 管線是完全自含的切割單元，縫是真實的。

---

## 二、src/components/ImagePlayground.tsx（921 行）

### 1. 職責清單（7 種）
1. 模式狀態機 + dust 轉場時序：L84-86、L213-230（260/320ms setTimeout 鏈 + animState 閘）
2. 生成參數 state owner（全站參數唯一權威）：L95-102 + `handlePromptSubmit` L394-423（鑑權+餘額+enhance+startGeneration）
3. 專業工作站挂載與執行：L82-83、L252-260、L570-591 + `handleProfessionalRun` L425-512（88 行 normalize/計價/送出）
4. D-12 參數回流三態復原：L279-371（agentBaseline/agentTouched/undo/restore + userSet\* 包裝 setter）
5. 畫布工作站：L103-139、L150-207（resultMode、chatPanel 兩態+寬度+localStorage、canvasHostRef 循環依賴解環 L116-133、body scroll lock、黏性旗標）
6. 進度條時序編排：L136-139、L519-566（假進度時長/fallback 延長/揭圖時機 + resultView 派生）
7. 頁面版面 JSX：L568-921，含 **108 行 inline `<style>` L598-706**、PromptInput 50 行 props 接線 L798-849、案例區/SEO 隱藏區/浮動狀態條

### 2-4. 結構與 hooks
無子組件、無匯出常量（除 `AGENT_PARAM_LABELS` L61-68）。27 useState、12 useEffect、16 useCallback、3 useRef、2 useMemo = **60 個 hook 呼叫**。匯出：`ImagePlayground`；Importer：僅 `src/app/page.tsx`。

### 與 PromptInput 的邊界（回答「是否糊掉」）
**沒有重複心智模型**：ImagePlayground 是參數/佇列/版面的 state owner，PromptInput 是輸入卡——兩者各 30/50 個 props 的接線（L798-849）是明確的所有權契約，不是複製。兩個真正异味：(a) PromptInput 直連 PixAI API 旁路父層佇列（刻意，L103-104 註解：pixai 結果「不走正常生成佇列」，經 onEditResult/onUpscaleResult 回拋）；(b) PromptInput 對 agent 聊天 10 個 props 純導管（見上）。`use-agent-chat` 邊界乾淨：PromptInput 不 import 它，AgentChatSurface（被 PromptInput 懶載）才是其唯一 UI 消費者——無需動作。

### 6. 自然切割縫
| 新檔 | 搬什麼 |
|---|---|
| `src/components/canvas-workstation/CanvasChatWorkstation.tsx` | **L598-706 的 108 行 `<style>` + L711-723 overlay + L734-872 面板殼/拖寬手柄**，配 `use-chat-panel.ts`（chatPanelState/Width + localStorage 3 個 effect L176-193 + 拖寬 handlers L852-869） |
| `src/hooks/use-agent-param-reflect.ts` | L279-371 整段（agentBaseline/agentTouched/handleParamsReflected/undoAgentParam/restoreMyParams/userSet\*）+ `AGENT_PARAM_LABELS` |
| `src/components/playground/use-professional-run.ts` | `handleProfessionalRun` L425-512 + openProfessionalMode/LoRA tour armed 邏輯 L252-260 |

舊檔保留：模式狀態機、handlePromptSubmit、進度時序、首頁版面與 PromptInput 接線、CaseShowcase/SEO 區，預期 ~420 行。

### 8. 風險
1. **`.agent-composer-anchor` 跨檔 CSS 陷阱**：定義在 ImagePlayground inline style L662，卻作用於 AgentChatPanel.tsx 內部——style 塊搬家時這條必須跟著 overlay 生命週期走（AgentChatPanel 只在 agent 面渲染，恰好同域，但這是隱式耦合）
2. `canvasHostRef` 解環順序：L116-133 先建 callback 後賦值 ref——拆工作站時 ref 指標必須仍在同一組件實例
3. `inCanvasWorkstation` 派生值（L194）同時驅動 body scroll lock、版面 grid 切換、面板殼、PromptInput fillAvailableHeight——四個消費點跨新舊檔後要經 props 明示
4. userSet\* setter 身分依賴（memo 不失效設計，L262-268 註解）——抽 hook 時 `useCallback` 依賴陣列要原樣保留
5. 測試：ImagePlayground.test.ts 11 個 test 斷言 `inCanvasWorkstation = displayMode === ...`（L64）、`chatPanelState` useState 原文（L78-79）等——工作站抽走後這些斷言全指向新檔

### 9-10. 工作量與結論
**NICE。** M（1 天）——只做畫布工作站單縫抽取（~300 行含 style），其餘留在原地。理由：60 個 hook 由單一模式狀態機串起，全面拆分收益低於閉包/setter 身分/時序鏈的回歸風險；唯一自含且高頻演進的區塊是畫布工作站。

---

## 建議總順序（跨兩檔）
1. **S**：PromptInput 抽 3 個 hooks（use-pixai-tools-panel / use-agent-hint / use-height-lock）——零 JSX 移動、測試影響最小
2. **S-M**：PromptInput 抽 EditPanel + UpscalePanel（自含三元組）
3. **M**：PromptInput 抽 GenerateControls + ActionRow，同步改寫 19 個契約測試讀取路徑
4. **M**：ImagePlayground 抽 CanvasChatWorkstation（含 style 塊 + use-chat-panel）+ use-agent-param-reflect
5. 全程避開：不動模式狀態機、不動 triggerTransition 時序、不把 AgentChatSurface 懶載移出 PromptInput
