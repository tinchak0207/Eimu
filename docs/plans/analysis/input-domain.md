# 主画布输入域解剖报告（只读分析，未动任何档案）

**结论先行：PromptInput = NEED（必须拆，9 种职责）；ImagePlayground = NICE（唯一干净缝是画布工作站）；两者边界「没有糊掉」——是父子状态分工，真正的重复心智模型是「两条并存的生成管线」（父层 useImageGeneration 伫列 vs 子层直连 PixAI API），但这是注解明载的刻意设计（ImagePlayground L103-104）。**

最大隐性风险（先讲，因为它改变拆分成本）：**两档的测试全是「读原始码文字 + regex 断言」的契约测试**（`readFileSync(join(process.cwd(), "src/components/PromptInput.tsx"))` 后 `assert.match(source, /handleStyleChange/)`，PromptInput.test.ts L6-17；ImagePlayground.test.ts 同款 L11/31/73）。任何符号搬家 = 测试同步改读取路径，共 19+11 个 test 全数受影响。

---

## 一、src/components/PromptInput.tsx（1207 行）

### 1. 职责清单（实际 9 种）
1. 型别与 props 契约：L44-114（`PromptInputMode` 汇出型别 L49、30 个 props 的 interface L51-114）
2. 常量与 dynamic import 层：L116-200（`LABEL_CLASS/RAIL_CLASS/ROW_CLASS` L120-138、PixAI 比例常量 L142-149、`AGENT_HINT_SEEN_KEY` L139、`ReferenceImageUpload`/`AgentChatSurface` 懒载入 L161-188、**死码 `AGENT_SURFACE_HEIGHT` L197**——仅注解引用）
3. 高度锁测量系统：L264-293（实测 generate/edit 自然高并锁为全模式外框高，含 resize 监听）
4. D-24 渐进披露提示：L312-360（3 state + timer ref + sessionStorage，与送出路径交叉抑制）
5. **改图完整管线**：L248-252 state + L414-426 选档 + L428-462 `handleEditSubmit`（uploadMedia→runEdit→结果）
6. **放大完整管线**：L253-257 state + L464-494 `handleUpscaleSubmit`
7. 参考图拖拽/粘贴入口：L515-560（dragDepthRef 深度计数 + Ctrl+V 拦截）
8. generate 设定 rails：L710-853（示例/模型/比例/画质/时长/音讯/风格，~143 行 JSX）
9. 模式面 JSX + 动作列：edit 面 L855-937、upscale 面 L939-1027、agent 面宿主 L1038-1059、底部模式切换/CTA 列 L1073-1203（~130 行）

### 2. 内部结构地图
| 行区段 | 区块 |
|---|---|
| L1-42 | imports（22 个内部模组） |
| L44-114 | types（`PromptInputMode`、`PromptInputProps`） |
| L116-200 | 常量 + 2 个 dynamic import |
| L202-566 | 单一巨型组件主体（hooks + handlers，无子组件函数） |
| L568-1207 | JSX（640 行，最大巢状区 = generate 设定区 L710-853，5 层） |

### 3. 耦合
- 汇出：`PromptInput`、`PromptInputMode`。Importers：**仅 ImagePlayground.tsx**（单一消费者，无 barrel）
- 关键内部依赖：pixai-tools/shared（直连 API）、generation-model-catalog、prompt-compose、agent-chat-types
- **边界事实：10 个 props 是纯导管**（`onParamsReflected/onImageResult/onCanvasEvent/canvasStateProvider/onSessionChange/agentSeed/chatHeaderExtra/fillAvailableHeight/currentModelId` 等，L84-113 → L1045-1057 原样转发 AgentChatSurface）——PromptInput 是 agent 聊天 plumbing 的 pass-through 层
- CSS 耦合：`dust-exit/dust-enter/dust-enter-kf` 在 globals.css；`--agent-surface-height`（globals.css L905/910）的对应常量已死

### 4. Hooks/state
17 useState、7 useEffect、7 useCallback、5 useRef、1 useMemo（共 37 个 hook 呼叫）。useEffect 清单：displayMode 镜像 L260、高度测量 L286/L289、externalPrompt 注入 L306、agentHint sessionStorage L323、agentHint 计时 L332、suppress 解除 L348。

