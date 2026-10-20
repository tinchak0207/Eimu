import type { AgentMemoryDocInput, EvidenceKind, MemoryScope, MemoryType } from "./types";

// ─────────────────────────── 结构校验（形状防线；G1 在 gateway）

const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
const SCOPES: MemoryScope[] = ["private", "shared"];
const TYPES: MemoryType[] = ["user", "feedback", "project", "domain", "workflow"];
const EVIDENCE_KINDS: EvidenceKind[] = ["tool_result", "user_confirmed", "verbatim"];

function isStructurallyValid(input: AgentMemoryDocInput): boolean {
  if (!SCOPES.includes(input?.scope)) return false;
  if (!SLUG_PATTERN.test(String(input?.slug ?? ""))) return false;
  const domain = String(input?.domain ?? "");
  if (!domain.trim()) return false;
  // INDEX 是「一行一条」：domain/description 含换行会造成伪造行注入，直接拒绝。
  if (/[\r\n]/.test(domain)) return false;
  if (typeof input?.description !== "string") return false;
  if (input.description.length === 0 || input.description.length > 120) return false;
  if (/[\r\n]/.test(input.description)) return false;
  if (typeof input?.body !== "string") return false;
  if (input.body.length === 0 || input.body.length > 2000) return false;
  if (!TYPES.includes(input?.type)) return false;
  if (!EVIDENCE_KINDS.includes(input?.evidenceKind)) return false;
  if (typeof input?.selfScore !== "number" || !Number.isFinite(input.selfScore)) return false;
  if (input.scope === "private" && !String(input.ownerKey ?? "").trim()) return false;
  return true;
}

export { TYPES, isStructurallyValid };
