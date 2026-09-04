// workflow-dsl/decompile.ts — 畫布真相 → DSL 源碼的反向讀取器（compileWorkflow 的逆操作）。
//
// 角色（暴君裁定 2026-09-02）：畫布圖為唯一運行時真相；本檔按節點 metadata 的
// workflow 運行期鍵（compile.ts 鋪的 workflow_ns/stepId/stepIndex）把畫布分組反推回
// WorkflowDslSource，供 agent「看圖改源碼」或 round-trip 校驗。
//
// 反推規則：
//   1. 分組鍵 = metadata.workflow_ns；缺 workflow_ns 但有 workflow_id → 衛生化後採用；
//      兩者皆無 → 跳過該節點。缺 metadata.stepId 的節點跳過。
//   2. steps 按 metadata.stepIndex 排序（缺省沉底，按 stepId 定序保證確定性）。
//   3. needs 從組內節點間連線反推（fromNodeId 節點的 stepId 為依賴）。
//   4. model/size/count/prompt/gate/toolId/kind 反向讀出；meta 透傳 = metadata 減去
//      白名單欄位後的剩餘（淺拷貝）。
//   5. 目標：對 DSL 編譯產物 decompile 後再 compile → 全部 update_node、零新增連線
//      （round-trip 冪等，workflow-dsl.test.ts 案⑤把關）。

import { CanvasNodeType, type CanvasConnection, type CanvasNode } from "../canvas/types";
import { WORKFLOW_NS_PATTERN, type WorkflowDslSource, type WorkflowDslStep } from "./schema";
import type { WorkflowNodeMetadata } from "./compile";

/** compile 鋪進 metadata 的白名單欄位（decompile 讀取後從 meta 透傳中扣除）。 */
const METADATA_WHITELIST_KEYS = new Set([
  "prompt",
  "content",
  "kind",
  "model",
  "size",
  "count",
  "gate",
  "toolId",
  "workflow_id",
  "workflow_ns",
  "stepId",
  "stepIndex",
  "status",
]);

/** 衛生化命名空間：小寫、非法字符換 _、首字符非 [a-z] 補 wf_ 前綴、截 48；清完為空回 null（丟棄）。 */
function sanitizeWorkflowNs(raw: string): string | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 48);
  if (cleaned.length === 0) return null;
  if (WORKFLOW_NS_PATTERN.test(cleaned)) return cleaned;
  // 首字符非 [a-z]：補 wf_ 前綴（前綴後仍須 ≤48，故原串截 45）。
  return `wf_${cleaned.slice(0, 45)}`;
}

/** 讀節點 metadata 為寬鬆鍵值（CanvasNodeMetadata 無索引簽名，借 WorkflowNodeMetadata 橋接）。 */
function asLooseMetadata(md: CanvasNode["metadata"]): WorkflowNodeMetadata {
  return (md ?? {}) as WorkflowNodeMetadata;
}

function nodeTypeToKind(type: CanvasNode["type"]): WorkflowDslStep["kind"] {
  switch (type) {
    case CanvasNodeType.Text:
      return "text";
    case CanvasNodeType.Video:
      return "video";
    case CanvasNodeType.Audio:
      return "audio";
    default:
      return "image";
  }
}

interface GroupAccumulator {
  workflow: string;
  /** stepId → 反推中的 step（保插入序，輸出前再按 stepIndex 排序）。 */
  steps: Map<string, WorkflowDslStep & { _stepIndex?: number | null }>;
  /** stepId → 節點 id（連線反推用）。 */
  nodeIds: Map<string, string>;
}

/**
 * 畫布當前真相 → DSL 源碼清單（每個 workflow 命名空間一份）。
 * 只讀 current；非 workflow 產物節點一律跳過，不虛構步驟。
 */
export function decompileWorkflow(current: { nodes: CanvasNode[]; connections: CanvasConnection[] }): WorkflowDslSource[] {
  const groups = new Map<string, GroupAccumulator>();

  for (const node of current.nodes) {
    const md = asLooseMetadata(node.metadata);
    const stepId = typeof md.stepId === "string" && md.stepId.length > 0 ? md.stepId : undefined;
    if (stepId === undefined) continue; // 缺 metadata.stepId 的節點跳過

    let workflow: string | null = null;
    if (typeof md.workflow_ns === "string" && md.workflow_ns.length > 0) {
      workflow = sanitizeWorkflowNs(md.workflow_ns);
    } else if (typeof md.workflow_id === "string" && md.workflow_id.length > 0) {
      workflow = sanitizeWorkflowNs(md.workflow_id); // 缺 workflow_ns 但有 workflow_id → 衛生化後採用
    }
    if (workflow === null) continue; // 兩者皆無 → 跳過該節點

    let group = groups.get(workflow);
    if (!group) {
      group = { workflow, steps: new Map(), nodeIds: new Map() };
      groups.set(workflow, group);
    }
    group.nodeIds.set(stepId, node.id);
    if (!group.steps.has(stepId)) {
      const step: WorkflowDslStep & { _stepIndex?: number | null } = {
        id: stepId,
        title: typeof node.title === "string" && node.title.length > 0 ? node.title : stepId,
        _stepIndex: typeof md.stepIndex === "number" && Number.isFinite(md.stepIndex) ? md.stepIndex : null,
      };
      step.kind = nodeTypeToKind(node.type); // 未知型別退 "image"（同 layout.ts toNodeType 的降級哲學）
      if (typeof md.prompt === "string") step.prompt = md.prompt;
      if (typeof md.model === "string") step.model = md.model;
      if (typeof md.size === "string") step.size = md.size;
      if (typeof md.count === "number") step.count = md.count;
      if (md.gate === true) step.gate = true;
      if (typeof md.toolId === "string") step.tool = md.toolId;
      // meta 透傳 = metadata 減去白名單欄位後的剩餘（淺拷貝）。
      const meta: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(md)) {
        if (!METADATA_WHITELIST_KEYS.has(key)) meta[key] = value;
      }
      if (Object.keys(meta).length > 0) step.meta = meta;
      group.steps.set(stepId, step);
    }
  }

  const sources: WorkflowDslSource[] = [];
  for (const group of groups.values()) {
    // needs 從組內節點間連線反推：from 節點的 stepId 為 to 節點的依賴。
    const ownerIdByNodeId = new Map<string, string>();
    for (const [stepId, nodeId] of group.nodeIds) ownerIdByNodeId.set(nodeId, stepId);
    for (const conn of current.connections) {
      const fromStep = ownerIdByNodeId.get(conn.fromNodeId);
      const toStep = ownerIdByNodeId.get(conn.toNodeId);
      if (!fromStep || !toStep || fromStep === toStep) continue;
      const step = group.steps.get(toStep);
      if (!step) continue;
      if (!step.needs) step.needs = [];
      if (!step.needs.includes(fromStep)) step.needs.push(fromStep);
    }

    // steps 按 stepIndex 排序（缺省沉底，按 stepId 定序保證確定性）。
    const steps = [...group.steps.values()].sort((a, b) => {
      const ia = a._stepIndex ?? Number.POSITIVE_INFINITY;
      const ib = b._stepIndex ?? Number.POSITIVE_INFINITY;
      return ia !== ib ? ia - ib : a.id.localeCompare(b.id);
    });
    for (const step of steps) delete step._stepIndex;

    sources.push({ workflow: group.workflow, steps });
  }
  return sources;
}
