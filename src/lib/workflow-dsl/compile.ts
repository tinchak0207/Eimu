// workflow-dsl/compile.ts — DSL → 既有 8-op CanvasAgentOp 的纯函式编译器。
//
// 角色（暴君裁定 2026-09-02）：画布图为唯一运行时真相；AI 的笔 = 紧凑宣告式 DSL
// （schema.ts 的 WorkflowDslSource），本档把 DSL 编译成 src/lib/canvas/types.ts
// L239-247 的 CanvasAgentOp（契约真源），交由前端 canvas-reducer-adapter 执行。
//
// 语义要点：
//   1. 校验顺序：schema（schema.ts）→ id 唯一 → needs 引用存在 → Kahn 拓扑（环列成员）
//      → tool ∈ HARNESS_TOOL_IDS。任何 error → ok:false、ops 空；message 一律简体中文
//      且自带修复提示（教学式报错，2026-09-02 暴君追加）。
//   2. 节点 id 确定性：wf- + 两轮不同 seed 的 FNV-1a 32 位杂凑拼 16 hex——同输入永远同 id，
//      幂等重套用根绝二次建号竞态（记忆 2026-08-31-workflow-start-idempotent-p0）。
//   3. 一律不带 position/width/height：座标留 (0,0) 交 reducer nextPosition
//      （src/lib/canvas/layout.ts 头注、src/lib/canvas/reducer.ts upsertNode）。
//   4. 增量发射：id 已存在 → update_node（patch 禁含 position/width/height/moved，
//      人拖位置自动保留）；不存在 → add_node。连线合并成一条 connect_nodes，
//      且全部 add_node 在前、connect_nodes 在后。
//   5. v0 不删节点：DSL 移除的步骤只进 summary.warnings。
//   6. 对 DSL 编译产物 decompile（decompile.ts）后再 compile → 全部 update_node、
//      零新增连线（round-trip 幂等）。

import {
  CanvasNodeType,
  type CanvasAgentOp,
  type CanvasConnection,
  type CanvasNode,
  type CanvasNodeMetadata,
} from "../canvas/types";
import { HARNESS_TOOL_ID_LIST, HARNESS_TOOL_IDS } from "../harness-tool-registry";
import {
  validateWorkflowDsl,
  type WorkflowDslSource,
  type WorkflowDslStep,
  type WorkflowValidationIssue,
} from "./schema";

// WorkflowValidationIssue 的权威定义在 schema.ts（compile/decompile 共用），此处按契约再导出。
export type { WorkflowValidationIssue } from "./schema";

/** 编译输入 = 画布当前真相（仅读，不修改）。 */
export interface WorkflowCompileInput {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
}

export type WorkflowCompileResult =
  | { ok: true; ops: CanvasAgentOp[]; summary: { added: number; updated: number; connected: number; warnings: string[] } }
  | { ok: false; errors: WorkflowValidationIssue[]; ops: [] };

/**
 * DSL 节点 metadata：CanvasNodeMetadata 白名单栏位 + workflow 运行期键
 * （workflow_ns/stepId/gate）+ meta 透传剩余键。workflow_ns/stepId 为
 * decompile 反推的依据；gate 为门禁步标记。型别上借 Record<string, unknown>
 * 承载白名单之外的键，不改 types.ts。
 */
export type WorkflowNodeMetadata = Partial<CanvasNodeMetadata> & Record<string, unknown>;

// ─────────────────────────── 确定性节点 id（FNV-1a 32，两轮不同 seed 拼 16 hex）

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** 黄金比例常数：第二轮杂凑的 seed 异扰，防两轮同串碰撞。 */
const SECOND_ROUND_SEED = 0x9e3779b9;

