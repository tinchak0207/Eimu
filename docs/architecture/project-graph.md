# 工程图（ProjectGraph）：把影音长任务的真状态从对话流搬进一张可执行的图

> 2026-10-28。设计文档，不含源码改动。目的只有一个：拆成可并行派发、文件归属互不相交、有独立判准的切片。
> 关系：`film-compiler.md` 是总方案（病因与八件东西）；本文是它的落地分解，节点命名与执行器基底以本文为准（基底改为 world2 网关引擎，不新造 ProductionGraph）。`dual-truth-boundary.md` 的“双真相是取舍”结论已被取代，本文不再引用它的铁律。
> 记忆与现场冲突以现场为准，冲突见 §0.2。
> 章节对应：A 类型契约=§3；B 持久化与事件=§3.4；C 切片表=§4（波次表 §11）；D 风险与裁定=§9；E spec 粘贴块=§10。

## 0. 推翻/修改理由（先读）

已定决策基本照做。下面是三处与现场硬证据不一致、因此改写了落点的地方，以及两处需要同时说明的后果。没有并列方案。

### 0.1 修改

1. runtime `AGENTS.md` 压到 ≤200 行：已满足，硬指标改掉。证据：`wc -l deploy-staging/opencode-runtime/AGENTS.md` = 76 行 / 10732 字节；`opencode.json` 的 `instructions` 为空数组。真正的规则质量在两处：①gateway 每轮尾部注入（`messages-gw-admission.ts` 里约 25 处 `appendSystemPayloadToTurnTail/appendContextDelta`），②`opencode-runtime/skills/*/SKILL.md` 合计 2773 行。所以判准从“≤200 行”改成“每条规则带 `[R-nn]` 标签，`rules-map.ts` 里映射到强制它的代码路径与测试，否则删”。行数上限保留为附带检查（见 S17）。
2. `submitGeneration()` 抽取的位置：anatomy Q5 建议从 `tools/image_generate.ts` 抽到 opencode 侧 `lib/`。但执行器已定在网关，而 image_generate 的幂等/收据依赖 opencode 进程里的 SQLite（`tool-jobs.sqlite`），网关进程拿不到。所以基底改为网关里已经在生产跑的 `workflow-gw-submit.ts:268 submitWorkflowNode`（它已有三级模型解析、F2 failover、同步轮询、取消退款），补上 image_generate 才有的四样：`Idempotency-Key`、`generation_receipts` 登记（`job-store.ts`）、项目预算（`/internal/project-budget`）、`payload.workflow.metadata` 带 node_id/signature；载荷字段对齐以 image_generate 第 490-520 行为准逐行对表（S5）。
3. 完成通知不再唤醒模型。已定决策要求“网关往对话塞的伪用户消息=0”，而现状三条路径都在塞：`dispatchWorkflowWake`（`workflow-gw-service.ts:674`）、子代理 `wakeParent`（`subagent-finish.ts:578`）、监视器/定时唤醒（`index.ts:426,442`）。工程模式下的替代：模型在回合内用 `project_get({wait_sec})` 长轮询（≤90 秒一次）等事件；回合结束后产物完成，只走 UI 事件（`sendWorkflowNotice` 是 UI 直发，`workflow-gw-service.ts:362`）+ 交付卡，下一条真实用户消息到来时由目标卡+工程摘要接续。这是产品行为变化，列入 §9 裁定点 J1。

### 0.2 与记忆/现场不一致（已按现场处理）

- 记忆“模板 8 个/674 节点/可执行 51”：现场 13 个模板、798 节点、可执行 66（前者是去掉 5 个小模板后的子集）。本文按 13 个处理。
- 记忆“world1 无执行”：DSL 编译器确无，但 `CanvasAgentOp` 有 `run_generation`，浏览器端 `use-canvas-generation.ts:549` 真执行。本设计不动这条（它只服务人手点画布），工程模式下模型不使用 `run_generation`。
- 记忆“compile.ts:131 无条件 idle、无人工锁”：HEAD 成立；工作树已加 `patchForExisting`（`compile.ts:153-173`，未提交）。本文以工作树为准，S13 的第一动作是确认这个改动已被提交。
- `dual-truth-boundary.md §5.3` 说白名单清洗器在 `layout.ts`；现场在 `src/lib/canvas/layout/normalize.ts:232`。
- Codex 的 `tool_search`/Deferred 不照搬：见 §2 第 8 条。

### 0.3 W2 执行期的现场修正（2026-10-28，均已落码）

- **模板节点数口径**：13 个模板的**原始**节点是 147 个（可执行 66 = image 57 + video 4 + film 3 + audio 2）；“798 节点”是展开派生卡（工具卡/门禁卡）后的口径。§8 I7 的“节点数≥旧可执行数”按原始节点算。
- **music 没有 seconds/model**：上游 `music_gen` 只接受 `{prompt, lyrics, duration_hint}`。原 §3.5 表里的 `seconds`/`model` 是签名参数但不影响产物，改一次会白花 1 币，已从 `NODE_SPECS.music.params` 删除；`durationHint(full|clip30)` 是唯一时长控制，`rights` 仍 non-signed。
- **`ref:` 派生输入键**：S4 的 `mergeInputs` 把 `${}` 派生边写成 `ref:` 前缀键，S3/S2 两处校验器已放行该前缀（其余段规则不变）。`PINNED_FORBIDS` 契约夹具原写“set on pinned 被拒”是错的——pinned 是产物锁不是作者锁，`set` 允许并进 drift；夹具已改为非用户 `remove_node`。
- **席位锁存点**：真实会话创建点是 `session-lifecycle.ts:handleCreateSession`（不在 S19 可写清单），锁存挂在 `sessions.set()`（`SeatLatchedSessions`），新建与两条 DB 恢复路径都经它；锁存失败 fail-open 只打日志。
- **旧工作流导入**：下载失败的旧节点只进导入报告的 `stale`，不落图——reference 节点缺 `artifactId` 过不了校验，留节点等于留死节点。导入报告需由 S9/S10b 露出。
- **QC 失败通道**：按冻结契约，machine QC 判不过返回 `{ok:false, code:"qc_failed"}` 且无 outputs，deficiencies 只在 `error.message`（S6 落进节点 error）。`image_pack` 包级 QC 未实现（包输入报 `bad_input`）；v1 的 qc 检查 keyframe 图片本身。
- **`wait_sec`**：工具侧长轮询 60 秒，服务端允许 90 秒；网关回合看门狗是 90 秒，零帧 90 秒会触发重投（`constants-gateway.ts:70-88`、`timers-gw.ts:138-181`）。
- **子代理身份**：`project` 路由的 Actor 只由网关解析（不读请求体）：`byChildOc` 命中 → 真实 `run.lane`；run 已删但 TTL 表/`generation_consumers` 耐久行仍认 → 空 lane 只读（收尾后不升级为主席位）；都不命中才是主席位。
- **产物入库默认允许根**：`projects/<sid>` + `WORKSPACE_DIR/uploads` + `WORKSPACE_DIR/tts-audio`（voice 的旧式落盘与上传素材都要能 ingest）。
- **render3d**：v1 无执行器、13 个配方均不使用；§8 I7 的“每个节点类型有执行器”按“每个配方用到的类型”执行。

### 0.4 W3/W4 落地期的现场修正与接线（2026-10-28，均已落码）

- **forEach 扇出在补丁路径落图**：`expandGraph` 原先是纯库（只有测试导入），实例永远不进图，`signature.ts` 的「模板 target 展开为实例」也就永远找不到实例。S21 把它接进 `applyPatch`：每次成功补丁后展开并合并 `nodes/order`，展开失败整批拒绝；新建实例进 patch 事件的 `nodes`，孤儿发 `node_status(to:"orphaned")`，回执只留 `fanout:+N -M orphan:K`。`planRun` 同时排除 `orphaned`（S21b），否则删行后的实例会被判 `toRun` 继续花钱。代价：每次补丁多一次 O(节点) 展开（实测 174 节点 1.6ms、54 节点 0.3ms）。
- **切片按文件边界切完不等于系统接通**：W4 验收时全仓 grep，`ProjectCanvasBridge`、`checkExportArtifacts`、`deliverablesFromExport` 三件库**零消费者**——工程跑完画布不出节点、坏片不被拦、用户拿不到成片。补 S20 四件事：①`project_get`（含模型长轮询的 internal GET）与 run 收尾时 `pump` 事件进画布桥；②export 执行器在 `ctx.ingest` 后跑交付闸，失败把节点置 failed（`code:"qc_failed"`）；③产物复制进既有公网面（`PROJECT_PUBLIC_UPLOADS_DIR`，缺省 `/opt/image-data-api/data/uploads`，URL 面同 media upload）并写 `Output.url`；④交付卡只由 `deliverablesFromExport` 发 `video.done`/`image.done`（复用站点现有 reducer）。S20b：`image_pack` 的 manifest 与每张图逐件公网化，逐张出 `image.done`（无 zip，N 张图=N 张卡）。
- **测试隔离的真因**：`persistence-schema.ts` 的 `DB_PATH` 是**模组载入时常量**。bun test 里先 import 的档会把路径钉死，之后同进程的档改 env 无效、`enterPlanMode` 抛 `harness_security_store_unavailable`。修法：先设 `SESSIONS_DB_PATH` 再 **dynamic import**，临时库目录留到进程退出才删（提前删会让后跑的档拿到已删除的库）。单跑全绿不能证明隔离，必须两档同跑（含反序）。
- **`beastAgentField` 按锁存席位**：`seat==="creator"` 恒 `{agent:"creator"}`（不读 beast 设置）；`creator_legacy` + beast → `orchestrator_legacy`；非 beast → `{}`；缺 `seat` 键按 `creator_legacy`。旧席位野兽会话不再推新的 `orchestrator`。
- **运行时 `AGENTS.md` 76→32 行、16 条 `[R-nn]`**：按“能代码强制才留”删掉了研究先行、文风、乐理、版权、并行习惯等条目。两条不影响行为：研究指令仍在 `expert/opencode-agents.json` 席位提示词（“研究再动手”“研究并发和独立评审照做”）；简体由出口层 `sse-core.ts`/`outbound-emit.ts` 强制。**版权条（在版歌曲旋律不交）按 J5 待用户裁定**：删掉后没有任何代码替它把关，是否在 music 执行器加参数/提示词闸需用户决定。
- **五键白名单已收敛为单一真源**：`node-metadata-fields.ts` 的 A/B 清单驱动 `layout/normalize.ts` 的 cleaner 与 `canvas-chat-types.ts` 的 transform（`Record<CleanerName,…>` 由 tsc 强制穷尽），不再三处各抄一份；`CanvasNodeMetadata` 已补 `project_node_id/project_sig/project_pinned/project_stale/project_reused` 五个可选键。
- **交付卡的边界**：去重键是 `nodeId:sha256` 的进程内 Set；网关重启后同一产物下一轮 run 会再发一次同 URL 卡（前端 reducer 按 URL 去重），未共用 `emitVideoDone` 的 `announcedUrls`。
- **`targets.audio` 字面语义**：只要 `targets` 存在且没写 `audio:"none"` 就要求音轨；纯画面工程若设了 `targets` 会被判「无音轨」失败，配方需显式写 `audio:"none"`。
- **pin 会改下游签名**：pinned 节点按叶子读取（用钉住时的 outputsSha），所以给某节点加 pin 后第一次 run 会重跑它的下游一次；这是签名语义，不是漂移 bug。
- **I3 的完成腿**：run 完成事件是真跑出来的，但测试没有真派子代理（避免拉起子会话与上游）；抑制点是同一个 `turnTailAllowed`，旧席位反例已证明注入器确实会注入。
- **权威测试跑法是 `deploy-staging/vps-tools/run-tests.sh`（逐档启动）**：单进程 `bun test` 整目录会被模组载入常量互相污染（`PLATFORM_BASE`、`WORKSPACE_DIR`、`SESSIONS_DB_PATH`），出现一批假失败；`bun test deploy-staging/gateway` 还会被某个档的 `process.exit(0)` 提前终止、静默少跑。测试档内拼路径一律以 `import.meta.dir` 为基准，不许用 `process.cwd()`（S21 修了 `routes.test.ts` 的 cwd 缺陷，它曾让权威门 fail=2）。
- **站点侧 runner 是 tsx**：`npx tsx --test` 下 canvas+workflow-dsl 36 档 461/461 绿；`bun test` 全量 canvas 有 2 条既有假红（`client.test.ts` 的模块级 `LOCAL_TEST_MODE` 被别档先 import 后缓存成 false），不是本轮回归。

## 1. 终点与因果链

终点（可测）：一句话需求进去，无人干预跑到 `export` 节点，产出可播放、时长对、有音轨、QC 过的成片；中途任何一轮模型上下文由工程图重建且大小有固定上限；改一个节点只重跑它和下游，人手钉住的节点不动。

因果链：状态住对话流 → 压缩/截断丢目标 → 模型靠还看得见的形式过闸。要切断的是第一环：把目标、进度、资产 ID、用户决定放进一张图，由引擎执行，上下文由图生成。

单一真相：**ProjectGraph**。载体是网关（world2 引擎演进），画布是它的视图，DSL 是它的编辑语言之一，模板是它的配方（recipe）。

## 2. 外部楷模落实表（引文来自 `/tmp/ext/exemplar-quotes.md`，该文件在 /tmp，易失，关键行逐字抄在这里）

许可：ComfyUI=GPL v3，n8n=Sustainable Use License（SaaS 对外提供越界），都只学形态不抄码；Codex=Apache-2.0。所有实现从算法描述重写，测试按行为重写，不复制其源码或测试代码。

| # | 硬约束（exemplar §） | 逐字依据 | 落点 | 与楷模的差异及理由 |
|---|---|---|---|---|
| 1 | 签名=类型+指纹+排序常量参数+祖先 DFS 序号展开，不含 node_id（§1.1/§1.2） | `signature = [class_type, await self.is_changed_cache.get(node_id)]`；`signature.append((key,("ANCESTOR", ancestor_index, ancestor_socket)))` | S1 `signature.ts` | 多一项 `specVersion`（执行器语义升级时整体失效）；pinned/reference 节点在 DFS 里当叶子（它们的内容指纹已代表上游）。 |
| 2 | 输入指纹=内容 sha256；出错视为已变（§1.4） | `m = hashlib.sha256()` / `node["is_changed"] = float("NaN")` | S1 `FingerprintResolver`，异常→`unstable`→必重跑 | 无。 |
| 3 | seed 是普通参数；真不确定节点显式永不命中（§1.6） | `"seed": ("INT", {... "control_after_generate": True})`、`return float("NaN")` | S1/S3：`params.seed` 在签名里；`reroll` 操作=换 seed；`NodeSpec.volatile` 标永不命中 | ComfyUI 的 seed 由前端换；这里由引擎在 `add_node` 时按 hash(nodeId) 确定性赋值，保证签名稳定。 |
| 4 | 命中节点不入队、下游取其输出、仍发已复用事件、缓存 GC（§1.5） | `execution_cached` 消息；`add_strong_link` 先问 `is_cached`；`clean_unused()` | S6 调度、S5 账本 `reused` 行、S1 `gcCache` | 付费节点 GC 保留 7 天墓碑（可撤销回滚）；ComfyUI 立即删。重跑=花钱，故更积极缓存。 |
| 5 | pin=已完成，执行器不调上游，人手 pin 的不被自动重算（§2.2/§2.3） | `if (pinnedOutput) { nodeSuccessData = pinnedOutput }`；`if (hasPinnedData) { return false; }` | S2 补丁规则、S6 跳过、S1 DFS 截断 | 无。 |
| 6 | n8n 无参数变更检测（`// TODO: implement`），用约束 1 补，pinned 漂移只提示（§2.3） | `const propertiesOrOptionsChanged = false;` | `PinState.signatureAtPin` + 回执/摘要的 `drift` 列表 | 无。 |
| 7 | pin 边界写成 schema 显式规则（§2.4） | `PIN_DATA_NODE_TYPES_DENYLIST`、`isValidNodeType` | S3 `NodeSpec.pinnable` + §3.5 规则表 | n8n 禁多输出节点；这里允许多输出口但必须整体 pin。 |
| 8 | 小而稳的常驻核心，会话内不增删，只门控（§3、§6.1） | `ToolExposure::Deferred`；`avoid dynamically adding or removing tools mid-iteration`；`it masks the token logits` | S14：主席位 ≤12 工具、`creator` 唯一席位、plan 模式与 beast 改成门控/提示词差异 | 不引入 `tool_search`：主席位只剩 9-10 个工具，没有长尾可延迟；长尾能力（blender、放大、抠图）变成节点类型或子代理席位里的能力，不进主席位。Codex 每步重建 router 的事实（§3.4）说明“会话内不变”要靠约定保证，所以本文用测试锁。 |
| 9 | 中间产物不进上下文，agent 只拿 id+摘要；压缩可逆（§5、§6.2） | `the agent only sees what you explicitly log or return`；`Our compression strategies are always designed to be restorable` | 回执 ≤1KB；产物只在 `outputs[]` 里以 id/sha/路径出现；窗口外的旧步骤留在 opencode 库与 `events.jsonl`，可按需 `project_get(view:"events")` | 无。 |
| 10 | 用户原话不靠 LLM 摘要，逐字入图，末尾复述（§4、§6.3） | `List ALL user messages ... ` 是模型转述；`reciting its objectives into the end of the context` | S15：`brief[]` 逐字存、每轮目标卡+摘要作为末尾合成片段 | 无。 |

## 3. A. 类型契约（切片间只通过它耦合）

落盘位置：`deploy-staging/gateway/project/types.ts`（只含类型与常量，无运行时依赖；src 侧用 `import type` 引用，不进 Next 构建）。S0 把下面代码块原样写入。任何切片改动契约，必须先回报 orchestrator，不得自行修改。

