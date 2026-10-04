# 巨档重构实施方案（>1000 行档案治理）

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 6 个 NEED 级巨型档案按既有拆分模式增量拆解，消除改动摩擦与合并冲突热点，全程零 API 变化、测试护栏全绿。

**Architecture:** 三层既定模式贯穿全程——lib 纯函数（资料分片 + barrel）→ hooks 组装（职责域拆 hook）→ components 呈现（props 驱动 memo 面板）。旧档一律保留为汇出点（barrel / re-export），54 个 importer 零改动。

**Tech Stack:** Next.js 15 App Router、React 19、TypeScript、node:test 契约测试（读源码 regex 断言）。

**依据:** `docs/plans/analysis/{canvas,workstation,core,input}-domain.md`（4 份解剖报告，含行级结构地图与符号清单）。

---

## 前置条件（Phase 0）

1. rgba→token 设计系统迁移（3 个 subagent 进行中）**已落库并部署**——重构与迁移触同一批行，顺序颠倒= rebase 地狱。
2. 基线全绿：`npx tsc --noEmit` && `npm test`（747 test）&& `npm run build`。记下基线测试数，每个 Task 收尾必须回到同数或更多。
3. 全程约束（每个 Task 都适用）：
   - 符号名即契约：搬运**不得改名**（ProfessionalWorkstation.test.ts 逐名断言 498 条）。
   - 路径冻结：`workstation-constants.ts` 不可搬/改名（canvas/CanvasNodeView.tsx L18 跨域 import REFERENCE_IMAGE_ROLES）；`generation-model-catalog.ts`、`use-cases.ts`、`use-canvas-chat.ts` 档名保留作 barrel。
   - CRLF 档案（use-cases / catalog / openapi route）搬移时保持行尾一致，否则 git diff 整档标红。
   - 每个 Task = 一个 commit；commit 前跑该 Task 的测试命令 + `npx tsc --noEmit`。

## 优先级矩阵

| 档案 | 行数 | churn | 判定 | 工作量 | Task |
|---|---|---|---|---|---|
| src/lib/use-cases.ts | 5396 | 3 | NEED | S | 1 |
| src/lib/generation-model-catalog.ts | 1331 | 7 | NEED | M | 2 |
| src/components/PromptInput.tsx | 1207 | 7 | NEED | S→S-M→M | 3/6/9 |
| src/components/pro-workstation/InvokeInspiredWorkstation.tsx | 3873 | 2 | NEED | S/M/M/M/L | 4 |
| src/hooks/use-canvas-chat.ts | 1417 | 3 | NEED | M | 5 |
| src/components/canvas/CanvasEmbed.tsx | 2149 | 5 | NEED | M | 7 |
| src/components/canvas/CanvasNodeView.tsx | 1044 | 4 | NICE | S-M | 11 |
| src/components/ImagePlayground.tsx | 921 | — | NICE | M | 10 |

**SKIP 清单（明确不拆，拆了是负价值）:** CanvasImageEditorDialog.tsx（五模式共享底座，像素纯函数已外移）、openapi.json/route.ts（单一 spec 字面量+读源码测试耦合，端点翻倍再议）、workstation 15 个支撑档（既定模式成品）、use-agent-chat（边界干净）。**重访触发器:** SKIP 档 churn 翻倍或单模式膨胀时重评。

---

## Phase 1：纯资料分片（零风险，两 Task 可并行）

### Task 1: use-cases.ts 按域分片（S，半天）

**Files:**
- Create: `src/lib/use-cases/types.ts`（L8-55 六个 interface）、`src/lib/use-cases/base-<domain>.ts` × 17（anime/architecture/automotive/content/design/ecommerce/education/fashion/finance/gaming/health/marketing/personal/photography/training/travel/ui，每片 6 条 entry 约 310 行）
- Modify: `src/lib/use-cases.ts` → 瘦身为 40 行 index（import 全部分片 + USE_CASES 聚合 L5363-5371 + getUseCase/relatedUseCases/replaceAuthorUrl L5373-5396）

