# pro-workstation 专业工作台域 — 巨档解剖报告（只读重构前期分析）

> 日期：2026-08-22（基于当前 working tree，仅读取，无任何程式码改动）
> 范围：src/components/pro-workstation/ 全域 + 锁定测试 ProfessionalWorkstation.test.ts
> 交接背景：另有 agent 在同批档案做 className 设计系统迁移（rgba→token），本报告忽略 class 字串噪音，只论结构。

**总结论先行：巨档 NEED（分 5 刀增量拆）；其余 15 个支撑档全数 SKIP（已是既定拆分模式的成品）；测试档是字串 regex 契约，拆分按其内建机制加一行模组名即可续命，不会炸。**

**重要修正**：目录中没有 panels/ 子目录——LoraLibraryPanel 等 4 个面板平铺在 pro-workstation/ 根目录。

---

## 1. InvokeInspiredWorkstation.tsx（3873 行）— NEED 拆

**汇出**：`InvokeInspiredWorkstation`（L188，唯一函数，3685 行）＋ 2 条 re-export（L184-185，ImagePlayground 依赖，必须留在入口）。
**被 import**：ImagePlayground.tsx（L48 type、L55 dynamic、L572 使用）、3 个 test 档（ProfessionalWorkstation / ImagePlayground / PricingSync）。dynamic() 懒载入 → 入口 chunk 边界已存在，拆出的子模组自动跟 chunk 走。
**规模**：58 useState／24 useEffect／10 useMemo／32 useEventCallback／26 useRef／1 useCallback = **151 个 hooks 单函数**；props 14 个（L188-204）。

### 1.1 职责清单（实际承担 9 种）

| # | 职责 | 行区段 | 约行数 |
|---|------|--------|------|
| 1 | import + re-export 层 | L1-186 | 186 |
| 2 | 草稿/布局持久化 + 模型参数收敛 effects | L205-395 | ~190 |
| 3 | LoRA 引导联动（tour 推进/选卡完成） | L397-490 | ~95 |
| 4 | 通知系统 + 派生状态（结果/槽位/进度/ETA） | L504-810 | ~305 |
| 5 | 生成编排（buildRunConfig/run/retry/applyScenario/undoTemplateApply/brand/regional） | L803-1234 | ~430 |
| 6 | 板夹/快照 CRUD + 汇出（boards/shots） | L1235-1455 | ~220 |
| 7 | 画布标注引擎（paint/repaint/zoom/pan/undo/export） | L1473-1798 | ~325 |
| 8 | 溯源回填（provenance/workflow recall/历史还原） | L1799-1968 | ~170 |
| 9 | 面板缩放引擎 + 命令派发 + 键盘热键 | L1969-2250 | ~280 |
| 10 | 主 JSX：顶栏 L2251-2450／左栏 L2455-2994（prompt tab L2514 / assets tab L2721 / settings tab L2807）／画布 L3011-3431／检查器 L3432-3767（queue L3506 / gallery L3580 / history L3691）／portal L3768-3872 | L2251-3872 | **1621** |

### 1.2 最大 JSX 嵌套区段
左栏 prompt tab（L2514-2720，206 行）与画布 actual-size 检视（L3047-3431，384 行）为最深最长两块。

### 1.3 24 个 useEffect 摘要（行号 → 用途）
模型参数重置 L327｜草稿落盘 L333｜beforeunload L344｜布局落盘 L355｜尺寸收敛 L378｜画质收敛 L390｜LoRA tour 旗标 L397｜模型选单/tour 推进 L414｜LoRA 选卡完成 L465｜通知自动关 L515｜跑表 L621+L629｜手机阶段同步 L759｜自动选最新成片 L771｜失效选中归位 L789｜LoRA 清理 L797｜zoom 复位 L1592+L1596｜非 passive wheel L1606｜首载 brand/boards L2069｜手机滚顶 L2076｜缩略图并行载入 L2081｜全域热键 L2196｜灯箱键 L2229。

