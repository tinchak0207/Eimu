# traditional-vs-eimu 依据表

读取时间 2026-10-11 21:50 (UTC+8)。gateway 以 VPS `/opt/agent-harness/gateway/` 为准。本地 `deploy-staging/gateway/` 与 VPS md5 不同的文件：messages-gw.ts、subagent.ts、opencode-event-handler.ts、events-translate.ts、environment-facts.ts、types-gateway.ts；canvas-write-gate.ts 只在本地，VPS 上没有。下表这几份文件的行号都来自 VPS 文件，其余 gateway 文件两端 md5 相同。运行时底座以 VPS `/opt/agent-harness/workspace/` 为准，本地 `deploy-staging/opencode-runtime/AGENTS.md` 与 VPS 版本 md5 不同。

## 传统 agent（对照基线，不对应本仓代码）
| 节点 | 依据 |
|---|---|
| T1–T6 | 通用单会话循环示意，作对照用，没有对应的活代码 |

## Eimu
| 节点 | 一句依据 | 文件:函数/行 |
|---|---|---|
| A1 AGENTS.md | 注释写明 AGENTS.md 常驻 opencode environment.system，网关不重复贴 | VPS `/opt/agent-harness/workspace/AGENTS.md`；`messages-gw.ts` ~L700 注释（「AGENTS.md 常驻 environment.system」） |
| A2 agents | creator / orchestrator / critic 三个 agent 定义 | `opencode-runtime/opencode.json` L335 / L343 / L1100 |
| A3 工具表 | opencode 自定义工具目录 | `opencode-runtime/tools/*.ts`（VPS `workspace/.opencode/tools`） |
| A4 skills | beast-research/creation/critique/dispatch-verify 等 skill 目录 | `opencode-runtime/skills/`（VPS `workspace/.opencode/skills`）；只有 v3 才注入 `BEAST_PHASE_SKILL_POINTERS`（messages-gw L406 起） |
| E0 | 每轮用户消息入口 | `messages-gw.ts:handleSendMessage` L586 |
| E1/E1x | Jev 越狱/注入闸，命中返回 400 injection_blocked | `messages-gw.ts` L670 → `jev-gate.ts:gateUserInput` L231 |
| E2 | 条件是 beast 开且没挂用户模板；与 E1 并行，判模板后建骨架；plan-only 用确定性正则，不调 Jev | `messages-gw.ts:buildTemplateSkeletonForPrompt` L330（L332 classifyDispatchMeta、L351 isPlanOnlyNoGenerationIntent）；`jev-gate.ts` L403 |
| M1 | 新创作判定用正则，不调 Jev | `messages-gw.ts` L688 → `memory-wiring.ts:isFreshCreativeRequest` L58 |
| M2 | 取上一轮 idle 预算好的召回前缀，读后即删；过期、超 TTL 或超会话字节帽时降级；miss 时本轮不注入，改为排异步补算 | `messages-gw.ts` L690；`memory-wiring.ts:takeMemoryRecallPrefix` L400、`scheduleMemoryRecallPrefetch` L429 |
| M3 | 新创作时丢掉召回前缀，改注「从零构思」指令 | `messages-gw.ts` ~L695；`memory-wiring.ts:FRESH_CREATIVE_TURN_DIRECTIVE` L72 |
| M4 | 画像、教训、私有 docs（≤8）注入 system，作为不缓存段每轮重算；freshCreative 时不注专案档案 | `messages-gw.ts` L731；`memory-wiring.ts:buildMemoryInjectionBlocks` L84 |
| （写入侧，图中未画） | 记忆入库用纯函数闸 G0–G6；workflow 记忆另过 Jev（fail-open 回 true） | `memory-batch.ts` L725 → `memory-gate.ts:applyMemoryGates` L148；`workflow-gw.ts` L279 → `jev-gate.ts:gateWorkflowMemory` L559 |
| F1 | Jev 选阶段；返回 null 时注入全部阶段；dispatch-verify 恒选 | `messages-gw.ts:selectBeastStages` L523 → `jev-gate.ts:classifyBeastStages` L507；调用点 L863 |
| F2 | 稳定核心＋所选阶段模组＋registry-digest；v3（env BEAST_FRAME_V3=1）改为核心 v3＋skill 指针 | `messages-gw.ts` `BEAST_STABLE_CORE` L428、`BEAST_STAGE_MODULES` L455、组装 L863 起 |
| F3 | 野兽帧拼到本轮 turn 尾，不放进 system 头 | `messages-gw.ts:appendSystemPayloadToTurnTail` L294，调用 L887（V2=0 时走旧单体帧 L901） |
| F4 | beast 开时挂 orchestrator，关时挂 creator | `messages-gw.ts` L905 / L910 |
| F5 | 环境事实段（agent／工具表／能力断路） | `messages-gw.ts:buildEnvironmentSection` L236，调用 L922 |
| L1 | 主会话在 opencode 里跑 LLM↔tools | opencode serve（gateway 经 `opencode-client.ts` 投递） |
| C1 | context-slim 真实存在，是 opencode 插件：在 messages.transform 钩子上做 microCompact 和工具结果预算 | `opencode-runtime/plugin/context-slim.ts:ContextSlim`（VPS `workspace/.opencode/plugin/context-slim.ts`）→ `lib/context-slim-core.ts:slimMessages` L195；开关 `CONTEXT_SLIM!=="0"` L41 |
| D1 | beast 下要求 sync 但判定为非快查时，强制转 async | `subagent.ts:handleSubagentDispatch` L2041；L2076 → `jev-gate.ts:syncDispatchEligible` L324 |
| D2 | 省略 expert 时由 Jev 选域；LLM 点名的 expert 是最终裁决 | `subagent.ts` L2119 → `jev-gate.ts:routeExpertAuthoritative` L286 |
| D3 | 一次 Jev 调用判 research／rework／music／lyrics 依赖，结果喂 guardExpertContent、musicFirst、lyricsFirst 三个守卫 | `subagent.ts` L2130–L2161 → `jev-gate.ts:classifyDispatchGuards` L620（另一处在 L2031 研究前置判定） |
| D4 | spec 间接注入隔离 | `subagent.ts` L2178 → `jev-gate.ts:quarantineSpec` L243 |
| D5 | Jev 分类后，把 spec-templates.json 配方和工作流模板指令前置到任务书头 | `subagent.ts` L2193–L2216 → `jev-gate.ts:classifyDispatchMeta` L417、`workflowTemplateDirective` L450 |
| D6 | 返工时前置锁原档指令 | `subagent.ts` L2272 → `jev-gate.ts:reworkLockDirective` L753 |
| D7 | 建子 opencode 会话并 prompt_async 投递任务书 | `subagent.ts:dispatchAttempt` L1475，L1544 |
| K1 | 子代理终态登记待审清单，异步模式下唤醒父会话 | `subagent.ts:finishRun` L661，L863 `pendingCriticTargets.set`，L913 wakeParent |
| I1 | idle 时预算下一轮召回 | `opencode-event-handler.ts` session.idle L366，L449 |
| I2 | 机器 critic 判据：beast 开、有 Expert 交付、有成品证据、本轮没派过 critic、没声明未审、每会话至多 1 次 | `opencode-event-handler.ts` L711 → `subagent.ts:maybeRunMachineCriticPass` L1816 → `delivery-gate.ts:shouldTriggerCriticPass` L267 |
| I3 | 网关自己派 critic 子会话 | `subagent.ts` L1855 `buildCriticPassSpec`（delivery-gate.ts L333），L1880 `agent: "critic"` |
| I4 | 退回判定 = 词表命中或数值阈值（<7 且来源合规） | `subagent.ts` L789；`delivery-gate.ts:criticVerdictRejected` L399、`evaluateCriticScoreThreshold` L449 |
| I5 | 退回时 summary 加前缀「【独立审核·退回】」，并要求重派原 Expert | `subagent.ts` L801；`delivery-gate.ts:CRITIC_REJECT_MARK` L211 |
| W0 | 唤醒父会话。重派由父会话里的 orchestrator 按 summary 去做，网关不自动重派 | `subagent.ts` L913/L922；`index.ts:wakeSessionForSubagent` L185（L295 注入为 deps.wakeParent） |
| I6 | Jev 测谎和空壳栏初筛，只在 shadow 模式运行，JEV_ENABLED≠true 时不做任何事 | `opencode-event-handler.ts` L722 → `jev-gate.ts:runJevShadowGate` L123 |
| I7 | gateway 侧滚动摘要压缩（与 context-slim 不是一回事） | `opencode-event-handler.ts` L734 → `messages-gw.ts:maybeCompactSession` L1186 |
| G1 | 前端从全量节点反推 DSL，写进快照的 dsl 栏 | `src/hooks/canvas/canvas-agent-snapshot.ts:buildWorkflowDsl` L98 → `src/lib/workflow-dsl/decompile.ts:decompileWorkflow` L251；`buildAgentCanvasSnapshot` L111 |
| G2 | 工具读网关快照，拿到 dsl 和 node_versions | `opencode-runtime/lib/canvas-flow.ts:gatewayReadSnapshot` L201（`/internal/canvas/snapshot`）；`tools/canvas_get_state.ts` L17、`tools/workflow_history.ts` L20；版本索引 `canvas-agent-snapshot.ts:buildNodeVersionIndex` L68 |
| G3 | 整份 source 交给站点编译器做全图校验 | `tools/workflow_write.ts` L68 → `src/app/api/v1/workflow/compile/route.ts` L72 → `src/lib/workflow-dsl/compile.ts:compileWorkflow` L333 |
| G4 | 编译出的 ops 原样经网关下发到画布，30s 回执 | `tools/workflow_write.ts` L151 → `lib/canvas-flow.ts:gatewayDispatchOps` L250 |
| G5 | 回滚 = 下发一个 revert_node op | `tools/workflow_rollback.ts` L21–L23 |

## 照实说明（未画/差异）
- canvas-write-gate.ts（多步影音收盘硬闸、pendingAvCanvasDirective）只在本地，VPS 上没有，所以不画。
- isPlanOnlyNoGenerationIntent 和 isFreshCreativeRequest 都是正则，不是 Jev 挂点。
- mem：`mem find 用户记忆`、`mem find dual-truth` 都没有命中。
- 无法从 VPS 读到 JEV_ENABLED、BEAST_FRAME_V3、CONTEXT_SLIM、MEMORY_RECALL_ENABLED 的实际值，原因是 /proc environ 权限被拒；图中按代码默认值画（v2 帧、context-slim 默认开）。