**Steps:**
1. 先写汇总契约测试 `src/lib/use-cases.test.ts`：总数 ≥102、slug 全域唯一、getUseCase/relatedUseCases 行为不变（这是搬移正确性的钉子）。跑一次绿（对旧档）。
2. 机械搬移：每域 6 条 entry → base-<domain>.ts，型别改从 `./use-cases/types` 引。`BASE_USE_CASES` 无外部引用，各分片直接汇出各自阵列。
3. 旧档改 index，汇出面完全不变（6 interface + USE_CASES + 3 函数）。3 个真实消费者（use-cases/[slug]/page.tsx、sitemap.ts、UseCaseLinks.tsx）零改动。
4. reddit-* 分片的 `import type { UseCase } from "./use-cases"` 不动（type-only 循环无害）。
5. 验证：`npx tsx --test src/lib/use-cases.test.ts src/lib/reddit-use-cases.test.ts` + tsc。全绿 commit：`refactor: split use-cases.ts into 17 domain shards (5396→40 lines)`。

### Task 2: generation-model-catalog 六模组切分（M，1 天）

**Files:**
- Create: `src/lib/generation-model-catalog/{types,catalog,pricing-overrides,capabilities,pricing,resolution}.ts`
  - types.ts ← L56-167（型别 + 比例常量，`as const` readonly 推导原样保留）
  - catalog.ts ← L169-831（46 模型定义）+ L1-3 build-cache-bust 注解随迁（Vercel stale 快取绕过，刻意保留）
  - pricing-overrides.ts ← L846-990（**唯一全域状态拥有者**：effectiveCatalog/activeOverrides/pricingRevision/pricingListeners + apply/subscribe）
  - capabilities.ts ← L992-1180（20+ 查询/投影/normalize，**单向 import pricing-overrides**，严禁循环）
  - pricing.ts ← L1184-1244（generationCredits/generationCoins/modelPriceLabel）
  - resolution.ts ← L1245-1331（resolve*/SUPPORTED_IMAGE_SIZES/换算）
- Modify: `src/lib/generation-model-catalog.ts` → 纯 re-export barrel（57 个 export 原名原路径；IMAGE_MODEL_IDS 等 3 个转发 L833-835 留在 barrel）

**Steps:**
1. 搬 types.ts → catalog.ts → pricing-overrides.ts → capabilities.ts（单向依赖链依序落地，每步 tsc）。
2. **最大雷自查**：grep 确认 `effectiveCatalog` 只在 pricing-overrides.ts 出现模组级声明——两份真相= admin 改价后计费与选单分裂。
3. barrel 化，54 个 importer 一行不改。测试 import 带 `.ts` 副档名，实跑确认解析。
4. 验证：`npx tsx --test src/lib/generation-model-catalog.test.ts src/lib/generation-model-catalog.pricing.test.ts src/lib/generation-core/batch-service.test.ts src/components/PromptInput.test.ts src/app/api/admin/model-pricing/route.test.ts` + tsc。commit：`refactor: split generation-model-catalog into 6 modules with barrel (54 importers untouched)`。

---

## Phase 2：hooks 抽取（无 JSX 移动，测试影响最小；Task 3/4/5 不同档案可并行）

### Task 3: PromptInput 抽 3 个 hooks（S，半天）

**Files:**
- Create: `src/components/prompt-input/use-pixai-tools-panel.ts`（PIXAI_RATIO_* 常量 L142-149 + edit/upscale 10 state + pickSourceFile/handleEditSubmit/handleUpscaleSubmit L414-494 → 收敛成 usePixaiEdit()/usePixaiUpscale()）、`use-agent-hint.ts`（AGENT_HINT_SEEN_KEY + 3 state + timer + 3 effect L312-360）、`use-height-lock.ts`（contentRef/contentHeight/measureContentHeight + 2 effect L264-293）
- Modify: `src/components/PromptInput.tsx`（壳接线；**AgentChatSurface 懒载入必须留在本档**，L70-71 注解明载；高度锁测量根必须仍是包含所有模式面的同一 section DOM 节点）

