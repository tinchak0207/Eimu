// 画布 → agent 快照载荷的唯一建构子（2026-10-03，人机共笔「图＝声明的可逆表达」落地）。
//
// 背景：报告第四章的范式主张是「智能体读回 DSL → 像改代码一样改 → 编译原子落图」。
// 但上行快照（唯一喂给 agent 的眼睛）过去只带 nodes/connections 的**压缩白名单**
// metadata——`compactMetadataForAgent` 会剥掉 workflow_ns/stepId/gate 等 DSL 运行期键，
// 于是 agent 读不到「自己刚编译出的那张图」的声明形态＝读改链路单边断。
//
// 本档把「上行载荷」抽成纯函式：节点仍走既有压缩白名单，另加两个新栏位——
//   · `dsl`：`decompileWorkflow` 从**全量 reducer state**（非压缩节点）反推的
//     `WorkflowDslSource[]`。这是 agent 读回自己作品的可逆表达（图→声明）。
//   · `node_versions`：节点版本索引（逐版只留 version/createdAt/reason/title，不带 metadata）。
//     供 agent 读「这格改过几版」并经 `revert_node` 回退（REQ-B4 回滚面）。
//
// 大小守卫：gateway `CANVAS_STATE_MAX_BYTES = 512KB`，超限整份 413（快照全丢）。
// `dsl` 会复制一份 prompt（节点 metadata 里已有一份），故先算 base、逐栏位加、超预算就
// 依序丢 `dsl`→`node_versions`（丢的是**新增面**，既有 nodes/connections 永不受影响）。

import { decompileWorkflow } from "@/lib/workflow-dsl/decompile";
import type { WorkflowDslSource } from "@/lib/workflow-dsl/schema";
import type { CharacterCard } from "@/lib/character-cards";
import type {
  CanvasConnection,
  CanvasNode,
  CanvasNodeVersion,
  CanvasProjectType,
  CanvasViewport,
} from "@/lib/canvas/types";
import { compactMetadataForAgent } from "./canvas-chat-types";

/** 上行载荷预算（< gateway 512KB 硬上限，留 52KB 给 header/JSON 转义膨胀）。 */
export const AGENT_SNAPSHOT_BUDGET_BYTES = 460_000;

/** 节点版本索引的单一节点条目（agent 读的版本清单，刻意不带 metadata）。 */
export interface AgentNodeVersionIndexEntry {
  node_id: string;
  title: string;
  versions: { version: number; created_at: string; reason: string; title: string }[];
}

/** 快照输入＝当前 render 的最新值（皆由 hook 的 ref/state 提供）。 */
export interface AgentCanvasSnapshotInput {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  selectedNodeIds: string[];
  viewport: CanvasViewport;
  projectType?: CanvasProjectType;
  currentStep?: number;
  characterCards?: CharacterCard[];
  nodeVersions?: CanvasNodeVersion[];
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** 节点版本 → 按 nodeId 分组的索引（升序；title 取该节点当前标题，缺则取最新版标题）。 */
export function buildNodeVersionIndex(
  nodes: CanvasNode[],
  versions: readonly CanvasNodeVersion[] | undefined,
): AgentNodeVersionIndexEntry[] {
  if (!versions || versions.length === 0) return [];
  const byNode = new Map<string, AgentNodeVersionIndexEntry>();
  for (const v of versions) {
    if (!v || typeof v.nodeId !== "string" || v.nodeId.length === 0) continue;
    let entry = byNode.get(v.nodeId);
    if (!entry) {
      const current = nodes.find((n) => n.id === v.nodeId);
      entry = { node_id: v.nodeId, title: current?.title ?? v.title ?? "", versions: [] };
      byNode.set(v.nodeId, entry);
    }
    entry.versions.push({
      version: v.version,
      created_at: v.createdAt,
      reason: v.reason,
      title: v.title,
    });
  }
  for (const entry of byNode.values()) {
    entry.versions.sort((a, b) => a.version - b.version);
  }
  return [...byNode.values()];
}

/** DSL 反推：从**全量** reducer state 算（不可用压缩节点，白名单已剥 DSL 运行期键）。 */
export function buildWorkflowDsl(nodes: CanvasNode[], connections: CanvasConnection[]): WorkflowDslSource[] {
  try {
    return decompileWorkflow({ nodes, connections });
  } catch {
    // 反推失败（极端脏 metadata）不该拖垮整份快照：略过 dsl，agent 退化成只读节点。
    return [];
  }
}

/**
 * 建构 agent 上行快照。回传物件即 `postCanvasSnapshot` 的 body（gateway 直接存）。
 * 超过预算时依序丢 `dsl`、`node_versions`（新增面），既有栏位不动。
 */
export function buildAgentCanvasSnapshot(input: AgentCanvasSnapshotInput): Record<string, unknown> {
  const { nodes, connections, selectedNodeIds, viewport, projectType, currentStep, characterCards, nodeVersions } = input;

  const payload: Record<string, unknown> = {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: String(n.type),
      title: n.title,
      position: n.position,
      width: n.width,
      height: n.height,
      ...(compactMetadataForAgent(n.metadata) ? { metadata: compactMetadataForAgent(n.metadata) } : {}),
    })),
    connections,
    selectedNodeIds,
    viewport,
    // 作品/剧集三栏（2026-09-15 刀 1）：restoreAgentSnapshot 唯一资料源，故意只带两个纯量指针。
    ...(projectType ? { projectType } : {}),
    ...(currentStep !== undefined ? { currentStep } : {}),
    ...(characterCards && characterCards.length > 0
      ? {
          character_cards: characterCards.map((c) => ({
            id: c.id,
            kind: c.kind,
            name: c.name,
            prompt: c.prompt,
            ...(c.negativePrompt ? { negative_prompt: c.negativePrompt } : {}),
            reference_count: c.references.length,
            ...(c.loraIds?.length ? { lora_ids: c.loraIds } : {}),
          })),
        }
      : {}),
  };

  const dsl = buildWorkflowDsl(nodes, connections);
  if (dsl.length > 0) payload.dsl = dsl;
  const versionIndex = buildNodeVersionIndex(nodes, nodeVersions);
  if (versionIndex.length > 0) payload.node_versions = versionIndex;

  if (byteLength(payload) > AGENT_SNAPSHOT_BUDGET_BYTES) delete payload.dsl;
  if (byteLength(payload) > AGENT_SNAPSHOT_BUDGET_BYTES) delete payload.node_versions;
  return payload;
}