```ts
// ===== project/types.ts — 契约 v1 =====
export const PROJECT_SCHEMA_VERSION = 1

export type ProjectId = string        // = sessionId（v1：一个会话一个工程）
export type NodeId = string           // /^[a-z][a-z0-9_]{0,47}(#[a-z0-9_]{1,32})?$/ ；'#' 后是 forEach 实例的 row.id
export type ArtifactId = string       // "art_" + sha256 前 16 位小写 hex（内容寻址）
export type Sha256 = string           // 64 位小写 hex
export type RunId = string
export type RubricId = string
export type Iso = string
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export type NodeType =
  | "reference"  // 参考图/外部素材（上传、素材库、或生成的参考图见 keyframe.role）
  | "script"     // 剧本（authored：由模型/子代理写入，引擎只落盘）
  | "shotlist"   // 镜头表/行表（authored，rows[]）；非电影配方里也用来放 views/variants/items
  | "keyframe"   // 图片生成：参考图/关键帧/海报/详情页等，用 params.role 区分
  | "clip"       // 逐镜视频
  | "voice"      // 配音
  | "music"      // 音乐
  | "timeline"   // 时间线（确定性，套 timeline.ts 的 IR）
  | "subtitle"   // 字幕（确定性）
  | "mix"        // 混音（确定性，mix.ts）
  | "export"     // 导出（成片 mp4 或图片包），唯一的交付出口
  | "qc"         // 质检（machine=ffprobe 等；critic=评审子代理写 verdict）
  | "render3d"   // Blender 渲染（经 exec-bridge），v1 不被任何配方使用

export type NodeStatus =
  | "pending"    // 未运行或输入未就绪
  | "queued" | "running"
  | "done"       // 有有效产物；复用/钉住/新跑都是 done，区别在 lastRun.via
  | "failed"     // 本节点失败（含重试用尽）
  | "blocked"    // 上游失败或缺必需输入
  | "stale"      // 有旧产物但当前签名≠产物签名（非 pinned）
  | "skipped"    // onFail=skip 后跳过
  | "orphaned"   // forEach 的 row 被删但实例是 pinned/人手产物，保留不删

export type Actor =
  | { kind: "user" }                                   // 经鉴权的画布/UI 操作
  | { kind: "agent" }                                  // 主代理
  | { kind: "engine" }                                 // 执行器自身
  | { kind: "subagent"; runId: string; lane: NodeId[] } // 子代理，只能写 lane 内节点

export interface Output {
  port: string                       // 输出口名；默认主口 "out"
  artifactId: ArtifactId
  sha256: Sha256
  path: string                       // 网关本地绝对路径（artifact-store 内）
  mime: string
  bytes: number
  origin: "generated" | "user" | "derived"
  url?: string                       // 公网地址（给画布/用户；签名不用它）
  width?: number; height?: number; durationSec?: number
  take?: number                      // takes 候选序号
  meta?: Record<string, Json>        // 如 executedModel、seed、charge_ref；不进签名
}

export interface InputRef { from: NodeId; port?: string }           // port 缺省=主口
export interface FileRef { artifactId: ArtifactId; role: string }    // 外部常量素材，指纹=内容 sha256
export interface ForEach { over: NodeId; as: string }                // over 必须是 shotlist；as 不能是 "row"
export interface TakesSpec { n: number /*2..4*/; select: "qc" | "first" | "user"; rubric?: RubricId }
export type OnFail =
  | { action: "regenerate"; max: number /*1..2*/; on?: "error" | "qc_fail" | "any"; then?: "fail" | "skip" | "ask_user" }
  | { action: "fail" } | { action: "skip" } | { action: "ask_user" }
export interface LockState { by: "user" | "agent"; fields: string[] | "*"; at: Iso } // 作者锁：agent 不得覆盖这些字段；节点仍会因签名变化重跑
export interface PinState {                                           // 产物锁：执行器不重算
  by: "user" | "agent"; at: Iso; reason?: string
  take?: number                      // takes 节点钉住哪一个候选
  outputsSha: Sha256[]               // 钉住时的产物指纹（下游签名用它）
  signatureAtPin: string             // 钉住时的签名；与当前签名不同=漂移
}
export interface RunRecord {
  runId: RunId; at: Iso
  via: "executed" | "reused" | "pinned"
  signature: string                  // 产出这些 outputs 的签名
  costCoins: number; attempt: number; durationMs?: number
}
export interface Inflight { idemKey: string; taskId?: string; since: Iso; submitUnknown?: boolean }

export interface ProjectNode {
  id: NodeId
  type: NodeType
  intent: string                     // ≤200 字，人话说明；不进签名，不被执行，不被当规则
  params: Record<string, Json>       // 类型相关，见 NODE_SPECS；字符串值可含 ${...} 引用（§3.3）
  inputs: Record<string, InputRef>   // 规范化后的边（由引用语法解析得到或显式 connect）
  refs: FileRef[]
  forEach?: ForEach                  // 有则本节点是“扇出模板”，实例为 `${id}#${row.id}`
  takes?: TakesSpec
  onFail?: OnFail
  locked?: LockState
  pinned: PinState | null
  status: NodeStatus
  signature: string | null           // 当前图下算出的签名；不稳定则 null
  lastRun: RunRecord | null
  outputs: Output[]                  // 被选中的产物
  takesPool?: Output[]               // takes 全部候选（含 qc 分数在 meta）
  error?: { code: string; message: string; retryable: boolean; at: Iso }
  inflight?: Inflight
  rev: number                        // 每次改 intent/params/inputs/refs/takes/onFail/forEach 自增
  derivedFrom?: { template: NodeId; rowId: string }
  scratch?: { expiresAt: Iso }       // 草稿：到期销毁，不进交付，不进缓存索引
}

export interface BriefEntry { id: string; at: Iso; messageId: string; text: string; truncated?: boolean } // 用户原话逐字，单条≤12000 字
export interface Decision { id: string; at: Iso; question: string; answer: string; refs?: NodeId[] }       // answer 是用户原话
export interface Targets { durationSec?: number; aspect?: string; shots?: number; subtitles?: boolean; audio?: "voice" | "music" | "both" | "none"; setBy: Actor; at: Iso }
export interface ProjectDefaults { videoModel?: string; imageModel?: string; imageSize?: string; voice?: string; style?: string }
export interface Budget { capCoins: number | null; spentCoins: number; savedCoins: number /*复用省下*/ }

export interface ProjectGraph {
  schema: typeof PROJECT_SCHEMA_VERSION
  id: ProjectId; sessionId: string
  version: number                    // 每次补丁批次成功后 +1
  createdAt: Iso; updatedAt: Iso
  templateId?: string                // 来源配方
  brief: BriefEntry[]                // 仅网关在收到真实用户消息时追加；模型不能写
  decisions: Decision[]              // 仅网关在用户回答 question 时追加
  targets: Targets | null
  defaults: ProjectDefaults
  nodes: Record<NodeId, ProjectNode>
  order: NodeId[]                    // 创建序，展示用
  budget: Budget
  activeRun: RunId | null
  seq: number                        // 事件序号高水位
}

// ===== 补丁 =====
export type PatchOp =
  | { op: "add_node"; node: NewNode }
  | { op: "set"; node: NodeId; path: string; value: Json; ifRev?: number } // path ∈ intent | params.<k> | takes | onFail | forEach | refs
  | { op: "remove_node"; node: NodeId }
  | { op: "connect"; to: NodeId; input: string; from: NodeId; port?: string }
  | { op: "disconnect"; to: NodeId; input: string }
  | { op: "lock"; node: NodeId; fields: string[] | "*" }
  | { op: "unlock"; node: NodeId }
  | { op: "pin"; node: NodeId; take?: number; reason?: string }
  | { op: "unpin"; node: NodeId }
  | { op: "replace_output"; node: NodeId; artifactId: ArtifactId }  // 仅 actor=user；自动 pin(origin:"user")
  | { op: "select_take"; node: NodeId; take: number }
  | { op: "reroll"; node: NodeId }                                   // 只改 params.seed
  | { op: "write_result"; node: NodeId; value: Json }                // script/shotlist/qc(critic)；子代理在 lane 内可用
  | { op: "set_targets"; targets: Omit<Targets, "setBy" | "at"> }
  | { op: "set_defaults"; defaults: ProjectDefaults }
  | { op: "apply_recipe"; recipe: string; params: Record<string, Json> }
export type NewNode = Pick<ProjectNode, "id" | "type"> & Partial<Pick<ProjectNode, "intent" | "params" | "inputs" | "refs" | "forEach" | "takes" | "onFail">>

export type PatchErrorCode =
  | "NOT_FOUND" | "EXISTS" | "BAD_PATH" | "BAD_VALUE" | "BAD_REF" | "CYCLE" | "LOCKED" | "PINNED_FORBIDS"
  | "NOT_PINNABLE" | "NOT_AUTHORED" | "LANE_VIOLATION" | "ACTOR_FORBIDDEN" | "REV_CONFLICT" | "VERSION_CONFLICT"
  | "GRAPH_INVALID" | "UNKNOWN_RECIPE" | "RUN_ACTIVE_CONFLICT"

export interface PatchRequest { ops: PatchOp[]; baseVersion?: number; atomic?: boolean } // 默认 atomic=false（逐 op 应用，坏的丢弃并报告；最终图无效则整批 GRAPH_INVALID）
export interface PatchReceipt {          // 序列化后 ≤1024 字节（UTF-8），超出按固定优先级截断并置 more
  ok: boolean; version: number; applied: number
  rejected: { i: number; code: PatchErrorCode; node?: NodeId; msg: string /*≤120 字*/ }[]   // ≤5 条
  changed: { node: NodeId; fields: string[] }[]                                             // ≤12 条
  stale: NodeId[]                         // 本批新变 stale 的节点，≤12
  drift: NodeId[]                         // pinned 且签名漂移，≤8
  warnings: string[]                      // ≤3
  more?: { rejected?: number; changed?: number; stale?: number; drift?: number }
}

// ===== 模型侧三个工具 =====
export interface ProjectGetArgs { view?: "digest" | "node" | "events"; node?: NodeId; since?: number; wait_sec?: number /*0..90，仅 events/digest 等待变化*/; detail?: "summary" | "full" }
export interface ProjectGetReceipt {      // digest≤6144B；node≤4096B；events≤20 行且总≤2048B
  ok: boolean; version: number; cursor: number
  digest?: string; node?: NodeView; events?: string[]; truncated?: boolean
}
export interface NodeView { id: NodeId; type: NodeType; status: NodeStatus; intent: string; params: Record<string, Json>; inputs: Record<string, InputRef>
  outputs: { port: string; artifactId: ArtifactId; sha256: Sha256; mime: string; bytes: number; durationSec?: number; url?: string }[]
  pinned?: boolean; drift?: boolean; locked?: string[] | "*"; lastRun?: Pick<RunRecord, "via" | "costCoins" | "attempt" | "at">; error?: string }
export interface ProjectPatchArgs { ops: (PatchOp | { op: "dsl"; source: unknown })[]; baseVersion?: number; atomic?: boolean } // "dsl" 由工具端先经站点 compile 展开成 PatchOp（S13/S9），网关只收强类型 PatchOp
export interface ProjectRunArgs { targets?: NodeId[]; mode?: "incremental" | "force"; dry_run?: boolean; budget_coins?: number; wait_sec?: number }
export interface ProjectRunReceipt {      // ≤1024B
  ok: boolean; runId?: RunId
  status: "quoted" | "started" | "running" | "done" | "partial" | "failed" | "needs_user" | "rejected"
  quote: { coins: number | null; run: number; reuse: number; pinned: number; unknownPrice: NodeId[] }
  done?: number; failed?: NodeId[]; cursor: number; reason?: string
}

// ===== 签名（实现在 signature.ts）=====
export interface FingerprintResolver { fileSha256(artifactId: ArtifactId): Promise<Sha256> } // 抛错=不稳定
export type SignatureResult = { ok: true; signature: string } | { ok: false; unstable: true; reason: string }
export declare function computeSignature(graph: Readonly<ProjectGraph>, nodeId: NodeId, fp: FingerprintResolver, specs: Readonly<Record<NodeType, NodeSpecLite>>): Promise<SignatureResult>
export declare function planRun(graph: Readonly<ProjectGraph>, targets: NodeId[] | undefined, mode: "incremental" | "force", fp: FingerprintResolver, specs: Readonly<Record<NodeType, NodeSpecLite>>): Promise<RunPlan>
export interface RunPlan { toRun: NodeId[]; reuse: NodeId[]; pinned: NodeId[]; blocked: NodeId[]; unknown: NodeId[] /*签名依赖尚未产出的上游内容，保守视为要跑*/ }
export interface NodeSpecLite { type: NodeType; specVersion: number; signedParams: string[]; volatile?: boolean; pinnable: boolean; fingerprintMode: "structural" | "content" }

// ===== 执行器 =====
export interface ExecContext {
  project: Readonly<ProjectGraph>; node: Readonly<ProjectNode>
  signature: string; runId: RunId; attempt: number; take: number
  sessionId: string; session: unknown                      // 网关 SessionState，只供执行器取 apiKey/用户设置
  params: Record<string, Json>                              // ${} 已解析
  inputs: Record<string, Output[]>                          // 输入口名 → 上游产物
  refs: { role: string; output: Output }[]
  signal: AbortSignal
  ingest(src: { path: string } | { url: string }, hint: { port: string; mime?: string; origin: Output["origin"] }): Promise<Output> // 下载→算 sha256→入 artifact-store
  ledger: LedgerWriter
  submitGeneration: SubmitGenerationFn
  execBridge: ExecBridgeClient
}
export type ExecErrorCode = "provider_error" | "safety_blocked" | "timeout" | "submit_unknown" | "price_unknown" | "bad_input" | "bridge_unavailable" | "qc_failed" | "cancelled"
export type ExecResult =
  | { ok: true; outputs: Output[]; pool?: Output[]; costCoins: number }
  | { ok: false; code: ExecErrorCode; message: string; retryable: boolean; submitUnknown?: boolean; costCoins?: number }
export interface NodeExecutor {
  type: NodeType; specVersion: number
  estimate(node: Readonly<ProjectNode>, project: Readonly<ProjectGraph>, session: unknown): Promise<number | null> // null=报不出价，拒绝运行
  run(ctx: ExecContext): Promise<ExecResult>
}

export interface SubmitGenerationReq {
  kind: "image" | "video"; model: string; prompt: string
  size?: string; n?: number; seconds?: number; resolution?: string; quality?: string; seed?: number
  referenceImages?: string[]; generateAudio?: boolean; styleLock?: string
  projectId: ProjectId; nodeId: NodeId; signature: string; runId: RunId; attempt: number; take: number
  apiKey: string; sessionId: string; signal: AbortSignal
}
export type SubmitGenerationRes =
  | { ok: true; taskId: string; urls: string[]; costCoins: number; requestId: string; executedModel: string }
  | { ok: false; code: ExecErrorCode; message: string; taskId?: string; submitUnknown?: boolean; retryable: boolean }
export type SubmitGenerationFn = (req: SubmitGenerationReq) => Promise<SubmitGenerationRes>
// Idempotency-Key = `pg:${projectId}:${signature.slice(0,40)}:t${take}:a${attempt}`；payload.workflow.metadata 必带 {project_id,node_id,signature,run_id,attempt,take}

export interface ExecBridgeClient {
  call(route: "music_gen" | "blender_render", body: { sessionId: string; projectId: ProjectId; nodeId: NodeId; signature: string; idemKey: string; params: Record<string, Json> }, opts: { timeoutMs: number; signal: AbortSignal }): Promise<
    | { ok: true; files: { path: string; mime: string; bytes: number; durationSec?: number }[]; costCoins: number; chargeRef?: string; provider?: string }
    | { ok: false; code: ExecErrorCode; message: string; retryable: boolean }>
  result(idemKey: string): Promise<{ state: "unknown" | "running" | "done" | "failed"; files?: { path: string; mime: string; bytes: number }[]; costCoins?: number; chargeRef?: string }>
}

// ===== 账本新字段（追加在 quota-ledger.ts 的 LedgerEntry 上，全部可选）=====
export interface LedgerEntryProjectFields {
  project_id?: string; node_id?: string; signature?: string; run_id?: string
  attempt?: number; take?: number; reused?: boolean
  artifact_sha256?: string; idem_key?: string; charge_ref?: string
}
// kind="generation"，event ∈ submitted | completed | failed | reused | refunded；reused 行 cost_coins=0
export interface LedgerWriter { write(e: LedgerEntryProjectFields & { event: "submitted" | "completed" | "failed" | "reused" | "refunded"; model?: string; cost_coins?: number; task_id?: string; result_url?: string }): Promise<void> }

// ===== 事件 =====
export type ProjectEventKind = "patch" | "node_status" | "node_reused" | "node_output" | "pin_drift" | "run_started" | "run_finished" | "brief" | "decision" | "cost"
export interface ProjectEvent { seq: number; at: Iso; kind: ProjectEventKind; node?: NodeId; run?: RunId; data: Record<string, Json> }

// ===== 配方（S11）=====
export interface Recipe {
  id: string; title: string
  build(p: Record<string, Json>): { nodes: NewNode[]; targets?: Omit<Targets, "setBy" | "at">; defaults?: ProjectDefaults }
  legacyRoleMap: Record<string, NodeId | { intentOf: NodeId } | { dropped: string /*理由*/ }> // 旧模板每个 role 去哪了
}