**Steps:**
1. 逐 hook 抽取（pixai → hint → height-lock），每抽一个跑 `npx tsx --test src/components/PromptInput.test.ts`（19 test 读源码 regex——**纯逻辑符号搬家断言多半仍指向旧档**，把测试 read 路径改成新档+旧档拼接，语义不放宽）。
2. agentHintSuppressed 被 generate/edit/upscale 三条送出路径闭包共享——hook 回传 suppress() 统一下发。
3. tsc + PromptInput 测试绿 → commit：`refactor: extract 3 hooks from PromptInput (state/logic layer)`。

### Task 4: InvokeInspiredWorkstation 前 4 刀（S+M+M+M，每刀独立 commit）

**Files（依刀序）:**
1. `src/components/pro-workstation/use-panel-resize.ts`（~160 行）← panelResizeRef L286 + L1969-2104 六个 resize 函数 + 布局落盘 effect L355-366 + read/writeLayoutPrefs 接线。最自闭、零测试符号耦合，先做。
2. `src/components/pro-workstation/use-canvas-annotation.ts`（~340 行）← 9 个 refs（L492-533 strokesRef 等）+ L1473-1798 全部标注/缩放/平移函数 + effects L1592-1612。回传 API 物件（handlers + zoom state）。
3. `src/components/pro-workstation/use-boards-library.ts`（~300 行）← L1235-1455 板夹/快照 CRUD + 汇出 + L2081-2104 缩略图 effect + shotUrls/shotUrlPendingRef。BoardsPanel 已存在，直接消费。
4. `src/components/pro-workstation/workstation-recall.ts`（~180 行）← L1799-1968（buildProvenanceConfig/applyWorkflowRecallConfig/restore* 系列），setter 物件参数化解耦。

**Steps（每刀相同节奏）:**
1. 搬码：refs+effects+handlers **整组搬**（漏搬一个 ref = 闭包失效，症状是标注错位/缩放残留）；useEventCallback 继续包装回调（稳定引用，下游 effect 依赖行为不变）。
2. useEffect 声明顺序保持原相对顺序（L327 模型重置 → L378 尺寸 → L390 画质收敛链）。
3. **测试护栏**：新档加进 `ProfessionalWorkstation.test.ts` 的 WORKSTATION_TSX_MODULES 数组（一行），30 test 必须全绿——这是设计来陪拆分长大的机制，漏加会红灯（不会静默漏检）。
4. `npx tsx --test src/components/ProfessionalWorkstation.test.ts` + tsc → commit（如 `refactor: extract use-canvas-annotation from workstation (cut 2/5)`）。

### Task 5: use-canvas-chat 外围搬迁（M，1 天）——在 Task 7 之前定型介面

**Files:**
- Create: `src/hooks/canvas/canvas-chat-types.ts`（L385-459 卡片/专案类型 + L460-541 UseCanvasChatReturn 37 成员介面）、`canvas-reducer-adapter.ts`（L62-360 CanvasAction + canvasReducer，19 种 action 纯函数）、`canvas-project-sync.ts`（L954/991/1015 三个持久化 effect + refs）、`use-canvas-cards.ts`（L603-735 角色卡域）、`canvas-event-settler.ts`（L752-953 settle 对账逻辑）
- Modify: `src/hooks/use-canvas-chat.ts` 保留主体 + **re-export 全部原汇出**（37 成员 return 是隐式合约，ImagePlayground L132 等解构多）

**Steps:**
1. 先搬 types（零风险），旧档 re-export。
2. 搬 reducer-adapter 后**补 adapter 测试**（19 种 action 逐种驱动断言 state 转移——这是本 Task 唯一新增测试）。
3. 搬 project-sync（L1010 的 eslint-disable exhaustive-deps 依赖语义原样保留，注解随迁）、cards、event-settler。
4. `canvasRef.current = canvas` 同步 ref 模式：拆出 hook 回传 getter 或接收 ref 物件。
5. `npx tsx --test src/lib/canvas/*.test.ts` + 新 adapter 测试 + tsc → commit：`refactor: extract canvas-chat types/reducer-adapter/sync/cards/settler`。