function fnv1a32(seed: number, input: string): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function toHex8(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/** wf-${h1.hex}${h2.hex}（wf- + 16 hex）。同输入永远同 id。 */
export function workflowNodeId(workflow: string, stepId: string): string {
  const key = `${workflow}/${stepId}`;
  const h1 = fnv1a32(FNV_OFFSET_BASIS, key);
  const h2 = fnv1a32(FNV_OFFSET_BASIS ^ SECOND_ROUND_SEED, key);
  return `wf-${toHex8(h1)}${toHex8(h2)}`;
}

// ─────────────────────────── DSL kind → CanvasNodeType

function kindToNodeType(kind: WorkflowDslStep["kind"]): CanvasNodeType {
  switch (kind) {
    case "text":
      return CanvasNodeType.Text;
    case "video":
      return CanvasNodeType.Video;
    case "audio":
      return CanvasNodeType.Audio;
    case "director":
      // director 步 = 3D 白模预演（2026-09-03），铺导演台节点；metadata.kind 仍不设
      // （既有契约只承载 image/video），节点型别即导演语义。
      return CanvasNodeType.Director;
    case "image":
    case undefined:
      return CanvasNodeType.Image;
  }
}

function isPresent<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

/** 步骤 metadata 白名单组装（对齐 src/lib/canvas/types.ts CanvasNodeMetadata 既有栏位名）。 */
function buildStepMetadata(source: WorkflowDslSource, step: WorkflowDslStep, stepIndex: number): WorkflowNodeMetadata {
  const md: WorkflowNodeMetadata = {};
  if (isPresent(step.prompt)) {
    md.prompt = step.prompt;
    // text 步另设 content=prompt（CanvasNodeMetadata.content：文本节点正文）。
    if (step.kind === "text") md.content = step.prompt;
  }
  // metadata.kind 既有契约只承载 "image" | "video"；text/audio 由节点 type 表达。
  const mdKind = step.kind === undefined || step.kind === "image" ? "image" : step.kind === "video" ? "video" : undefined;
  if (mdKind !== undefined) md.kind = mdKind;
  if (isPresent(step.model)) md.model = step.model;
  if (isPresent(step.size)) md.size = step.size;
  if (isPresent(step.count)) md.count = step.count;
  if (step.gate === true) md.gate = true;
  if (isPresent(step.tool)) md.toolId = step.tool;
  md.workflow_id = source.workflow;
  md.workflow_ns = source.workflow;
  md.stepId = step.id;
  md.stepIndex = stepIndex; // 拓扑序（1 起）
  md.status = "idle";
  if (isPresent(step.meta)) {
    for (const [key, value] of Object.entries(step.meta)) {
      if (key === "_origin_node_id") continue; // decompile 运输键：只供收编匹配，不写入产物节点 metadata
      md[key] = value; // meta 透传
    }
  }
  return md;
}

// ─────────────────────────── 编译期校验（schema 之后的跨步骤语义）

/**
 * 校验顺序：id 唯一 → needs 引用存在 → Kahn 拓扑 → tool 成员。
 * 通过时附带确定性拓扑序（每轮按 DSL 原始顺序扫描，同输入同 stepIndex）。
 */
function validateGraph(steps: WorkflowDslStep[]): { errors: WorkflowValidationIssue[]; topoOrder: WorkflowDslStep[] | null } {
  const errors: WorkflowValidationIssue[] = [];
  const idSet = new Set(steps.map((s) => s.id));
  const allIds = steps.map((s) => s.id).join(", ");

  // id 唯一（撞号时 needs/拓扑不可信，先返回）
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      errors.push({
        step: step.id,
        field: "id",
        message: `步骤 id "${step.id}" 重复；同档内步骤 id 必须唯一，把重名的改成 keyframe_01 / keyframe_02 这类递增名`,
        hint: "改掉重复的 id",
      });
    }
    seen.add(step.id);
  }
  if (errors.length > 0) return { errors, topoOrder: null };

  // needs 引用存在（引用残缺时拓扑不可信）
  for (const step of steps) {
    for (const dep of new Set(step.needs ?? [])) {
      if (!idSet.has(dep)) {
        errors.push({
          step: step.id,
          field: "needs",
          message: `步骤 ${step.id} 的 needs 引用了不存在的步骤 ${dep}；本档现有步骤：${allIds}`,
          hint: "从上面清单里选，或先补一个该 id 的步骤",
        });
      }
    }
  }
  if (errors.length > 0) return { errors, topoOrder: null };

  // _origin_node_id 同档唯一（复制粘贴步骤忘改该键时，两个步骤会抢同一个画布节点：
  // 后写者覆盖前者的 title/stepId，且 needs 若互指同一节点会发出自环连线——静默图损坏）
  const originOwner = new Map<string, string>();
  for (const step of steps) {
    const origin = typeof step.meta?._origin_node_id === "string" ? step.meta._origin_node_id : "";
    if (origin.length === 0) continue;
    const owner = originOwner.get(origin);
    if (owner !== undefined) {
      errors.push({
        step: step.id,
        field: "meta._origin_node_id",
        message: `步骤 ${step.id} 与步骤 ${owner} 的 meta._origin_node_id 都是 "${origin}"，两个步骤抢同一个画布节点 ⇒ 编译会把两者写进同一节点并产生自环连线（后写者覆盖前者）；把本步的 _origin_node_id 改成一个专属节点 id，或直接删掉该键让它新增平行节点`,
        hint: "该键是 canvas_get_state 的 dsl 原样带回的来源节点 id；复制步骤时必须一并改掉，不可两步骤共用",
      });
    } else {
      originOwner.set(origin, step.id);
    }
  }
  if (errors.length > 0) return { errors, topoOrder: null };

  // Kahn 拓扑（环是根因，先修环再谈 tool，故有环时不再并行回报 tool 错）
  const needsMap = new Map<string, string[]>();
  for (const step of steps) needsMap.set(step.id, [...new Set(step.needs ?? [])]);
  const satisfied = new Set<string>();
  const topoOrder: WorkflowDslStep[] = [];
  let progress = true;
  while (topoOrder.length < steps.length && progress) {
    progress = false;
    for (const step of steps) {
      if (satisfied.has(step.id)) continue;
      if ((needsMap.get(step.id) ?? []).every((d) => satisfied.has(d))) {
        satisfied.add(step.id);
        topoOrder.push(step);
        progress = true;
      }
    }
  }
  if (topoOrder.length < steps.length) {
    const leftover = steps.map((s) => s.id).filter((id) => !satisfied.has(id));
    errors.push(...cycleErrors(leftover, needsMap));
    return { errors, topoOrder: null };
  }

  // tool ∈ HARNESS_TOOL_IDS
  for (const step of steps) {
    if (!isPresent(step.tool)) continue;
    if (!HARNESS_TOOL_IDS.has(step.tool)) {
      errors.push({
        step: step.id,
        field: "tool",
        message: `步骤 ${step.id} 的 tool "${step.tool}" 不在 harness 工具清单中；相近的合法 id：${suggestTools(step.tool).join("、")}（或去掉 tool 字段改为纯提示步骤）`,
        hint: "换成清单里的 id，如 image_generate",
      });
    }
  }
  return { errors, topoOrder };
}

