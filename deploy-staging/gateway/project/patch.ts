// 补丁引擎（S2）：16 种 PatchOp 的语义。纯函数式——输入图不被修改，返回提交用的新图 + 回执 + 事件草稿。
// 持久化/互斥/版本文件归 store.ts。规则出处：设计文档 §3（契约）、§3.1（谁写什么）、§3.4（并发/版本）、§3.5（pin 边界）。
//
// 状态口径：引擎（S1/S6）才有真签名；这里只做「结构性」过期标记——改动节点及其下游（遇 pinned 止步并计入 drift）。
// 宁可多标 stale、不可漏标；真正是否重跑由 planRun 按签名裁决。
import { ArtifactStore } from "./artifacts.ts"
import { createHash } from "node:crypto"
import { expandGraph, readRows } from "./expand.ts"
import type { EventDraft } from "./events.ts"
import {
  NODE_ID_RE, INPUT_NAME_RE, PORT_RE, buildChildren, findGraphProblem, fnvSeed, idBase, reachesSelf, scanParamRefs,
} from "./patch-graph.ts"
import {
  MAX_NODES, NODE_TYPES, checkDefaults, checkForEach, checkInputs, checkIntent, checkJson, checkLockFields, checkOnFail, checkRefs,
  checkTakes, checkTargets, checkWriteValue, isPlainObject, jsonEqual, lockCovers, type V,
} from "./patch-validate.ts"
import { buildPatchReceipt } from "./receipt.ts"
import { checkParams, materializeDefaults, resolvePort, specOf } from "./specs.ts"
import { validateSet } from "./validate.ts"
import { RESEARCH_AGENT_FORBIDDEN, RESEARCH_RECIPES, isResearchNode, researchNewNodes, researchNodeIds } from "./research.ts"
import type {
  Actor, Json, NodeId, NodeType, Output, PatchErrorCode, PatchOp, PatchReceipt, PatchRequest, ProjectGraph, ProjectNode, Recipe, TargetField, TargetSource,
} from "./types.ts"

export const MAX_OPS_PER_BATCH = 1000

export interface PatchEngineOptions {
  now?: () => Date
  artifacts: Pick<ArtifactStore, "putBytes" | "get">
  /** 配方注册表（S11z 提供）；缺省=无配方，apply_recipe 一律 UNKNOWN_RECIPE。 */
  recipes?: (id: string) => Recipe | undefined
  /** 参数是否进签名（S3 的 NODE_SPECS 提供）；缺省=全部算签名参数（保守：多标 stale）。 */
  isSignedParam?: (type: NodeType, key: string) => boolean
}

export interface PatchOutcome {
  graph: ProjectGraph        // committed=false 时是输入图本身（未改）
  receipt: PatchReceipt
  events: EventDraft[]
  committed: boolean         // 版本是否 +1
}

export class PatchError extends Error {
  constructor(readonly code: PatchErrorCode, msg: string, readonly node?: NodeId) {
    super(msg)
  }
}
const fail = (code: PatchErrorCode, msg: string, node?: NodeId): never => {
  throw new PatchError(code, msg, node)
}
// tsconfig 关掉了 strictNullChecks，布尔字面量判别式（ok: true/false）不再自动收窄联合类型，故显式转到失败分支类型。
const unwrap = <T,>(v: V<T>, node?: NodeId): T => {
  if (v.ok) return v.value
  const e = v as { code: PatchErrorCode; msg: string }
  return fail(e.code, e.msg, node)
}

interface Ctx {
  g: ProjectGraph
  actor: Actor
  opts: PatchEngineOptions
  nowIso: string
  selfDirty: Set<NodeId>
  outDirty: Set<NodeId>
  changed: Map<NodeId, Set<string>>
  events: EventDraft[]
  warnings: string[]
  lockedNodes: Set<NodeId>
}

const isHuman = (a: Actor): boolean => a.kind === "user" || a.kind === "engine"
const SUBAGENT_OPS = new Set(["add_node", "set", "remove_node", "connect", "disconnect", "write_result", "reroll"])
const SEEDED: readonly NodeType[] = ["keyframe", "clip"]
const NEW_NODE_KEYS = new Set(["id", "type", "intent", "params", "inputs", "refs", "forEach", "takes", "onFail"])

function touch(ctx: Ctx, id: NodeId, field: string): void {
  const s = ctx.changed.get(id)
  if (s) s.add(field)
  else ctx.changed.set(id, new Set([field]))
}

function getNode(ctx: Ctx, id: unknown): ProjectNode {
  if (typeof id !== "string") return fail("BAD_VALUE", "node 必须是字符串")
  return ctx.g.nodes[id] ?? fail("NOT_FOUND", `节点 ${id} 不存在`, id)
}

function checkActor(ctx: Ctx, op: PatchOp): void {
  const a = ctx.actor
  if (op.op === "replace_output" && a.kind !== "user") fail("ACTOR_FORBIDDEN", "replace_output 仅限用户操作")
  if (a.kind === "subagent" && !SUBAGENT_OPS.has(op.op)) fail("ACTOR_FORBIDDEN", `子代理不可使用 ${op.op}`)
}

function checkLane(ctx: Ctx, id: NodeId): void {
  const a = ctx.actor
  if (a.kind !== "subagent") return
  const base = idBase(id)
  if (!a.lane.some((l) => l === id || l === base)) fail("LANE_VIOLATION", `节点 ${id} 不在子代理 lane 内`, id)
}

function assertUnlocked(ctx: Ctx, node: ProjectNode, fields: string[]): void {
  if (isHuman(ctx.actor) || !node.locked) return
  const lock = node.locked.fields
  if (fields.some((f) => f === "*" || lockCovers(lock, f))) {
    ctx.lockedNodes.add(node.id)
    fail("LOCKED", `节点 ${node.id} 的 ${fields.join(",")} 被${node.locked.by === "user" ? "用户" : "代理"}锁定，请先 unlock 或交用户确认`, node.id)
  }
}

function signedParam(ctx: Ctx, type: NodeType, key: string): boolean {
  return ctx.opts.isSignedParam ? ctx.opts.isSignedParam(type, key) : true
}

