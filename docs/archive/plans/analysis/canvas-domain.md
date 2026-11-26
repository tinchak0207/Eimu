# 巨档解剖报告：canvas 无限画布域

**总结论先行**：CanvasEmbed（NEED，必拆）、use-canvas-chat（NEED，但只拆 reducer 适配层外围）、CanvasNodeView（NICE）、CanvasImageEditorDialog（SKIP）。拆分应在设计系统迁移（rgba→token）完成后进行，否则同一批行会产生迁移冲突。

---

### 1. CanvasEmbed.tsx（2149 行，churn 5）— NEED 必拆

**职责清单（9 种）**：
- L80-187 工具函数（toDvh/formatRelative/imageUrlOf/safeFilename/fetchImageBlob/triggerDownload/buildAuthHeaders/fileToDataUrl/wouldCreateCycle）
- L97-112 `usePrefersReducedMotion` hook
- L189-212 本地 UI 类型（MenuState/EditorState/PortDragState/CreateMenuState）
- L214-243 状态树：21 个 useState + 15 个 useRef（含 10 个「最新值镜像 ref」）
- L275-302 派生资料 memo（nodeById/childToParent/adjacentIds/visibleNodes 视口裁剪）
- L323-377 尺寸量测/fit-once effects
- L378-1077 交互 handlers（选取/框选/复制贴上/对齐分布/连线/埠拖拽/右键选单）
- L621-1002 **生成编排**（callCanvasGenerate→generateIntoNode→handleGenerateFromNode→retryNode→upscaleNode→runAgentGeneration）——与 UI 无关的 API 编排逻辑
- L1004-1296 节点级动作（createNodeAt/importImageFiles/saveNodeAsCard/saveNodeToAssets）
- L1299-1402 键盘快捷键 + 系统剪贴簿 effects
- L1561-2149 JSX：内嵌 `<style>` 块（L1563-1632，70 行 CSS）+ 顶栏 + 角色卡面板（L1916-1985）+ 历史画布（L1988-2021）+ 节点清单（L2024-2068）+ agent 确认闸（L1859-1900）+ 错误 toast（L1903-1913）

**结构地图**：顶层仅 20 个声明——L58-212 是前导（types/常量/工具），**L214-2149 是单一 1935 行函数组件**（89 个内部声明、11 个 useEffect、52 个 useCallback/useMemo）。单函数体积就是主要问题。

**耦合**：汇出 `CanvasEmbedProps` + `CanvasEmbed`。仅 `ImagePlayground.tsx` L12 动态 import（`dynamic(..., {ssr:false})`，L721 使用）。内部依赖 10 个 canvas 子组件 + `use-canvas-chat` 的 `UseCanvasChatReturn`（37 个成员的巨型介面）+ semantic-nodes/character-cards/new-api-client。**外部依赖面窄（1 个使用点），拆分安全性高。**

**自然切割缝（建议 5 个新档）**：
1. `src/components/canvas/embed/embed-helpers.ts` — 搬 L72-187 纯函数（toDvh/formatRelative/imageUrlOf/safeFilename/fetchImageBlob/triggerDownload/buildAuthHeaders/fileToDataUrl/wouldCreateCycle）+ L189-212 四个 UI types + AGENT_AUTO_APPROVE_KEY
2. `src/components/canvas/embed/use-canvas-generation.ts` — 搬 L621-884 生成编排链（callCanvasGenerate/generateIntoNode/handleGenerateFromNode/stopGeneration/retryNode/upscaleNode）+ abortRef，输入 `canvas` 物件与 refs，回传 handlers 集合
3. `src/components/canvas/embed/use-canvas-interaction.ts` — 搬 L227-237 交互 state + L378-620/954-1077 选取/框选/连线/埠拖拽/对齐逻辑
4. `src/components/canvas/embed/use-canvas-shortcuts.ts` — 搬 L1299-1402 两个 window effect（键盘+剪贴簿）
5. `src/components/canvas/embed/CanvasEmbedOverlays.tsx` — 搬 L1859-2068 agent 确认闸/角色卡面板/历史画布/节点清单（4 个独立浮层，props 传递即可），内嵌 CSS（L1563-1632）移入 CSS module 或保留
6. L1079-1228 `menuItems`（150 行选单配置）→ `embed/context-menu-items.ts` 工厂函数

