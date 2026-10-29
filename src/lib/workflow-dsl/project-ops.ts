// workflow-dsl/project-ops.ts — DSL v2 → 工程图强类型 PatchOp[]（target:"project"，设计文档 §3.4）。
//
// 角色：网关不 import src/，DSL 在站点端编译；本档把 ProjectDslSource（schema.ts）对着工程里
// 已有节点的摘要（current，来自 project_get / ProjectGraph.nodes）diff 成 PatchOp，再交
// project_patch 工具送网关。契约真源 = deploy-staging/gateway/project/types.ts（只 import type）。
//
// 语义与 compile.ts 的 patchForExisting（P0）逐项对齐：
//   · 增量：current 里没有的 id → add_node；已有 → 只对「有差异」的字段发 set（幂等，重编译零 op）。
//   · 不重置状态：status/outputs/签名是引擎的，编译器不碰（对应 P0「status 不重置」）。
//   · locked：被锁的字段上的 set 一律丢弃，且只在「DSL 与现值确有差异」时回 lockedDropped（不静默）；
//     locked 整节点（"*" 或旧语义 true）= P0 的 locked===true；连线（connect）不受影响，与 P0 一致。
//   · 不删节点：DSL 没写的节点原样保留（P0 v0 不删）；也不删 params 里 DSL 没写的键，要清写 null。
//   · 永远不产出任何「运行」类 op；运行走 project_run。
// 档内不 import compile.ts（compile.ts 反向 import 本档做 target 分派，避免环）。

import type {
  FileRef, ForEach, Json, NewNode, NodeId, NodeType, OnFail, PatchOp, TakesSpec,
} from "../../../deploy-staging/gateway/project/types";
import {
  PROJECT_KIND_ALIASES,
  PROJECT_NODE_KINDS,
  validateProjectDsl,
  type ProjectDslInputRef,
  type ProjectDslStep,
  type WorkflowValidationIssue,
} from "./schema";

/** 工程里已有节点的摘要。ProjectNode / NodeView 都能直接赋值（多余字段忽略；缺字段按「未知」处理）。 */
export interface ProjectCurrentNode {
  id: string;
  type: string;
  intent?: string;
  params?: Record<string, unknown>;
  inputs?: Record<string, { from: string; port?: string }>;
  refs?: unknown;
  forEach?: unknown;
  takes?: unknown;
  onFail?: unknown;
  /** ProjectNode.locked 是 LockState；NodeView.locked 是 string[] | "*"；true = P0 旧语义。 */
  locked?: boolean | "*" | string[] | { fields: string[] | "*" } | null;
  /** ProjectNode.pinned 是 PinState|null；NodeView.pinned 是 boolean。 */
  pinned?: boolean | { take?: number; reason?: string } | null;
  rev?: number;
  derivedFrom?: unknown;
  scratch?: unknown;
}
export interface ProjectCompileInput { nodes: ProjectCurrentNode[] }

export type ProjectCompileResult =
  | { ok: true; ops: PatchOp[]; summary: { added: number; updated: number; connected: number; pinned: number; warnings: string[]; lockedDropped: NodeId[] } }
  | { ok: false; errors: WorkflowValidationIssue[]; ops: [] };

/** 路由用：current.nodes 数组或 {id: node} 对象都收；非对象/缺 id/缺 type 的项丢弃。 */
export function normalizeProjectCurrent(rawNodes: unknown): ProjectCompileInput {
  const out: ProjectCurrentNode[] = [];
  const entries: [string | undefined, unknown][] = Array.isArray(rawNodes)
    ? rawNodes.map((n) => [undefined, n])
    : rawNodes && typeof rawNodes === "object"
      ? Object.entries(rawNodes as Record<string, unknown>)
      : [];
  for (const [key, n] of entries) {
    if (!n || typeof n !== "object" || Array.isArray(n)) continue;
    const node = n as Record<string, unknown>;
    const id = typeof node.id === "string" ? node.id : key;
    if (typeof id !== "string" || typeof node.type !== "string") continue;
    out.push({ ...(node as unknown as ProjectCurrentNode), id, type: node.type });
  }
  return { nodes: out };
}