### 1.4 自然切割缝（沿既有模式：hooks→.ts、面板→props 驱动 memo 元件、资料重面板→dynamic()）

新档按建议拆出顺序：

1. **`src/components/pro-workstation/use-canvas-annotation.ts`**（~340 行）
   搬：L492-533 相关 refs（strokesRef / currentStrokeRef / canvasSizeRef / isDrawingRef / hasAnnotationRef / lastPointRef / annotationCanvasRef / baseImageRef / canvasViewportRef）＋ L1473-1798 全部标注/缩放/平移函数（paintStroke / repaintAnnotations / syncAnnotationCanvasSize / annotationPoint / zoomAtPointer / resetZoom / startPan / movePan / endPan / drawAnnotationSegment / handleAnnotationPointerDown/Move/Up / undoAnnotation / clearAnnotation / canvasToBlob / exportAnnotationToReference）＋ effects L1592-1612。
   形式：custom hook，回传 API 物件（handlers + zoom state）。

2. **`src/components/pro-workstation/use-panel-resize.ts`**（~160 行）
   搬：panelResizeRef（L286）、L1969-2104（startPanelResize / handlePanelResize / endPanelResize / nudgePanel / resetPanel / handleResizeKeyDown）＋布局落盘 effect L355-366 与 readLayoutPrefs/writeLayoutPrefs 接线。

3. **`src/components/pro-workstation/use-boards-library.ts`**（~300 行）
   搬：L1235-1455（refreshBoards / handleCreateBoard / handleDeleteBoard / handleDeleteActiveBoard / saveResultToBoard / handleMoveShot / handleToggleStar / handleDeleteShot / downloadShot / handleExportBoard）＋ L2081-2104 缩略图并行载入 effect ＋ shotUrls / shotUrlPendingRef 状态。
   消费端：BoardsPanel 已存在于 workstation-subcomponents.tsx。

4. **`src/components/pro-workstation/workstation-recall.ts`**（~180 行）
   搬：L1799-1968（buildProvenanceConfig / copyProvenanceConfig / applyWorkflowRecallConfig / restoreProvenanceConfig / restoreProvenanceConfigFromPng / restoreHistoryEntry）。
   解耦方式：以 setter 物件参数化（模型/提示词/参数回写）。

5. **`src/components/pro-workstation/panels/`** 新目录（沿用根目录平铺亦可）：
   - `WorkstationTopbar.tsx` ← L2251-2450（~200 行）
   - `LeftPromptTab.tsx` ← L2514-2720（~206 行）
   - `LeftSettingsTab.tsx` ← L2807-2994（含模型列 / LoRA / 张数）
   - `CanvasStage.tsx` ← L3011-3431（消费 hook #1 的 API）
   - `InspectorPanel.tsx` ← L3432-3767（queue / gallery / history 三 tab）

   全部 props 驱动 + memo，照 HistoryInspectorPanel 模板写。

6. **旧档保留**：props 解构、未被搬走的状态声明、派生值（L534-810）、生成编排（L803-1234 职责 5——闭包跨越 15+ 状态，最后拆或不拆）、executeCommand（L2129-2195 引用 20+ handler，可先留）、主 JSX 组装骨架、re-export L184-185。
   预估入口降至 ~1200-1500 行。

---

## 2. 既有拆分模式档案群 — 全部 SKIP