**旧档保留**：组件壳 + JSX 组装（visibleNodes.map 的 CanvasNodeView 挂载 L1678-1731）+ 顶栏。

**风险**：①52 个 useCallback 链彼此引用，抽 hook 时依赖阵列需整组搬迁；②10 个「最新值镜像 ref」（L250-266）模式被键盘 effect 依赖，拆开后 ref 生命周期须由 hook 回传；③L1563 内嵌 `<style>` 的 `.ce-embed-*` 选择器与浮层同迁移，漏搬会样式失效；④`menuItems` useMemo 闭包捕获 20+ handlers，改工厂后须显式传参；⑤唯一使用点是 dynamic import，路径别名不变则安全。

**测试**：`ImagePlayground.test.ts`（11 个 test）覆盖 shell 行为（overlay/expand/composer 位置），不直接渲染 CanvasEmbed 内部——重构可全走现有测试+ tsc + build 验证，无需新增测试即可安全搬迁。

**工作量 M（1 天）**。建议顺序 ①：churn 最高、单函数 1935 行已超可维护阈值，先拆。

---

### 2. use-canvas-chat.ts（1417 行，churn 3）— NEED（有限拆分）

**职责清单（7 种）**：
- L62-360 `CanvasAction` union + `canvasReducer` 适配器（273 行 switch：event/load/move/resize/remove/clear/batch_*/reference/move_many/add_nodes/delete_many/connect/disconnect/rename/patch_metadata/agent_ops 共 19 种 action）
- L361-384 `normalizeAgentNode`
- L385-431 卡片/专案类型（CanvasPlanCard/CanvasDeriveCard/CanvasBudget/CanvasProjectSummary/toProjectSummaries）
- L432-459 `compactMetadataForAgent` + 常量
- L460-541 `UseCanvasChatReturn` 介面（37 成员）
- L543-1417 hook 本体：**6 个域**——卡片管理（L603-735）、SSE 事件入口/最终一致性收敛（L750-953）、专案持久化 debounce（L976-1012）、快照上行（L1015+）、undo/redo 快照栈（L736-749）、视口/flyTo 动画、40+ 个动作 callbacks

**耦合**：汇出 canvasReducer/CanvasAction/UseCanvasChatReturn/各卡类型/useCanvasChat。被 ImagePlayground.tsx（L132）、CanvasEmbed.tsx、CanvasSidePanel.tsx（type-only）import。底层已正确委托 `src/lib/canvas/`（reducer/layout/client/character-card-client）——**纯函数层已存在，hook 只是组装**。

**自然切割缝**：
1. `src/hooks/canvas/canvas-reducer-adapter.ts` — 搬 L62-360（CanvasAction + canvasReducer，纯函数可直接加测试）
2. `src/hooks/canvas/canvas-project-sync.ts` — 搬持久化三 effect（列表载入 L954/储存 debounce L991/快照上行 L1015）+ buildProject/saveTimer/hydrated/everHadNodes refs
3. `src/hooks/canvas/use-canvas-cards.ts` — 搬 L603-735 角色卡域（characterCards/activeCardIds state + upsert/remove/toggle + 载入 effect）
4. `src/hooks/canvas/canvas-event-settler.ts` — 搬 L752-953 `handleCanvasEvent` 内的 settle 逻辑（isPendingSettledNode/settleNodeWithUrl/settleCandidateNode + imageDoneQueueRef 对账）
5. 类型搬 `src/hooks/canvas/canvas-chat-types.ts`（L385-459），旧档 re-export 保持相容

**旧档保留**：useCanvasChat 主体 + 视口/undo/动作 callbacks + return 物件。

**测试**：lib/canvas 已有 reducer.test.ts/layout.test.ts/project-store.test.ts。canvasReducer 适配器搬出后可在 `src/hooks/canvas/` 加 adapter 测试驱动 19 种 action；其余搬迁不破坏现有测试（路径 re-export 相容）。

**风险**：①`canvasRef.current = canvas` 等同步 ref 模式遍布——拆出的 hook 必须回传 getter 或接收 ref 物件；②持久化 effect 的 eslint-disable exhaustive-deps（L1010）搬迁时依赖语义易错；③return 物件 37 成员是隐式合约，消费端（ImagePlayground L132）解构多，**保留 `use-canvas-chat.ts` 作为唯一汇出点 + re-export** 可消解。