// ─────────────────────────── 小工具

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** 锁定字段集：null=未锁。 */
export function lockedFieldsOf(node: ProjectCurrentNode): "*" | string[] | null {
  const l = node.locked;
  if (l === true || l === "*") return "*";
  if (Array.isArray(l)) return l.length > 0 ? l : null;
  if (l && typeof l === "object") {
    if (l.fields === "*") return "*";
    return Array.isArray(l.fields) && l.fields.length > 0 ? l.fields : null;
  }
  return null;
}
function pathLocked(fields: "*" | string[] | null, path: string): boolean {
  if (fields === null) return false;
  if (fields === "*") return true;
  return fields.some((f) => path === f || path.startsWith(`${f}.`));
}

interface Resolved {
  step: ProjectDslStep;
  type: string;
  existing: ProjectCurrentNode | undefined;
  intent: string | undefined;
  params: Record<string, Json>;
  wanted: Record<string, ProjectDslInputRef>;
}

/** 步骤 → 期望 params：meta（最低）< params < prompt/model/size/count(→n) 快捷字段。 */
function buildParams(step: ProjectDslStep): Record<string, Json> {
  const params: Record<string, Json> = {};
  for (const [k, v] of Object.entries(step.meta ?? {})) if (k !== "_origin_node_id" && k.length > 0 && !k.includes(".")) params[k] = v as Json;
  for (const [k, v] of Object.entries(step.params ?? {})) params[k] = v as Json;
  if (step.prompt !== undefined && step.prompt !== null) params.prompt = step.prompt;
  if (step.model !== undefined && step.model !== null) params.model = step.model;
  if (step.size !== undefined && step.size !== null) params.size = step.size;
  if (step.count !== undefined && step.count !== null) params.n = step.count;
  return params;
}

function pinRequested(p: ProjectDslStep["pinned"]): boolean {
  return p === true || (typeof p === "object" && p !== null);
}

// ─────────────────────────── 编译主入口

