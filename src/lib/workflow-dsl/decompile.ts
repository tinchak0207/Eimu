// workflow-dsl/decompile.ts — 画布真相 → DSL 源码的反向读取器（compileWorkflow 的逆操作）。
//
// 角色（暴君裁定 2026-09-02）：画布图为唯一运行时真相；本档按节点 metadata 的
// workflow 运行期键（compile.ts 铺的 workflow_ns/stepId/stepIndex）把画布分组反推回
// WorkflowDslSource，供 agent「看图改源码」或 round-trip 校验。
//
// 反推规则：
//   1. 分组键 = metadata.workflow_ns；缺 workflow_ns 但有 workflow_id → 卫生化后采用；
//      两者皆无 → 跳过该节点。缺 metadata.stepId 的节点跳过。
//   2. steps 按 metadata.stepIndex 排序（缺省沉底，按 stepId 定序保证确定性）。
//   3. needs 从组内节点间连线反推（fromNodeId 节点的 stepId 为依赖）。
//   4. model/size/count/prompt/gate/toolId/kind 反向读出；meta 透传 = metadata 减去
//      白名单栏位后的剩余（浅拷贝）。
//   5. 目标：对 DSL 编译产物 decompile 后再 compile → 全部 update_node、零新增连线
//      （round-trip 幂等，workflow-dsl.test.ts 案⑤把关）。

import { CanvasNodeType, type CanvasConnection, type CanvasNode } from "../canvas/types";
import { WORKFLOW_NS_PATTERN, type WorkflowDslSource, type WorkflowDslStep } from "./schema";
import type { WorkflowNodeMetadata } from "./compile";

/** compile 铺进 metadata 的白名单栏位（decompile 读取后从 meta 透传中扣除）。 */
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

/** 卫生化命名空间：小写、非法字符换 _、首字符非 [a-z] 补 wf_ 前缀、截 48；清完为空回 null（丢弃）。 */
function sanitizeWorkflowNs(raw: string): string | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 48);
  if (cleaned.length === 0) return null;
  if (WORKFLOW_NS_PATTERN.test(cleaned)) return cleaned;
  // 首字符非 [a-z]：补 wf_ 前缀（前缀后仍须 ≤48，故原串截 45）。
  return `wf_${cleaned.slice(0, 45)}`;
}

/** 读节点 metadata 为宽松键值（CanvasNodeMetadata 无索引签名，借 WorkflowNodeMetadata 桥接）。 */
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
  /** stepId → 反推中的 step（保插入序，输出前再按 stepIndex 排序）。 */
  steps: Map<string, WorkflowDslStep & { _stepIndex?: number | null }>;
  /** stepId → 节点 id（连线反推用）。 */
  nodeIds: Map<string, string>;
}

/**
 * 画布当前真相 → DSL 源码清单（每个 workflow 命名空间一份）。
 * 只读 current；非 workflow 产物节点一律跳过，不虚构步骤。
 */
export function decompileWorkflow(current: { nodes: CanvasNode[]; connections: CanvasConnection[] }): WorkflowDslSource[] {
  const groups = new Map<string, GroupAccumulator>();

  for (const node of current.nodes) {
    const md = asLooseMetadata(node.metadata);
    const stepId = typeof md.stepId === "string" && md.stepId.length > 0 ? md.stepId : undefined;
    if (stepId === undefined) continue; // 缺 metadata.stepId 的节点跳过

    let workflow: string | null = null;
    if (typeof md.workflow_ns === "string" && md.workflow_ns.length > 0) {
      workflow = sanitizeWorkflowNs(md.workflow_ns);
    } else if (typeof md.workflow_id === "string" && md.workflow_id.length > 0) {
      workflow = sanitizeWorkflowNs(md.workflow_id); // 缺 workflow_ns 但有 workflow_id → 卫生化后采用
    }
    if (workflow === null) continue; // 两者皆无 → 跳过该节点

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
      step.kind = nodeTypeToKind(node.type); // 未知型别退 "image"（同 layout.ts toNodeType 的降级哲学）
      if (typeof md.prompt === "string") step.prompt = md.prompt;
      if (typeof md.model === "string") step.model = md.model;
      if (typeof md.size === "string") step.size = md.size;
      if (typeof md.count === "number") step.count = md.count;
      if (md.gate === true) step.gate = true;
      if (typeof md.toolId === "string") step.tool = md.toolId;
      // meta 透传 = metadata 减去白名单栏位后的剩余（浅拷贝）。
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
    // needs 从组内节点间连线反推：from 节点的 stepId 为 to 节点的依赖。
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

    // steps 按 stepIndex 排序（缺省沉底，按 stepId 定序保证确定性）。
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