/** 环成员与被环阻塞步骤分开归因：真环给破环建议，被阻塞步骤指向先修环。 */
function cycleErrors(leftover: string[], needsMap: Map<string, string[]>): WorkflowValidationIssue[] {
  const errors: WorkflowValidationIssue[] = [];
  const remaining = new Set(leftover);
  while (remaining.size > 0) {
    // 剥掉「无环内依赖」的纯被阻塞步骤，剩下的才是真环成员。
    let peeled = true;
    while (peeled) {
      peeled = false;
      for (const id of [...remaining]) {
        const unmet = (needsMap.get(id) ?? []).filter((d) => remaining.has(d));
        if (unmet.length === 0) {
          errors.push({
            step: id,
            field: "needs",
            message: `步骤 ${id} 被上游循环依赖阻塞；先解除环（把环中一方的 needs 移除）后本步即可成链`,
            hint: "先修上游的环",
          });
          remaining.delete(id);
          peeled = true;
        }
      }
    }
    if (remaining.size === 0) break;
    const cycle = findCyclePath([...remaining], needsMap);
    if (cycle.length === 0) break; // 防御：不可达
    errors.push({
      step: cycle[0],
      field: "needs",
      message: `依赖链 ${cycle.join(" → ")} 形成循环依赖；把其中一方的 needs 移除即可成链`,
      hint: "移除环中一条 needs 依赖",
    });
    for (const id of cycle) remaining.delete(id);
  }
  return errors;
}

