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
//
// 三族收纳规则（2026-10-08 读面解锁，记忆 dsl-adoption-zero-audit：读面死锁根因）：
//   画布上真实存在三族产线节点，仅族3 带 workflow_ns+stepId 真键——本档按族收纳：
//   - 族3（编译器产物，id wf-<16hex>）：workflow_ns+stepId 真键，走上述既有规则。
//   - 族1（gateway 骨架，id 如 single_image-prompt-0）：metadata 无任何身份键，
//     但连线 id 为 wf-<workflowId>-<fromNodeId>-<toNodeId>（workflowId 无连字符）——
//     按「出现在 wf- 前缀连线两端」归属：ns 从连线 id 提取，stepId = node.id 卫生化。
//   - 族2（前端模板卡，id 如 tpl-<ts36>-s<i>-<key>）：带 workflow_id=template.id，
//     生成卡另有 stepIndex——按 workflow_id+stepIndex 收纳（stepId=step_<i>），
//     辅助卡（head/tool/gate 带 pipelineCard 键）刻意排除。
//   每个收纳 step 的 meta 塞运输键 _origin_node_id = node.id，供 compile.ts 收编
//   第三路把 DSL 回写原节点（键回填 workflow_ns/stepId 后存量节点从此族3化）。

import { CanvasNodeType, type CanvasConnection, type CanvasNode } from "../canvas/types";
import { STEP_ID_PATTERN, WORKFLOW_NS_PATTERN, type WorkflowDslSource, type WorkflowDslStep } from "./schema";
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

/**
 * 卫生化 stepId（族1 用：node.id 直接当步骤符号名）：非法字符换 _、首字符非 [a-z]
 * 补 s_ 前缀、截 48，保证过 STEP_ID_PATTERN（^[a-z][a-z0-9_]{0,47}$）；清完为空回 null。
 */
function sanitizeStepId(raw: string): string | null {
  const cleaned = raw.replace(/[^a-z0-9_]+/g, "_").slice(0, 48);
  if (cleaned.length === 0) return null;
  if (STEP_ID_PATTERN.test(cleaned)) return cleaned;
  // 首字符非 [a-z]（数字/_ 开头）：补 s_ 前缀（前缀后仍须 ≤48，故原串截 46）。
  return `s_${cleaned.slice(0, 46)}`;
}

/**
 * 族1 归属索引：node id → 从 wf- 前缀连线 id 提取的 workflowId（连线 id 格式
 * wf-<workflowId>-<fromNodeId>-<toNodeId>，workflowId 无连字符）。同一节点的多条
 * wf- 连线不一致时取数组序第一条；同一条 wf- 连线两端节点取同一 ns。
 */