// ===== 常量（S0 同步写入 project/constants.ts）=====
export const LIMITS = {
  PATCH_RECEIPT_BYTES: 1024, RUN_RECEIPT_BYTES: 1024, DIGEST_BYTES: 6144, NODE_VIEW_BYTES: 4096, EVENTS_BYTES: 2048,
  SUBAGENT_SUMMARY_BYTES: 4096, SUBAGENT_NODE_IDS: 20, CONTEXT_WINDOW_STEPS: 6, WAIT_SEC_MAX: 90,
  INTENT_CHARS: 200, BRIEF_ENTRY_CHARS: 12000, TAKES_MAX: 4, REGENERATE_MAX: 2, INPUT_CAP_BYTES: 65536,
  MAIN_TOOLS_MAX: 12, TOMBSTONE_DAYS: 7,
} as const
export const estimateTokens = (s: string) => Math.ceil(new TextEncoder().encode(s).length / 2) // 保守估计：CJK 约 1 token/1.5 字符，按 2 字节/token 偏大
// 起始超集（来自 R/tools/ 目录清单）；S14 必须再扫描 R/tools/*.ts 里直接触达生成端点（generations、/tts、music、blender、image_generate 的 lib 包装）的工具补全，补全结果与“被折叠到哪个节点类型/role/配方、或本期不支持”的清单写进 S14 回报
export const DIRECT_GENERATION_TOOLS = [
  "image_generate","image_edit","image_upscale","background_remove","keyframe_render","canvas_generate_image","canvas_create_generation_flow",
  "character_dna_turnaround","product_conditioned_generation","virtual_tryon","hand_contact_repair","outlier_audit_regenerate",
  "scene_pack_batch","shot_grid_batch","style_aligned_batch","aspect_reflow","multi_aspect_reflow","platform_reflow","moodboard_diverge_converge","emotion_board_matrix",
  "last_frame_video_chain","storyboard_voiceover","music_gen","tts_speak","blender_exec","blender_render","blender_export_gltf",
  "timeline_ops","timeline_mix","timeline_master","timeline_style","timeline_rhythm","timeline_restore","artifact_publish",
] as const
```

### 3.1 契约里每个字段的归属（谁写、谁读）

| 字段 | 唯一写入者 | 备注 |
|---|---|---|
| `brief[]` | 网关收到真实用户消息时（S15 的 ingress 钩子） | 模型无写入口 |
| `decisions[]` | 网关在用户回答 `question` 时 | answer 逐字 |
| `targets` | 补丁 `set_targets`（agent/user） | 记录 `setBy`，摘要里显示来源 |
| `node.params/intent/inputs/refs/forEach/takes/onFail` | 补丁（agent/user/subagent-lane） | 引擎绝不改 |
| `node.status/outputs/lastRun/signature/error/inflight` | 引擎（执行器与调度器） | 补丁只可通过“标 stale”间接影响 status |
| `node.pinned` | `pin/unpin/replace_output` | `replace_output` 仅 user |
| `node.locked` | `lock/unlock`（user；agent 仅在用户明说时） | 语义=`compile.ts patchForExisting` 的 `metadata.locked` |

### 3.2 签名算法（S1，规范性描述）

对节点 N：

1. `immediate(M)` = canonicalJson( [ M.type, spec.specVersion, fingerprint(M), ...按 key 排序的 (signedParam, value), ...按 input 名排序的 (inputName, ancestorOrdinal, port), ...按 role 排序的 (role, sha256(refs 内容)) ] )。`signedParams` 由 `NodeSpec` 声明；`intent`、`title`、位置、`locked` 不进签名。引用字符串（`${...}`）在签名前解析成 (ancestorOrdinal, port)。
2. `fingerprint(M)`：`reference` 节点 = 其产物内容 sha256；pinned 节点 = `pinned.outputsSha`；`takes` 节点 = 被选中产物的 sha256 列表；其余 `null`（结构性）。任何 `fileSha256` 抛错 → 整个签名 `unstable`。`spec.volatile` 的节点直接 `unstable`。
3. 祖先展开：从 N 起按“排序后的 input 名”做 DFS，每个祖先第一次出现时分配序号，遇到 pinned 或 reference 节点当叶子（不再展开其输入）。signature = sha256( canonicalJson([ immediate(N), immediate(a1), immediate(a2), ... ]) )，祖先引用只用序号，不含 node_id（ComfyUI §1.1）。
4. 基线性质（测试断言，来源是 ComfyUI 的行为而非其代码）：同构图换 id → 同签名；改祖先任一 signed 参数 → 下游签名全变、无关分支不变；换 seed → 只该节点及下游变。
5. `planRun`：对 targets 的上游闭包逐节点：pinned → `pinned`；签名 `ok` 且 `cache-index` 命中且产物文件仍在（sha 复核）→ `reuse`；`unstable` → `toRun`；依赖的上游 `toRun` 且本节点 `fingerprintMode:"content"` → `unknown`（保守按要跑计价）；`force` 模式下 targets 本身（非 pinned）强制 `toRun`，下游随之。
6. 缓存索引（`cache-index.ts`）：`signature → {outputs[], costCoins, at}`，存在 `projects/<sid>/cache.json`；GC 只留“当前图所有节点签名 ∪ pinned 节点的 `signatureAtPin` ∪ 7 天内的墓碑”。

### 3.3 引用与扇出文法（S4，规范性）

```
ref   := "${" head ("." seg)* "}"
head  := "row"          // 行字段：${row.action}，仅 forEach 节点内
       | <as 别名>       // 同行兄弟实例：${shot.keyframe} = 节点 keyframe 的同一 row 实例（可再接 .port）
       | <nodeId>       // 普通节点输出：${cast_sheet} 或 ${cast_sheet.out}
```

- `forEach:{over:"shots", as:"shot"}` 的节点 X，对 `shots.rows[i]`（按 `row.id` 去重、保序）生成实例 `X#<row.id>`，实例继承 X 的 type/params/inputs/refs/takes/onFail，并做 `${row.*}`、`${shot.*}` 替换。
- 实例是真节点（可 pin、可被画布显示、有自己的签名与账本行）；模板节点 X 自身不执行（`pinnable:false`）。
- row 被删：若实例未 pinned → 随之删除；若 pinned/有人手产物 → 状态置 `orphaned`，保留。
- 不允许 forEach 节点 over 另一个 forEach 节点（v1 单层扇出）；`takes` 与 `onFail` 可与 forEach 同时使用，作用在每个实例上。
- `on_fail: regenerate(max=2)`：失败（`on` 决定是错误还是 QC 不过）后同一节点重新生成，attempt+1、seed 自动 +1（不改 `params.seed`，只在 Idempotency-Key 的 `a<attempt>` 与提交载荷里体现，成功产物仍以原签名入缓存）；`max` 用尽按 `then` 处理。
- `takes:{n,select}`：同一签名并发产出 n 个候选，`select:"qc"` 用 `rubric` 对每个候选评分取最高（评分函数与 `qc` 节点共用，S8c），`first` 取第一个成功，`user` 等 `select_take`。

### 3.4 持久化、版本与并发（B）

- **位置**：`$WORKSPACE_DIR/projects/<sessionId>/`（与 `timeline.ts` 的 `$WORKSPACE_DIR/timelines/<sid>/current.json + versions/<n>.json + log.jsonl` 同形，复用它的目录习惯，见 `timeline.ts:5,180,683-693`）：
  - `project.json` 当前图（原子写：写临时文件 + `rename`）；
  - `versions/<n>.json` 每次补丁批次一份，保留最近 50 份，外加每次 run 起止各一份；
  - `events.jsonl` 追加式，`seq` 即行号（游标）；
  - `cache.json` 签名缓存索引；
  - 产物文件在 artifact-store（`artifact-store-io.ts:112 sha256Hex` 的同一套），`Output.path` 指向它。
- **与现有 state 机制的关系**：sessions.db 的 `workflowSnapshot`（`persistence-io.ts:27,57,101`）保留给旧工作流，不动。工程模式会话在 `PERSISTED_DATA_KEYS` 里新增 `projectMode`（见 S19，需同步 `persistence-schema.test.ts` 的守门清单）。工程图本身不放进 sessions.db：整份覆盖与零校验的教训见记忆 `2026-10-18-canvas-snapshot-overwrite-no-rev`，图文件用原子写 + `version` 比较。
- **并发**：网关单进程；每个工程一个 promise 链互斥锁，所有写（补丁、引擎状态更新）串行进入。补丁带 `baseVersion` 时不匹配 → `VERSION_CONFLICT`（整批拒绝）；`set` 带 `ifRev` 时不匹配 → 该 op `REV_CONFLICT`。引擎写结果时比较“启动时的签名”与“当前签名”：用户在节点运行期间改了参数 → 结果照存（产物已花钱），节点置 `stale`。
- **崩溃恢复**：网关启动时扫描 `projects/*/project.json`，对 `status=running/queued` 的节点：有 `inflight.taskId` → 按平台任务轮询接续；只有 `idemKey` → 用同一 Idempotency-Key 重提交（上游去重，不重复扣费）；`submitUnknown` 的节点按 `ExecBridgeClient.result(idemKey)` 或平台任务查询确认，不假装没收到。
- **画布呈现（不新造图）**：S10a 订阅 `events.jsonl` 写入，转成现有 world2→world1 事件桥使用的 `canvas.node.created/updated/connected`（`workflow-gw-service.ts:39-80` 那套 emit + `applyCanvasNode*` 写穿快照）。画布节点 id = `workflowNodeId("p_"+projectId前8位, nodeId)`（与 `compile.ts:80` 同一个 FNV 函数，S10a 以跨端等值测试锁定），metadata 带 `workflow_ns/stepId/stepIndex`（让现有 `decompile` 读面继续可用）+ 新键 `project_node_id/project_sig/project_pinned/project_stale/project_reused`；forEach 实例不带 `workflow_ns`（同衍生卡规则）。`pinned`/`locked` 在画布上复用现有 `locked` 视觉，P2 不新增控件（见裁定点 J3）。
- **人手改动回写（反向，仅人手）**：画布上的用户编辑（改 prompt/模型/尺寸、锁定、删除、替换产物）经 S10b 的 `project-sync` 以 `Actor=user` 调 `POST /agent/v1/sessions/:id/project/patch`（会话主人鉴权）落到工程图。模型永远不通过画布写工程图；DSL 与画布 op 对工程图只有 `project_patch` 一条写路径。
- **DSL → 图 的 compile 落点**：复用并扩展 `src/lib/workflow-dsl`（S13）：
  - `schema.ts` 的 `kind` 增加 §3 的 NodeType（保持 `image|text|video|audio|director` 兼容旧画布），新增 `forEach/takes/onFail/pinned/refs/intent` 字段；
  - `compile.ts` 新增 `target:"project"`：输出强类型 `PatchOp[]`（`add_node/set/connect`），`locked` 节点沿用 `patchForExisting`（`compile.ts:153-173`）的语义——丢弃该节点的 patch 并回 warning（`lockedDropped`），不静默覆盖；
  - 站点路由 `/api/v1/workflow/compile` 加 `target` 参数；`project_patch` 工具（opencode 进程）先取 `project_get` 的当前节点摘要作为 `current`，调站点编译，再把 `PatchOp[]` 交网关。网关不 import `src/`（`deploy-staging/gateway` 的 tsc 范围之外）。
  - 老路径 `workflow_write → canvas_apply_ops` 保持为旧席位（`creator_legacy`）使用，MCP/B-key 的 `/api/v1/canvas/workflow` 不动（P4 再收）。

### 3.5 节点规格表（S3 把它落成 `NODE_SPECS`；这里是规范性内容）

| type | 主输出口 | 签名参数（signedParams） | 可 pin | 执行器 | 网关侧包装点 | 价格来源 |
|---|---|---|---|---|---|---|
| reference | out(file) | source, artifactId | 是 | materialize（把上传/素材库文件入库） | `ctx.ingest` | 0 |
| script | out(text) | text | 是 | authored（`write_result` 落盘） | `artifacts.ts` | 0 |
| shotlist | out(json) | kind, rows[] | 是 | authored | 同上 | 0 |
| keyframe | out(image) | prompt, model, size, seed, role, n, styleLock | 是 | generation | `submitGeneration(kind:"image")` | `estimateNodeCoins` / 价目缓存，缺价→null |
| clip | out(video) | prompt, model, seconds, resolution, seed, generateAudio | 是 | generation | `submitGeneration(kind:"video")` | `videoNodeCoinsSync` |
| voice | out(audio) | text, voice, speed | 是 | speech | `synthesizeSpeech`（合并 `media-internal-routes.ts:362 handleTts` 与 `workflow-gw-service.ts:153` 两份实现） | 按字数，同 handleTts |
| music | out(audio) | prompt, lyrics, seconds, model, sourceAudioSha | 是 | exec-bridge | `ExecBridgeClient.call("music_gen")` | 1 币/次（`musicChargeRef` 幂等，见记忆 `2026-10-10-music-one-coin-billing`） |
| timeline | out(json) | order, transitions, aspect, fps, styleId | 是（人手剪辑后钉住） | deterministic | `timeline.ts` 的 ops 套用，产物=`current.json` 快照 | 0 |
| subtitle | srt, ass | style, burnIn, lang | 是 | deterministic | 由 shotlist 台词 + timeline 时间轴生成 | 0 |
| mix | out(audio) | levels, ducking, targetLufs | 是 | deterministic | `mix.ts applyMix` | 0 |
| export | out(video 或 package) | preset(`landscape_169`等 `MASTER_PRESETS` / `image_pack`) | **否** | deterministic | `master.ts masterExport` + `assembleFilmNode` 重构出的 `assembleFromClips` | 0 |
| qc | out(json verdict) | mode(machine/critic), rubric, thresholds | **否** | machine=`film-qc.ts analyzeFilm`+ffprobe；critic=评审子代理写 verdict | S8c | critic 子代理成本走子代理账 |
| render3d | out(file) | script, engine, params | 是 | exec-bridge | `ExecBridgeClient.call("blender_render")` | 报不出价→null |

Pin 边界（schema 显式规则，S2 强制、S3 声明、S18 测试）：不可 pin = `export`、`qc`、forEach 模板节点本体、没有产物的节点、status 为 failed/blocked 的节点、`scratch` 节点；`takes` 节点 pin 时必须指定 take，且钉住的是被选中的那个；pin 必须冻结该节点所有输出口（不允许只钉一部分）。上游被删导致 pinned 节点输入悬空：保留产物，状态置 `orphaned`，不自动删。

### 3.6 exec-bridge：opencode 进程里的能力怎么被网关调用（S12）

- 现状：`music_gen`（`opencode-runtime/lib/music-tools-impl-*.ts` + `music_flowmusic/lyria/yue2.ts`，约 6000 行，直接对上游 `fetch`，扣费走 `platformFetch`）与 `blender_*`（`blender-tools-impl.ts`，桥 `127.0.0.1:8765`）只能在 opencode 进程里被调用；网关里没有等价函数。把 6000 行拷进网关会制造第三份音乐实现，违反“禁止造轮子”。
- 做法：新增一个独立 Bun 进程 `exec-bridge`（`deploy-staging/opencode-runtime/exec-bridge/server.ts`），`import` 现有 adapter 包装后的 `musicGenTool` 与 `blenderExecTool` 的 `execute`，对外只暴露两条回环 HTTP 路由；用 systemd 单元 `deploy/vps/systemd/agent-exec-bridge.service`（与 `opencode-server.oom.conf` 同目录）。
  - 监听：`127.0.0.1:8767`（8765 被 blender 桥占用，8890-8899 是 zen 代理池，18893 是 groq 隧道，均避开）。
  - 鉴权：`X-Internal-Token` 必须等于环境变量 `HARNESS_INTERNAL_TOKEN`（网关已有同名机制，`task-board-http.ts:34 internalTokenRejection`）。**与网关不同，桥在 token 缺失时拒绝启动**（fail-closed，不做“只靠回环信任”的降级）。
  - 路由：`POST /v1/exec/music_gen`、`POST /v1/exec/blender_render`，body=`{sessionId, projectId, nodeId, signature, idemKey, params}`；`GET /v1/exec/result/:idemKey` 返回结果缓存（磁盘保留 24 小时）。
  - 幂等：`idemKey` 作为 `musicChargeRef`（music 已有该幂等扣费机制）；同 key 二次调用直接返回缓存结果，不再调用上游。
  - 超时：桥内硬超时 music 240 秒、blender_render 1200 秒；网关客户端超时 = 桥超时 + 15 秒；客户端超时 → 节点置 `inflight.submitUnknown=true`，恢复流程查 `result/:idemKey`，禁止盲重投。
  - 并发：桥内信号量 music=2、blender=1，超出排队；网关侧调度器另受全局并发上限约束。
  - 文件交接：桥把产物写到 `$WORKSPACE_DIR/projects/<sid>/tmp/<idemKey>/`，响应里只回路径；网关用 `ctx.ingest` 搬入 artifact-store 并算 sha256。写入目录属主/权限按记忆 `2026-10-15-runtime-write-root-agentsvc-sqlite-cantopen` 处理（opencode 进程以 `agentsvc` 运行）。
- 为什么不放进 opencode 插件里开 `Bun.serve`：插件可能被多次实例化，端口冲突与生命周期不可控。为什么不让网关 `import` runtime lib：两棵树的部署与 tsc 范围不同，路径依赖脆弱。

### 3.7 每轮上下文装配、主代理工具面、beast_mode（S15/S14，规范性）

**每轮输入 = 固定小系统提示 + 目标卡 + 工程摘要 + 最近 K=6 步 + 当前用户消息。**