export function compileProjectDsl(sourceRaw: unknown, current: ProjectCompileInput): ProjectCompileResult {
  // 旧tool卡有执行义务，不能当注释吞掉。仅接与现有节点真正等价的生成入口。
  const toolKinds: Record<string, NodeType> = { image_generate: "keyframe", video_generate: "clip", music_gen: "music", tts: "voice", blender_render: "render3d" };
  const source = sourceRaw && typeof sourceRaw === "object" ? structuredClone(sourceRaw) as Record<string, any> : sourceRaw;
  const compatibilityErrors: WorkflowValidationIssue[] = [];
  if (source && typeof source === "object" && Array.isArray((source as Record<string, any>).steps)) {
    for (const step of (source as Record<string, any>).steps) {
      if (!step || typeof step !== "object") continue;
      if (step.gate === true) compatibilityErrors.push({ step: step.id, field: "gate", message: `步骤 ${step.id} 的事前人工批准门尚无等价执行机制，未应用整份DSL；onFail/候选选择不是事前批准的替代品`, hint: "保留该义务，先接真实批准机制；不要删gate冒充完成" });
      if (typeof step.tool === "string") {
        const mapped = toolKinds[step.tool];
        if (!mapped) compatibilityErrors.push({ step: step.id, field: "tool", message: `步骤 ${step.id} 的工具 ${step.tool} 尚未接入同工程执行，未应用整份DSL`, hint: "使用该工具已有路径完成实际义务；不得只把工具名改成说明文字" });
        else {
          const declared = PROJECT_KIND_ALIASES[step.kind] ?? step.kind;
          if (declared && declared !== mapped && !(step.kind === "audio" && (mapped === "music" || mapped === "voice"))) compatibilityErrors.push({ step: step.id, field: "tool", message: `步骤 ${step.id} 的工具 ${step.tool} 对应${mapped}，与kind=${step.kind}不一致` });
          else step.kind = mapped;
          delete step.tool;
        }
      }
    }
  }
  if (compatibilityErrors.length) return { ok: false, errors: compatibilityErrors, ops: [] };
  const validated = validateProjectDsl(source);
  if (!validated.ok) return { ok: false, errors: validated.errors, ops: [] };
  const steps = validated.source.steps;

  const errors: WorkflowValidationIssue[] = [];
  const fail = (step: string, field: string, message: string, hint?: string) => errors.push({ step, field, message, hint });
  const currentById = new Map(current.nodes.map((n) => [n.id, n]));
  const dslIds = new Set<string>();
  for (const s of steps) {
    if (dslIds.has(s.id)) fail(s.id, "id", `步骤 id "${s.id}" 重复；同档内步骤 id 必须唯一`);
    dslIds.add(s.id);
  }
  if (errors.length > 0) return { ok: false, errors, ops: [] };

  // 类型、期望输入、期望字段
  const resolved = new Map<string, Resolved>();
  for (const step of steps) {
    const existing = currentById.get(step.id);
    const kindType = step.kind === undefined || step.kind === null ? undefined : (PROJECT_KIND_ALIASES[step.kind] ?? step.kind);
    let type: string;
    if (existing) {
      if (kindType !== undefined && kindType !== existing.type) {
        fail(step.id, "kind", `节点 ${step.id} 已存在且类型为 ${existing.type}，不能改成 ${kindType}；类型不可改，换一个 id 新建（或先 remove_node 再建）`);
      }
      type = existing.type;
    } else {
      if (kindType === undefined) fail(step.id, "kind", `新增节点 ${step.id} 必须写 kind（${PROJECT_NODE_KINDS.join("|")}）`);
      type = kindType ?? "";
    }
    const wanted: Record<string, ProjectDslInputRef> = {};
    for (const dep of new Set(step.needs ?? [])) wanted[dep] = { from: dep };
    for (const [name, ref] of Object.entries(step.inputs ?? {})) wanted[name] = ref.port === undefined ? { from: ref.from } : { from: ref.from, port: ref.port };
    const intent = step.intent !== undefined && step.intent !== null ? step.intent : typeof step.title === "string" ? step.title : undefined;
    resolved.set(step.id, { step, type, existing, intent, params: buildParams(step), wanted });
  }

  // 依赖存在 / 自依赖 / forEach / pin 边界
  const typeOf = (id: string): string | undefined => resolved.get(id)?.type ?? currentById.get(id)?.type;
  const known = (id: string) => dslIds.has(id) || currentById.has(id);
  const internalDeps = new Map<string, string[]>();
  for (const r of resolved.values()) {
    const sid = r.step.id;
    const deps = new Set<string>();
    for (const [name, ref] of Object.entries(r.wanted)) {
      if (ref.from === sid) fail(sid, "needs", `步骤 ${sid} 依赖了自己（输入口 ${name}）`);
      else if (!known(ref.from)) fail(sid, "needs", `步骤 ${sid} 的输入 ${name} 引用了不存在的节点 ${ref.from}；DSL 内步骤：${[...dslIds].join(", ")}`, "先补一个该 id 的步骤，或改引用工程里已有的节点");
      else if (dslIds.has(ref.from)) deps.add(ref.from);
    }
    const fe = r.step.forEach;
    if (fe) {
      if (fe.over === sid) fail(sid, "forEach", `步骤 ${sid} 的 forEach.over 不能是自己`);
      else if (!known(fe.over)) fail(sid, "forEach", `步骤 ${sid} 的 forEach.over 引用了不存在的节点 ${fe.over}`);
      else {
        if (typeOf(fe.over) !== "shotlist") fail(sid, "forEach", `步骤 ${sid} 的 forEach.over=${fe.over} 类型为 ${typeOf(fe.over)}；forEach 只能遍历 shotlist`);
        const overStep = resolved.get(fe.over);
        const overFe = overStep ? (overStep.step.forEach === undefined ? overStep.existing?.forEach : overStep.step.forEach) : currentById.get(fe.over)?.forEach;
        if (overFe) fail(sid, "forEach", `步骤 ${sid} 的 forEach.over=${fe.over} 本身也是 forEach 节点；v1 只允许单层扇出`);
        if (dslIds.has(fe.over)) deps.add(fe.over);
      }
    }
    if (pinRequested(r.step.pinned) && (fe || r.type === "export" || r.type === "qc")) {
      fail(sid, "pinned", `步骤 ${sid} 不可钉住（export、qc、forEach 模板节点本体不可 pin）`);
    }
    internalDeps.set(sid, [...deps]);
  }
  if (errors.length > 0) return { ok: false, errors, ops: [] };

  // Kahn 拓扑（每轮按 DSL 原序扫描，同输入同顺序）；只排 DSL 内部依赖，指向工程已有节点的依赖视为已满足。
  const done = new Set<string>();
  const order: Resolved[] = [];
  let progress = true;
  while (order.length < steps.length && progress) {
    progress = false;
    for (const s of steps) {
      if (done.has(s.id)) continue;
      if ((internalDeps.get(s.id) ?? []).every((d) => done.has(d))) {
        done.add(s.id);
        order.push(resolved.get(s.id)!);
        progress = true;
      }
    }
  }
  if (order.length < steps.length) {
    const left = steps.map((s) => s.id).filter((id) => !done.has(id));
    return { ok: false, ops: [], errors: [{ step: left[0], field: "needs", message: `步骤 ${left.join("、")} 形成循环依赖（或被循环阻塞）；移除环中一条 needs/inputs/forEach 依赖`, hint: "先修环" }] };
  }

  // ── 发射
  const nodeOps: PatchOp[] = [];
  const connectOps: PatchOp[] = [];
  const pinOps: PatchOp[] = [];
  const warnings: string[] = [];
  const lockedDropped: NodeId[] = [];
  let added = 0;
  let updated = 0;
  let connected = 0;
  let pinned = 0;

  for (const r of order) {
    const { step, existing } = r;

    if (!existing) {
      const node: NewNode = { id: step.id, type: r.type as NodeType };
      if (r.intent !== undefined) node.intent = r.intent;
      if (Object.keys(r.params).length > 0) node.params = r.params;
      if (step.refs) node.refs = step.refs as FileRef[];
      if (step.forEach) node.forEach = step.forEach as ForEach;
      if (step.takes) node.takes = step.takes as TakesSpec;
      if (step.onFail) node.onFail = step.onFail as OnFail;
      nodeOps.push({ op: "add_node", node });
      added++;
      if (pinRequested(step.pinned)) warnings.push(`步骤 ${step.id} 是新增节点，还没有产物可钉住，pinned 已忽略`);
    } else {
      // 候选 set：只收与现值有差异的（幂等）。null = 清除。
      const cands: { path: string; value: Json }[] = [];
      const differs = (cur: unknown, want: unknown) => (want === null ? cur !== undefined && cur !== null : !same(cur, want));
      if (r.intent !== undefined && differs(existing.intent, r.intent)) cands.push({ path: "intent", value: r.intent });
      for (const [k, v] of Object.entries(r.params)) if (differs(existing.params?.[k], v)) cands.push({ path: `params.${k}`, value: v });
      for (const key of ["takes", "onFail", "forEach", "refs"] as const) {
        const want = step[key];
        if (want !== undefined && differs(existing[key], want)) cands.push({ path: key, value: want as Json });
      }
      const lf = lockedFieldsOf(existing);
      const droppedPaths: string[] = [];
      let setCount = 0;
      for (const c of cands) {
        if (pathLocked(lf, c.path)) {
          droppedPaths.push(c.path);
          continue;
        }
        nodeOps.push({ op: "set", node: step.id, path: c.path, value: c.value });
        setCount++;
      }
      if (setCount > 0) updated++;
      if (droppedPaths.length > 0) {
        lockedDropped.push(step.id);
        warnings.push(`lockedDropped: 步骤 ${step.id} 的工程节点已锁定，DSL 对其 ${droppedPaths.join("、")} 的改动未生效`);
      }
    }

    // 连线：已有同口同源 → 跳过；口被占且不同 → 先 disconnect 再 connect（不依赖引擎的覆盖语义）。
    for (const [name, ref] of Object.entries(r.wanted)) {
      const cur = existing?.inputs?.[name];
      if (cur && cur.from === ref.from && cur.port === ref.port) continue;
      if (cur) connectOps.push({ op: "disconnect", to: step.id, input: name });
      connectOps.push(ref.port === undefined
        ? { op: "connect", to: step.id, input: name, from: ref.from }
        : { op: "connect", to: step.id, input: name, from: ref.from, port: ref.port });
      connected++;
    }

    // 钉住 / 解钉（pin 不是内容 patch，locked 节点照常处理——与 P0「连线不受锁影响」同理）。
    if (existing) {
      const curPin = existing.pinned;
      const curPinned = curPin === true || (typeof curPin === "object" && curPin !== null);
      const want = step.pinned;
      if (want === false) {
        if (curPinned) { pinOps.push({ op: "unpin", node: step.id }); pinned++; }
      } else if (pinRequested(want)) {
        const take = typeof want === "object" && want !== null ? want.take : undefined;
        const reason = typeof want === "object" && want !== null ? want.reason : undefined;
        const curTake = typeof curPin === "object" && curPin !== null ? curPin.take : undefined;
        if (!curPinned || (take !== undefined && take !== curTake)) {
          pinOps.push({ op: "pin", node: step.id, ...(take !== undefined ? { take } : {}), ...(reason !== undefined ? { reason } : {}) });
          pinned++;
        }
      }
    }
  }

  return { ok: true, ops: [...nodeOps, ...connectOps, ...pinOps], summary: { added, updated, connected, pinned, warnings, lockedDropped } };
}