### 6. 自然切割缝（新路径 + 搬运清单）
| 新档 | 搬什么 | 旧档保留 |
|---|---|---|
| `src/components/prompt-input/use-pixai-tools-panel.ts` | `PixaiRatioKey/PixaiStage/PIXAI_RATIO_SIZES/PIXAI_RATIO_CHIPS`（L142-149）、edit/upscale 10 个 state、`pickSourceFile/handleEditSubmit/handleUpscaleSubmit`（L414-494）→ 收敛成 `usePixaiEdit()` / `usePixaiUpscale()` | props 介面与结果回呼接线 |
| `src/components/prompt-input/use-agent-hint.ts` | `AGENT_HINT_SEEN_KEY`、`agentHintOpen/Spent/Suppressed` 3 state + timer ref + `spendAgentHint` + 3 个 effect（L312-360） | 送出处呼叫 `suppress()` |
| `src/components/prompt-input/use-height-lock.ts` | `contentRef/contentHeight/measureContentHeight` + 2 effect（L264-293） | section 上的 ref/style 绑定 |
| `src/components/prompt-input/EditPanel.tsx` | edit 面 JSX L855-937 | — |
| `src/components/prompt-input/UpscalePanel.tsx` | upscale 面 JSX L939-1027 | — |
| `src/components/prompt-input/GenerateControls.tsx` | L710-853（示例/模型/比例/画质/时长/音讯/风格 rails） | — |
| `src/components/prompt-input/ActionRow.tsx` | 底部模式切换/已套用风格/专业模式 toggle/CTA L1073-1203 | — |
| 旧档 PromptInput.tsx | — | 保留：壳 + 高度锁绑定 + 模式面分发 + AgentChatSurface 宿主（懒载入必须留在这，L70-71 注解明载）+ 预期 ~450 行 |

### 7. 测试现况
PromptInput.test.ts：19 个 test 全读 `src/components/PromptInput.tsx` 原文做 regex 断言（如 L27 `onChange={handleStyleChange}`、L51-71 的 className 约束）。拆分后：读取路径需按符号新家改多档读取；**最省事顺序 = 先抽 hooks（纯逻辑层）再动 JSX**——JSX 类断言（chip 尺寸、无分隔线、断点）最脆。

### 8. 风险
1. 契约测试文字断言：搬家即红（上述 19 test）
2. `agentHintSuppressed` 被三条送出路径（generate/edit/upscale）闭包共享写入——拆成三个面板后 suppress 逻辑跨档，需经 props 或 context 下发
3. 高度锁测量根必须是包含所有模式面的同一 DOM 节点（L579 `ref={contentRef}` 的 section）——模式面抽成子组件不能改变测量根
4. `prevDisplayModeRef` 驱动的 textarea 消散/重组 class（L299-304）依赖「切走时 state 未清」的单组件事实——拆分需保持 input state 在父层
5. `fillAvailableHeight` 分支渗透 5 处（L274/584/601/700/1043）——工作站立场是隐式全局旗标，跨档后易漏

### 9-10. 工作量与结论
**NEED。** 顺序：①hooks 三连抽（S，半天，测试影响最小）→ ②EditPanel/UpscalePanel（S-M，自带 state+JSX 三元组最干净）→ ③GenerateControls/ActionRow（M，含 19 test 改写）。理由：1207 行里 640 行 JSX、9 种职责、churn 7；edit/upscale 管线是完全自含的切割单元，缝是真实的。

---

## 二、src/components/ImagePlayground.tsx（921 行）

### 1. 职责清单（7 种）
1. 模式状态机 + dust 转场时序：L84-86、L213-230（260/320ms setTimeout 链 + animState 闸）
2. 生成参数 state owner（全站参数唯一权威）：L95-102 + `handlePromptSubmit` L394-423（鉴权+余额+enhance+startGeneration）
3. 专业工作站挂载与执行：L82-83、L252-260、L570-591 + `handleProfessionalRun` L425-512（88 行 normalize/计价/送出）
4. D-12 参数回流三态复原：L279-371（agentBaseline/agentTouched/undo/restore + userSet\* 包装 setter）
5. 画布工作站：L103-139、L150-207（resultMode、chatPanel 两态+宽度+localStorage、canvasHostRef 循环依赖解环 L116-133、body scroll lock、黏性旗标）
6. 进度条时序编排：L136-139、L519-566（假进度时长/fallback 延长/揭图时机 + resultView 派生）
7. 页面版面 JSX：L568-921，含 **108 行 inline `<style>` L598-706**、PromptInput 50 行 props 接线 L798-849、案例区/SEO 隐藏区/浮动状态条