1. 固定系统提示：一份静态文本（≤8KB），不随轮次变化，保证前缀缓存稳定；beast_mode 的差异只体现在这份文本里的一个开关段（构建时按会话固定，不按轮切换）。
2. 目标卡（`brief[]` 渲染，S15 把 `eimu-guard.ts` 的 `renderGoalCard`（`:603`）逐行搬到网关 `project/brief.ts`，规则不变：首条+最近若干条+更早的纠正/否决/授权类，其余折叠并标注条数；上限沿用 `GOAL_CARD_MAX_TOKENS=4000`）。工程模式下 eimu-guard 不再自己水合，改为向网关取（`GET /internal/project/context?session_id=`）。
3. 工程摘要（`digest.ts` 由图确定性生成，≤6144 字节≈3000 token，非模型写）：分段固定为 状态计数 / 失败与阻塞（全列）/ 钉住与漂移（全列）/ 待决问题与用户决定 / 预算与授权 / 环境可用性（≤600B）/ 用户偏好（≤600B）/ 最近事件（≤10 行）。超限按段内优先级截断，**失败与漂移段永不被截成空**（双侧判准的下限）。
4. 最近 K 步：窗口单位是“一条完成的 assistant 消息及其工具结果”，从尾部取 6 步，保持 tool_use/tool_result 成对；更早的步骤不发给模型（仍在 opencode 库里，可由 `project_get(view:"events")` 复盘）。
5. 装配点：`eimu-guard.ts` 的 `experimental.chat.messages.transform`（已有，`:1208`，现状就在这里给最近用户消息追加合成片段）。工程模式下该 hook 做三件事：①把 `output.messages` 裁成 [最近 K 步 + 当前用户消息]；②在当前用户消息末尾追加合成片段（目标卡+摘要，`synthetic:true`，不落库）；③跳过旧的压缩目标卡逻辑。**未验证假设**：opencode 1.18.14 是否采用被原地裁剪后的数组。S15 第一动作做最小探针（≤2 次读取/1 次本地跑），不成立就停手回报“资产上限”，不得改成两案并存。
6. 工程模式会话不再触发压缩（窗口始终小）；`experimental.session.compacting` 保留给旧席位。
7. 网关不再往用户消息尾部追加任何文本：`messages-gw-admission.ts` 里 25 处尾部注入，在工程模式下只保留三个事实进摘要（授权模式、余额/预算、环境可用性），其余删除或进摘要。“伪用户消息”的定义：**持久化进 opencode 会话库的 user 角色文本里，不等于人类原话的部分**（transform 时合成、不落库的片段不算，但计入 INPUT_CAP）。
8. 主代理工具面（≤12，会话内不变）：`project_get, project_patch, project_run, subagent_dispatch, subagent_stop, question, read_image, search_web, asset_search, read`（共 10；`bash/edit/write/skill/memory_*/canvas_*/workflow_*/image_*/video_*/music_gen/blender_*/timeline_*/tts_speak/local_files*` 全部从主席位移除）。`subagent_status` 并入 `project_get`（事件里带子代理完成）。上传文件由网关在 ingress 注册为 `reference` 节点，不再需要 `image_upload/video_upload`。`skill` 的内容改为节点类型的 `guidance`，经 `project_get(view:"node", detail:"full")` 取。
9. beast_mode：`messages-gw-admission.ts:519/525` 现在按 beast_mode 在 `orchestrator`(38 工具)/`creator`(49 工具) 间切换，且每轮实时读设置，等于会话中途换工具表。改法：旧行为整体冻结给旧会话（`creator_legacy`/`orchestrator_legacy`，原席位逐字拷贝，仍按 beast 切换）；工程会话主席位固定为新定义的 `creator`（10 个工具），`opencode.json` 里新 `orchestrator` 条目的工具表与 `creator` 逐项相同（仅防残留引用）；beast_mode 只决定固定系统提示里的开关段，并在会话创建时锁存（`state.seat`、`state.beast` 持久化，S19）。plan 模式（`agent: "plan"`，5 个工具）取消换席位，改为 `/internal/tool/precheck`（`router-internal.ts`，eimu-guard 的 `tool.execute.before` 已经每次调用它）对 `project_patch/project_run/subagent_dispatch` 返回拒绝。等价不变性=Manus 的 mask 做法（exemplar §6.1），拒绝而非隐藏，schema 不变。
10. 子代理席位：专家席位（director3d、music、video-director、editor、screenwriter、motion-director、web3d-director、critic、lyricist 等）同时被旧会话使用，不能原地改。做法：为每个专家席位在 `opencode.json` 新增工程版 `<expert>_p`（静态条目，复制原席位后去掉 `DIRECT_GENERATION_TOOLS`、加入 `project_get/project_patch`，受 lane 约束）；旧席位原样保留。工程模式下 `subagent_dispatch` 解析席位时自动换成 `_p` 版（S16）。工程版席位要出图/视频就在自己 lane 里 `add_node`（可带 `scratch`）再 `project_run`。这样账本才能做到“每笔生成带 node_id，直调=0”。

### 3.8 子代理与 critic（S16）

- `subagent_dispatch` 入参新增 `lane: NodeId[]`（该子代理可写的节点集合，默认空=只读）。子代理的补丁以 `Actor={kind:"subagent", runId, lane}` 进入，`set/write_result/add_node(仅 lane 下新节点)` 越界 → `LANE_VIOLATION`。
- 回父会话：`summary`（≤2000 token≈4096 字节）+ `nodeIds`（≤20），不再带全文；全文已在节点产物里。`finishRun` 不再 `wakeParent`（工程模式），完成事件进 `events.jsonl`，主代理经 `project_get` 的事件取到（§0.1 第 3 点）。
- critic = 图里的 `qc(mode:"critic")` 节点：QC 执行器通过现有 `/internal/subagent/dispatch` 派评审子代理，lane=[该 QC 节点]，子代理用 `write_result` 写 `{score, pass, deficiencies[]}`；`CRITIC_PASS_MARK/REJECT_MARK` 前缀机制在工程模式下不再使用。

### 3.9 闸：删闸不加闸（S17）

- 工程模式下，交付只存在于 `export` 节点：交付卡（用户看到的下载/播放入口）只从 `export.outputs` 渲染；模型的自然语言“已完成”不产生任何交付物，也不被任何闸检查（不检查措辞）。
- 保留的闸全部查产物，由 `export` 与 `qc` 节点执行：文件存在且 sha256 对得上、`ffprobe` 能解码、时长在 `targets.durationSec` ±10% 内（无 targets 时只检查非零且 ≤ 配方上限）、有音轨（`targets.audio≠"none"` 时）、`analyzeFilm` 的响度/黑帧/冻结帧过阈值、`qc` 评分≥阈值。
- 删除（工程模式下不接线）：`canvas-write-gate.ts` 残余（已在 2026-10-28 停用，`canvas-write-gate-off.test.ts`）、`delivery-gate.ts` 字段名检查、`opencode-event-handler.ts` 里依赖它们的 nudge。旧席位保持原样。
- 运行时 `AGENTS.md`：每条规则一个 `[R-nn]` 标签；`project/rules-map.ts` 把标签映射到强制它的代码路径与测试名；没有映射的规则删除，并把删除清单回报 orchestrator（含“在版歌曲旋律不交”“乐理核对”这类无法用代码强制的，见裁定点 J5）。

## 4. C. 切片表

波次：W0 → W1 → W2 → W3 → W4。同一波次的切片文件互不相交（见 §4.3 校验）。P1=核心引擎（S0-S8c、S12，无需模型即可验证），P2=切换（S9-S11z、S13-S17、S19），P3=上线门（S18 + 端到端评测设计）。

### 4.1 总表

| ID | 目标 | 阶段 | 波次 | 依赖 | 预期 |
|---|---|---|---|---|---|
| S0 | 契约冻结：types.ts、constants.ts、fixtures、SessionState 字段 | P1 | W0 | 无 | 20 分钟 |
| S1 | 签名、planRun、缓存索引 | P1 | W1 | S0 | 40 |
| S2 | 存储、补丁引擎、产物入库、事件流 | P1 | W1 | S0 | 60 |
| S3 | NODE_SPECS 与图校验（端口/环/pin 边界） | P1 | W1 | S0 | 45 |
| S4 | 引用文法、forEach 展开、takes/onFail 数据处理 | P1 | W1 | S0 | 45 |
| S5 | submitGeneration 抽取 + 账本 node_id + 收据登记 | P1 | W1 | S0 | 50 |
| S12 | exec-bridge（music/blender）+ 网关客户端 | P1 | W1 | S0 | 45 |
| S13 | DSL v2 编译（target:"project"） | P2 | W1 | S0 | 45 |
| S6 | 调度器：增量执行、重试、恢复、准入（报价/确认/预算） | P1 | W2 | S1,S2,S3,S4 | 70 |
| S7 | 执行器：reference/script/shotlist/keyframe/clip | P1 | W2 | S2,S5 | 50 |
| S8a | 执行器：voice、music | P1 | W2 | S2,S5,S12 | 45 |
| S8b | 执行器：timeline、subtitle、mix、export | P1 | W2 | S2,S3 | 60 |
| S8c | 执行器：qc（machine/critic）+ takes 选优 | P1 | W2 | S2,S3 | 45 |
| S11a | 配方：电影族 4 个 | P2 | W2 | S3,S4 | 45 |
| S11b | 配方：图片/电商族 6 个 | P2 | W2 | S3,S4 | 45 |
| S11c | 配方：IP/策展族 3 个 | P2 | W2 | S3,S4 | 45 |
| S15 | 上下文装配、目标卡→brief、摘要生成、ingress 钩子 | P2 | W2 | S2 | 60 |
| S10a | 画布桥（网关侧：事件→canvas.*） | P2 | W2 | S2 | 40 |
| S9 | project_* 路由与三个工具 | P2 | W3 | S2,S6,S15 | 50 |
| S11z | 配方索引 + 可执行率与不可牺牲内容测试 | P2 | W3 | S11a-c | 30 |
| S14 | 主代理工具面收敛、beast/plan 处理 | P2 | W3 | S9,S15 | 45 |
| S16 | 子代理写节点、lane、critic 接线 | P2 | W3 | S2,S8c,S9 | 55 |
| S19 | 迁移、回滚、会话席位锁存、旧工作流导入 | P2 | W3 | S2,S3 | 45 |
| S10b | 画布前端：白名单 + 人手回写 | P2 | W4 | S10a,S9 | 60 |
| S17 | 删闸与规则压缩 | P2 | W4 | S9,S14,S16 | 40 |
| S18 | P3 CI 不变量测试 + CI job | P3 | W4 | 全部 | 60 |

### 4.2 每片：独占文件、判准、预算、瓶颈、禁止打磨、需读章节

路径前缀：`G=deploy-staging/gateway`，`P=deploy-staging/gateway/project`，`R=deploy-staging/opencode-runtime`，`SRC=src`。除表中列出的 hunk 外，切片不得改任何其他既有文件。

| ID | 独占文件（新文件写全路径） | 判准（上限 / 下限=不可牺牲） | 迭代预算 | 首要瓶颈 | 禁止打磨 | 需读 |
|---|---|---|---|---|---|---|
| S0 | `P/types.ts`、`P/constants.ts`、`P/contract-fixtures.json`；`G/types-gateway.ts` 加 `projectMode?:boolean; seat?:"creator"|"creator_legacy"; beast?:boolean` | `npx tsc -p deploy-staging/gateway --noEmit` 绿 / fixtures 覆盖 PatchOp 全部 16 种 op、每个 PatchErrorCode 至少 1 例、三个工具各 1 个满量回执样本 | 1 轮 | 契约与本文 §3 逐字一致 | 重命名、美化 | §3 |
| S1 | `P/signature.ts`、`P/cache-index.ts`、`P/signature.test.ts`、`P/cache-index.test.ts` | 上限：200 节点图 `planRun` ≤200ms / 下限：§3.2 第 4 条四个性质 + pinned 漂移不重算 + 指纹抛错→重跑 + 缓存命中产物文件被删→不命中 + GC 保留墓碑 | 2 轮 | 签名正确性（宁可多重跑，不可错用旧产物） | 性能、缓存分片 | §2 第 1-7 行、§3.2 |
| S2 | `P/store.ts`、`P/patch.ts`、`P/receipt.ts`、`P/artifacts.ts`、`P/events.ts`、`P/store.test.ts`、`P/patch.test.ts` | 上限：回执序列化 ≤1024B（含 256 个 op 的极端批）/ 下限：16 种 op 语义全覆盖、pin 边界 7 条规则、lock 语义对齐 `patchForExisting`、崩溃后重启读回同图、并发 50 个补丁无丢失、`replace_output` 仅 user | 2 轮 | 补丁语义（pinned/locked/lane 交叉规则） | 事件格式美化 | §3.1、§3.4、§3.5 |
| S3 | `P/specs.ts`、`P/validate.ts`、`P/specs.test.ts`、`P/validate.test.ts` | 下限：13 个 NodeType 全有 spec、每个签名参数有校验、环/悬空/类型不匹配拒绝、pin 边界表与 §3.5 一致 | 1 轮 | 参数校验与现有 `image_generate` 载荷字段对齐 | 文案 | §3.5 |
| S4 | `P/refs.ts`、`P/expand.ts`、`P/takes.ts`、`P/refs.test.ts`、`P/expand.test.ts` | 下限：§3.3 文法全部 case（含 `${row.x}`、`${shot.keyframe}`、`${node.port}`、非法 alias=`row`、嵌套 forEach 拒绝）、row 删除时 pinned 实例→orphaned、扇出 50 行 ≤50ms；上限：实例 id 稳定（同输入同 id） | 2 轮 | 引用解析与扇出实例的确定性 | 语法糖 | §3.3 |
| S5 | `P/submit-generation.ts`、`P/ledger.ts`、`P/submit-generation.test.ts`；hunk：`G/quota-ledger.ts`（LedgerEntry 加 §3 字段）、`G/job-store.ts`（`acknowledgeGeneration` 保留 `artifacts[].sha256`；项目会话的 `/internal/job-register` 无 node_id 则 409） | 上限：不动 `workflow-gw-submit.ts` 现有导出签名 / 下限：对 fake 平台服务器的每个 POST 都有 `Idempotency-Key` 且格式 `pg:<pid>:<sig40>:t<take>:a<attempt>`、body 的 `workflow.metadata` 有 node_id/signature/project_id、收据登记、项目预算预留与释放、`submit_unknown` 保留 key 不丢、载荷字段与 image_generate 逐字段对表无遗漏（reference_images、style_lock、quality、resolution、generate_audio、cap_coins 等） | 2 轮 | 载荷对齐（两套轮子取舍见 §0.1 第 2 点） | 重写轮询/failover 逻辑 | §0.1(2)、anatomy Q5 |
| S12 | `R/exec-bridge/server.ts`、`R/exec-bridge/server.test.ts`、`P/exec-bridge-client.ts`、`P/exec-bridge-client.test.ts`、`deploy/vps/systemd/agent-exec-bridge.service` | 下限：无 token 拒绝启动、错 token 403、同 idemKey 二次调用不二次调用上游（fake 计数）、超时后 `result/:key` 可取回、网关客户端超时置 submitUnknown；上限：单请求内存 ≤50MB | 2 轮 | 与 adapter 包装的 `music_gen` 保持逐行同一调用路径 | 新增路由 | §3.6 |
| S13 | `SRC/lib/workflow-dsl/schema.ts`、`compile.ts`、`decompile.ts`、`project-ops.ts`（新）、对应 `*.test.ts`、`SRC/app/api/v1/workflow/compile/route.ts` | 上限：旧 DSL 输入输出不变（现有测试全绿）/ 下限：新 kind 与 forEach/takes/onFail/pinned/refs 往返、locked 节点 patch 丢弃+warning、输出的 PatchOp 通过 S0 fixtures 校验 | 2 轮 | 与 `patchForExisting` 语义逐项一致 | 错误文案 | §3.4 DSL 段 |
| S6 | `P/scheduler.ts`、`P/run.ts`、`P/admission.ts`、`P/recovery.ts`、`P/executor-registry.ts`、`P/scheduler.test.ts` | 上限：命中节点不入队（fake 执行器调用数=0）/ 下限：按层并发、`regenerate(max=2)`、takes、失败下游 blocked、重启恢复不重复提交（同 idemKey）、预算超限拒绝、确认阈值沿用 `CONFIRM_THRESHOLD_COINS` 与 auto/full 授权、`reused` 事件与账本行必发 | 3 轮 | 复用/重跑判定与账本的一致性 | 调度公平性 | §2 第 4 行、anatomy Q2 |
| S7 | `P/executors/{reference,authored,keyframe,clip}.ts`、`P/executors/generation.test.ts` | 下限：键帧/视频走 `ctx.submitGeneration`（不得自行 fetch 平台）、模型 failover 沿用、产物经 `ctx.ingest` 带 sha256、`${}` 已解析的 prompt 才提交；上限：不新增 env | 2 轮 | 载荷与 `workflow-gw-submit.ts` 的 prompt/参考图解析等价 | 提示词润色 | §3.5、anatomy Q2 |
| S8a | `P/executors/{voice,music}.ts`、`P/speech.ts`、`P/executors/audio.test.ts`；hunk：`G/media-internal-routes.ts`（`handleTts` 改为调 `synthesizeSpeech`，行为不变） | 下限：旧 `/tts` 路由响应逐字节不变、music 经 `ExecBridgeClient`、同 idemKey 不二次扣费；上限：不动 `workflow-gw-service.ts` 的内联 audio（旧路径） | 2 轮 | TTS 两份实现合并为一份而不改旧行为 | 音色选项 | §3.5、记忆 music-one-coin |
| S8b | `P/executors/{timeline,subtitle,mix,export}.ts`、`P/executors/assemble.test.ts`；hunk：`G/workflow-gw-assemble.ts`（抽出 `assembleFromClips(clips,audio,opts)`，`assembleFilmNode` 改为调它） | 下限：旧 `assembleFilmNode` 行为不变（现有测试绿）、export 产出可解码 mp4 且有音轨（ffprobe 断言）、镜头顺序来自图而非 id 字符串、`image_pack` 预设产出包清单；上限：不新增转场/特效 | 2 轮 | 重构 `assembleFilmNode` 不破旧路径 | 视觉效果 | §3.5、记忆 film-subtitle-burnin |
| S8c | `P/executors/qc.ts`、`P/rubrics.ts`、`P/executors/qc.test.ts` | 下限：machine QC 用 `analyzeFilm` 阈值（`QC_TARGET_LUFS=-16`、`QC_TARGET_TP=-1.5`）；坏样例（无音轨/时长偏差 >10%/全黑）必须判不过，好样例必须判过；takes 选优选分最高；critic 模式写 `write_result` | 2 轮 | 坏样例集要独立构造（ffmpeg 生成的真文件），不是 mock | 评分美学 | §3.3、§3.9 |
| S11a | `P/recipes/{single_video,feature_film,novel_film,shortdrama_visual}.ts` | 见 §6 映射原则；下限：旧模板每个 role 在 `legacyRoleMap` 有去处；每个旧可执行节点（image/video/audio/film）至少对应一个新可执行节点 | 2 轮 | 旧 role 全映射且无牺牲内容 | 提示词文案 | §6 |
| S11b | `P/recipes/{single_image,character_sheet,scene_setup,ecom_launch,ecom_model,shortdrama_poster}.ts` | 同上 | 2 轮 | 同上 | 同上 | §6 |
| S11c | `P/recipes/{novel_ip,art_curation,art_style}.ts` | 同上 | 2 轮 | 同上 | 同上 | §6 |
| S11z | `P/recipes/index.ts`、`P/recipes/recipes.test.ts` | 13 个配方 100% 通过 `validate` 且每个节点类型都有注册执行器；对每个配方 `dry_run` 报价无 `unknownPrice`（价目用测试目录）；节点数 ≥ 该模板旧可执行节点数 | 1 轮 | 同上 | 同上 | §6、§8 I7 |
| S15 | `P/brief.ts`、`P/digest.ts`、`P/context.ts`、`P/context.test.ts`；hunk：`R/plugin/eimu-guard.ts`（工程模式分支）、`G/messages-gw-types.ts`（ingress 追加 brief + 首条消息自动 `ensureProject`，复用 `buildTemplateSkeletonForPrompt` 的意图判定） | 上限：200 步合成会话每轮输入 ≤`INPUT_CAP_BYTES`=65536 / 下限：每轮含目标卡且与用户原话逐字相同；摘要含全部 failed/blocked/pinned/drift 节点；旧席位路径逐字节不变 | 2 轮 | opencode 是否采用被裁剪的 messages 数组（§3.7 第 5 点） | 摘要排版 | §2 第 9/10 行、§3.7 |
| S10a | `P/bridge-canvas.ts`、`P/bridge-canvas.test.ts` | 下限：引擎事件→canvas.node.created/updated/connected 全覆盖、画布节点 id 与 `compile.ts workflowNodeId` 在 100 组样本上逐字相等、复用/钉住/过期标记写入 metadata；上限：不改 `workflow-gw-service.ts` | 2 轮 | 跨端 id 等值 | 事件节流 | §3.4 |
| S9 | `P/routes.ts`、`P/routes.test.ts`、`R/tools/project_get.ts`、`R/tools/project_patch.ts`、`R/tools/project_run.ts`、`R/lib/project-client.ts`；hunk：`G/router.ts`（挂载 `/internal/project/*` 与 `/agent/v1/sessions/:id/project/*`，仅挂载行） | 下限：三个工具的参数 schema 与契约一致（用 S0 fixtures 双向校验）；回执满量样本 ≤1024B（`project_get(view:"digest")` ≤6144B）；`wait_sec` 最大 90 且事件到达即返回；通过 `tools/check-opencode-tool-schemas.mjs` | 2 轮 | 长轮询与回合看门狗（`armWatchdogTimer`/心跳）的相容性（未验证，S9 先量） | 工具描述润色 | §3.7 |
| S14 | `R/opencode.json`、`G/expert/opencode-agents.json`、`G/messages-gw-admission.ts`、`G/router-internal.ts` | 上限：`creator` 与 `orchestrator` 启用工具数均 ≤12 且集合相同 / 下限：§3.7 第 8 点十个工具齐全；`DIRECT_GENERATION_TOOLS`（含扫描补全）在 creator/orchestrator/全部 `_p` 席位启用集中为 0；beast 开关两种取值下 `promptBody.agent` 都是 `creator`；plan 模式下 `project_patch/project_run/subagent_dispatch` 被 precheck 拒绝而工具表不变；旧席位 `creator_legacy` 为原 `creator` 逐字拷贝 | 2 轮 | 工程版 `_p` 席位与旧席位并存，不破现有派工；被折叠工具的去向清单 | 提示词 | §3.7 第 8-10 点 |
| S16 | `G/subagent-finish.ts`、`G/subagent-dispatch.ts`、`G/subagent-types.ts`、`P/lanes.ts`、`P/lanes.test.ts` | 上限：回父摘要 ≤4096B 且 nodeIds ≤20 / 下限：工程模式下 dispatch 解析席位自动换成 `<expert>_p`（旧会话不变）；lane 越界被拒、工程模式不 `wakeParent`、旧席位路径行为不变（`subagent.test.ts` 绿）、critic 通过 QC 节点写 verdict | 3 轮 | 三个文件是脏树文件，需在干净基线上做最小 hunk | 摘要措辞 | §3.8 |
| S19 | `P/legacy-import.ts`、`P/legacy-import.test.ts`；hunk：`G/persistence-types.ts`、`G/persistence-io.ts`（`PERSISTED_DATA_KEYS` 加 `projectMode/seat/beast`）、`G/persistence-schema.test.ts`（守门清单）、`G/sessions-core.ts`（创建会话时按 env 锁存席位） | 下限：旧会话读回后 `seat` 仍是 `creator_legacy`；`EIMU_PROJECT_MODE=off` 时新会话走旧席位（回滚）；导入器把旧 `nodeContent` 变成 pinned 的 reference/产物节点，产物 sha256 实算；上限：导入不触发任何上游调用 | 2 轮 | 持久化守门清单必须同批更新 | 导入映射覆盖率 | §7 |
| S10b | `SRC/lib/canvas/node-metadata-fields.ts`、`SRC/lib/canvas/layout/normalize.ts`、`SRC/hooks/canvas/canvas-chat-types.ts`、`SRC/hooks/canvas/project-sync.ts`（新）、挂接点（S10b 第一动作定位，只许 1 个文件 ≤10 行 hunk） | 下限：新键 `project_node_id/project_sig/project_pinned/project_stale/project_reused` 在三处白名单同批加入且重载后存活（对 `2026-09-24-ws10-emits-entity-whitelist-strip-fix` 同类测试）；用户改 prompt/锁定/删除→`Actor=user` 补丁；agent 的 ops 不触发回写（防回环）；视觉改动按仓库规则做本地 E2E 截图自审 | 3 轮 | 回环抑制（用户改动 vs 引擎事件） | 视觉美化 | §3.4 |
| S17 | `G/canvas-write-gate.ts`、`G/delivery-gate.ts`、`G/opencode-event-handler.ts`、`R/AGENTS.md`、`P/rules-map.ts`、`P/gates.ts` | 下限：旧席位路径测试全绿；工程模式 `export` 前置检查=产物检查；无映射规则被删并列出；上限：`AGENTS.md` ≤200 行且每条非空规则带 `[R-nn]` | 2 轮 | 区分“可由代码强制”与“只是愿望” | 措辞压缩 | §3.9 |
| S18 | `P/__invariants__/*.test.ts`、`P/__invariants__/fixtures/*`、`.github/workflows/ci.yml`（只追加一个新 job，不碰现有 job） | 见 §8 七条不变量；上限：整个 job ≤8 分钟 | 2 轮 | 期望值独立于实现（§8 逐条给出独立来源） | 覆盖率 | §8 |