/** 用户（含画布回写）改成功的字段自动上锁，expand 不得再用模板盖掉。 */
function lockFieldByUser(ctx: Ctx, node: ProjectNode, path: string): void {
  if (ctx.actor.kind !== "user") return
  const prev = node.locked
  if (prev?.by === "user" && (prev.fields === "*" || prev.fields.includes(path))) return
  const fields: string[] | "*" = prev?.fields === "*" ? "*" : [...new Set([...(prev?.fields ?? []), path])]
  node.locked = { by: "user", fields, at: ctx.nowIso }
  touch(ctx, node.id, "locked")
}

function currentSignature(node: ProjectNode): string {
  return node.signature ?? node.lastRun?.signature ?? ""
}

/** 把 params 里的引用存在性 / 成环重新核一遍；失败时由调用方回滚。 */
function checkRefsAndCycle(ctx: Ctx, node: ProjectNode): void {
  const scanned = scanParamRefs(node)
  if (scanned.ok) {
    for (const t of scanned.targets) if (!ctx.g.nodes[t]) fail("BAD_REF", `引用了不存在的节点 ${t}`, node.id)
  } else {
    fail("BAD_REF", (scanned as { msg: string }).msg, node.id)
  }
  if (reachesSelf(ctx.g, node.id)) fail("CYCLE", `节点 ${node.id} 的依赖成环`, node.id)
}

// ───────────────────────────── 各 op ─────────────────────────────

function opAddNode(ctx: Ctx, raw: unknown): void {
  const g = ctx.g
  if (!isPlainObject(raw)) return fail("BAD_VALUE", "node 必须是对象")
  for (const k of Object.keys(raw)) if (!NEW_NODE_KEYS.has(k)) fail("BAD_VALUE", `新节点不允许字段 ${k}`)
  const id = raw.id
  if (typeof id !== "string" || !NODE_ID_RE.test(id)) return fail("BAD_VALUE", "节点 id 须匹配 /^[a-z][a-z0-9_]{0,47}$/")
  if (id.includes("#") && ctx.actor.kind !== "engine") return fail("BAD_VALUE", "含 # 的实例 id 只能由引擎展开产生", id)
  if (g.nodes[id]) return fail("EXISTS", `节点 ${id} 已存在`, id)
  const type = raw.type as NodeType
  if (!NODE_TYPES.includes(type)) return fail("BAD_VALUE", `未知节点类型 ${String(raw.type)}`, id)
  checkLane(ctx, id)
  if (Object.keys(g.nodes).length >= MAX_NODES) return fail("BAD_VALUE", `节点数已达上限 ${MAX_NODES}`)
  const intent = unwrap(checkIntent(raw.intent ?? ""), id)
  const paramsRaw = raw.params ?? {}
  if (!isPlainObject(paramsRaw)) return fail("BAD_VALUE", "params 必须是对象", id)
  // 默认值必须落进 params（进签名），否则工程 defaults 变化会让旧产物被错误复用（S3 materializeDefaults 注释）。
  const params: Record<string, Json> = {
    ...materializeDefaults(type, id, unwrap(checkJson(paramsRaw, "params"), id) as Record<string, Json>, g.defaults ?? {}),
  }
  const paramIssues = checkParams(type, params, id)
  if (paramIssues.length) {
    const issue = paramIssues[0]
    const known = !!specOf(type)?.params[issue.key]
    return fail(known ? "BAD_VALUE" : "BAD_PATH", `field=params.${issue.key}；${issue.message}`, id)
  }
  const inputs = unwrap(checkInputs(g, raw.inputs ?? {}), id)
  const refs = unwrap(checkRefs(raw.refs ?? []), id)
  const forEach = raw.forEach == null ? null : unwrap(checkForEach(g, id, type, raw.forEach), id)
  const takes = raw.takes == null ? null : unwrap(checkTakes(raw.takes), id)
  const onFail = raw.onFail == null ? null : unwrap(checkOnFail(raw.onFail), id)
  const node: ProjectNode = {
    id, type, intent, params, inputs, refs, pinned: null, status: "pending", signature: null, lastRun: null, outputs: [], rev: 1,
  }
  if (forEach) node.forEach = forEach
  if (takes) node.takes = takes
  if (onFail) node.onFail = onFail
  g.nodes[id] = node
  g.order.push(id)
  try {
    checkRefsAndCycle(ctx, node)
  } catch (e) {
    delete g.nodes[id]
    g.order.pop()
    throw e
  }
  touch(ctx, id, "add")
}

const PARAM_PATH_RE = /^params\.([A-Za-z_][A-Za-z0-9_]*)$/

