// 畫布 → agent 快照載荷的唯一建構子（2026-10-03，人機共筆「圖＝聲明的可逆表達」落地）。
//
// 背景：報告第四章的範式主張是「智能體讀回 DSL → 像改代碼一樣改 → 編譯原子落圖」。
// 但上行快照（唯一餵給 agent 的眼睛）過去只帶 nodes/connections 的**壓縮白名單**
// metadata——`compactMetadataForAgent` 會剝掉 workflow_ns/stepId/gate 等 DSL 運行期鍵，
// 於是 agent 讀不到「自己剛編譯出的那張圖」的聲明形態＝讀改鏈路單邊斷。
//
// 本檔把「上行載荷」抽成純函式：節點仍走既有壓縮白名單，另加兩個新欄位——
//   · `dsl`：`decompileWorkflow` 從**全量 reducer state**（非壓縮節點）反推的
//     `WorkflowDslSource[]`。這是 agent 讀回自己作品的可逆表達（圖→聲明）。
//   · `node_versions`：節點版本索引（逐版只留 version/createdAt/reason/title，不帶 metadata）。
//     供 agent 讀「這格改過幾版」並經 `revert_node` 回退（REQ-B4 回滾面）。
//
// 大小守衛：gateway `CANVAS_STATE_MAX_BYTES = 512KB`，超限整份 413（快照全丟）。
// `dsl` 會複製一份 prompt（節點 metadata 裡已有一份），故先算 base、逐欄位加、超預算就
// 依序丟 `dsl`→`node_versions`（丟的是**新增面**，既有 nodes/connections 永不受影響）。

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

/** 上行載荷預算（< gateway 512KB 硬上限，留 52KB 給 header/JSON 轉義膨脹）。 */
export const AGENT_SNAPSHOT_BUDGET_BYTES = 460_000;

/** 節點版本索引的單一節點條目（agent 讀的版本清單，刻意不帶 metadata）。 */
export interface AgentNodeVersionIndexEntry {
  node_id: string;
  title: string;
  versions: { version: number; created_at: string; reason: string; title: string }[];
}

/** 快照輸入＝當前 render 的最新值（皆由 hook 的 ref/state 提供）。 */
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

/** 節點版本 → 按 nodeId 分組的索引（升序；title 取該節點當前標題，缺則取最新版標題）。 */
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

/** DSL 反推：從**全量** reducer state 算（不可用壓縮節點，白名單已剝 DSL 運行期鍵）。 */
export function buildWorkflowDsl(nodes: CanvasNode[], connections: CanvasConnection[]): WorkflowDslSource[] {
  try {
    return decompileWorkflow({ nodes, connections });
  } catch {
    // 反推失敗（極端髒 metadata）不該拖垮整份快照：略過 dsl，agent 退化成只讀節點。
    return [];
  }
}

/**
 * 建構 agent 上行快照。回傳物件即 `postCanvasSnapshot` 的 body（gateway 直接存）。
 * 超過預算時依序丟 `dsl`、`node_versions`（新增面），既有欄位不動。
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
    // 作品/劇集三欄（2026-09-15 刀 1）：restoreAgentSnapshot 唯一資料源，故意只帶兩個純量指針。
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
