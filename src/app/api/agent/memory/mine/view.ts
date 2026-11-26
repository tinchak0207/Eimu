import type { AgentMemoryDoc } from "@/lib/agent/agent-memory-store";

/** 「我的记忆」对前端暴露的字段（不含 ownerKey／batchId／promptVersion 等内部栏位）。 */
export interface MineMemoryView {
  id: string;
  description: string;
  body: string;
  domain: string;
  type: string;
  source: "user" | "agent";
  createdAt: string;
  updatedAt: string;
}

export function toMineView(doc: AgentMemoryDoc): MineMemoryView {
  return {
    id: doc.id,
    description: doc.description,
    body: doc.body,
    domain: doc.domain,
    type: doc.type,
    source: doc.promptVersion === "user-manual" ? "user" : "agent",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
