/**
 * 技能交付型別的標籤真源（2026-09-27 立）。
 *
 * 為什麼單獨成檔：這組詞同時被三個面消費——表單下拉（`MySkillsDialog`，client）、
 * 技能庫列表頁（`/skills`，server）、單技能頁（`/skills/[id]`，server）。
 * 放在任一消費檔裡都會逼另一邊複製一份同義詞，或讓 server 端去讀 client 模組
 * （`"use client"` 的匯出在 server 元件裡只是 reference 代理，**不是資料**）。
 * 本檔零依賴、可在任一邊直接讀。
 */
import type { AgentSkillOutputKind } from "./types";

/** 權威枚舉順序即下拉順序；`id` 必須與 `AgentSkillOutputKind` 逐一對齊。 */
export const SKILL_OUTPUT_KIND_OPTIONS: readonly { id: AgentSkillOutputKind; label: string }[] = [
  { id: "image", label: "图像" },
  { id: "text", label: "文本" },
  { id: "video", label: "视频" },
  { id: "audio", label: "音频" },
  { id: "director", label: "导演" },
  { id: "mixed", label: "混合" },
] as const;

/** 同組詞的查表形態（列表徽章／詳情頁直接取用）。 */
export const OUTPUT_KIND_LABELS: Record<AgentSkillOutputKind, string> = Object.fromEntries(
  SKILL_OUTPUT_KIND_OPTIONS.map((option) => [option.id, option.label]),
) as Record<AgentSkillOutputKind, string>;