function buildWfNsByNodeId(connections: CanvasConnection[]): Map<string, string> {
  const wfNsByNodeId = new Map<string, string>();
  for (const conn of connections) {
    if (!conn.id.startsWith("wf-")) continue;
    const rest = conn.id.slice("wf-".length);
    const dash = rest.indexOf("-");
    const rawNs = dash === -1 ? rest : rest.slice(0, dash);
    const ns = sanitizeWorkflowNs(rawNs);
    if (ns === null) continue;
    if (!wfNsByNodeId.has(conn.fromNodeId)) wfNsByNodeId.set(conn.fromNodeId, ns);
    if (!wfNsByNodeId.has(conn.toNodeId)) wfNsByNodeId.set(conn.toNodeId, ns);
  }
  return wfNsByNodeId;
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
  // 族1 归属索引（wf- 前缀连线 → 两端节点的 ns），先于节点扫描建好。
  const wfNsByNodeId = buildWfNsByNodeId(current.connections);

  for (const node of current.nodes) {
    const md = asLooseMetadata(node.metadata);
    const mdStepId = typeof md.stepId === "string" && md.stepId.length > 0 ? md.stepId : undefined;

    let workflow: string | null = null;
    let stepId: string | undefined = mdStepId;
    if (mdStepId !== undefined) {
      // 族3 真键（或已收编回填键）：既有规则不动。
      if (typeof md.workflow_ns === "string" && md.workflow_ns.length > 0) {
        workflow = sanitizeWorkflowNs(md.workflow_ns);
      } else if (typeof md.workflow_id === "string" && md.workflow_id.length > 0) {
        workflow = sanitizeWorkflowNs(md.workflow_id); // 缺 workflow_ns 但有 workflow_id → 卫生化后采用
      }
    } else if (
      typeof md.workflow_id === "string" &&
      md.workflow_id.length > 0 &&
      typeof md.stepIndex === "number" &&
      Number.isFinite(md.stepIndex) &&
      !("pipelineCard" in md)
    ) {
      // 族2 存量（前端模板生成卡）：workflow_id+stepIndex 收纳，辅助卡（pipelineCard）刻意排除。
      workflow = sanitizeWorkflowNs(md.workflow_id);
      stepId = `step_${md.stepIndex}`;
    } else if (wfNsByNodeId.has(node.id)) {
      // 族1 存量（gateway 骨架）：出现在 wf- 前缀连线两端 → 按连线归属，node.id 卫生化为 stepId。
      workflow = wfNsByNodeId.get(node.id)!;
      stepId = sanitizeStepId(node.id) ?? undefined;
    }
    if (workflow === null || stepId === undefined) continue; // 无任何族归属 → 跳过该节点

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
      else if (step.kind === "text" && typeof md.content === "string") step.prompt = md.content; // 族1 prompt 兜底：text 类节点正文当提示词
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
      // 运输键：每个收纳 step 一律携带原节点 id，供 compile.ts 收编第三路回写原节点
      // （此键刻意不进 METADATA_WHITELIST_KEYS——编译侧负责扣下不写入产物 metadata）。
      meta._origin_node_id = node.id;
      step.meta = meta;
      group.steps.set(stepId, step);
    }
  }

  const sources: WorkflowDslSource[] = [];
  // 全图连线 → 每节点上游清单（needs 传导用，桥接辅助卡不在组内但连线仍可穿）。
  const upstreamByNodeId = new Map<string, string[]>();
  for (const conn of current.connections) {
    const list = upstreamByNodeId.get(conn.toNodeId);
    if (list) list.push(conn.fromNodeId);
    else upstreamByNodeId.set(conn.toNodeId, [conn.fromNodeId]);
  }
  for (const group of groups.values()) {
    // needs 从组内节点间连线反推（上游传导版）：直接 from 节点是同组 step ⇒ 取其 stepId
    // 为依赖（既有行为）；from 节点无 stepId（辅助卡桥接）⇒ 沿连线继续向上游走，直到撞见
    // 同组 step 节点为止。BFS 深度上限 8、visited 防环；找不到就不加 needs。
    const ownerIdByNodeId = new Map<string, string>();
    for (const [stepId, nodeId] of group.nodeIds) ownerIdByNodeId.set(nodeId, stepId);
    for (const [stepId, nodeId] of group.nodeIds) {
      const step = group.steps.get(stepId);
      if (!step) continue;
      const deps: string[] = [];
      const visited = new Set<string>([nodeId]);
      let frontier = (upstreamByNodeId.get(nodeId) ?? []).slice();
      for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
        const next: string[] = [];
        for (const upId of frontier) {
          if (visited.has(upId)) continue;
          visited.add(upId);
          const owner = ownerIdByNodeId.get(upId);
          if (owner !== undefined) {
            if (owner !== stepId && !deps.includes(owner)) deps.push(owner);
            continue; // step 节点是依赖终点，不再穿过它继续上游
          }
          next.push(...(upstreamByNodeId.get(upId) ?? [])); // 桥接节点：继续向上游传导
        }
        frontier = next;
      }
      if (deps.length > 0) step.needs = deps;
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