/** 在剩余节点里沿 needs 反向走，取一条闭合环路（首尾相接，如 [a, b, a]）。 */
function findCyclePath(remaining: string[], needsMap: Map<string, string[]>): string[] {
  const remainingSet = new Set(remaining);
  const start = remaining[0];
  if (start === undefined) return [];
  const seenAt = new Map<string, number>();
  const walk: string[] = [];
  let cur: string = start;
  while (!seenAt.has(cur)) {
    seenAt.set(cur, walk.length);
    walk.push(cur);
    const unmet = (needsMap.get(cur) ?? []).filter((d) => remainingSet.has(d));
    const next = unmet[0];
    if (next === undefined) return []; // 剩余节点全是被阻塞者，非真环（上层已剥除，理论不可达）
    cur = next;
  }
  const startAt = seenAt.get(cur) ?? 0;
  return [...walk.slice(startAt), cur];
}

// ─────────────────────────── 工具 id 建议（教学式报错）

/** 工具 id 建议 fallback：皆为 HARNESS_TOOL_ID_LIST 实际成员（由 workflow-dsl.test.ts 用真 registry 把关）。 */
const COMMON_TOOL_SUGGESTIONS: string[] = ["image_generate", "image_edit", "canvas_generate_image"];

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** 前缀命中优先，其次编辑距离最近的 1-3 个；都不沾边给常用生成类 fallback。 */
function suggestTools(input: string): string[] {
  const prefix = HARNESS_TOOL_ID_LIST.filter((id) => id.startsWith(input)).slice(0, 3);
  const scored = HARNESS_TOOL_ID_LIST.map((id) => ({ id, d: levenshtein(input, id) })).sort((x, y) => x.d - y.d || x.id.localeCompare(y.id));
  const threshold = Math.max(2, Math.floor(input.length / 3));
  const closest = scored.filter((s) => s.d <= threshold).slice(0, 3).map((s) => s.id);
  const suggestions = [...new Set([...prefix, ...closest])].slice(0, 3);
  return suggestions.length > 0 ? suggestions : COMMON_TOOL_SUGGESTIONS;
}

// ─────────────────────────── 编译主入口

/**
 * 全图校验 → 增量 op 发射（对 current）。任何 error → ok:false、ops 空。
 * current 仅读；呼叫方把 ops 交 canvas_apply_ops / 前端 adapter 执行。
 */