---

## Phase 3：JSX 面板抽取（Task 6/7/8 不同档案可并行）

### Task 6: PromptInput 抽 EditPanel + UpscalePanel（S-M）

**Files:**
- Create: `src/components/prompt-input/EditPanel.tsx`（L855-937）、`UpscalePanel.tsx`（L939-1027）——自带 state+JSX 三元组最干净的两块，消费 Task 3 的 hooks。
- Modify: `src/components/PromptInput.tsx`（模式面分发）

**Steps:** 搬 JSX + 对应 handlers（props 驱动）；textarea 消散/重组 class 逻辑（prevDisplayModeRef）**保留在父层**——它依赖「切走时 state 未清」的单组件事实；PromptInput.test.ts 的 JSX 类断言（chip 尺寸/无分隔线/断点）read 路径同步。测试+tsc 绿 commit。

### Task 7: CanvasEmbed 拆 embed/ 域（M，1 天）

**Files:**
- Create: `src/components/canvas/embed/embed-helpers.ts`（L72-212 纯函数+UI types+AGENT_AUTO_APPROVE_KEY）、`use-canvas-generation.ts`（L621-1002 生成编排链 + abortRef）、`use-canvas-interaction.ts`（L227-237+L378-620/954-1077 选取/框选/连线/埠拖拽/对齐）、`use-canvas-shortcuts.ts`（L1299-1402 键盘+剪贴簿 effects）、`CanvasEmbedOverlays.tsx`（L1859-2068 四个浮层：agent 确认闸/角色卡/历史/节点清单）、`context-menu-items.ts`（L1079-1228 menuItems 工厂）
- Modify: `src/components/canvas/CanvasEmbed.tsx` 保留组件壳+节点挂载+顶栏（预估 2149→~600 行）

**Steps:**
1. 先搬 helpers（零风险）→ shortcuts → interaction → generation → overlays，每步 tsc。
2. 52 个 useCallback 链：依赖阵列整组随函数搬迁；10 个「最新值镜像 ref」（L250-266）改由 hook 回传。
3. L1563-1632 内嵌 `<style>` 的 `.ce-embed-*` 选择器与浮层同迁移（漏搬=样式失效）。
4. menuItems 工厂化后显式传参（原 useMemo 闭包捕获 20+ handlers）。
5. 唯一使用点是 ImagePlayground 的 dynamic import——路径不变则零影响。验证：`npx tsx --test src/components/ImagePlayground.test.ts`（11 test 只测 shell，不渲染内部）+ tsc → commit。

### Task 8: workstation panels/ 五面板（L，2 天+，最大单 Task）

**Files:**
- Create: `src/components/pro-workstation/panels/{WorkstationTopbar,LeftPromptTab,LeftSettingsTab,CanvasStage,InspectorPanel}.tsx` ← 分别对应 L2251-2450 / L2514-2720 / L2807-2994 / L3011-3431 / L3432-3767
- Modify: `InvokeInspiredWorkstation.tsx` 保留 props 解构+未搬 hooks+派生值+生成编排（L803-1234 闭包跨 15+ 状态，最后拆或不拆）+executeCommand+JSX 组装骨架+re-export L184-185（ImagePlayground type import 依赖）。入口预估 3873→~1200-1500 行。

**Steps:**
1. 照 HistoryInspectorPanel 模板写（props 驱动 + memo）；CanvasStage 消费 Task 4 刀 2 的 annotation API。
2. **顺序敏感断言护栏**：跨行 `A 在 B 前` 断言（L613/706/707/766/772/846 共 7 处）——入口恒排第一，JSX 区段搬出时保持相对先后（leftPanel 链：pro-left-panel→pro-model-row→pro-prompt-input→pro-run-bar）。
3. 每个面板落地下下来就加进 WORKSTATION_TSX_MODULES + 跑 30 test。
4. `.pro-*` 全域类名 45+ 条样式断言钉死——className 逐一保留。
5. 五个面板各自独立 commit，任一红灯停手回滚该面板。