function opSet(ctx: Ctx, op: Extract<PatchOp, { op: "set" }>): void {
  if (typeof op.path === "string" && (op.path === "outputs.verdict" || op.path.startsWith("outputs.verdict."))) {
    const node = getNode(ctx, op.node)
    return fail("LANE_VIOLATION", "主代理或非 critic lane 不能写 outputs.verdict", node.id)
  }
  // 图级硬预算。不进节点锁、不标脏、不改 expand 的输入。node 只是既有 set op 的必填位，这里不读取。
  if (op.path === "budget.capCoins") {
    const value = op.value
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      return fail("BAD_VALUE", "budget.capCoins 必须是非负有限数或 null")
    }
    if (!ctx.g.budget) ctx.g.budget = { capCoins: null, spentCoins: 0, savedCoins: 0 }
    const next = typeof value === "number" ? value : null
    if (ctx.g.budget.capCoins === next) return
    ctx.g.budget.capCoins = next
    return
  }
  const node = getNode(ctx, op.node)
  checkLane(ctx, node.id)
  const path = op.path
  const pm = typeof path === "string" ? PARAM_PATH_RE.exec(path) : null
  if (!(path === "intent" || pm || path === "takes" || path === "onFail" || path === "forEach" || path === "refs")) {
    return fail("BAD_PATH", `path 必须是 intent|params.<k>|takes|onFail|forEach|refs，收到 ${String(path)}`, node.id)
  }
  if (op.ifRev !== undefined && node.rev !== op.ifRev) return fail("REV_CONFLICT", `节点 ${node.id} rev=${node.rev}，ifRev=${op.ifRev}`, node.id)
  assertUnlocked(ctx, node, [path])
  const value = op.value
  if (pm || path === "intent" || path === "takes" || path === "onFail" || path === "forEach" || path === "refs") {
    const issue = validateSet(node, path, value as Json)
    if (issue) return fail(issue.patchCode, `field=${issue.path ?? path}；${issue.message}`, node.id)
  }
  if (path === "intent") {
    const next = unwrap(checkIntent(value), node.id)
    if (next === node.intent) return
    node.intent = next
    lockFieldByUser(ctx, node, path)
  } else if (pm) {
    if (pm[1] === "text" && isResearchNode(node) && ctx.actor.kind === "agent") return fail("ACTOR_FORBIDDEN", RESEARCH_AGENT_FORBIDDEN, node.id)
    const next = unwrap(checkJson(value, "params 值"), node.id)
    if (jsonEqual(node.params[pm[1]], next) && pm[1] in node.params) return
    const had = pm[1] in node.params
    const prev = node.params[pm[1]]
    node.params[pm[1]] = next
    try {
      checkRefsAndCycle(ctx, node)
    } catch (e) {
      if (had) node.params[pm[1]] = prev
      else delete node.params[pm[1]]
      throw e
    }
    if (signedParam(ctx, node.type, pm[1])) ctx.selfDirty.add(node.id)
    lockFieldByUser(ctx, node, path)
  } else if (path === "takes") {
    const next = unwrap(checkTakes(value), node.id)
    if (jsonEqual(next, node.takes ?? null)) return
    if (next) node.takes = next
    else delete node.takes
    ctx.selfDirty.add(node.id)
    lockFieldByUser(ctx, node, path)
  } else if (path === "onFail") {
    const next = unwrap(checkOnFail(value), node.id)
    if (jsonEqual(next, node.onFail ?? null)) return
    if (next) node.onFail = next
    else delete node.onFail
    lockFieldByUser(ctx, node, path)
  } else if (path === "forEach") {
    const next = unwrap(checkForEach(ctx.g, node.id, node.type, value), node.id)
    if (jsonEqual(next, node.forEach ?? null)) return
    const prev = node.forEach
    if (next) node.forEach = next
    else delete node.forEach
    try {
      checkRefsAndCycle(ctx, node)
    } catch (e) {
      if (prev) node.forEach = prev
      else delete node.forEach
      throw e
    }
    ctx.selfDirty.add(node.id)
    lockFieldByUser(ctx, node, path)
  } else {
    const next = unwrap(checkRefs(value), node.id)
    if (jsonEqual(next, node.refs)) return
    node.refs = next
    ctx.selfDirty.add(node.id)
    lockFieldByUser(ctx, node, path)
  }
  node.rev += 1
  touch(ctx, node.id, path)
}

function dependsOn(ctx: Ctx, node: ProjectNode, target: NodeId): boolean {
  if (Object.values(node.inputs).some((r) => r.from === target)) return true
  if (node.forEach?.over === target) return true
  const scanned = scanParamRefs(node)
  return scanned.ok && scanned.targets.includes(target)
}

function opRemoveNode(ctx: Ctx, op: Extract<PatchOp, { op: "remove_node" }>): void {
  const g = ctx.g
  const node = getNode(ctx, op.node)
  checkLane(ctx, node.id)
  assertUnlocked(ctx, node, ["*"])
  if (isResearchNode(node) && ctx.actor.kind !== "user") return fail("ACTOR_FORBIDDEN", "研究节点只有用户能删；研究写进 research 节点再开跑", node.id)
  if (node.pinned && ctx.actor.kind !== "user") return fail("PINNED_FORBIDS", `节点 ${node.id} 已钉住，先 unpin 再删`, node.id)
  if (node.status === "running" || node.status === "queued" || node.inflight) return fail("RUN_ACTIVE_CONFLICT", `节点 ${node.id} 正在运行，不能删除`, node.id)
  delete g.nodes[node.id]
  g.order = g.order.filter((x) => x !== node.id)
  touch(ctx, node.id, "remove")
  for (const other of Object.values(g.nodes)) {
    if (other.derivedFrom?.template === node.id) {
      if (other.pinned) {
        other.status = "orphaned"
        touch(ctx, other.id, "orphaned")
      } else {
        delete g.nodes[other.id]
        g.order = g.order.filter((x) => x !== other.id)
        touch(ctx, other.id, "remove")
      }
    }
  }
  for (const other of Object.values(g.nodes)) {
    if (!other.pinned || !dependsOn(ctx, other, node.id)) continue
    for (const [name, ref] of Object.entries(other.inputs)) if (ref.from === node.id) delete other.inputs[name]
    other.status = "orphaned"
    touch(ctx, other.id, "orphaned")
  }
}

function checkEdgeNames(input: unknown, port: unknown): void {
  if (typeof input !== "string" || !INPUT_NAME_RE.test(input)) fail("BAD_VALUE", "输入口名须匹配 /^[a-z][a-z0-9_]*$/")
  if (port !== undefined && (typeof port !== "string" || !PORT_RE.test(port))) fail("BAD_VALUE", "port 须匹配 /^[a-z][a-z0-9_]*$/")
}