### 4.3 文件独占校验

- 新增目录 `P/` 下按切片分文件，互不重名；`P/recipes/` 三族文件各归一片，`index.ts` 归 S11z。
- 既有共享文件各只有一个切片拥有：`quota-ledger.ts`/`job-store.ts`=S5；`media-internal-routes.ts`=S8a；`workflow-gw-assemble.ts`=S8b；`router.ts`=S9（仅挂载行）；`router-internal.ts`/`messages-gw-admission.ts`/`opencode.json`/`expert/opencode-agents.json`=S14；`eimu-guard.ts`/`messages-gw-types.ts`=S15；`subagent-*.ts`=S16；`persistence-*.ts`/`sessions-core.ts`=S19；`canvas-write-gate.ts`/`delivery-gate.ts`/`opencode-event-handler.ts`/`R/AGENTS.md`=S17；`ci.yml`=S18；`types-gateway.ts`=S0；`src/lib/workflow-dsl/**`=S13；`src/lib/canvas/**`、`src/hooks/canvas/**`=S10b。
- 跨切片只通过 `P/types.ts`、`P/constants.ts`、`P/contract-fixtures.json`。

### 4.4 脏工作树风险

当前工作树有未提交改动的文件（`git status` 快照）与它们落在哪个切片：`job-store.ts`(S5)、`router.ts`(S9)、`subagent-finish`相邻的 `subagent-types.ts`/`subagent-messages.ts`/`subagent-attempt.ts`(S16)、`sessions-core.ts`(S19)、`opencode-event-handler.ts`(S17)、`R/AGENTS.md`(S17)、`ci.yml`(S18)、`workflow-gw-service.ts`(不被任何切片修改，仅被引用)、`music-tools-*`/`music_*.ts`(S12 只 import，不改)。处理：每个切片在 `isolation: worktree`（从 HEAD）内工作，回报 diff；orchestrator 用 `git apply --3way` 合入并先确认拥有者对这些文件的未提交改动已提交或暂存（记忆 `2026-10-14-shared-tree-temp-index-commit`、`2026-10-14-shared-tree-worktree-release-vs-concurrent-commit`）。S13 第一动作确认 `compile.ts` 的 `patchForExisting` 已在基线里。

## 5. 现状锚点（切片写代码前的定位表，均来自 anatomy 的行号核验）

| 要动/要复用的东西 | 位置 |
|---|---|
| world2 引擎纯函数：拓扑/就绪 | `G/workflow-engine.ts:97 expandTemplate`、`:349 topologicalSort`、`:378 readyNodes` |
| world2 服务：start/update/rerun/generate | `G/workflow-service.ts:216,391,826,558`；重入语义“success 且有 content 即跳过” `generateInnerBody :628-648` |
| 节点提交（生产在用）：prompt BFS、模型三级解析、failover、轮询 | `G/workflow-gw-submit.ts:268 submitWorkflowNode`，轮询预算 ~:470 |
| 成片拼接 | `G/workflow-gw-assemble.ts:13 assembleFilmNode`；镜头数硬闸 P0-B |
| 时间线/混音/导出 | `G/timeline.ts`、`G/mix.ts:292 applyMix`、`G/master.ts:188 masterExport`、`G/film-qc.ts:66 analyzeFilm` |
| 会话持久化键 | `G/persistence-io.ts:16-40 PERSISTED_DATA_KEYS`、`:44 serialize` |
| 内部路由与 token | `G/router.ts:181-286`（loopback）；`G/task-board-http.ts:34 internalTokenRejection` |
| 目标卡渲染 | `R/plugin/eimu-guard.ts:603 renderGoalCard`、`:551 GOAL_CARD_MAX_TOKENS`、`:1208 messages.transform` |
| 席位选择 | `G/messages-gw-admission.ts:519/525`（beast→orchestrator，否则 creator） |
| 工具表 | `R/opencode.json` `agent.<name>.tools`（creator 49、orchestrator 38、build 84…）；预检读 `G/expert/opencode-agents.json`（`seat-preflight.ts:16`） |
| image_generate 载荷与幂等 | `R/tools/image_generate.ts:490-520` |
| 子代理回父 | `G/subagent-finish.ts:119 finishRun`、`:183` 摘要、`:578` wakeParent；`G/subagent-types.ts:63,68` |
| 白名单三处 | `SRC/lib/canvas/node-metadata-fields.ts:62,190`、`SRC/lib/canvas/layout/normalize.ts:232`、`SRC/hooks/canvas/canvas-chat-types.ts:153,210` |
| DSL | `SRC/lib/workflow-dsl/schema.ts:21-52`、`compile.ts:80,112-139,153-173,390`、`decompile.ts:268` |

## 6. 13 个模板 → 配方：节点类型映射原则

旧模板由 `text`(说明/输入)、`config`(`X_gen`，只存 model/size)、`image/video/audio/film`(执行) 组成；衍生的工具卡/笔记卡/门禁卡 651 张全是 `kind:"text"`。映射原则：

1. `text` 且被下游当 prompt 来源（剧本、小说、角色描述、分镜、世界观）→ `script` 或 `shotlist`（authored，有内容才算节点）。说明性 text（交付说明、迭代记录、审计提示）→ 并入相邻节点的 `intent`，不成节点。
2. `config`（`*_gen`）→ 不成节点：model/size 进下游 `keyframe/clip` 的 `params`，或进 `ProjectGraph.defaults`。
3. 衍生的工具卡/笔记卡/门禁卡 → 全部删除成节点；`deliverable/gate/notes` 文本并入对应节点 `intent`（≤200 字，超出截断并在 `legacyRoleMap` 标 `dropped`），能机器检查的门禁并入 `qc` 的阈值。
4. 多个同构图片节点（view1-4、角色卡、多场景）→ 一个 `shotlist(kind:"views"|"items")` + 一个 `forEach` 的 `keyframe`。
5. `video` → `clip`（forEach 在 shotlist 上）；`audio`(voiceover) → `voice`；`film`(final_cut) → `timeline` + `subtitle` + `mix` + `export`，另挂一个 `qc(machine)`；`audit/iteration/delivery`(text) → `qc(critic)`（图片族）或 `export(preset:"image_pack")`（交付包）。
6. 每个配方 `legacyRoleMap` 必须覆盖旧模板全部 role，每个 role 去向三选一：`NodeId`、`{intentOf}`、`{dropped:理由}`。

| 族 | 模板（旧 role 数 / 旧可执行数） | 新节点骨架 |
|---|---|---|
| 电影 | `single_video`(5/1+…)、`feature_film`(15/7)、`novel_film`(16/6)、`shortdrama_visual`(14/6) | `script → shotlist(shots) → [reference(角色/场景) → keyframe#shot → clip#shot]`（forEach）`→ voice#shot → music → timeline → subtitle → mix → export → qc`；`novel_film` 的 `novel/art_brief/storyboard` 变 `script`/`shotlist`；`shortdrama_visual` 的 `promo` 变一个独立 `keyframe` + 并入 `export` 的包 |
| 单图/场景/角色 | `single_image`(3/1)、`scene_setup`(3/1)、`character_sheet`(6/4) | `shotlist(views)` + `keyframe#view`（forEach）`→ qc(critic) → export(image_pack)`；`single_image/scene_setup` 退化为 1 个 keyframe + export |
| 电商 | `ecom_launch`(15/7)、`ecom_model`(14/7)、`shortdrama_poster`(12/5) | `shotlist(items)`（产品卡/场景/模特/KV/详情/多比例）+ `keyframe#item`（forEach，放大并入 keyframe 的 `size`/后续 `keyframe` 引用）`→ qc → export(image_pack)`；`delivery`/`iteration` 文本变 `intent` |
| IP/策展 | `novel_ip`(15/7)、`art_curation`(14/6)、`art_style`(15/7) | `script(世界观/主题)` + `shotlist(情绪板/风格/构图/批量/展陈…)` + `keyframe#item` `→ qc(critic) → export(image_pack)`；`lora_log/audit` 变 `qc` 的 rubric 或 `intent` |

节点数下限（防止“删光达标”）：每个配方的可执行节点数 ≥ 对应旧模板的可执行节点数（单图 1、角色卡 4、feature_film 7 …，数字见 anatomy Q4 表）；电影族必含 `{script, shotlist, keyframe, clip, voice, music, timeline, subtitle, mix, export, qc}` 全部 11 类；图片族必含 `{keyframe, qc, export}`。

## 7. 迁移与回滚（S19）

- **席位锁存**：会话创建时写入 `state.seat ∈ {creator, creator_legacy}`、`state.beast`、`state.projectMode`，随 `PERSISTED_DATA_KEYS` 持久化，之后永不变（这也是“会话内工具集不变”的实现）。旧会话读回时缺这些键 → 视为 `creator_legacy`/`projectMode=false`。
- **开关**：环境变量 `EIMU_PROJECT_MODE=on|off|allowlist`（allowlist 按 userId）。回滚 = 设为 off：新会话回到旧席位；已经开工的工程会话保持工程模式，图文件在磁盘上不丢。
- **旧会话里的 world2 工作流**：不自动迁移。旧会话按旧路径跑完。提供只读导入器 `legacy-import.ts`：把 `workflowSnapshot` 里已有产物的节点变成 `pinned` 的 `reference` 节点（实算 sha256，下载失败的标 `stale` 不钉），用于“旧会话想接到新引擎”的场景；S19 不接 UI 入口。
- **双跑期的隔离**：两条路径不共享产物命名空间（工程产物只在 `projects/<sid>/` 与 artifact-store；旧路径沿用 `TTS_AUDIO_DIR`/旧目录）；旧模板文件和 `workflow_start` 等工具保持不动直到 P4。
- **发布顺序**（遵守仓库的发布纪律）：网关/opencode 用 `deploy/vps/gateway-release.sh` 与 `opencode-release.sh`（只上已提交的快照，`--fast` 仅限文案类）；exec-bridge 的 systemd 单元首次安装是新增服务，需一次性装机步骤；站点（DSL/画布）走 Vercel，视觉改动前做本地 E2E 截图。部署不在本任务内。

## 8. P3 上线门（写成 CI 结构不变量；期望值独立于实现）

位置：`deploy-staging/gateway/project/__invariants__/*.test.ts`（`bun:test`，沿用 gateway 现有测试风格：先设沙箱环境变量，再动态 import）。CI：在 `.github/workflows/ci.yml` 追加 job `project-invariants`（self-hosted，`bun test deploy-staging/gateway/project/__invariants__`；CI 里已有 `bun tools/check-opencode-tool-schemas.mjs`，说明 runner 有 bun）。现有 gateway 测试目前不在 CI 里跑，这一个 job 是第一个。

