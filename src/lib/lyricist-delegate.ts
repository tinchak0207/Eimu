/** 歌词专家交付组装：复用 screenwriter 的签名与 Expert 闸，不裁剪歌词。 */
import { computeQcSignature, validateExpertDeliverable, type ExpertDeliverable, type ExpertTaskContract, type LyricistDeliverablePayload } from "./expert-contract";
export const LYRICIST_DELIVERABLES = ["title", "lyrics", "hook", "prosody_notes", "qc"] as const;
export const LYRICIST_DELIVERABLE_KIND = "original_lyrics" as const;
export type LyricistToolResult = { title: string; output: string };
export interface LyricistDelegationInput { intent: string; materials: string[]; acceptance: string[] }
export function composeLyricistDelegation(input: LyricistDelegationInput): ExpertTaskContract {
  return { expertId: "lyricist", intent: input.intent, materials: [...input.materials], acceptance: [...input.acceptance] };
}
export function collectLyricistDeliverableFromToolResult(result: LyricistToolResult, context: { contract: ExpertTaskContract }):
  { ok: true; deliverable: ExpertDeliverable } | { ok: false; code: string; hint: string; missing: string[] } {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(result.output); } catch { return { ok: false, code: "no_output", hint: "歌词交付必须为合法 JSON。", missing: ["output"] }; }
  if (!parsed || typeof parsed !== "object" || parsed.ok !== true) return { ok: false, code: "no_output", hint: "歌词未完成交付。", missing: ["ok"] };
  const missing: string[] = LYRICIST_DELIVERABLES.filter((key) => typeof parsed[key] !== "string" || !(parsed[key] as string).trim());
  const artifactPath = typeof parsed.artifact_path === "string" ? parsed.artifact_path.trim() : "";
  if (!artifactPath) missing.push("artifact_path");
  if (missing.length) return { ok: false, code: "missing_deliverables", hint: `缺少歌词交付字段：${missing.join("、")}`, missing };
  const payload = Object.fromEntries(LYRICIST_DELIVERABLES.map((key) => [key, parsed[key]])) as LyricistDeliverablePayload;
  const unsigned = { expertId: "lyricist" as const, kind: LYRICIST_DELIVERABLE_KIND, payload, evidence: { artifactPath }, contract: context.contract };
  const deliverable = { ...unsigned, qcSignature: computeQcSignature(unsigned) };
  const gate = validateExpertDeliverable(deliverable);
  return gate.ok ? { ok: true, deliverable } : { ok: false, code: "deliverable_invalid", hint: gate.errors.join("；"), missing: [] };
}
