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
export type TargetField = "durationSec" | "aspect" | "shots" | "subtitles" | "audio"
export interface TargetSource { kind: "default" | "agent" | "user"; messageId?: string; evidence?: string; interpretation?: boolean; revision: string; supersedes?: string }
export interface GoalInterpretationInput { sourceMessageIds: string[]; requirements: string; supersedes?: string[]; statusOnly?: boolean }
export interface GoalInterpretation extends GoalInterpretationInput { id: string; actor: Actor; at: Iso }
export interface Targets { durationSec?: number; aspect?: string; shots?: number; subtitles?: boolean; audio?: "voice" | "music" | "both" | "none"; setBy: Actor; at: Iso; sources?: Partial<Record<TargetField, TargetSource>> }
export interface ProjectDefaults { videoModel?: string; imageModel?: string; imageSize?: string; voice?: string; style?: string }
export interface Budget { capCoins: number | null; spentCoins: number; savedCoins: number /*复用省下*/ }

/** 执行层写入的接续责任；投递状态不等于作者完成或作品交付。 */
export interface ProjectContinuationTask {
  id: string
  kind: "author" | "continue" | "provider_unknown" | "user" | "platform_fault" | "qc_rework"
  owner: "orchestrator" | "reconciler" | "user" | "operator"
  nodes: NodeId[]
  reason: string
  delivery: "pending" | "delivering" | "delivered" | "unknown" | "completed" | "cancelled"
}
export interface ProjectContinuation {
  runId: RunId
  targets?: NodeId[]
  cancelled?: boolean
  tasks: ProjectContinuationTask[]
}

export interface ProjectGraph {
  schema: typeof PROJECT_SCHEMA_VERSION
  id: ProjectId; sessionId: string
  version: number                    // 每次补丁批次成功后 +1
  createdAt: Iso; updatedAt: Iso
  templateId?: string                // 来源配方
  brief: BriefEntry[]                // 仅网关在收到真实用户消息时追加；模型不能写
  decisions: Decision[]              // 仅网关在用户回答 question 时追加
  goalInterpretations?: GoalInterpretation[] // 作者对原话的解释候选；不是授权，也不是用户已确认事实
  targets: Targets | null
  defaults: ProjectDefaults
  nodes: Record<NodeId, ProjectNode>
  order: NodeId[]                    // 创建序，展示用
  budget: Budget
  activeRun: RunId | null
  activeRunAdmission?: { runId: RunId; accepting: boolean; joinedNodes: NodeId[] }
  continuation?: ProjectContinuation
  legacyGenerationRefs?: { taskId: string; requestId: string; kind: string; evidence: string; nodes?: NodeId[]; at: Iso }[] // 旧订单只读关联；不授权新提交或补造扣费
  seq: number                        // 事件序号高水位
  entry?: { via: "session_api"; messageId: string } // 只有 persistUserBriefNow 成功时写；补丁不能写
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
  | { op: "set_targets"; targets: Omit<Targets, "setBy" | "at" | "sources">; sourceMessageId?: string; interpretation?: GoalInterpretationInput }
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
  known?: string                         // 节点不存在时：现有节点 id（按类型分组）
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
  generationOperation?: (req: GenerationOperationReq) => Promise<import("./generation-journal.ts").SharedJournalOperation>
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
export type ExecErrorCode = "provider_error" | "platform_fault" | "safety_blocked" | "timeout" | "submit_unknown" | "price_unknown" | "bad_input" | "bridge_unavailable" | "qc_failed" | "cancelled"
export type ExecResult =
  | { ok: true; outputs: Output[]; pool?: Output[]; costCoins: number }
  | { ok: false; code: ExecErrorCode; message: string; retryable: boolean; submitUnknown?: boolean; costCoins?: number }
export interface NodeExecutor {
  type: NodeType; specVersion: number
  estimate(node: Readonly<ProjectNode>, project: Readonly<ProjectGraph>, session: unknown): Promise<number | null> // null=报不出价，拒绝运行
  run(ctx: ExecContext): Promise<ExecResult>
}

export interface SubmitGenerationReq {
  prepared?: { payload: Record<string, Json>; identity: Record<string, Json>; lock: Record<string, Json> }
  onAccepted?: (notice: { taskId: string; requestId: string; model: string; costCoins: number; status: "accepted" | "succeeded" }) => Promise<void>
  kind: "image" | "video"; model: string; prompt: string
  size?: string; n?: number; seconds?: number; resolution?: string; quality?: string; seed?: number
  referenceImages?: string[]; generateAudio?: boolean; styleLock?: string
  projectId: ProjectId; nodeId: NodeId; signature: string; runId: RunId; attempt: number; take: number
  apiKey: string; sessionId: string; signal: AbortSignal
}

export interface GenerationOperationReq {
  kind: "music" | "voice"; projectId: string; nodeId: string; signature: string; runId: string; attempt: number; take: number; sessionId: string
  idemKey: string; model: string; payload: Record<string, Json>; coins: number
}
export type SubmitGenerationRes =
  | { ok: true; taskId: string; urls: string[]; costCoins: number; requestId: string; executedModel: string; reusedOperation?: boolean; originalCostCoins?: number }
  | { ok: false; code: ExecErrorCode; message: string; taskId?: string; submitUnknown?: boolean; retryable: boolean }
export type SubmitGenerationFn = (req: SubmitGenerationReq) => Promise<SubmitGenerationRes>
// Idempotency-Key = `pg:${projectId}:${signature.slice(0,40)}:t${take}:a${attempt}`；payload.workflow.metadata 必带 {project_id,node_id,signature,run_id,attempt,take}

export interface ExecBridgeClient {
  call(route: "music_gen" | "blender_render", body: { sessionId: string; projectId: ProjectId; nodeId: NodeId; signature: string; idemKey: string; runId?: string; params: Record<string, Json> }, opts: { timeoutMs: number; signal: AbortSignal }): Promise<
    | { ok: true; files: { path: string; mime: string; bytes: number; durationSec?: number; sha256?: string }[]; costCoins: number; chargeRef?: string; provider?: string }
    | { ok: false; code: ExecErrorCode; message: string; retryable: boolean; recoverable?: boolean }>
  result(idemKey: string, identity?: { sessionId: string; projectId: string; nodeId: string; signature: string }): Promise<{ state: "unknown" | "running" | "done" | "failed"; files?: { path: string; mime: string; bytes: number; sha256?: string }[]; costCoins?: number; chargeRef?: string }>
  ingested?(identity: { idemKey: string; sessionId: string; projectId: string; nodeId: string; signature: string; runId: string; artifacts: { sha256: string; path: string }[] }): Promise<{ ok: boolean }>
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

// ===== 常量（定义在 ./constants.ts，此处仅再导出，保持契约单入口）=====
export { LIMITS, estimateTokens, DIRECT_GENERATION_TOOLS } from "./constants"