function opConnect(ctx: Ctx, op: Extract<PatchOp, { op: "connect" }>): void {
  const to = getNode(ctx, op.to)
  checkLane(ctx, to.id)
  checkEdgeNames(op.input, op.port)
  const from = ctx.g.nodes[op.from as string]
  if (!from) return fail("BAD_REF", `connect 的来源节点 ${String(op.from)} 不存在`, to.id)
  const fromSpec = specOf(from.type)
  if (!fromSpec || resolvePort(fromSpec, op.port) === null) {
    const names = fromSpec ? fromSpec.outputs.map((o) => o.name).join("、") : ""
    return fail("BAD_REF", `field=inputs.${op.input}.port；${from.id}（${from.type}）没有输出口 ${JSON.stringify(op.port ?? "out")}。期望端口：${names || "（未知类型）"}`, to.id)
  }
  assertUnlocked(ctx, to, [`inputs.${op.input}`])
  const next = op.port === undefined ? { from: from.id } : { from: from.id, port: op.port }
  if (jsonEqual(to.inputs[op.input], next)) return
  const prev = to.inputs[op.input]
  to.inputs[op.input] = next
  if (from.id === to.id || reachesSelf(ctx.g, to.id)) {
    if (prev) to.inputs[op.input] = prev
    else delete to.inputs[op.input]
    return fail("CYCLE", `连接 ${from.id} -> ${to.id}.${op.input} 会成环`, to.id)
  }
  to.rev += 1
  ctx.selfDirty.add(to.id)
  touch(ctx, to.id, `inputs.${op.input}`)
}

function opDisconnect(ctx: Ctx, op: Extract<PatchOp, { op: "disconnect" }>): void {
  const to = getNode(ctx, op.to)
  checkLane(ctx, to.id)
  checkEdgeNames(op.input, undefined)
  if (!to.inputs[op.input]) return fail("NOT_FOUND", `节点 ${to.id} 没有输入口 ${op.input}`, to.id)
  assertUnlocked(ctx, to, [`inputs.${op.input}`])
  delete to.inputs[op.input]
  to.rev += 1
  ctx.selfDirty.add(to.id)
  touch(ctx, to.id, `inputs.${op.input}`)
}

function opLock(ctx: Ctx, op: Extract<PatchOp, { op: "lock" }>): void {
  const node = getNode(ctx, op.node)
  const fields = unwrap(checkLockFields(op.fields), node.id)
  if (node.locked?.by === "user" && !isHuman(ctx.actor)) return fail("ACTOR_FORBIDDEN", `节点 ${node.id} 由用户锁定，代理不可改锁`, node.id)
  node.locked = { by: ctx.actor.kind === "user" ? "user" : "agent", fields, at: ctx.nowIso }
  touch(ctx, node.id, "locked")
}

function opUnlock(ctx: Ctx, op: Extract<PatchOp, { op: "unlock" }>): void {
  const node = getNode(ctx, op.node)
  if (!node.locked) return
  if (node.locked.by === "user" && !isHuman(ctx.actor)) return fail("ACTOR_FORBIDDEN", `节点 ${node.id} 由用户锁定，代理不可解锁`, node.id)
  delete node.locked
  touch(ctx, node.id, "locked")
}

/** §3.5 Pin 边界：export/qc/forEach 模板/scratch 不可 pin；无产物、failed/blocked 不可 pin。 */
function assertPinnableType(node: ProjectNode): void {
  if (node.type === "export" || node.type === "qc") fail("NOT_PINNABLE", `${node.type} 节点不可钉住`, node.id)
  if (node.forEach) fail("NOT_PINNABLE", `forEach 模板节点 ${node.id} 不可钉住（钉它的实例）`, node.id)
  if (node.scratch) fail("NOT_PINNABLE", `草稿节点 ${node.id} 不可钉住`, node.id)
  if (node.status === "running" || node.status === "queued") fail("RUN_ACTIVE_CONFLICT", `节点 ${node.id} 正在运行`, node.id)
}

function opPin(ctx: Ctx, op: Extract<PatchOp, { op: "pin" }>): void {
  const node = getNode(ctx, op.node)
  checkLane(ctx, node.id)
  if (op.reason !== undefined && (typeof op.reason !== "string" || [...op.reason].length > 200)) return fail("BAD_VALUE", "reason 必须是 ≤200 字的字符串", node.id)
  if (node.pinned) {
    if (op.take !== undefined && op.take !== node.pinned.take) return fail("PINNED_FORBIDS", `节点 ${node.id} 已钉住 take=${String(node.pinned.take)}，换 take 须先 unpin`, node.id)
    return
  }
  assertPinnableType(node)
  if (node.status === "failed" || node.status === "blocked") return fail("NOT_PINNABLE", `${node.status} 状态的节点不可钉住`, node.id)
  if (node.outputs.length === 0) return fail("NOT_PINNABLE", `节点 ${node.id} 还没有产物`, node.id)
  if (node.takes) {
    // §3.5 + S3 checkPinnable(takes_needs_take)：必须指定 take，且必须是当前选中的那个（先 select_take）。
    if (op.take === undefined) return fail("BAD_VALUE", `takes 节点 ${node.id} 钉住时必须指定 take`, node.id)
    if (!(node.takesPool ?? []).some((o) => o.take === op.take)) return fail("BAD_VALUE", `节点 ${node.id} 没有 take=${op.take}`, node.id)
    const selected = node.outputs[0]?.take
    if (selected !== op.take) return fail("BAD_VALUE", `take ${op.take} 不是当前选中的候选（当前选中 ${selected ?? "无"}）；先 select_take 再 pin`, node.id)
  } else if (op.take !== undefined) {
    return fail("BAD_VALUE", `节点 ${node.id} 没有 takes，不能指定 take`, node.id)
  }
  node.pinned = {
    by: ctx.actor.kind === "user" ? "user" : "agent",
    at: ctx.nowIso,
    outputsSha: node.outputs.map((o) => o.sha256), // 冻结全部输出口
    signatureAtPin: currentSignature(node),
  }
  if (op.reason !== undefined) node.pinned.reason = op.reason
  if (op.take !== undefined) node.pinned.take = op.take
  if (node.status === "stale" || node.status === "pending") node.status = "done"
  touch(ctx, node.id, "pinned")
}

function opUnpin(ctx: Ctx, op: Extract<PatchOp, { op: "unpin" }>): void {
  const node = getNode(ctx, op.node)
  checkLane(ctx, node.id)
  if (!node.pinned) return
  if (node.pinned.by === "user" && !isHuman(ctx.actor)) return fail("ACTOR_FORBIDDEN", `节点 ${node.id} 由用户钉住，代理不可 unpin`, node.id)
  const drifted = node.signature !== null && node.signature !== node.pinned.signatureAtPin
  node.pinned = null
  if (drifted && node.status === "done") node.status = "stale"
  touch(ctx, node.id, "pinned")
}