| # | 不变量 | 独立期望来源 | 双侧（不可牺牲） |
|---|---|---|---|
| I1 | 200 步合成会话，每轮发给模型的总字节 ≤65536（`INPUT_CAP_BYTES`） | 常量来自本文与已定决策，不由被测实现导出；字节数在 fake opencode 收到的最终请求上量 | 同一轮必须同时含目标卡、摘要、最近 6 步；摘要里全部 failed/pinned 节点一个不少 |
| I2 | 每轮含目标卡且与库里用户原话逐字一致（含 emoji、换行、>12000 字被截断标记的情形） | 测试自己发送的用户消息字节串，不读 `brief` 实现；折叠规则单独一例 | 折叠场景下首条与最近 N 条仍逐字 |
| I3 | 网关发给 opencode 的 prompt 里，user 角色文本中不等于人类原话的条数=0（定时/监视器唤醒是用户创建的任务，各带用户任务 id，白名单化并逐条核对） | fake opencode 记录的 prompt 载荷 vs 测试发送列表 | 同一会话里子代理完成、run 完成事件都真实发生过（防止“没发生所以为 0”） |
| I4 | 主席位（`creator` 与 `orchestrator`）启用工具数 ≤12 且两席位集合相同；beast 开关两种取值 `promptBody.agent` 相同；200 步里工具表字节恒定；生成类工具在 creator/orchestrator/全部 `_p` 席位为 0 | `opencode.json` 解析 + 对 `R/tools/*.ts` 源码的静态扫描（含生成端点特征 `generations`、`/tts`、`music`、`blender`）+ 本文超集清单（取并集，不依赖 S14 提交的清单） | 十个必需工具齐全 |
| I5 | 账本每笔生成带 node_id，直调=0：对 fake 平台服务器（测试内起的 HTTP server）统计 POST：缺 `Idempotency-Key` 或 `workflow.metadata.node_id` 的次数=0；项目会话里无 node_id 的 `/internal/job-register` 被 409 | fake 服务器的原始请求，不读账本实现 | 6 个生成节点 + 1 次复用 + 1 次失败重试的账本行数与手算一致 |
| I6 | 改一个节点只重跑它与下游、pinned 不动：3 镜图，改 shot2 的 keyframe prompt，期望重跑集合=`{shot2.keyframe, shot2.clip, timeline, subtitle, mix, export, qc}`；pinned 的 shot1.clip 在其上游变化后不重跑且出现在 `drift` | 期望集合由测试按拓扑手写，fake 供应商按节点计调用数 | 其余节点 reused 事件与 `reused` 账本行齐全 |
| I7 | 模板可执行率 100%：13 个配方全部通过 `validate`，每个节点类型有注册执行器，`dry_run` 无 `unknownPrice` | 13 个模板 id 列表（来自 anatomy Q4）+ 旧可执行节点数表 | 每个旧 role 有去处；电影族 11 类齐全；节点数 ≥ 旧可执行数 |
| I8 | 回执大小：满量样本（256 op 的补丁、200 节点的 get）序列化 ≤ 契约字节数 | 契约常量 | 截断后 `more` 计数正确，失败/漂移不被截 |
| I9 | AGENTS 规则绑定：`R/AGENTS.md` 每条规则带 `[R-nn]` 且 `rules-map.ts` 有对应；`wc -l` ≤200 | 文件本身 | 被删规则清单与 S17 回报一致 |

### 8.1 端到端评测（只设计，不执行；付费上游硬闸：评测提交必须由 orchestrator 执行，待 orchestrator 执行）

- 样本：生产会话取 20 条“首句需求”，按近 14 天媒体意图会话分层抽样（建议 8 条影片/短剧、6 条图集、4 条音乐、2 条电商）；取数用 `opencode.db` 与 `sessions.db`（只读 SQL），不入仓库。
- 运行：staging 网关，`interaction_mode=auto`（持续授权），单条预算上限与模型白名单由 orchestrator 在执行前逐条写定（对照 AGENTS.md 付费硬闸①②③，核价目 API 后才提交），**subagent 不持上游 key，不提交任何生成**；无人干预（不注入任何后续用户消息）。
- 成片率口径=export 节点 `done` 且 `deliver` 检查全过：可解码 mp4/图片包文件在、时长在目标 ±10%（无目标则 8-90 秒）、有音轨（需要时）、`qc(machine)` 过、账本每笔有 node_id 且总花费 ≤ 预算；通过 ≥16/20（80%）算过。
- 附带度量：每轮输入字节分位数（应 ≤65536）、伪用户消息数（=0）、重复付费次数（同签名二次扣费=0）、复用省下的币。
- 质量侧：机器口径之外，“值得看”由暴君从 20 条里抽 5 条人工看（裁定点 J2），不由 agent 判。

## 9. D. 风险、不可判定项与需要暴君裁定的点

### 9.1 风险

1. **opencode 是否采用被原地裁剪的 messages 数组**：未验证（§3.7 第 5 点）。这是 S15 的首要瓶颈；不成立就停手回报，不并存第二套方案。
2. **长轮询与回合看门狗**：`project_get({wait_sec:90})` 单次工具调用 90 秒，与 `armWatchdogTimer`/心跳（`timers-gw.ts`）、opencode 的单工具超时的相容性未验证；S9 第一动作量取，必要时把 `WAIT_SEC_MAX` 降到实测安全值（契约常量，需回报 orchestrator 才能改）。
3. **两套提交轮子的载荷对齐**（§0.1 第 2 点）：`submitWorkflowNode` 与 `image_generate` 字段不完全相同；S5 逐字段对表，漏一个字段=生成质量或计费语义静默改变。
4. **签名正确性比命中率重要**：宁可多重跑，不可错用旧产物。生成类节点按签名缓存意味着“同参数再来一次”默认得到同一张图；用户要新变体必须走 `reroll`（换 seed）。回执会写明 `reused n`，避免模型以为生成了新图。
5. **一个会话一个工程（v1）**：并行多片需求要在同一工程里用多个子图表达。多工程留到 P4。
6. **exec-bridge 是新增运维面**：新进程、新 systemd 单元、新端口、共享 token。缺 token 拒启动，避免静默降级。
7. **监视器/定时唤醒**：它们是用户创建的任务，会产生合成 user 消息。I3 白名单化并要求每条携带用户任务 id；如果暴君认为这也算伪用户消息，需要另行裁定替代机制。
8. **脏工作树**：见 §4.4。
9. **MCP/B-key 路径**（`/api/v1/canvas/workflow`、MCP 工具）仍落到旧 world1 画布，不经工程图；外部 coding agent 的结果不受新引擎的复用/账本保护。P4 处理。
10. **领域生成工具被折叠**：现有 ≈30 个领域生成工具（virtual_tryon、character_dna_turnaround、style_aligned_batch、product_conditioned_generation 等）在工程版席位上被移除，它们内部的编排与一致性逻辑只能折叠成 `keyframe.role` 预设、配方或 guidance；映射不到的本期不支持。去向清单由 S14 产出。
11. **成片“值得看”不可判定**：任何“好看/电影感”目标不得派给 agent。可量测代理=文件在、可解码、时长偏差、音轨、响度/黑帧/冻结帧、QC 分、节点数下限。QC 分来自评审子代理的 rubric 打分，本身是模型判断，只能当筛选器，不能当审美裁决（见 J2）。
12. **`targets` 由谁定**：时长/比例等验收目标由 agent 写入（`set_targets`），存在“放宽判准再宣布达标”的风险。缓解：`targets` 记录 `setBy`，摘要里与目标卡并排显示，QC 的 critic rubric 读 `brief` 原话；用户明确给出的数字以用户为准（`Actor=user` 覆盖 agent）。

### 9.2 需要暴君裁定的点

- **J1 完成通知不再唤醒模型**（§0.1 第 3 点）。默认：回合内长轮询；回合结束后只发 UI 交付卡，用户下一条消息接续。代价：用户离开期间，如果 run 以“需要用户决定/部分失败”结束，不会有模型自动接着修，只会看到一张带“继续”入口的卡片。要保持全自动接续就得放宽“伪用户消息=0”。
- **J2 “值得看”怎么验**：建议 E2E 的 20 条里暴君抽 5 条自己看；机器只负责可播放/时长/音轨/QC。
- **J3 画布是否新增“钉住”控件**：P2 不加（复用 `locked` 视觉，钉住通过聊天里“钉住这张”由 agent 代执行，或上传替换产物自动钉住）。这是审美与交互决策。
- **J4 旧席位保留期与切换门槛**：建议 P3 全绿 + E2E ≥80% 后对新会话默认开启工程模式；`creator_legacy` 保留一个版本周期用于回滚。
- **J6 工程模式首发是否接受子代理席位失去一批领域生成工具**：清单由 S14 回报；每个工具要么折叠到节点类型/role/配方，要么本期不支持。是否接受“不支持”的那部分，是产品能力取舍。
- **J5 无法用代码强制的规则被删**：例如“在版歌曲旋律不交”“乐理术语核对”“交付链接从回执复制”中的前两条。按已定决策“要么代码强制要么删”，S17 会列出清单；其中涉及版权的一条是否改为在 `music` 执行器里加提示词/参数闸，需要你决定。

## 10. E. 每片 spec 粘贴块

使用方法：每个切片的完整 spec = `COMMON` + 该切片块。orchestrator 在派发前把 `{WORKTREE_NOTE}` 换成实际情况。所有切片都以 `isolation: worktree` 派发。

### COMMON（每片都要）

```
预期时长见各片块开头；超 2 倍会被中止并带改写后的 spec 重派。

【任务背景】
Eimu 影音长任务把真状态（目标、进度、资产 ID、用户决定）搬进单一可执行的工程图 ProjectGraph。设计全文：/home/lenovo/Documents/image-app/docs/architecture/project-graph.md（以下称“设计文档”）。契约是设计文档 §3 的 TypeScript，落盘在 deploy-staging/gateway/project/types.ts；你只通过契约与其他切片耦合，不得自行修改契约（需要改→停手回报）。

【必读记忆】（记忆与现场冲突时以现场为准并回报冲突）
1. ~/.claude/memory/MEMORY.md
2. mem show 2026-10-28-eimu-context-rot-root-cause.md —— 为什么做这件事
3. mem show 2026-10-20-feedback-1000-line-file-cap.md —— 新文件主动控制在 1000 行内，按职责拆
4. 各片块里列出的其他档名（均已用 mem show 验在）

【硬规则】
- 不调用任何真实上游（图片/视频/音乐/TTS 平台、真实 key 一律不碰、也没有给你）。所有测试用测试内自起的 fake HTTP 服务器或纯函数。付费上游硬闸：生成型 POST 禁止。
- 只改“独占文件”清单里的文件；列了 hunk 的既有文件只改指定 hunk，改前先 git diff 看该文件已有的未提交改动并原样保留。
- 不新建文档、README；不写任何 secret/token/cookie 到文件或输出；不 headless 登录任何站点；不在生产机构建。
- 禁止用 str.replace 连环补丁改生成脚本；不自造辅助脚本（除测试文件外）；“复用/复制”= 逐行 cp 原源码再改白名单字段，不是参考重写。
- 同一错误重试 2 次未过 → 停止并回报事实（命令、输出、你的诊断），不要无限试错。
- 测试断言的期望值要有独立来源（真实故障、用户原话、上游契约、手算结果、设计文档给的常量），不要镜像实现、不要专为当前补丁自造窄样本；不故意跑预期失败的测试。
- 判准是双侧的：上限（体积/次数/时间）和下限（不可牺牲的内容）都要满足。只靠删东西达到上限 = 不合格。
- 禁止打磨项见各片块；遇到“好看/电影感”类目标不要自行猜测，用可量测代理，并在回报里标“需暴君裁定”。

【环境与命令】
- 工作目录 /home/lenovo/Documents/image-app（你在其 git worktree 里）。bun 在 /home/lenovo/.local/bin/bun。
- 网关依赖：npm install --prefix deploy-staging/gateway --no-package-lock --no-audit --no-fund
- 网关类型检查：npx tsc -p deploy-staging/gateway --noEmit
- 网关测试：bun test <path>（用 bun:test；先设沙箱环境变量，再动态 import，参照 deploy-staging/gateway/subagent.test.ts 开头）
- 站点测试/类型：npx --yes tsx --test "<file>"；npx tsc --noEmit
- 开始改码前先确认：这个工作树里是否存在 deploy-staging/gateway/project/types.ts（W1 之后的切片依赖它）；没有→停手回报。

【回报格式】≤30 行：①改动文件（路径+增删行）②每条判准的实测结果（命令+实际输出摘要，数字）③未验证项 ④与设计文档/记忆/现场的冲突 ⑤需要暴君裁定的点。不要写总结性空话；不要贴大段代码。
{WORKTREE_NOTE}
```

### S0（预期 20 分钟）

```
【目标】把设计文档 §3 的契约 TypeScript 原样写入 deploy-staging/gateway/project/types.ts；常量块写入 project/constants.ts；写 project/contract-fixtures.json；在 deploy-staging/gateway/types-gateway.ts 的 SessionState 加 projectMode?:boolean; seat?:"creator"|"creator_legacy"; beast?:boolean。
【必读记忆】mem show 2026-10-28-original-user-prompt-pin-prod.md —— 新增会话字段与持久化清单的先例（本片只加类型，不动持久化，持久化归 S19）
【独占文件】project/types.ts、project/constants.ts、project/contract-fixtures.json、deploy-staging/gateway/types-gateway.ts（仅上述一个 hunk）
【做法】类型代码块逐字复制；types.ts 里的 declare function 保持 declare（实现归 S1）。fixtures：PatchOp 16 种 op 各一例；PatchErrorCode 每个至少一个触发该码的 (graph, op) 对（用最小图）；project_get/patch/run 各一个“满量”回执样本（真实长度，用来被其它切片测大小）。
【判准】上限：tsc 绿（npx tsc -p deploy-staging/gateway --noEmit）；types.ts 不 import 任何运行时依赖。下限：fixtures 覆盖设计文档 §3 全部 PatchOp、全部 PatchErrorCode、三个回执满量样本，且满量样本字节数符合 LIMITS。
【迭代预算】1 轮。【首要瓶颈】与设计文档逐字一致。【禁止打磨】重命名、注释润色、加字段。
```

### S1（预期 40 分钟）

```
【目标】实现设计文档 §3.2 的签名算法、planRun、缓存索引（cache-index.ts：signature→outputs，含 GC 与 7 天墓碑）。
【必读记忆】mem show 2026-10-28-eimu-context-rot-root-cause.md；mem show 2026-08-31-provider-reconciliation-architecture.md（重复付费/孤儿账的先例，理解为什么宁可多跑不错用旧产物）
【必读引文】设计文档 §2 第 1-7 行（ComfyUI 签名/指纹/复用、n8n pin 的逐字依据）。许可：ComfyUI 是 GPL、n8n 是 Sustainable Use，只学形态，从设计文档的算法描述重写，不看也不复制它们的源码。
【独占文件】deploy-staging/gateway/project/{signature,cache-index}.ts 及对应 .test.ts
【做法】canonicalJson（键排序、无空白、数字规范化）；DFS 按排序 input 名；pinned/reference 叶子；takes 节点 fingerprint=被选产物 sha；fileSha256 抛错→unstable；NodeSpecLite 由调用方传入（不要 import specs.ts，那是 S3 的）。
【判准】上限：200 节点图 planRun ≤200ms（bun test 内计时，放宽到 500ms 以防抖）。下限（行为测试，期望值手算/手写）：①同构图换 node_id 签名相同 ②改祖先一个 signed 参数→其下游全变、无关分支不变 ③换 seed→只该节点及下游变 ④intent/title 改动签名不变 ⑤pinned 节点上游变→不重算、drift 列表含它 ⑥fileSha256 抛错→该节点及下游 unstable→toRun ⑦缓存命中但产物文件被删→不命中 ⑧GC 后墓碑 7 天内仍在、之后消失 ⑨force 模式 targets 强制 toRun。
【迭代预算】2 轮。【首要瓶颈】正确性（错用旧产物比多重跑严重得多）。【禁止打磨】性能优化、缓存分片。
```

### S2（预期 60 分钟）

```
【目标】实现工程图存储（原子写、版本、事件、崩溃恢复读取）、补丁引擎（16 种 op、actor 规则、回执）、产物入库（ingest：下载/拷贝→sha256→artifact-store）。
【必读记忆】mem show 2026-10-18-canvas-snapshot-overwrite-no-rev.md（整份覆盖与零校验的教训）；mem show 2026-10-28-original-user-prompt-pin-prod.md
【必读代码】deploy-staging/gateway/timeline.ts 的存储（第 5、180、683-693 行附近，目录习惯）；artifact-store-io.ts:112 sha256Hex；src/lib/workflow-dsl/compile.ts:153-173 patchForExisting（lock 语义的参照）
【独占文件】project/{store,patch,receipt,artifacts,events}.ts、store.test.ts、patch.test.ts
【做法】设计文档 §3.1（谁能写什么）、§3.4（位置/并发/恢复）、§3.5（pin 边界）。每个工程一个 promise 链互斥锁；写 project.json 用临时文件+rename；versions 保留 50 份；events.jsonl 追加，seq=行号。补丁默认非原子（逐 op），最终图无效→整批 GRAPH_INVALID；Actor 校验：replace_output 仅 user；subagent 只能写 lane；agent 不能写 brief/decisions；locked 字段 agent 写入→LOCKED；pinned 节点被 set 允许但回执进 drift；pin 边界 7 条规则；节点 rev 与 ifRev。回执序列化超 1024B 时按优先级截断并填 more。
【判准】上限：回执 ≤1024B（含 256 个 op 的极端批，且 rejected 全为长消息的情形）。下限：16 种 op 语义测试；PatchErrorCode 每个至少一例（用 contract-fixtures.json）；pin 边界每条规则一例；重启（重新 load）读回同图与同事件序；50 个并发补丁最终 version=50 且无丢失；崩溃模拟（写临时文件后不 rename）不破坏旧 project.json；replace_output 非 user 被拒。
【迭代预算】2 轮。【首要瓶颈】pinned/locked/lane/actor 的交叉规则。【禁止打磨】事件格式、日志文案。
```