---

## Phase 4：NICE 级（时间盒允许才做）

### Task 9: PromptInput GenerateControls + ActionRow（M）
L710-853 设定 rails + L1073-1203 动作列 → 两个面板；**同步改写 19 个契约测试**（JSX 断言最脆，此 Task 测试改写量最大，故排最后）。

### Task 10: ImagePlayground 抽 CanvasChatWorkstation（M）
`src/components/canvas-workstation/CanvasChatWorkstation.tsx` ← L598-706 的 108 行 inline `<style>`（含 `.agent-composer-anchor` 跨档作用于 AgentChatPanel——style 块必须跟 overlay 生命周期同迁）+ L711-723 overlay + L734-872 面板壳/拖宽手柄 + `use-chat-panel.ts`；`src/hooks/use-agent-param-reflect.ts` ← L279-371 三态复原 + AGENT_PARAM_LABELS。旧档预估 921→~420 行。**不动**模式状态机/triggerTransition 时序/canvasHostRef 解环顺序（L116-133）。

### Task 11: CanvasNodeView（S-M）
`node-view/constants.ts`（STATUS_*/TYPE_*/RESIZE_HANDLES）+ `use-node-gestures.ts`（L233-421 三套指标手势）+ `NodeBody.tsx`（renderBody+renderPlaceholder）。props drilling 46 个介面债顺手还；不引入 context（避免 memo 失效）。

---

## 执行顺序总览

```
Phase 0: lg-* 迁移落库部署 + 基线绿（前置）
Phase 1: [Task 1 ‖ Task 2]                          （纯资料，并行）
Phase 2: [Task 3 ‖ Task 4(刀1-4) ‖ Task 5]          （hooks，并行；不同档案集）
Phase 3: [Task 6 ‖ Task 7 ‖ Task 8]                 （JSX；T5 必须先于 T7）
Phase 4: [Task 9/10/11 按余力]                       （NICE）
```

**总工作量:** NEED 约 6-8 个工作日（1 人），并行（3 agent）约 2-3 天。每 Task 独立 commit、独立可回滚、独立验证——任何时刻中断都不留半成品。

## 全域验收证据（每 Task 收尾 + 最终）

- `npx tsc --noEmit` 零错
- `npm test` 全绿且数量 ≥ 基线（747）
- `npm run build` 成功
- 每个 NEED 档案行数对照：use-cases 5396→~40、catalog 1331→barrel、PromptInput 1207→~450、workstation 3873→~1300、use-canvas-chat 1417→~500、CanvasEmbed 2149→~600
- 最终一轮 `vercel --prod` 部署，视觉验收归用户

## 风险登记册（跨 Task 通用的十条）

1. 闭包共享：workstation 58 state/26 ref、CanvasEmbed 52 callback 链——搬迁整组走，漏一个 ref 即行为异常
2. useEffect 声明序 = 执行序，hooks 化后呼叫顺序保持原相对顺序
3. 契约测试读源码：搬家即红——read 路径同步是每个 Task 的必修步，语义禁止放宽
4. pricing-overrides 单一状态拥有者，capabilities 单向 import，禁止循环
5. 路径冻结：workstation-constants / 三个 barrel 档名
6. 符号名冻结：被逐名断言的函数（renderBoardsPanel/run/applyCreatorResource…）
7. 内嵌 `<style>` 选择器与其作用 DOM 同迁移（.ce-embed-*、.agent-composer-anchor）
8. CRLF 行尾档案搬移保持一致
9. build-cache-bust 注解随 catalog.ts 保留
10. 动态 import 边界（dynamic() 懒载入）是天然 chunk 边界，新路径不改 import 方式

---

**Plan complete. Two execution options:**
1. **Subagent-Driven（本 session）** — 我每 Task 派 fresh subagent，Task 间审查，快速迭代
2. **Parallel Session（独立 session）** — 新 session 用 executing-plans 逐 Task 执行，批量推进

（建议：Phase 1 两个纯资料 Task 先走 Subagent-Driven 试水，模式验证后其余批量。）