async function opReplaceOutput(ctx: Ctx, op: Extract<PatchOp, { op: "replace_output" }>): Promise<void> {
  const node = getNode(ctx, op.node)
  assertPinnableType(node)
  if (typeof op.artifactId !== "string") return fail("BAD_VALUE", "artifactId 必须是字符串", node.id)
  const art = await ctx.opts.artifacts.get(op.artifactId, { port: "out", origin: "user" })
  if (!art) return fail("NOT_FOUND", `产物 ${op.artifactId} 不在工程产物库`, node.id)
  const kept = node.outputs.filter((o) => o.port !== "out")
  node.outputs = [{ ...art, port: "out", origin: "user" }, ...kept]
  node.pinned = { by: "user", at: ctx.nowIso, outputsSha: node.outputs.map((o) => o.sha256), signatureAtPin: currentSignature(node) }
  node.status = "done"
  delete node.error
  node.lastRun = { runId: "user_replace", at: ctx.nowIso, via: "pinned", signature: currentSignature(node), costCoins: 0, attempt: 0 }
  ctx.outDirty.add(node.id)
  ctx.events.push({ kind: "node_output", node: node.id, data: { port: "out", artifactId: op.artifactId, origin: "user" } })
  touch(ctx, node.id, "outputs")
  touch(ctx, node.id, "pinned")
}

function opSelectTake(ctx: Ctx, op: Extract<PatchOp, { op: "select_take" }>): void {
  const node = getNode(ctx, op.node)
  checkLane(ctx, node.id)
  assertUnlocked(ctx, node, ["outputs"])
  if (node.pinned) return fail("PINNED_FORBIDS", `节点 ${node.id} 已钉住，换 take 须先 unpin`, node.id)
  if (!node.takes || !node.takesPool?.length) return fail("BAD_VALUE", `节点 ${node.id} 没有候选 take`, node.id)
  const picked = node.takesPool.filter((o) => o.take === op.take)
  if (picked.length === 0) return fail("BAD_VALUE", `节点 ${node.id} 没有 take=${String(op.take)}`, node.id)
  if (jsonEqual(picked.map((o) => o.sha256), node.outputs.map((o) => o.sha256))) return
  node.outputs = structuredClone(picked)
  node.status = "done"
  ctx.outDirty.add(node.id)
  ctx.events.push({ kind: "node_output", node: node.id, data: { take: op.take } })
  touch(ctx, node.id, "outputs")
}

function opReroll(ctx: Ctx, op: Extract<PatchOp, { op: "reroll" }>): void {
  const node = getNode(ctx, op.node)
  checkLane(ctx, node.id)
  if (!SEEDED.includes(node.type)) return fail("BAD_VALUE", `${node.type} 节点没有 seed，不能 reroll`, node.id)
  assertUnlocked(ctx, node, ["params.seed"])
  if (node.pinned) return fail("PINNED_FORBIDS", `节点 ${node.id} 已钉住，reroll 须先 unpin`, node.id)
  const cur = typeof node.params.seed === "number" ? (node.params.seed as number) : fnvSeed(node.id)
  node.params.seed = (cur + 1) & 0x7fffffff
  node.rev += 1
  ctx.selfDirty.add(node.id)
  touch(ctx, node.id, "params.seed")
}

async function opWriteResult(ctx: Ctx, op: Extract<PatchOp, { op: "write_result" }>): Promise<void> {
  const node = getNode(ctx, op.node)
  checkLane(ctx, node.id)
  if (isResearchNode(node) && ctx.actor.kind === "agent") return fail("ACTOR_FORBIDDEN", RESEARCH_AGENT_FORBIDDEN, node.id)
  if (node.type === "qc" && ctx.actor.kind !== "subagent") {
    return fail("LANE_VIOLATION", "主代理或非 critic lane 不能写 outputs.verdict", node.id)
  }
  const authored = node.type === "script" || node.type === "shotlist" || (node.type === "qc" && node.params.mode === "critic")
  if (!authored) return fail("NOT_AUTHORED", `${node.type} 节点不是作者型节点，不能写结果`, node.id)
  const lockFields = node.type === "script" ? ["params.text"] : node.type === "shotlist" ? ["params.rows", "params.kind"] : ["outputs"]
  assertUnlocked(ctx, node, lockFields)
  if (node.pinned) return fail("PINNED_FORBIDS", `节点 ${node.id} 已钉住，写结果须先 unpin`, node.id)
  const content = unwrap(checkWriteValue(node.type, op.value), node.id)
  const body = node.type === "script" ? (content.text as string) : JSON.stringify(node.type === "shotlist" ? { kind: content.kind ?? node.params.kind ?? null, rows: content.rows } : content)
  const out = await ctx.opts.artifacts.putBytes(body, {
    port: "out", origin: ctx.actor.kind === "user" ? "user" : "generated", mime: node.type === "script" ? "text/plain" : "application/json",
  })
  const sameOutput = node.outputs.length === 1 && node.outputs[0].sha256 === out.sha256
  if (node.type === "script") {
    if (node.params.text !== content.text) { node.params.text = content.text; node.rev += 1; touch(ctx, node.id, "params.text") }
  } else if (node.type === "shotlist") {
    let paramsChanged = false
    if (!jsonEqual(node.params.rows, content.rows)) { node.params.rows = content.rows; paramsChanged = true }
    if (content.kind !== undefined && node.params.kind !== content.kind) { node.params.kind = content.kind; paramsChanged = true }
    if (paramsChanged) { node.rev += 1; touch(ctx, node.id, "params.rows") }
  }
  if (sameOutput && node.status === "done") return
  node.outputs = [out]
  node.status = "done"
  delete node.error
  node.lastRun = { runId: "write_result", at: ctx.nowIso, via: "executed", signature: currentSignature(node), costCoins: 0, attempt: 1 }
  ctx.outDirty.add(node.id)
  ctx.events.push({ kind: "node_output", node: node.id, data: { port: "out", artifactId: out.artifactId } })
  touch(ctx, node.id, "outputs")
}

