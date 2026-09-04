// workflow-dsl/compile.ts — DSL → 既有 8-op CanvasAgentOp 的純函式編譯器。
//
// 角色（暴君裁定 2026-09-02）：畫布圖為唯一運行時真相；AI 的筆 = 緊湊宣告式 DSL
// （schema.ts 的 WorkflowDslSource），本檔把 DSL 編譯成 src/lib/canvas/types.ts
// L239-247 的 CanvasAgentOp（契約真源），交由前端 canvas-reducer-adapter 執行。
//
// 語義要點：
//   1. 校驗順序：schema（schema.ts）→ id 唯一 → needs 引用存在 → Kahn 拓撲（環列成員）
//      → tool ∈ HARNESS_TOOL_IDS。任何 error → ok:false、ops 空；message 一律簡體中文
//      且自帶修復提示（教學式報錯，2026-09-02 暴君追加）。
//   2. 節點 id 確定性：wf- + 兩輪不同 seed 的 FNV-1a 32 位雜湊拼 16 hex——同輸入永遠同 id，
//      冪等重套用根絕二次建號競態（記憶 2026-08-31-workflow-start-idempotent-p0）。
//   3. 一律不帶 position/width/height：座標留 (0,0) 交 reducer nextPosition
//      （src/lib/canvas/layout.ts 頭註、src/lib/canvas/reducer.ts upsertNode）。
//   4. 增量發射：id 已存在 → update_node（patch 禁含 position/width/height/moved，
//      人拖位置自動保留）；不存在 → add_node。連線合併成一條 connect_nodes，
//      且全部 add_node 在前、connect_nodes 在後。
//   5. v0 不刪節點：DSL 移除的步驟只進 summary.warnings。
//   6. 對 DSL 編譯產物 decompile（decompile.ts）後再 compile → 全部 update_node、
//      零新增連線（round-trip 冪等）。

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

// WorkflowValidationIssue 的權威定義在 schema.ts（compile/decompile 共用），此處按契約再導出。
export type { WorkflowValidationIssue } from "./schema";

/** 編譯輸入 = 畫布當前真相（僅讀，不修改）。 */
export interface WorkflowCompileInput {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
}

export type WorkflowCompileResult =
  | { ok: true; ops: CanvasAgentOp[]; summary: { added: number; updated: number; connected: number; warnings: string[] } }
  | { ok: false; errors: WorkflowValidationIssue[]; ops: [] };

/**
 * DSL 節點 metadata：CanvasNodeMetadata 白名單欄位 + workflow 運行期鍵
 * （workflow_ns/stepId/gate）+ meta 透傳剩餘鍵。workflow_ns/stepId 為
 * decompile 反推的依據；gate 為門禁步標記。型別上借 Record<string, unknown>
 * 承載白名單之外的鍵，不改 types.ts。
 */
export type WorkflowNodeMetadata = Partial<CanvasNodeMetadata> & Record<string, unknown>;

// ─────────────────────────── 確定性節點 id（FNV-1a 32，兩輪不同 seed 拼 16 hex）

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** 黃金比例常數：第二輪雜湊的 seed 異擾，防兩輪同串碰撞。 */
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

/** wf-${h1.hex}${h2.hex}（wf- + 16 hex）。同輸入永遠同 id。 */
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
      // director 步 = 3D 白模预演（2026-09-03），鋪導演台節點；metadata.kind 仍不設
      // （既有契約只承載 image/video），節點型別即導演語義。
      return CanvasNodeType.Director;
    case "image":
    case undefined:
      return CanvasNodeType.Image;
  }
}

function isPresent<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

/** 步驟 metadata 白名單組裝（對齊 src/lib/canvas/types.ts CanvasNodeMetadata 既有欄位名）。 */
function buildStepMetadata(source: WorkflowDslSource, step: WorkflowDslStep, stepIndex: number): WorkflowNodeMetadata {
  const md: WorkflowNodeMetadata = {};
  if (isPresent(step.prompt)) {
    md.prompt = step.prompt;
    // text 步另設 content=prompt（CanvasNodeMetadata.content：文本節點正文）。
    if (step.kind === "text") md.content = step.prompt;
  }
  // metadata.kind 既有契約只承載 "image" | "video"；text/audio 由節點 type 表達。
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
  md.stepIndex = stepIndex; // 拓撲序（1 起）
  md.status = "idle";
  if (isPresent(step.meta)) {
    for (const [key, value] of Object.entries(step.meta)) md[key] = value; // meta 透傳
  }
  return md;
}

// ─────────────────────────── 編譯期校驗（schema 之後的跨步驟語義）

/**
 * 校驗順序：id 唯一 → needs 引用存在 → Kahn 拓撲 → tool 成員。
 * 通過時附帶確定性拓撲序（每輪按 DSL 原始順序掃描，同輸入同 stepIndex）。
 */
