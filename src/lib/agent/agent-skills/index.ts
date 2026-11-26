/**
 * Agent Skill 汇总与查询入口（2026-09-27 立）。
 *
 * 定位：本档**只做汇总与查询**，不重新定义任何 skill 内容（禁造第二套 catalog）。
 * 条目真源 = 同目录 11 个题材家族档（一档一 family，并行契约同 agent-templates 09-20）：
 *   cinema-auteur / cinema-auteur-b / ad-tvc / short-drama / script /
 *   storyboard / casting / ugc / music-mv / travel-life / vfx-animation
 * 四来源聚合（+ recipe / template / user）在 `registry.ts`，本档只负责 builtin 这一层。
 *
 * 消费面：`/api/skills`（只读列举/搜寻）；前端与 harness 不应直接 import 各家族档。
 */

import { CINEMA_AUTEUR_SKILLS } from "./cinema-auteur";
import { CINEMA_AUTEUR_B_SKILLS } from "./cinema-auteur-b";
import { AD_TVC_SKILLS } from "./ad-tvc";
import { SHORT_DRAMA_SKILLS } from "./short-drama";
import { SCRIPT_SKILLS } from "./script";
import { STORYBOARD_SKILLS } from "./storyboard";
import { CASTING_SKILLS } from "./casting";
import { UGC_SKILLS } from "./ugc";
import { MUSIC_MV_SKILLS } from "./music-mv";
import { TRAVEL_LIFE_SKILLS } from "./travel-life";
import { VFX_ANIMATION_SKILLS } from "./vfx-animation";
import type { AgentSkillFamily, AgentSkillSpec } from "./types";
import type { AgentSkillView } from "./registry";

/**
 * 题材家族显示标签（简体，与使用者介面文案一致）。
 * 这 10 个 key = 家族全集的权威列举（10 个家族皆已有条目，见家族分布测试）。
 */
export const AGENT_SKILL_FAMILY_LABELS: Record<AgentSkillFamily, string> = {
  "cinema-auteur": "电影美学",
  "ad-tvc": "商业广告",
  "short-drama": "短剧漫剧",
  script: "剧本写作",
  storyboard: "分镜镜头",
  casting: "选角角色",
  ugc: "UGC带货",
  "music-mv": "音乐MV",
  "travel-life": "旅拍生活",
  "vfx-animation": "特效动画",
};

/** 家族全集（宣告序 = AGENT_SKILL_FAMILY_LABELS 的 key 序，供列举/筛选用）。 */
export const AGENT_SKILL_FAMILIES = Object.keys(AGENT_SKILL_FAMILY_LABELS) as AgentSkillFamily[];

/** 11 个家族档的原始条目（未加 source 的规格层）。 */
const BUILTIN_SKILL_SPECS: readonly AgentSkillSpec[] = [
  ...CINEMA_AUTEUR_SKILLS,
  ...CINEMA_AUTEUR_B_SKILLS,
  ...AD_TVC_SKILLS,
  ...SHORT_DRAMA_SKILLS,
  ...SCRIPT_SKILLS,
  ...STORYBOARD_SKILLS,
  ...CASTING_SKILLS,
  ...UGC_SKILLS,
  ...MUSIC_MV_SKILLS,
  ...TRAVEL_LIFE_SKILLS,
  ...VFX_ANIMATION_SKILLS,
];

/** 内建 skill 全集（133 条）。仅补 `source` 标记，内容逐栏位照抄家族档。 */
export const AGENT_SKILLS: readonly AgentSkillView[] = BUILTIN_SKILL_SPECS.map((spec) => ({
  ...spec,
  source: "builtin" as const,
}));

export interface ListAgentSkillsOptions {
  family?: AgentSkillFamily;
  /** 取前 n 条（不传 = 全量）。 */
  limit?: number;
}

/** 检索用的栏位串（搜寻语意单一真源；registry 聚合层共用本函式，避免第二套匹配逻辑）。 */
function skillHaystack(skill: AgentSkillSpec & { source?: string }): string {
  const parts: string[] = [
    skill.id,
    skill.name,
    skill.oneLiner,
    skill.family,
    AGENT_SKILL_FAMILY_LABELS[skill.family] ?? "",
    skill.useScenario,
    skill.inputType,
    skill.outputContent,
    skill.outputKind,
    skill.aesthetic ?? "",
    ...skill.tags,
  ];
  if (skill.source) parts.push(skill.source);
  return parts.join("\n").toLowerCase();
}

/**
 * 查询匹配：空白分隔的多词全部命中（AND，子字串比对，大小写不敏感）；
 * 空查询 = 全部命中。家族标签（如「电影美学」）也是命中栏位。
 */
export function skillMatchesQuery(skill: AgentSkillSpec & { source?: string }, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = skillHaystack(skill);
  return tokens.every((token) => haystack.includes(token));
}

/** 列举内建 skill（可按 family 筛选、可限笔数）；纯函式、无 I/O。 */
export function listAgentSkills(opts: ListAgentSkillsOptions = {}): readonly AgentSkillView[] {
  const filtered = opts.family ? AGENT_SKILLS.filter((skill) => skill.family === opts.family) : AGENT_SKILLS;
  if (typeof opts.limit === "number" && opts.limit >= 0) return filtered.slice(0, opts.limit);
  return filtered;
}

/** 取单条内建 skill；找不到回 undefined。 */
export function getAgentSkill(id: string): AgentSkillView | undefined {
  const key = id.trim();
  if (!key) return undefined;
  return AGENT_SKILLS.find((skill) => skill.id === key);
}

/** 搜寻内建 skill（多词 AND 子字串）。 */
export function searchAgentSkills(q: string): readonly AgentSkillView[] {
  return AGENT_SKILLS.filter((skill) => skillMatchesQuery(skill, q));
}

/** 各家族条目数（key 序 = 家族宣告序，含 0 条的家族）。 */
export function countAgentSkillsByFamily(
  skills: readonly AgentSkillSpec[] = AGENT_SKILLS,
): Record<AgentSkillFamily, number> {
  const counts = {} as Record<AgentSkillFamily, number>;
  for (const family of AGENT_SKILL_FAMILIES) counts[family] = 0;
  for (const skill of skills) counts[skill.family] += 1;
  return counts;
}