function opSetTargets(ctx: Ctx, op: Extract<PatchOp, { op: "set_targets" }>, sourceKind?: TargetSource["kind"]): void {
  const t = unwrap(checkTargets(op.targets))
  const interpretation = op.interpretation
  if (interpretation !== undefined) {
    if (!isPlainObject(interpretation) || !Array.isArray(interpretation.sourceMessageIds) || !interpretation.sourceMessageIds.length ||
      interpretation.sourceMessageIds.some((id) => typeof id !== "string" || !ctx.g.brief.some((b) => b.messageId === id)) ||
      typeof interpretation.requirements !== "string" || !interpretation.requirements.trim() || interpretation.requirements.length > 12000 ||
      (interpretation.statusOnly !== undefined && typeof interpretation.statusOnly !== "boolean") ||
      (interpretation.supersedes !== undefined && (!Array.isArray(interpretation.supersedes) || interpretation.supersedes.some((id) => !ctx.g.goalInterpretations?.some((old) => old.id === id))))) {
      return fail("BAD_VALUE", "interpretation 必须引用本工程真实原话与已有解释，requirements为1..12000字；只是解释候选，不授予权限")
    }
    if (interpretation.statusOnly === true && Object.keys(t).length) return fail("BAD_VALUE", "statusOnly 不能同时修改制作目标")
    if (interpretation.statusOnly === true && interpretation.supersedes?.some((id) => ctx.g.goalInterpretations?.some((old) => old.id === id && !old.statusOnly))) {
      return fail("BAD_VALUE", "状态询问不能撤销制作解释；确需修改请提交制作解释候选并由评审核对原话")
    }
  }
  const source = op.sourceMessageId === undefined ? undefined : ctx.g.brief.find((b) => b.messageId === op.sourceMessageId)
  if (op.sourceMessageId !== undefined && (typeof op.sourceMessageId !== "string" || !source)) {
    return fail("BAD_VALUE", "sourceMessageId 必须引用本工程真实用户原话；引用不提升操作身份或授权")
  }
  const previous = ctx.g.targets
  const sources = { ...(previous?.sources ?? {}) }
  for (const field of ["durationSec", "aspect", "shots", "subtitles", "audio"] as TargetField[]) {
    if (previous?.[field] === undefined || sources[field]) continue
    sources[field] = {
      kind: previous.setBy.kind === "user" ? "user" : previous.setBy.kind === "engine" ? "default" : "agent",
      revision: `${field}:${previous.at}:${previous.setBy.kind}`,
    }
  }
  const kind = sourceKind ?? (ctx.actor.kind === "user" ? "user" : ctx.actor.kind === "engine" ? "default" : "agent")
  const accepted: Record<string, unknown> = {}
  for (const field of Object.keys(t) as TargetField[]) {
    const value = t[field]
    const oldSource = sources[field]
    if (kind === "default" && previous?.[field] !== undefined) continue // 配方只填空，不能替换用户或导演当前选择
    if (oldSource?.kind === "user" && ctx.actor.kind !== "user" && previous?.[field] !== value) {
      return fail("ACTOR_FORBIDDEN", `targets.${field} 由用户设定，代理不可覆盖`)
    }
    accepted[field] = value
    if (oldSource?.kind === "user" && kind !== "user") { sources[field] = oldSource; continue }
    sources[field] = {
      kind, revision: createHash("sha256").update(JSON.stringify([field, value, kind, source?.messageId, oldSource?.revision, ctx.nowIso])).digest("hex"),
      ...(source ? { messageId: source.messageId, evidence: source.text.slice(0, 500), interpretation: kind !== "user" } : {}),
      ...(oldSource ? { supersedes: oldSource.revision } : {}),
    }
  }
  if (Object.keys(accepted).length) ctx.g.targets = { ...previous, ...accepted, sources, setBy: kind === "default" ? { kind: "engine" } : ctx.actor, at: ctx.nowIso }
  if (interpretation) {
    const candidate = {
      sourceMessageIds: [...new Set(interpretation.sourceMessageIds)],
      requirements: interpretation.requirements,
      supersedes: [...new Set(interpretation.supersedes ?? [])],
      statusOnly: interpretation.statusOnly === true,
    }
    const id = createHash("sha256").update(JSON.stringify(candidate)).digest("hex")
    ctx.g.goalInterpretations ??= []
    if (!ctx.g.goalInterpretations.some((old) => old.id === id)) ctx.g.goalInterpretations.push({ ...candidate, id, actor: ctx.actor, at: ctx.nowIso })
  }
}

function opSetDefaults(ctx: Ctx, op: Extract<PatchOp, { op: "set_defaults" }>): void {
  ctx.g.defaults = { ...ctx.g.defaults, ...unwrap(checkDefaults(op.defaults)) }
}

function fork(ctx: Ctx): Ctx {
  return {
    ...ctx,
    g: structuredClone(ctx.g),
    selfDirty: new Set(ctx.selfDirty),
    outDirty: new Set(ctx.outDirty),
    changed: new Map([...ctx.changed].map(([k, v]) => [k, new Set(v)])),
    events: [...ctx.events],
    warnings: [...ctx.warnings],
    lockedNodes: new Set(ctx.lockedNodes),
  }
}