function validateGraph(steps: WorkflowDslStep[]): { errors: WorkflowValidationIssue[]; topoOrder: WorkflowDslStep[] | null } {
  const errors: WorkflowValidationIssue[] = [];
  const idSet = new Set(steps.map((s) => s.id));
  const allIds = steps.map((s) => s.id).join(", ");

  // id 唯一（撞號時 needs/拓撲不可信，先返回）
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

  // needs 引用存在（引用殘缺時拓撲不可信）
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

  // Kahn 拓撲（環是根因，先修環再談 tool，故有環時不再並行回報 tool 錯）
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

/** 環成員與被環阻塞步驟分開歸因：真環給破環建議，被阻塞步驟指向先修環。 */
function cycleErrors(leftover: string[], needsMap: Map<string, string[]>): WorkflowValidationIssue[] {
  const errors: WorkflowValidationIssue[] = [];
  const remaining = new Set(leftover);
  while (remaining.size > 0) {
    // 剝掉「無環內依賴」的純被阻塞步驟，剩下的才是真環成員。
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
    if (cycle.length === 0) break; // 防禦：不可達
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

/** 在剩餘節點裡沿 needs 反向走，取一條閉合環路（首尾相接，如 [a, b, a]）。 */
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
    if (next === undefined) return []; // 剩餘節點全是被阻塞者，非真環（上層已剝除，理論不可達）
    cur = next;
  }
  const startAt = seenAt.get(cur) ?? 0;
  return [...walk.slice(startAt), cur];
}

// ─────────────────────────── 工具 id 建議（教學式報錯）

/** 工具 id 建議 fallback：皆為 HARNESS_TOOL_ID_LIST 實際成員（由 workflow-dsl.test.ts 用真 registry 把關）。 */
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

/** 前綴命中優先，其次編輯距離最近的 1-3 個；都不沾邊給常用生成類 fallback。 */
function suggestTools(input: string): string[] {
  const prefix = HARNESS_TOOL_ID_LIST.filter((id) => id.startsWith(input)).slice(0, 3);
  const scored = HARNESS_TOOL_ID_LIST.map((id) => ({ id, d: levenshtein(input, id) })).sort((x, y) => x.d - y.d || x.id.localeCompare(y.id));
  const threshold = Math.max(2, Math.floor(input.length / 3));
  const closest = scored.filter((s) => s.d <= threshold).slice(0, 3).map((s) => s.id);
  const suggestions = [...new Set([...prefix, ...closest])].slice(0, 3);
  return suggestions.length > 0 ? suggestions : COMMON_TOOL_SUGGESTIONS;
}

// ─────────────────────────── 編譯主入口

/**
 * 全圖校驗 → 增量 op 發射（對 current）。任何 error → ok:false、ops 空。
 * current 僅讀；呼叫方把 ops 交 canvas_apply_ops / 前端 adapter 執行。
 */
export function compileWorkflow(source: WorkflowDslSource, current: WorkflowCompileInput): WorkflowCompileResult {
  // 1. schema（runtime 形狀防禦：source 型別上已窄，實際可能是 JSON 反序列化產物）
  const schemaResult = validateWorkflowDsl(source);
  if (!schemaResult.ok) return { ok: false, errors: schemaResult.errors, ops: [] };
  const valid = schemaResult.source;

  // 2-5. id 唯一 → needs 引用 → Kahn 拓撲 → tool 成員
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

  // 增量發射：add_node 在前（拓撲序）
  for (let i = 0; i < topoOrder.length; i++) {
    const step = topoOrder[i];
    const nodeId = nodeIds.get(step.id)!;
    const metadata = buildStepMetadata(valid, step, i + 1);
    const existing = currentById.get(nodeId);
    if (existing) {
      // patch 禁含 position/width/height/moved——人拖位置自動保留（canvas-reducer-adapter update_node 語義）。
      ops.push({ type: "update_node", id: nodeId, patch: { title: step.title, metadata } });
      updated++;
    } else {
      // 一律不帶 position/width/height：座標留 (0,0) 交 reducer nextPosition。
      ops.push({ type: "add_node", node: { id: nodeId, type: kindToNodeType(step.kind), title: step.title, metadata } });
      added++;
    }
  }

  // 連線：needs 邊 dep→step；current 已有同 from/to → 跳過；新的合併成一條 connect_nodes（在全部 add_node 之後）。
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

  // 刪除語義：v0 不刪節點；DSL 移除的步驟只進 warnings。
  const dslStepIds = new Set(valid.steps.map((s) => s.id));
  const reportedRemoved = new Set<string>();
  for (const node of current.nodes) {
    const md = (node.metadata ?? {}) as WorkflowNodeMetadata;
    const nodeNs = typeof md.workflow_ns === "string" ? md.workflow_ns : undefined;
    const nodeWf = typeof md.workflow_id === "string" ? md.workflow_id : undefined;
    // 屬於本工作流的節點：workflow_ns 命中；或無 workflow_ns 但 workflow_id 命中（舊產物衛生歸屬）。
    const belongs = nodeNs === valid.workflow || (nodeNs === undefined && nodeWf === valid.workflow);
    if (!belongs) continue;
    const stepId = typeof md.stepId === "string" ? md.stepId : undefined;
    if (!isPresent(stepId) || dslStepIds.has(stepId) || reportedRemoved.has(stepId)) continue;
    reportedRemoved.add(stepId);
    warnings.push(`步骤 ${stepId} 已从源码移除，画布节点保留`);
  }

  return { ok: true, ops, summary: { added, updated, connected: newConnections.length, warnings } };
}
