/**
 * 技能交付型别的标签真源（2026-09-27 立）。
 *
 * 为什么单独成档：这组词同时被三个面消费——表单下拉（`MySkillsDialog`，client）、
 * 技能库列表页（`/skills`，server）、单技能页（`/skills/[id]`，server）。
 * 放在任一消费档里都会逼另一边复制一份同义词，或让 server 端去读 client 模组
 * （`"use client"` 的汇出在 server 元件里只是 reference 代理，**不是资料**）。
 * 本档零依赖、可在任一边直接读。
 */
import type { AgentSkillOutputKind } from "./types";

/** 权威枚举顺序即下拉顺序；`id` 必须与 `AgentSkillOutputKind` 逐一对齐。 */
export const SKILL_OUTPUT_KIND_OPTIONS: readonly { id: AgentSkillOutputKind; label: string }[] = [
  { id: "image", label: "图像" },
  { id: "text", label: "文本" },
  { id: "video", label: "视频" },
  { id: "audio", label: "音频" },
  { id: "director", label: "导演" },
  { id: "mixed", label: "混合" },
] as const;

/** 同组词的查表形态（列表徽章／详情页直接取用）。 */
export const OUTPUT_KIND_LABELS: Record<AgentSkillOutputKind, string> = Object.fromEntries(
  SKILL_OUTPUT_KIND_OPTIONS.map((option) => [option.id, option.label]),
) as Record<AgentSkillOutputKind, string>;