export function compileWorkflow(source: WorkflowDslSource, current: WorkflowCompileInput): WorkflowCompileResult {
  // 1. schema（runtime 形状防御：source 型别上已窄，实际可能是 JSON 反序列化产物）
  const schemaResult = validateWorkflowDsl(source);
  if (!schemaResult.ok) return { ok: false, errors: schemaResult.errors, ops: [] };
  const valid = schemaResult.source;

  // 2-5. id 唯一 → needs 引用 → Kahn 拓扑 → tool 成员
  const graph = validateGraph(valid.steps);
  if (graph.errors.length > 0 || graph.topoOrder === null) return { ok: false, errors: graph.errors, ops: [] };
  const topoOrder = graph.topoOrder;

  const warnings: string[] = [];
  const nodeIds = new Map<string, string>();
  for (const step of topoOrder) nodeIds.set(step.id, workflowNodeId(valid.workflow, step.id));

  const currentById = new Map(current.nodes.map((n) => [n.id, n]));
  const ops: CanvasAgentOp[] = [];
  let added = 0;
  let updated = 0;

  // 增量发射：add_node 在前（拓扑序）
  for (let i = 0; i < topoOrder.length; i++) {
    const step = topoOrder[i];
    const nodeId = nodeIds.get(step.id)!;
    const metadata = buildStepMetadata(valid, step, i + 1);
    const existing = currentById.get(nodeId);
    if (existing) {
      // patch 禁含 position/width/height/moved——人拖位置自动保留（canvas-reducer-adapter update_node 语义）。
      ops.push({ type: "update_node", id: nodeId, patch: { title: step.title, metadata } });
      updated++;
      continue;
    }
    // ③ 收编第三路（decompile 运输键 _origin_node_id，2026-10-08 读面解锁）：画布上存在
    // id 与之精确相等的节点 ⇒ 视为命中走 update_node 收编。匹配优先级：①确定性 id
    // （workflow_ns+stepId 杂凑，上面的 existing）> ②workflow_id 卫生归属（删除语义段）>
    // ③_origin_node_id。buildStepMetadata 无条件写 workflow_ns/stepId/stepIndex ⇒ 存量
    // 节点收编即键回填、从此族3化。nodeIds 覆写为原节点 id ⇒ 连线发射与「已存在连线」
    // 判定都指向画布真节点。同档内 _origin_node_id 的唯一性已由 validateGraph 保证
    // （撞键在编译前即 ok:false），此处不重复校验。
    const originNodeId = typeof step.meta?._origin_node_id === "string" ? step.meta._origin_node_id : undefined;
    if (originNodeId !== undefined && originNodeId.length > 0 && currentById.has(originNodeId)) {
      ops.push({ type: "update_node", id: originNodeId, patch: { title: step.title, metadata } });
      updated++;
      nodeIds.set(step.id, originNodeId);
      continue;
    }
    // 一律不带 position/width/height：座标留 (0,0) 交 reducer nextPosition。
    ops.push({ type: "add_node", node: { id: nodeId, type: kindToNodeType(step.kind), title: step.title, metadata } });
    added++;
  }

  // 连线：needs 边 dep→step；current 已有同 from/to → 跳过；新的合并成一条 connect_nodes（在全部 add_node 之后）。
  const newConnections: { fromNodeId: string; toNodeId: string }[] = [];
  for (const step of topoOrder) {
    const toId = nodeIds.get(step.id)!;
    for (const dep of new Set(step.needs ?? [])) {
      const fromId = nodeIds.get(dep)!;
      const exists = current.connections.some((c) => c.fromNodeId === fromId && c.toNodeId === toId);
      if (!exists) newConnections.push({ fromNodeId: fromId, toNodeId: toId });
    }
  }
  if (newConnections.length > 0) {
    ops.push({ type: "connect_nodes", connections: newConnections });
  }

  // 删除语义：v0 不删节点；DSL 移除的步骤只进 warnings。
  const dslStepIds = new Set(valid.steps.map((s) => s.id));
  const reportedRemoved = new Set<string>();
  for (const node of current.nodes) {
    const md = (node.metadata ?? {}) as WorkflowNodeMetadata;
    const nodeNs = typeof md.workflow_ns === "string" ? md.workflow_ns : undefined;
    const nodeWf = typeof md.workflow_id === "string" ? md.workflow_id : undefined;
    // 属于本工作流的节点：workflow_ns 命中；或无 workflow_ns 但 workflow_id 命中（旧产物卫生归属）。
    const belongs = nodeNs === valid.workflow || (nodeNs === undefined && nodeWf === valid.workflow);
    if (!belongs) continue;
    const stepId = typeof md.stepId === "string" ? md.stepId : undefined;
    if (!isPresent(stepId) || dslStepIds.has(stepId) || reportedRemoved.has(stepId)) continue;
    reportedRemoved.add(stepId);
    warnings.push(`步骤 ${stepId} 已从源码移除，画布节点保留`);
  }

  return { ok: true, ops, summary: { added, updated, connected: newConnections.length, warnings } };
}