### S3（预期 45 分钟）

```
【目标】NODE_SPECS（设计文档 §3.5 表）与图校验（环、悬空引用、端口类型、pin 边界声明、参数校验）。
【必读记忆】mem show 2026-10-28-eimu-context-rot-root-cause.md
【必读代码】deploy-staging/opencode-runtime/tools/image_generate.ts 第 327-560 行附近的参数与载荷（keyframe/clip 的参数集要与它能表达的集合一致，不丢字段）
【独占文件】project/{specs,validate}.ts、specs.test.ts、validate.test.ts
【判准】上限：validate 200 节点 ≤50ms。下限：13 个 NodeType 全有 spec；每个 signedParams 有类型校验；seed 缺省按 hash(nodeId) 确定性赋值；pinnable 与 §3.5 表一致；环/悬空/重复 id/forEach over 非 shotlist/alias 为 "row"/嵌套 forEach 全部拒绝并给出教学式错误（含修正示例）；keyframe/clip 参数能表达 image_generate 的 reference_images、style_lock、quality、resolution、generate_audio、duration。
【迭代预算】1 轮。【首要瓶颈】参数集不得比 image_generate 少。【禁止打磨】错误文案风格。
```

### S4（预期 45 分钟）

```
【目标】引用文法解析、forEach 扇出展开、takes/onFail 的数据处理（不含执行）。
【必读记忆】mem show 2026-10-28-eimu-context-rot-root-cause.md
【必读引文】设计文档 §3.3（文法与规则，逐条）。
【独占文件】project/{refs,expand,takes}.ts、refs.test.ts、expand.test.ts
【判准】上限：50 行扇出 ≤50ms。下限：文法全部 case（${row.x}、${shot.keyframe}、${node}、${node.port}、${row.a.b}）；非法 alias（"row"、与 nodeId 重名）拒绝；嵌套 forEach 拒绝；实例 id 同输入同输出；row 删除：未 pinned 实例删除、pinned/user 产物实例→orphaned；解析结果同时产出规范化 inputs 边；takes n∈2..4、regenerate max∈1..2 校验。
【迭代预算】2 轮。【首要瓶颈】实例 id 与引用解析的确定性。【禁止打磨】语法糖、表达式求值（不要做运算，只做替换）。
```

### S5（预期 50 分钟）

```
【目标】网关侧 submitGeneration：以 workflow-gw-submit.ts 的 submitWorkflowNode 为基底，补 Idempotency-Key、generation_receipts 登记、项目预算、payload.workflow.metadata(node_id/signature/project_id/run_id/attempt/take)；账本新字段；node-less 注册在项目会话被拒。
【必读记忆】mem show control-plane-billing-paradigm.md；mem show 2026-08-31-provider-reconciliation-architecture.md；mem show 2026-10-21-gateway-local-real-session-oracle-recipe.md（本地起网关做真路径验证的配方）
【必读代码】deploy-staging/gateway/workflow-gw-submit.ts:268（基底）；deploy-staging/opencode-runtime/tools/image_generate.ts:490-560（要对齐的载荷、Idempotency-Key、journal、收据）；deploy-staging/gateway/job-store.ts（generation_receipts、acknowledgeGeneration:229 丢 artifacts）；quota-ledger.ts:85 LedgerEntry
【独占文件】project/{submit-generation,ledger}.ts、submit-generation.test.ts；hunk：quota-ledger.ts（LedgerEntry 加设计文档 §3 字段，全可选）、job-store.ts（acknowledgeGeneration 保留 artifacts[].sha256；项目会话的 /internal/job-register 无 node_id→409）
【做法】先做 image_generate 与 submitWorkflowNode 载荷的逐字段对照表（写在回报里），再实现。不改 workflow-gw-submit.ts 现有导出签名；复用其导出的 resolveActiveModel、cancelPlatformJob、fetchModelStatusCached 等。submit_unknown 保留 key，不盲重投。
【判准】上限：旧路径（workflow-gw-submit 的现有测试）全绿。下限（对测试内起的 fake 平台服务器断言原始请求）：每个 POST 有 Idempotency-Key=pg:<pid>:<sig40>:t<take>:a<attempt>；body.workflow.metadata 含 node_id/signature/project_id；同 key 重投不产生第二个任务；预算预留/释放对称；失败退款路径写 refunded 行；ledger 行含 node_id；载荷字段对照表无遗漏项。
【迭代预算】2 轮。【首要瓶颈】载荷对齐（漏字段=静默改变计费/质量）。【禁止打磨】轮询间隔、failover 逻辑（保持原样）。
```

### S12（预期 45 分钟）

```
【目标】exec-bridge 进程与网关客户端，设计文档 §3.6。
【必读记忆】mem show 2026-10-15-runtime-write-root-agentsvc-sqlite-cantopen.md；mem show 2026-10-10-music-one-coin-billing.md；mem show 2026-09-06-blender-bridge-headless-executor.md；mem show 2026-10-11-music-lyric-register-at-tool-source.md
【必读代码】deploy-staging/opencode-runtime/tools/music_gen.ts 与 lib/music-tools-adapter.ts（桥必须调同一个 adapter 包装后的 execute）、lib/blender-tools-adapter.ts:34；deploy-staging/gateway/task-board-http.ts:34（token 比较）；deploy/vps/systemd/opencode-server.oom.conf（单元风格）
【独占文件】deploy-staging/opencode-runtime/exec-bridge/{server.ts,server.test.ts}、deploy-staging/gateway/project/{exec-bridge-client.ts,exec-bridge-client.test.ts}、deploy/vps/systemd/agent-exec-bridge.service
【做法】监听 127.0.0.1:8767；X-Internal-Token==HARNESS_INTERNAL_TOKEN，缺 token 启动失败；POST /v1/exec/{music_gen,blender_render}；GET /v1/exec/result/:idemKey（磁盘保留 24h）；信号量 music=2 blender=1；超时 music 240s blender 1200s；产物写 $WORKSPACE_DIR/projects/<sid>/tmp/<idemKey>/ 只回路径。测试里的 music/blender 用 fake execute 注入（不调真实上游）。
【判准】上限：单请求内存 ≤50MB。下限：无 token 拒启动；错 token 403；同 idemKey 二次调用 fake 计数仍为 1；超时后 result 可取回；网关客户端超时→返回 submitUnknown 语义并可经 result 查询；systemd 单元用 EnvironmentFile 读 token，不内嵌 token。
【迭代预算】2 轮。【首要瓶颈】桥与 tools/music_gen 的调用路径逐行同一。【禁止打磨】新增路由、指标。
```

### S13（预期 45 分钟）

```
【目标】DSL v2：新 kind 与 forEach/takes/onFail/pinned/refs/intent；compile 新增 target:"project" 输出强类型 PatchOp[]；locked 节点沿用 patchForExisting 语义。
【必读记忆】mem show 2026-10-08-dsl-adoption-zero-audit.md；mem show 2026-10-28-eimu-context-rot-root-cause.md；mem show 2026-09-24-ws10-emits-entity-whitelist-strip-fix.md（白名单漏键的教训）
【必读代码】src/lib/workflow-dsl/{schema,compile,decompile}.ts（compile.ts:80,112-139,153-173,390）；src/app/api/v1/workflow/compile/route.ts；deploy-staging/gateway/project/types.ts（import type 引用 PatchOp）
【独占文件】src/lib/workflow-dsl/{schema,compile,decompile,project-ops}.ts 及对应 *.test.ts、src/app/api/v1/workflow/compile/route.ts
【第一动作】git log -1 -- src/lib/workflow-dsl/compile.ts 并确认 patchForExisting 已在基线（工作树里未提交→回报 orchestrator，不要自己提交）。
【判准】上限：现有 workflow-dsl 测试全绿，旧 DSL 输入的输出逐字不变（旧画布不受影响）。下限：新 kind 往返（compile→decompile 幂等）；forEach/takes/onFail/pinned/refs 在 target:"project" 下输出对应 PatchOp 且通过 contract-fixtures.json 校验；locked 节点的 patch 被丢弃并带 lockedDropped warning；不产出 run_generation。
【迭代预算】2 轮。【首要瓶颈】与 patchForExisting 语义逐项一致。【禁止打磨】错误文案。
```

### S6（预期 70 分钟）

```
【目标】调度器：按签名增量执行、层内并发、regenerate/takes、失败下游 blocked、重启恢复、准入（报价→确认→预算）。
【必读记忆】mem show 2026-10-28-eimu-context-rot-root-cause.md；mem show 2026-08-31-provider-reconciliation-architecture.md；mem show workflow-template-abandon-incident-fix.md（确认内联阻塞事故，准入必须非阻塞）；mem show control-plane-billing-paradigm.md
【必读代码】deploy-staging/gateway/workflow-service.ts（generateInnerBody:584-720、runNodeWithRetry:73）、workflow-gw.ts:331 generate 路径与 workflow-gw-completion.ts runWfGenerate:173（准入：409/零交付闸/价目缺失/确认卡/非阻塞）、constants-gateway.ts:216 CONFIRM_THRESHOLD_COINS；P/types.ts；S1/S2/S3/S4 产物
【独占文件】project/{scheduler,run,admission,recovery,executor-registry}.ts、scheduler.test.ts
【做法】启动一轮=planRun；toRun 按拓扑层并发（并发上限沿用现有）；reuse 节点不入队，但必发 node_reused 事件和 reused 账本行；执行结果落盘前比较启动签名与当前签名，不同则置 stale；失败下游 blocked；regenerate/takes 按设计文档 §3.3；准入沿用现有确认阈值与 auto/full 授权（settleConfirm），确认非阻塞；恢复按设计文档 §3.4。执行器用 fake 注入测试。
【判准】上限：命中节点 fake 执行器调用数=0。下限：层内并发（fake 记录并发峰值=层宽，受上限限制）；regenerate max=2 次数精确；takes 选优；失败下游 blocked 且不调用其执行器；重启恢复用同 idemKey 且不二次提交；预算超限拒绝并给 reason；reused 事件与账本行数=复用节点数；运行期间用户改参数→结果照存、节点 stale。
【迭代预算】3 轮。【首要瓶颈】复用/重跑判定与账本的一致性。【禁止打磨】调度公平性、进度条。
```

### S7（预期 50 分钟）

```
【目标】执行器 reference/script/shotlist/keyframe/clip。
【必读记忆】mem show 2026-10-28-eimu-context-rot-root-cause.md；mem show 2026-10-21-gateway-local-real-session-oracle-recipe.md
【必读代码】deploy-staging/gateway/workflow-gw-submit.ts:268-500（prompt 解析、参考图、模型解析，要等价迁移到 ctx.params/inputs 的语义）；P/types.ts 的 ExecContext；S5 的 submitGeneration
【独占文件】project/executors/{reference,authored,keyframe,clip}.ts、executors/generation.test.ts
【判准】上限：不新增环境变量，不自行 fetch 平台。下限：keyframe/clip 只通过 ctx.submitGeneration 提交；${} 已解析的 prompt 才提交（含参考图 URL/路径解析）；产物经 ctx.ingest 带 sha256；authored 节点 write_result 后产物为落盘文本/JSON；reference 节点把上传/素材库文件入库。
【迭代预算】2 轮。【首要瓶颈】prompt/参考图解析与 submitWorkflowNode 等价。【禁止打磨】提示词润色。
```

### S8a（预期 45 分钟）

```
【目标】执行器 voice、music；合并两份 TTS 实现为 synthesizeSpeech。
【必读记忆】mem show 2026-10-10-music-one-coin-billing.md；mem show tts-upstream-edge-proxy.md；mem show 2026-10-28-eimu-context-rot-root-cause.md
【必读代码】deploy-staging/gateway/media-internal-routes.ts:362 handleTts；workflow-gw-service.ts:153-176（runNode 内联 audio，保持不动）；S12 的 exec-bridge-client
【独占文件】project/{speech}.ts、project/executors/{voice,music}.ts、executors/audio.test.ts；hunk：media-internal-routes.ts（handleTts 改调 synthesizeSpeech，行为逐字节不变）
【判准】上限：不动 workflow-gw-service.ts。下限：旧 /tts 路由响应（状态码与 body）逐字节不变；voice 产物带 sha256 与 durationSec；music 只经 ExecBridgeClient，同 idemKey 二次不再扣费（fake 计数）；text>2000 字的错误行为与旧路由一致。
【迭代预算】2 轮。【首要瓶颈】合并而不改旧行为。【禁止打磨】音色清单。
```

### S8b（预期 60 分钟）

```
【目标】执行器 timeline/subtitle/mix/export；assembleFilmNode 抽出 assembleFromClips。
【必读记忆】mem show 2026-10-02-film-subtitle-title-burnin-wiring.md；mem show 2026-10-02-e2e-final-cut-eval-and-residual-repair-round.md；mem show 2026-10-28-eimu-context-rot-root-cause.md
【必读代码】deploy-staging/gateway/workflow-gw-assemble.ts:13；timeline.ts；mix.ts:292 applyMix；master.ts:188 masterExport 与 MASTER_PRESETS；film-qc.ts
【独占文件】project/executors/{timeline,subtitle,mix,export}.ts、executors/assemble.test.ts；hunk：workflow-gw-assemble.ts（抽出 assembleFromClips(clips,audio,opts)；assembleFilmNode 改为调用它，旧签名与行为不变）
【判准】上限：不新增转场/特效。下限：旧 assembleFilmNode 的现有测试绿；export 对真 ffmpeg 生成的 3 段测试视频+一段音频产出可解码 mp4，ffprobe 断言有视频流+音频流、时长=各段之和±0.5s；镜头顺序来自图（order 参数）而非 id 字符串；image_pack 预设产出包含清单（每项 sha256）；timeline 产物=current.json 快照 sha256；字幕烧录/外挂二选一由 params 决定。
【迭代预算】2 轮。【首要瓶颈】重构 assembleFilmNode 不破旧路径。【禁止打磨】视觉效果。
```

### S8c（预期 45 分钟）

```
【目标】执行器 qc（machine/critic）与 takes 选优评分。
【必读记忆】mem show 2026-10-02-e2e-final-cut-eval-and-residual-repair-round.md；mem show 2026-09-15-machine-critic-pass-slice2.md；mem show 2026-10-28-eimu-context-rot-root-cause.md
【必读代码】deploy-staging/gateway/film-qc.ts（analyzeFilm、QC_TARGET_LUFS/TP）；film-qc.test.ts；P/types.ts
【独占文件】project/executors/qc.ts、project/rubrics.ts、executors/qc.test.ts
【判准】上限：machine QC 单文件 ≤30 秒（用 ≤10 秒测试片）。下限：用 ffmpeg 现生成的真文件做样例——好样例（有音轨、时长对、非全黑、响度在阈内）必判过；坏样例（无音轨、时长偏差>10%、全黑、响度超阈）每种都必判不过且 deficiencies 指向具体节点/原因；takes 选分最高；critic 模式经 write_result 接收 {score,pass,deficiencies[]}（本片不实现子代理派发，留接口，S16 接线）。
【迭代预算】2 轮。【首要瓶颈】坏样例必须是真文件而不是 mock。【禁止打磨】评分的“美学”。
```

### S11a / S11b / S11c（各预期 45 分钟；三片同构，换文件清单）

```
【目标】把旧模板改写成配方（Recipe），映射原则见设计文档 §6。
  S11a 文件：project/recipes/{single_video,feature_film,novel_film,shortdrama_visual}.ts
  S11b 文件：project/recipes/{single_image,character_sheet,scene_setup,ecom_launch,ecom_model,shortdrama_poster}.ts
  S11c 文件：project/recipes/{novel_ip,art_curation,art_style}.ts
【必读记忆】mem show 2026-10-28-eimu-context-rot-root-cause.md；mem show 2026-10-08-dsl-adoption-zero-audit.md
【必读代码】deploy-staging/gateway/workflow-templates/<对应旧模板>.ts 与 types.ts（逐 role 读：kind、defaults、deliverable、gate、notes、tools、emitsEntity）；project/specs.ts（S3）；project/refs.ts（S4）
【做法】每个旧 role 在 legacyRoleMap 里三选一（NodeId / {intentOf} / {dropped:理由}）；text 说明并入 intent（≤200 字）；config 并入 params/defaults；多镜用 shotlist+forEach；电影族成片段=timeline→subtitle→mix→export→qc。旧模板文件不得修改或删除。
【判准】上限：每个配方 build() 对默认参数 ≤20ms。下限：legacyRoleMap 覆盖旧模板全部 role（用旧模板文件现算，不手抄）；旧可执行节点(image/video/audio/film)每个至少对应一个新可执行节点；新节点数≥旧可执行数；电影族含 11 类节点；图片族含 keyframe/qc/export；build() 的结果通过 validate；不含任何“只有 intent 没有执行器”的节点。
【迭代预算】2 轮。【首要瓶颈】旧 role 全映射且无内容牺牲（提示词文案不是瓶颈）。【禁止打磨】提示词措辞。
```

### S11z（预期 30 分钟）

```
【目标】配方索引与总测试。
【必读记忆】mem show 2026-10-28-eimu-context-rot-root-cause.md
【独占文件】project/recipes/index.ts、project/recipes/recipes.test.ts
【判准】下限：index 导出 13 个配方（id 与 WORKFLOW_TEMPLATES 的 13 个 id 完全相同，旧 id 列表现算）；每个配方 build→validate 通过；每个节点类型在 executor-registry 里有注册执行器；dry_run 报价（用测试价目）无 unknownPrice；legacyRoleMap 覆盖率 100%；节点数≥旧可执行数。上限：测试总时长 ≤10 秒。
【迭代预算】1 轮。【首要瓶颈】无。【禁止打磨】无。
```

### S15（预期 60 分钟）