function opApplyRecipe(ctx: Ctx, op: Extract<PatchOp, { op: "apply_recipe" }>): void {
  if (typeof op.recipe !== "string") return fail("BAD_VALUE", "recipe 必须是字符串")
  const recipe = ctx.opts.recipes?.(op.recipe)
  if (!recipe) return fail("UNKNOWN_RECIPE", `配方 ${op.recipe} 不存在`)
  if (!isPlainObject(op.params)) return fail("BAD_VALUE", "recipe params 必须是对象")
  unwrap(checkJson(op.params, "recipe params"))
  let built: ReturnType<Recipe["build"]>
  try {
    built = recipe.build(op.params)
  } catch (e) {
    return fail("BAD_VALUE", `配方 ${op.recipe} 构建失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const trial = fork(ctx)
  const research = RESEARCH_RECIPES.has(recipe.id) && !researchNodeIds(trial.g).length && !built.nodes.some((n) => isResearchNode(n)) ? researchNewNodes() : []
  for (const rn of research) opAddNode(trial, rn)
  for (const nn of built.nodes) {
    // 剧本是第一道创作工序：接上全部研究，研究没写完它就停在 awaiting author，下游跟着停。
    const wired = research.length && nn.type === "script"
      ? { ...nn, inputs: { ...(nn.inputs ?? {}), ...Object.fromEntries(research.filter((r) => !nn.inputs?.[r.id]).map((r) => [r.id, { from: r.id }])) } }
      : nn
    opAddNode(trial, wired) // 任一节点失败 → 整个配方丢弃（trial 不提交）
  }
  if (built.defaults) opSetDefaults(trial, { op: "set_defaults", defaults: built.defaults })
  if (built.targets) {
    try {
      opSetTargets(trial, { op: "set_targets", targets: built.targets }, "default")
    } catch (e) {
      if (!(e instanceof PatchError)) throw e
      trial.warnings.push(`配方 targets 未写入：${e.message}`)
    }
  }
  if (!trial.g.templateId) trial.g.templateId = recipe.id
  Object.assign(ctx, trial)
}

async function applyOne(ctx: Ctx, op: PatchOp): Promise<void> {
  if (!isPlainObject(op) || typeof (op as { op?: unknown }).op !== "string") return fail("BAD_VALUE", "op 必须是带 op 字段的对象")
  checkActor(ctx, op)
  switch (op.op) {
    case "add_node": return opAddNode(ctx, op.node)
    case "set": return opSet(ctx, op)
    case "remove_node": return opRemoveNode(ctx, op)
    case "connect": return opConnect(ctx, op)
    case "disconnect": return opDisconnect(ctx, op)
    case "lock": return opLock(ctx, op)
    case "unlock": return opUnlock(ctx, op)
    case "pin": return opPin(ctx, op)
    case "unpin": return opUnpin(ctx, op)
    case "replace_output": return opReplaceOutput(ctx, op)
    case "select_take": return opSelectTake(ctx, op)
    case "reroll": return opReroll(ctx, op)
    case "write_result": return opWriteResult(ctx, op)
    case "set_targets": return opSetTargets(ctx, op)
    case "set_defaults": return opSetDefaults(ctx, op)
    case "apply_recipe": return opApplyRecipe(ctx, op)
    default: return fail("BAD_VALUE", `未知 op ${String((op as { op: unknown }).op)}`)
  }
}

// ───────────────────────────── 批处理 ─────────────────────────────

function wholeBatchFailure(graph: ProjectGraph, code: PatchErrorCode, msg: string, i = 0, node?: NodeId): PatchOutcome {
  const rejected = [{ i, code, msg, ...(node ? { node } : {}) }]
  return { graph, committed: false, events: [], receipt: buildPatchReceipt({ ok: false, version: graph.version, applied: 0, rejected, changed: [], stale: [], drift: [], warnings: [] }) }
}

/** 结构性过期传播。返回本批新变 stale 的节点与 drift 集合。 */
function propagate(ctx: Ctx, before: Map<NodeId, string>): { stale: NodeId[]; drift: NodeId[] } {
  const g = ctx.g
  const children = buildChildren(g)
  const touchedDrift = new Set<NodeId>()
  const visited = new Set<NodeId>()
  const walk = (from: NodeId): void => {
    const queue = [...(children.get(from) ?? [])]
    while (queue.length) {
      const id = queue.shift() as NodeId
      if (visited.has(id)) continue
      visited.add(id)
      const n = g.nodes[id]
      if (!n) continue
      if (n.pinned) { touchedDrift.add(id); continue } // pinned 当叶子：上游变了只提示漂移，不动它也不再下传
      if (n.status === "done") n.status = "stale"
      for (const c of children.get(id) ?? []) queue.push(c)
    }
  }
  for (const id of ctx.selfDirty) {
    const n = g.nodes[id]
    if (!n) continue
    if (n.pinned) { touchedDrift.add(id); continue }
    if (n.status === "done") n.status = "stale"
    walk(id)
  }
  for (const id of ctx.outDirty) if (g.nodes[id]) walk(id)
  const stale = Object.values(g.nodes).filter((n) => n.status === "stale" && before.has(n.id) && before.get(n.id) !== "stale").map((n) => n.id).sort()
  const drift = new Set(touchedDrift)
  for (const n of Object.values(g.nodes)) {
    if (n.pinned && n.signature !== null && n.signature !== n.pinned.signatureAtPin) drift.add(n.id)
  }
  return { stale, drift: [...drift].sort() }
}

/** agent 改 shotlist 行：删掉或改写 locked/pinned 实例对应行 → 整批 LOCKED。用户删行允许。 */
function protectedRowProblem(actor: Actor, before: ProjectGraph, after: ProjectGraph): { node: NodeId; msg: string } | null {
  if (actor.kind === "user" || actor.kind === "engine") return null
  for (const tpl of Object.values(before.nodes)) {
    if (!tpl.forEach || tpl.derivedFrom) continue
    const over = tpl.forEach.over
    const oldSl = before.nodes[over]
    const newSl = after.nodes[over]
    if (!oldSl || !newSl || oldSl.type !== "shotlist") continue
    const oldMap = new Map(readRows(oldSl).rows.map((r) => [r.id, JSON.stringify(r.data)]))
    const newMap = new Map(readRows(newSl).rows.map((r) => [r.id, JSON.stringify(r.data)]))
    for (const inst of Object.values(before.nodes)) {
      if (inst.derivedFrom?.template !== tpl.id) continue
      const rowId = inst.derivedFrom.rowId
      const userLocked = inst.locked?.by === "user"
      if (!newMap.has(rowId)) {
        if (inst.locked || inst.pinned) return { node: inst.id, msg: `删除镜头行 ${rowId} 会去掉${inst.locked ? "锁定" : "钉住"}的实例 ${inst.id}，整批拒绝` }
      } else if (userLocked && oldMap.get(rowId) !== newMap.get(rowId)) {
        return { node: inst.id, msg: `改镜头行 ${rowId} 会改写用户锁定的实例 ${inst.id}，整批拒绝` }
      }
    }
  }
  return null
}

export async function applyPatch(graph: Readonly<ProjectGraph>, req: PatchRequest, actor: Actor, opts: PatchEngineOptions): Promise<PatchOutcome> {
  const base = graph as ProjectGraph
  if (!req || !Array.isArray(req.ops)) return wholeBatchFailure(base, "BAD_VALUE", "ops 必须是数组")
  if (req.ops.length > MAX_OPS_PER_BATCH) return wholeBatchFailure(base, "BAD_VALUE", `单批 op 不得超过 ${MAX_OPS_PER_BATCH}`)
  if (req.baseVersion !== undefined && req.baseVersion !== base.version) {
    return wholeBatchFailure(base, "VERSION_CONFLICT", `图 version=${base.version}，baseVersion=${req.baseVersion}，整批拒绝`)
  }
  const nowIso = (opts.now?.() ?? new Date()).toISOString()
  const ctx: Ctx = {
    g: structuredClone(base), actor, opts, nowIso, selfDirty: new Set(), outDirty: new Set(), changed: new Map(), events: [], warnings: [], lockedNodes: new Set(),
  }
  const before = new Map(Object.values(base.nodes).map((n) => [n.id, n.status as string]))
  const rejected: { i: number; code: PatchErrorCode; node?: NodeId; msg: string }[] = []
  let applied = 0
  for (let i = 0; i < req.ops.length; i++) {
    // 每个 op 先在影子上跑：失败时整图回滚到该 op 之前，保证「坏的丢弃」不留半截改动。
    const snapshot = fork(ctx)
    try {
      await applyOne(ctx, req.ops[i])
      applied++
    } catch (e) {
      if (!(e instanceof PatchError)) throw e
      Object.assign(ctx, snapshot)
      rejected.push({ i, code: e.code, msg: e.message, ...(e.node ? { node: e.node } : {}) })
      if (req.atomic) return wholeBatchFailure(base, e.code, e.message, i, e.node)
    }
  }
  const problem = applied > 0 ? findGraphProblem(ctx.g) : null
  if (problem) return wholeBatchFailure(base, "GRAPH_INVALID", problem.msg, Math.max(0, rejected.length ? 0 : 0), problem.node)
  if (applied === 0) {
    const receipt = buildPatchReceipt({ ok: rejected.length === 0, version: base.version, applied: 0, rejected, changed: [], stale: [], drift: [], warnings: ctx.lockedNodes.size ? [`lockedDropped: ${[...ctx.lockedNodes].join(",")}`] : [] })
    return { graph: base, receipt, events: [], committed: false }
  }
  // S21：forEach 扇出在这里落图（§3.3）。expandGraph 是纯函数，只做「模板 → 实例」与引用规范化；
  // planRun 只认得已在图里的实例，所以每次成功补丁都必须展开。坏行表 / over 不是 shotlist 等 = 整批拒绝，图不变。
  const rowGuard = protectedRowProblem(actor, base, ctx.g)
  if (rowGuard) return wholeBatchFailure(base, "LOCKED", rowGuard.msg, 0, rowGuard.node)
  const exp = expandGraph(ctx.g)
  if (!exp.ok) {
    const issue = exp.issues[0]
    return wholeBatchFailure(base, issue.code, issue.message, 0, issue.node)
  }
  if (actor.kind !== "user" && actor.kind !== "engine") {
    for (const id of exp.removed) {
      const prev = ctx.g.nodes[id]
      if (prev?.locked || prev?.pinned) {
        return wholeBatchFailure(base, "LOCKED", `展开会删除${prev.locked ? "锁定" : "钉住"}的实例 ${id}，整批拒绝`, 0, id)
      }
    }
  }
  for (const w of exp.warnings) if (!ctx.warnings.includes(w)) ctx.warnings.push(w)
  ctx.g.nodes = exp.nodes
  ctx.g.order = exp.order
  const { stale, drift } = propagate(ctx, before)
  if (ctx.lockedNodes.size) ctx.warnings.push(`lockedDropped: ${[...ctx.lockedNodes].join(",")}`)
  if (exp.created.length || exp.removed.length || exp.orphaned.length) {
    ctx.warnings.push(`fanout:+${exp.created.length} -${exp.removed.length} orphan:${exp.orphaned.length}`)
  }
  const g = ctx.g
  if (actor.kind !== "user" && actor.kind !== "engine") g.entry = base.entry
  g.version = base.version + 1
  g.updatedAt = nowIso
  const changed = [...ctx.changed].map(([node, fields]) => ({ node, fields: [...fields] }))
  // 实例属派生节点，不进 changed 字段；只在 patch 事件里与本批改动合并（去重、仍按 20 条截断）。
  const eventNodes = [...new Set([...changed.map((c) => c.node), ...exp.created])].filter((id) => !!g.nodes[id])
  const events: EventDraft[] = [
    { kind: "patch", data: { version: g.version, actor: actor.kind, applied, rejected: rejected.length, nodes: eventNodes.slice(0, 20), more: Math.max(0, eventNodes.length - 20) } },
    ...ctx.events,
    ...stale.slice(0, 40).map((node): EventDraft => ({ kind: "node_status", node, data: { from: before.get(node) ?? "", to: "stale" } })),
    ...exp.orphaned.map((node): EventDraft => ({ kind: "node_status", node, data: { from: before.get(node) ?? "", to: "orphaned" } })),
    ...drift.slice(0, 20).map((node): EventDraft => ({ kind: "pin_drift", node, data: {} })),
  ]
  const receipt = buildPatchReceipt({ ok: rejected.length === 0, version: g.version, applied, rejected, changed, stale, drift, warnings: ctx.warnings })
  return { graph: g, receipt, events, committed: true }
}