| 档案 | 行数 | 内容地图 | 判定 |
|------|------|----------|------|
| workstation-constants.ts | 341 | types L23-31/217/243/295/310、选项表 L52-206、localStorage 读写 L225-272、useEventCallback L320、waitForSelector L327 | **SKIP**（大而内聚）。小瑕疵：useEventCallback/waitForSelector 是执行期工具混在常量档，属 NICE 级可挪走，不急 |
| workstation-subcomponents.tsx | 433 | dynamic() 包装 L18/L38、StyleGrid L47、DraggableReferenceTile L174、QueueSlotList L244、BoardsPanel L294、共用 types L120/L145/L235 | **SKIP**——这就是「共享叶元件 + 懒载入面板」模式本体；新面板勿塞进来，另起 panels/ |
| workstation-tours.ts | 523 | createWorkstationTours 工厂 L36（driver.js 引导） | **SKIP** 已内聚 |
| workstation-sources.ts | 88 | 纯资料（开源授权归属），零逻辑 | **SKIP** |
| workstation-cursor-demo.ts | 165 | 假滑鼠演示 runner，纯逻辑无 UI | **SKIP** |
| workstation.css | 7 | @import 入口（part-01..05） | **SKIP** 模式正确 |
| workstation-part-01~05.css | 754-912/档 | 纯选择器资料，无逻辑；按层叠顺序切分 | **SKIP** 已是成品；part-06 档名已被测试预留（existsSync 跳过不存在档） |

### 面板 4 档

| 档案 | 行数 | 结构 | 判定 |
|------|------|------|------|
| LoraLibraryPanel.tsx | 390 | 自带 types L8-45、分页/排序常量 L47-54、主元件 L65 | **SKIP** |
| TemplatePanel.tsx | 296 | 自带 types L19-44、default export L46 | **SKIP** |
| CreatorResourcePanel.tsx | 210 | 纯模板过滤/展示逻辑 L14-48、memo 元件 L48 | **SKIP** |
| HistoryInspectorPanel.tsx | 215 | 适配函数 L42-63、memo 包装 L215 | **SKIP** |

各自自带 types + 本地 state + props 介面；CreatorResource/Template 走 dynamic()。均低于 400 行且模板成熟——**巨档拆出的新面板直接抄这个模板**。

### 外部耦合警示

- `src/components/canvas/CanvasNodeView.tsx L18` import 了 workstation-constants 的 REFERENCE_IMAGE_ROLES——**constants 档不可改名/搬路径**，否则炸画布域。
- 入口 re-export（L184-185）被 ImagePlayground type import 依赖，必须留在入口档。

---

## 3. ProfessionalWorkstation.test.ts（939 行）— 拆分的护栏而非炸弹

**性质：100% 原始码字串断言，零渲染零 mock**。node:test + readFileSync；30 个 test、498 条断言（436 assert.match／45 doesNotMatch／10 ok／7 equal）。断言对象：中文文案契约、禁用词表、CSS 选择器与 grid 模板、JS 符号存在性（applyCreatorResource / renderBoardsPanel / saveResultToBoard…）。

### 3.1 内建拆分容错（L11-37 注释明说设计意图）

- `read(入口)` = 入口 + WORKSTATION_TSX_MODULES 5 档（entry / constants / subcomponents / tours / cursor-demo）按序拼接；CSS 同理（workstation.css + part-01..06，不存在的 part-06 自动跳过）。
- **拆分行为契约：每拆一个新 tsx/ts 档 → 在 WORKSTATION_TSX_MODULES 数组加一行路径（新 CSS 加进 CSS 数组），断言即继续覆盖新档，一字不改。**
- 顺序敏感断言（跨行 `[\\s\\S]`）：L613（assets tab 在 ReferenceImageUpload 前）、L706（run() → setInspectorExpanded(true)）、L707、L766、L772（pro-left-panel → pro-model-row → pro-prompt-input → pro-run-bar 相对顺序）、L846。**入口恒排第一**，只要被断言的两段程式码相对先后不倒转即安全；把 JSX 区段搬到 panels/ 时保持同序追加即可。
- 符号名即契约：搬函数**不得改名**（renderBoardsPanel L447、run L706、applyCreatorResource L96-98 等被逐名断言）。

### 3.2 测试现况与拆分后的跟法