**工作量 M（1 天）**。顺序 ②。

---

### 3. CanvasNodeView.tsx（1044 行，churn 4）— NICE

**职责清单（6 种）**：L22-121 类型/标签映射常量、L122-168 图片 URL 工具（isUrl/thumbUrl/proxySrc/renderBrokenImage/formatProgress）、L181-502 拖拽/缩放引擎（dragRef/resizeRef/scrollDragRef 三套指标手势）、L422-502 renderPlaceholder、L503-692 renderBody（switch node.type 渲染图/视频/文本/占位）、L697-1044 节点壳 JSX（标题栏/状态徽章/hover 工具列 L875/提示词面板 L937）。

**耦合**：仅 CanvasEmbed import（InfiniteCanvas 只有注释提及）。46 个 props（L181-224）是介面债，但仅一个消费端。

**切割缝**：`node-view/constants.ts`（STATUS_COLOR/STATUS_LABEL/TYPE_LABEL/RESIZE_HANDLES）、`node-view/use-node-gestures.ts`（L233-421 三套指标手势）、`node-view/NodeBody.tsx`（renderBody+renderPlaceholder）、旧档保留壳与头部。

**风险**：props drilling 46 个——拆 NodeBody 需转发 20+ props，若用 context 则 memo 失效；CanvasNodeView 未包 memo（render 每次 map 重建），手势 hook 拆出后 pointer capture 逻辑与 JSX 绑定需同步搬。

**测试**：无直接测试档。**工作量 S-M（半天-1 天）**。顺序 ③：churn 4 但结构尚清晰，生成编排稳定后再拆。

---

### 4. CanvasImageEditorDialog.tsx（1004 行，churn 1）— SKIP

**职责清单（5 种）**：L35-103 模式/常量定义、L105-164 五模式 state 丛（22 useState）、L164-249 图片载入/座标换算、L280-531 五模式各自交互 handlers（crop 拖框/split 线拖/mask 画笔/rotate 角度）、L542-1004 JSX（5 个模式面板）。**所有像素操作已委托 `src/lib/canvas/image-edit.ts`（254 行，13 个汇出）**——这是五合一对话框，模式间共享 bmp/viewSize/座标系，切开会造成 5 份重复载入/量测逻辑。churn 1 证明它稳定。若未来单模式膨胀，先抽 `use-image-editor-state`（L115-160 state 丛）即可。

**工作量 S（仅 state 丛抽 hook 时）**。顺序 ④（或不做）。

---

### 5. 目录级建议（18 个中小档归属判断）

- `CanvasNodePromptPanel`（807 行）：维持独立，NodeView 拆分时其 props 介面不动。
- `CanvasSidePanel`（约 300 行）已只做 type-only import，use-canvas-chat 类型搬迁后零影响。
- **避免重复心智模型**：生成编排（embed/use-canvas-generation）**不得**并入 `semantic-nodes.ts`（那是纯函数域）；交互 hook 不得并入 `interaction.ts`（那是几何纯函数）。新目录 `src/components/canvas/embed/` 与 `src/hooks/canvas/` 各司其职，与既有 `lib/canvas/`（纯函数）形成三层：lib 纯函数 → hooks 组装 → components 呈现。

### 总顺序与依赖
① CanvasEmbed 拆分（M）→ ② use-canvas-chat 外围搬迁（M）→ ③ CanvasNodeView（S-M）→ ④ EditorDialog（SKIP/S）。①② 无相互依赖可并行，但都触及 `UseCanvasChatReturn` 介面，建议 ② 先定型介面搬移、① 后拆。**前置条件：等 rgba→token 迁移 agent 完成后再动**，否则 L1775+ 的大量 className 行会产生 rebase 地狱。

### 诚实结论
- **CanvasEmbed：NEED** — 单函数 1935 行、9 种职责、churn 5，生成编排与 UI 壳强耦合是每次改动的实际摩擦点。
- **use-canvas-chat：NEED** — 1417 行含 273 行可独立测试的 reducer 适配器 + 4 个可分离 effect 域，但保留原档作唯一汇出点。
- **CanvasNodeView：NICE** — 结构清晰、单消费端，46 props 介面债值得还但非紧急。
- **CanvasImageEditorDialog：SKIP** — 大而内聚：五模式共享载入/座标/量测底座，像素纯函数已外移，拆了更糟。