### 2-4. 结构与 hooks
无子组件、无汇出常量（除 `AGENT_PARAM_LABELS` L61-68）。27 useState、12 useEffect、16 useCallback、3 useRef、2 useMemo = **60 个 hook 呼叫**。汇出：`ImagePlayground`；Importer：仅 `src/app/page.tsx`。

### 与 PromptInput 的边界（回答「是否糊掉」）
**没有重复心智模型**：ImagePlayground 是参数/伫列/版面的 state owner，PromptInput 是输入卡——两者各 30/50 个 props 的接线（L798-849）是明确的所有权契约，不是复制。两个真正异味：(a) PromptInput 直连 PixAI API 旁路父层伫列（刻意，L103-104 注解：pixai 结果「不走正常生成伫列」，经 onEditResult/onUpscaleResult 回抛）；(b) PromptInput 对 agent 聊天 10 个 props 纯导管（见上）。`use-agent-chat` 边界干净：PromptInput 不 import 它，AgentChatSurface（被 PromptInput 懒载）才是其唯一 UI 消费者——无需动作。

### 6. 自然切割缝
| 新档 | 搬什么 |
|---|---|
| `src/components/canvas-workstation/CanvasChatWorkstation.tsx` | **L598-706 的 108 行 `<style>` + L711-723 overlay + L734-872 面板壳/拖宽手柄**，配 `use-chat-panel.ts`（chatPanelState/Width + localStorage 3 个 effect L176-193 + 拖宽 handlers L852-869） |
| `src/hooks/use-agent-param-reflect.ts` | L279-371 整段（agentBaseline/agentTouched/handleParamsReflected/undoAgentParam/restoreMyParams/userSet\*）+ `AGENT_PARAM_LABELS` |
| `src/components/playground/use-professional-run.ts` | `handleProfessionalRun` L425-512 + openProfessionalMode/LoRA tour armed 逻辑 L252-260 |

旧档保留：模式状态机、handlePromptSubmit、进度时序、首页版面与 PromptInput 接线、CaseShowcase/SEO 区，预期 ~420 行。

### 8. 风险
1. **`.agent-composer-anchor` 跨档 CSS 陷阱**：定义在 ImagePlayground inline style L662，却作用于 AgentChatPanel.tsx 内部——style 块搬家时这条必须跟著 overlay 生命周期走（AgentChatPanel 只在 agent 面渲染，恰好同域，但这是隐式耦合）
2. `canvasHostRef` 解环顺序：L116-133 先建 callback 后赋值 ref——拆工作站时 ref 指标必须仍在同一组件实例
3. `inCanvasWorkstation` 派生值（L194）同时驱动 body scroll lock、版面 grid 切换、面板壳、PromptInput fillAvailableHeight——四个消费点跨新旧档后要经 props 明示
4. userSet\* setter 身分依赖（memo 不失效设计，L262-268 注解）——抽 hook 时 `useCallback` 依赖阵列要原样保留
5. 测试：ImagePlayground.test.ts 11 个 test 断言 `inCanvasWorkstation = displayMode === ...`（L64）、`chatPanelState` useState 原文（L78-79）等——工作站抽走后这些断言全指向新档

### 9-10. 工作量与结论
**NICE。** M（1 天）——只做画布工作站单缝抽取（~300 行含 style），其余留在原地。理由：60 个 hook 由单一模式状态机串起，全面拆分收益低于闭包/setter 身分/时序链的回归风险；唯一自含且高频演进的区块是画布工作站。

---

## 建议总顺序（跨两档）
1. **S**：PromptInput 抽 3 个 hooks（use-pixai-tools-panel / use-agent-hint / use-height-lock）——零 JSX 移动、测试影响最小
2. **S-M**：PromptInput 抽 EditPanel + UpscalePanel（自含三元组）
3. **M**：PromptInput 抽 GenerateControls + ActionRow，同步改写 19 个契约测试读取路径
4. **M**：ImagePlayground 抽 CanvasChatWorkstation（含 style 块 + use-chat-panel）+ use-agent-param-reflect
5. 全程避开：不动模式状态机、不动 triggerTransition 时序、不把 AgentChatSurface 懒载移出 PromptInput