- 覆盖此域的测试档：ProfessionalWorkstation.test.ts（主）、ImagePlayground.test.ts（入口间接）、PricingSync.test.ts（入口间接）。
- 拆分后：无需改写任何断言；仅维护两个模组数组。断言是文字级的——符号名 + 文案 + CSS 规则原样搬家即全绿。

---

## 4. 风险清单（按杀伤力排序）

1. **闭包共享**：全部 handler 闭包引用 58 state + 26 ref。拆 hooks 时必须整组搬 refs + effects，回传 API 物件；漏搬一个 ref 即闭包失效（症状：标注画布错位、缩放残留）。
2. **useEffect 声明顺序**：React 按声明序执行；拆成 hooks 后呼叫顺序须保持原相对顺序（尤其 L327 模型重置 → L378 尺寸收敛 → L390 画质收敛链）。
3. **测试模组数组漏更**：新档未加进 WORKSTATION_TSX_MODULES → 该档内所有被断言符号的 match 立即失败（红灯明显，不会静默漏检——设计如此）。
4. **跨行顺序断言倒转**：JSX 区段搬出时把「A 在 B 前」的两段分置两档且顺序翻转。入口恒第一，风险系数低，但需自查 L613/L706/L707/L766/L772/L846 六条。
5. **CSS 选择器**：.pro-* 全域类名被 45+ 条样式断言钉死；迁移时类名逐一保留（与并行中的 rgba→token 迁移正交，互不干扰）。
6. **useEventCallback 稳定引用**：拆出的 hooks 必须继续用它包装回调，否则下游 effect 依赖数组行为改变。
7. **re-export L184-185**：留在入口档尾，ImagePlayground 的 type import 依赖它。
8. **constants 档路径冻结**：CanvasNodeView 外部引用，不可动。

---

## 5. 工作量与建议顺序

| 刀 | 档案 | 量级 |
|----|------|------|
| 1 | use-panel-resize.ts（最自闭、零测试符号耦合） | S（<半天） |
| 2 | use-canvas-annotation.ts（自闭但 refs 多） | M（1 天） |
| 3 | use-boards-library.ts（含 1 个 effect） | M（1 天） |
| 4 | workstation-recall.ts（setter 参数化） | M（1 天） |
| 5 | panels/ 五个 JSX 面板（量最大、机械性强） | L（2 天+） |

每刀落地 = 搬码 + 测试数组加一行 + `node --test` 全绿才收。

---

## 6. 诚实结论（逐档一词）

| 档案 | 结论 | 理由 |
|------|------|------|
| InvokeInspiredWorkstation.tsx | **NEED** | 3685 行单函数、151 hooks、9 种职责，且专案已有被测试架构明确支持的增量拆分模式，继续膨胀只会让每次改动都全档重编辑 |
| workstation-constants.ts | **SKIP** | 341 行大而内聚（useEventCallback 挪走属 NICE，不急）；且被 canvas 域外部引用，路径冻结 |
| workstation-subcomponents.tsx | **SKIP** | 433 行，共享叶元件 + dynamic 模式本体，再拆是负价值 |
| workstation-tours.ts | **SKIP** | 523 行已内聚的引导工厂 |
| workstation-sources.ts | **SKIP** | 88 行纯资料 |
| workstation-cursor-demo.ts | **SKIP** | 165 行纯逻辑 runner |
| workstation.css + part-01~05.css | **SKIP** | 已按层叠序切好的纯选择器资料 |
| LoraLibraryPanel.tsx | **SKIP** | 390 行成熟面板模板 |
| TemplatePanel.tsx | **SKIP** | 296 行成熟面板模板 |
| CreatorResourcePanel.tsx | **SKIP** | 210 行成熟面板模板 |
| HistoryInspectorPanel.tsx | **SKIP** | 215 行成熟面板模板 |
| ProfessionalWorkstation.test.ts | **SKIP**（不拆不改） | 仅在每次拆分时往两个模组数组各加一行；它是设计来陪拆分长大的 |