```
【目标】上下文装配：brief（目标卡）、digest（工程摘要）、context（窗口裁剪与合成片段）、ingress 钩子。
【必读记忆】mem show 2026-10-28-original-user-prompt-pin-prod.md；mem show 2026-10-12-runtime-role-compaction-independent-receipts.md；mem show 2026-10-18-cc-2.1.302-harness-port-state.md；mem show 2026-10-03-beast-mode-is-prompt-injection-unmeasured.md
【必读引文】设计文档 §2 第 9、10 行；§3.7 全节。
【必读代码】deploy-staging/opencode-runtime/plugin/eimu-guard.ts:540-640（renderGoalCard 等，逐行搬运到 project/brief.ts，规则与常量不变）、:1208-1260（messages.transform）；deploy-staging/gateway/messages-gw-types.ts:417-433（originalUserPrompt 钉）与 :529（buildTemplateSkeletonForPrompt，复用其意图判定）
【独占文件】project/{brief,digest,context}.ts、context.test.ts；hunk：eimu-guard.ts（仅工程模式分支）、messages-gw-types.ts（ingress 追加 brief；首条消息自动 ensureProject，并在意图命中时 apply_recipe 默认参数）
【第一动作（瓶颈探针）】验证 opencode 1.18.14 是否采用 messages.transform 里被原地裁剪的数组（找到 opencode 源码或写一次最小本地探针；≤2 次读取/1 次运行）。结果为否→立即停手回报“资产上限”，不得改成别的方案。
【判准】上限：用 200 步合成会话（含 15 条用户消息、多种工具回执）驱动真实装配函数，每轮最终请求字节 ≤65536，以固定估算 estimateTokens 计 ≤32768。下限：每轮含目标卡且其中每条用户原话与测试发送的字节串逐字相同（含 emoji/换行；超长条按折叠规则，首条与最近条仍逐字）；摘要含全部 failed/blocked/pinned/drift 节点；摘要 ≤6144B；窗口保持 tool_use/tool_result 成对；旧席位（非工程模式）路径逐字节不变；合成片段 synthetic:true 且不落库。
【迭代预算】2 轮。【首要瓶颈】messages 裁剪是否被 opencode 采用。【禁止打磨】摘要排版。
```

### S10a（预期 40 分钟）

```
【目标】画布桥（网关侧）：工程事件→现有 canvas.node.created/updated/connected。
【必读记忆】mem show 2026-10-10-f1-closed-canvas-ops-queue.md；mem show 2026-10-18-canvas-snapshot-overwrite-no-rev.md；mem show 2026-10-02-template-guard-wiring-contract-not-ban.md
【必读代码】deploy-staging/gateway/workflow-gw-service.ts:39-80（emit 与 applyCanvasNode* 写穿）、canvas-cascade-state.ts（applyCanvasNode*、checkTemplateGuard:604）；src/lib/workflow-dsl/compile.ts:80（workflowNodeId）；P/types.ts、P/events.ts
【独占文件】project/{bridge-canvas}.ts、bridge-canvas.test.ts
【做法】订阅 events（S2）；节点 id=workflowNodeId("p_"+projectId前8位, nodeId) 的网关侧同构实现（FNV1a 双 seed 16hex），用跨端等值测试锁定（测试里 import src 的实现对 100 组样本逐字比较，参照 src/lib/agent-output-cards.test.ts 的跨树 import 先例）；metadata 带 workflow_ns/stepId/stepIndex 与 project_* 键；forEach 实例不带 workflow_ns；status 映射：pending/queued/stale→idle，running→loading，done→done，failed/blocked→error。
【判准】上限：不改 workflow-gw-service.ts；单事件处理 ≤5ms。下限：id 在 100 组样本上与 compile.ts 逐字相等；created/updated/connected 全覆盖；reused/pinned/stale 标记写入 metadata；对 checkTemplateGuard 不引发 TEMPLATE_SLOT_OPEN 误拦（工程节点不被当作漂浮节点）。
【迭代预算】2 轮。【首要瓶颈】跨端 id 等值。【禁止打磨】事件节流。
```

### S9（预期 50 分钟）

```
【目标】project_* 内部/公开路由与三个模型工具。
【必读记忆】mem show 2026-10-08-eimu-agent-gateway-headless-drive.md；mem show 2026-10-18-cc-2.1.302-harness-port-state.md；mem show 2026-10-28-eimu-context-rot-root-cause.md
【必读代码】deploy-staging/gateway/router.ts:181-286（internal 路由挂载与 loopback 检查）、media-internal-routes.ts 的 handleCanvasStatePublic（公开会话路由的鉴权先例）；deploy-staging/opencode-runtime/tools/workflow_update_node.ts（工具写法与 GATEWAY 调用）、tools/workflow_write.ts（先取 snapshot 再调站点 compile 的写法）；tools/check-opencode-tool-schemas.mjs
【独占文件】project/{routes}.ts、routes.test.ts、deploy-staging/opencode-runtime/tools/{project_get,project_patch,project_run}.ts、deploy-staging/opencode-runtime/lib/project-client.ts；hunk：router.ts（仅挂载行）
【做法】内部路由 /internal/project/{get,patch,run,context}（loopback+X-Internal-Token）；公开路由 POST /agent/v1/sessions/:id/project/patch（会话主人鉴权，Actor 强制 user）；工具以席位决定 Actor（主席位=agent，子代理席位=subagent+lane，由网关按 sessionID 解析，工具不得自带 actor）；project_patch 的 {op:"dsl"} 在工具端调站点 compile(target:"project") 展开；project_get 的 wait_sec ≤90，事件到达即返回；project_run 复用 S6 的准入。
【第一动作】量取 wait_sec=90 的单工具调用与回合看门狗（armWatchdogTimer/心跳，timers-gw.ts）和 opencode 单工具超时是否相容；不相容→把 LIMITS.WAIT_SEC_MAX 的建议值回报 orchestrator（不要自改契约）。
【判准】上限：满量回执 project_patch/project_run ≤1024B，project_get digest ≤6144B。下限：三个工具参数 schema 与契约双向一致（用 contract-fixtures.json 往返）；通过 tools/check-opencode-tool-schemas.mjs；子代理越 lane 被拒；公开路由 Actor 强制 user、他人会话 403；wait_sec 超过 90 被钳制。
【迭代预算】2 轮。【首要瓶颈】长轮询与看门狗相容性（未验证）。【禁止打磨】工具描述措辞。
```

### S14（预期 45 分钟）

```
【目标】主代理工具面收敛（≤12、会话内不变、beast/plan 不换席位）。
【必读记忆】mem show 2026-10-03-beast-mode-is-prompt-injection-unmeasured.md；mem show 2026-10-18-cc-2.1.302-harness-port-state.md；mem show 2026-10-28-eimu-context-rot-root-cause.md
【必读引文】设计文档 §2 第 8 行、§3.7 第 8-10 点。
【必读代码】deploy-staging/opencode-runtime/opencode.json（agent.creator/orchestrator/plan 及子代理席位）、deploy-staging/gateway/expert/opencode-agents.json 与 seat-preflight.ts:16、messages-gw-admission.ts:478-530（beast_mode 与席位选择）、router-internal.ts handleToolPrecheck、plugin/eimu-guard.ts:840（tool.execute.before，只读，不改）
【独占文件】deploy-staging/opencode-runtime/opencode.json、deploy-staging/gateway/expert/opencode-agents.json、deploy-staging/gateway/messages-gw-admission.ts、deploy-staging/gateway/router-internal.ts
【做法】新增 creator_legacy、orchestrator_legacy = 原 creator/orchestrator 逐字拷贝（旧会话与回滚用，旧会话仍按 beast 切换）；creator 重定义为十个工具（设计文档 §3.7 第 8 点）；新 orchestrator 的 tools 与 creator 相同；admission 按 state.seat 选席位，工程模式主会话恒为 creator，beast 只改系统提示开关段且按会话锁存；工程模式跳过 25 处尾部注入，仅保留授权/预算/环境三个事实（交给 S15 的摘要，留函数接口）；plan 模式在 precheck 里拒绝 project_patch/project_run/subagent_dispatch；为每个专家席位新增静态条目 <expert>_p（复制后去掉 DIRECT_GENERATION_TOOLS、加入 project_get/project_patch），旧专家席位不动；先扫描 R/tools/*.ts 里触达生成端点（generations、/tts、music、blender、image_generate 包装）的工具，补全 DIRECT_GENERATION_TOOLS，并在回报里列出“每个被移除的工具 → 折叠到哪个节点类型/role/配方，或本期不支持”的清单（这是产品能力取舍，见设计文档 J6）；两份席位表必须同步（预检读第二份）。
【判准】上限：creator 与 orchestrator 启用工具数均 ≤12 且集合相同。下限：十个必需工具齐全；DIRECT_GENERATION_TOOLS（含扫描补全）在 creator、orchestrator 与全部 _p 席位启用集中=0（_legacy 与旧专家席位不在此限）；beast 开/关 promptBody.agent 均为 creator（用 admission 的真实函数跑）；plan 模式工具表不变、被拒调用返回教学式原因；creator_legacy 与改前 creator 启用集逐项相同；旧会话（seat 缺省）仍走 creator_legacy；opencode.json 与 opencode-agents.json 两份一致（脚本比对）。
【迭代预算】2 轮。【首要瓶颈】子代理席位改写不破现有派工。【禁止打磨】提示词。
```

### S16（预期 55 分钟）

```
【目标】子代理写节点：lane、摘要 ≤4096B + nodeIds、工程模式不 wakeParent、critic 经 QC 节点接线。
【必读记忆】mem show 2026-10-14-subagent-collaboration-bus.md；mem show subagent-dispatch-speed-doctrine.md；mem show 2026-10-28-eimu-context-rot-root-cause.md
【必读代码】deploy-staging/gateway/subagent-finish.ts:119-331、:554-584；subagent-types.ts:60-142；subagent-dispatch.ts（lane 参数入口）；P/types.ts 的 Actor；P/patch.ts（lane 校验由 S2 实现，本片只传入）
【独占文件】subagent-finish.ts、subagent-dispatch.ts、subagent-types.ts、project/lanes.ts、project/lanes.test.ts（都是脏树文件，只做最小 hunk）
【判准】上限：回父 summary ≤4096B、nodeIds ≤20。下限：工程模式下 dispatch 解析席位自动换成 <expert>_p（旧会话不变）；subagent.test.ts 现有测试全绿（旧席位路径不变）；工程模式 finishRun 不调用 wakeParent，完成事件写入 events；lane 越界写入被拒；summary 不含全文（全文在节点产物）；critic 通过 qc(critic) 节点用 write_result 写 verdict。
【迭代预算】3 轮。【首要瓶颈】在脏树基线上做最小 hunk。【禁止打磨】摘要措辞。
```

### S19（预期 45 分钟）

```
【目标】席位锁存持久化、EIMU_PROJECT_MODE 开关、旧工作流只读导入器。
【必读记忆】mem show 2026-10-28-original-user-prompt-pin-prod.md（新增持久化键的同批清单）；mem show 2026-10-28-eimu-context-rot-root-cause.md
【必读代码】deploy-staging/gateway/persistence-io.ts:16-70,95-125、persistence-types.ts、persistence-schema.test.ts（守门清单）、sessions-core.ts:40-60、workflow-gw-submit.ts:117 workflowSnapshotOf
【独占文件】project/{legacy-import}.ts、legacy-import.test.ts；hunk：persistence-types.ts、persistence-io.ts（PERSISTED_DATA_KEYS 加 projectMode/seat/beast，serialize/hydrate 同批）、persistence-schema.test.ts（守门清单同批）、sessions-core.ts（创建会话时按 EIMU_PROJECT_MODE 锁存）
【判准】上限：导入不触发上游调用。下限：persistence-schema 守门测试绿且新键往返；缺键的旧行读回为 creator_legacy/projectMode=false；EIMU_PROJECT_MODE=off 时新会话 seat=creator_legacy；allowlist 按 userId 生效；导入器把旧 nodeContent 变成 pinned 的 reference 节点并实算 sha256，下载失败的节点标 stale 不钉。
【迭代预算】2 轮。【首要瓶颈】持久化守门清单必须同批更新。【禁止打磨】导入覆盖率。
```

### S10b（预期 60 分钟）

```
【目标】画布前端：新 metadata 键进三处白名单；用户编辑回写工程图。
【必读记忆】mem show 2026-09-24-ws10-emits-entity-whitelist-strip-fix.md；mem show 2026-10-18-canvas-snapshot-overwrite-no-rev.md；mem show 2026-10-03-visual-change-local-e2e-before-deploy.md；mem show 2026-10-10-f1-closed-canvas-ops-queue.md
【必读代码】src/lib/canvas/node-metadata-fields.ts:62,190；src/lib/canvas/layout/normalize.ts:232,301；src/hooks/canvas/canvas-chat-types.ts:153,210；src/hooks/canvas/canvas-chat-ops.ts（agent ops 与用户操作的分界）；S10a 的 metadata 键清单
【独占文件】src/lib/canvas/node-metadata-fields.ts、src/lib/canvas/layout/normalize.ts、src/hooks/canvas/canvas-chat-types.ts、src/hooks/canvas/project-sync.ts（新）、挂接点（第一动作定位，只许一个文件 ≤10 行 hunk，定位后回报）
【判准】上限：旧画布加载/保存行为不变（现有 canvas 测试全绿）。下限：project_node_id/project_sig/project_pinned/project_stale/project_reused 五键三处白名单同批、重载后存活（写同类于 ws10 先例的往返测试）；用户改 prompt/model/size、锁定、删除、替换产物→以 Actor=user 调公开补丁路由；agent ops 触发的变化不回写（防回环，测试覆盖）；本片含用户可见的状态标记，按仓库规则做本地 E2E 截图自审（暂存路由+Playwright deviceScaleFactor:2，折叠/展开/最长字状态截齐，收工删暂存路由）。
【迭代预算】3 轮。【首要瓶颈】回环抑制。【禁止打磨】视觉美化（新增控件不在范围，见裁定点 J3）。
```

### S17（预期 40 分钟）

```
【目标】工程模式下的删闸，以及运行时 AGENTS.md 规则绑定。
【必读记忆】mem show 2026-10-11-canvas-write-gate-20261011.md；mem show 2026-10-12-runtime-role-compaction-independent-receipts.md；mem show 2026-10-28-eimu-context-rot-root-cause.md
【必读引文】设计文档 §3.9 与 §0.1 第 1 点。
【必读代码】deploy-staging/gateway/canvas-write-gate.ts 与 canvas-write-gate-off.test.ts、delivery-gate.ts（档头自述“字段存在性检查”）、opencode-event-handler.ts、deploy-staging/opencode-runtime/AGENTS.md（76 行，逐条）
【独占文件】canvas-write-gate.ts、delivery-gate.ts、opencode-event-handler.ts（脏树文件，最小 hunk）、deploy-staging/opencode-runtime/AGENTS.md、project/{rules-map,gates}.ts
【做法】逐条规则判定：有强制它的代码路径→打 [R-nn] 并写进 rules-map.ts（标签→代码路径→测试名）；没有→删，并把删除清单回报；工程模式 export/qc 前置检查做成 gates.ts 的产物检查（文件在且 sha 对、可解码、时长、音轨、响度）；旧席位路径保持原行为。
【判准】上限：AGENTS.md ≤200 行。下限：旧席位路径现有测试全绿；每条非空规则带 [R-nn] 且 rules-map 有映射；被删规则清单完整列出（含版权/乐理类）；工程模式下模型文本“已完成”不触发任何闸、不产生交付卡。
【迭代预算】2 轮。【首要瓶颈】区分“能由代码强制”与“只是愿望”。【禁止打磨】措辞压缩。
```

### S18（预期 60 分钟）

```
【目标】P3 CI 不变量测试与 CI job。
【必读记忆】mem show 2026-10-21-gateway-local-real-session-oracle-recipe.md；mem show 2026-10-28-eimu-context-rot-root-cause.md；mem show 2026-10-12-runtime-role-compaction-independent-receipts.md
【必读引文】设计文档 §8 全节（每条不变量的独立期望来源和双侧）。
【独占文件】deploy-staging/gateway/project/__invariants__/*.test.ts、__invariants__/fixtures/*、.github/workflows/ci.yml（只追加 job project-invariants，不碰现有 job；该文件是脏树文件）
【做法】fake opencode 服务器记录网关发出的 prompt；fake 平台服务器记录生成 POST；200 步合成会话的用户消息、工具回执用固定种子生成；期望值全部来自测试自己发送/手算的数据与设计文档常量，不 import 被测模块的常量做期望。
【判准】上限：job 总时长 ≤8 分钟。下限：I1-I9 逐条各至少 1 个通过用例和 1 个“应当拦住”的反例（例如人为注入一条尾部伪用户消息时 I3 必须失败）；反例用测试内部构造的坏输入，不故意让产品代码失败。
【迭代预算】2 轮。【首要瓶颈】期望值独立于实现。【禁止打磨】覆盖率数字。
```

## 11. 波次表（回报用）

| 波次 | 切片 | 依赖 |
|---|---|---|
| W0 | S0 | 无 |
| W1 | S1, S2, S3, S4, S5, S12, S13 | S0 |
| W2 | S6, S7, S8a, S8b, S8c, S11a, S11b, S11c, S15, S10a | S6←S1,S2,S3,S4；S7←S2,S5；S8a←S2,S5,S12；S8b/S8c←S2,S3；S11a-c←S3,S4；S15/S10a←S2 |
| W3 | S9, S11z, S14, S16, S19 | S9←S2,S6,S15；S11z←S11a-c；S14←S9,S15；S16←S2,S8c,S9；S19←S2,S3 |
| W4 | S10b, S17, S18 | S10b←S10a,S9；S17←S9,S14,S16；S18←全部 |

并发建议：每个波次内常态保持 ≥3 路；完工一路立刻验收补派下一路，不等整波。W2 最宽（10 路），但 S6/S15 是关键路径，优先派发。
