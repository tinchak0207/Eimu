/**
 * Agent Skill 匯總與查詢入口（2026-09-27 立）。
 *
 * 定位：本檔**只做匯總與查詢**，不重新定義任何 skill 內容（禁造第二套 catalog）。
 * 條目真源 = 同目錄 11 個題材家族檔（一檔一 family，並行契約同 agent-templates 09-20）：
 *   cinema-auteur / cinema-auteur-b / ad-tvc / short-drama / script /
 *   storyboard / casting / ugc / music-mv / travel-life / vfx-animation
 * 四來源聚合（+ recipe / template / user）在 `registry.ts`，本檔只負責 builtin 這一層。
 *
 * 消費面：`/api/skills`（只讀列舉/搜尋）；前端與 harness 不應直接 import 各家族檔。
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
 * 題材家族顯示標籤（簡體，與使用者介面文案一致）。
 * 這 10 個 key = 家族全集的權威列舉（10 個家族皆已有條目，見家族分佈測試）。
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

/** 家族全集（宣告序 = AGENT_SKILL_FAMILY_LABELS 的 key 序，供列舉/篩選用）。 */
export const AGENT_SKILL_FAMILIES = Object.keys(AGENT_SKILL_FAMILY_LABELS) as AgentSkillFamily[];

/** 11 個家族檔的原始條目（未加 source 的規格層）。 */
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

/** 內建 skill 全集（133 條）。僅補 `source` 標記，內容逐欄位照抄家族檔。 */
export const AGENT_SKILLS: readonly AgentSkillView[] = BUILTIN_SKILL_SPECS.map((spec) => ({
  ...spec,
  source: "builtin" as const,
}));

export interface ListAgentSkillsOptions {
  family?: AgentSkillFamily;
  /** 取前 n 條（不傳 = 全量）。 */
  limit?: number;
}

/** 檢索用的欄位串（搜尋語意單一真源；registry 聚合層共用本函式，避免第二套匹配邏輯）。 */
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
 * 查詢匹配：空白分隔的多詞全部命中（AND，子字串比對，大小寫不敏感）；
 * 空查詢 = 全部命中。家族標籤（如「电影美学」）也是命中欄位。
 */
export function skillMatchesQuery(skill: AgentSkillSpec & { source?: string }, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = skillHaystack(skill);
  return tokens.every((token) => haystack.includes(token));
}

/** 列舉內建 skill（可按 family 篩選、可限筆數）；純函式、無 I/O。 */
export function listAgentSkills(opts: ListAgentSkillsOptions = {}): readonly AgentSkillView[] {
  const filtered = opts.family ? AGENT_SKILLS.filter((skill) => skill.family === opts.family) : AGENT_SKILLS;
  if (typeof opts.limit === "number" && opts.limit >= 0) return filtered.slice(0, opts.limit);
  return filtered;
}

/** 取單條內建 skill；找不到回 undefined。 */
export function getAgentSkill(id: string): AgentSkillView | undefined {
  const key = id.trim();
  if (!key) return undefined;
  return AGENT_SKILLS.find((skill) => skill.id === key);
}

/** 搜尋內建 skill（多詞 AND 子字串）。 */
export function searchAgentSkills(q: string): readonly AgentSkillView[] {
  return AGENT_SKILLS.filter((skill) => skillMatchesQuery(skill, q));
}

/** 各家族條目數（key 序 = 家族宣告序，含 0 條的家族）。 */
export function countAgentSkillsByFamily(
  skills: readonly AgentSkillSpec[] = AGENT_SKILLS,
): Record<AgentSkillFamily, number> {
  const counts = {} as Record<AgentSkillFamily, number>;
  for (const family of AGENT_SKILL_FAMILIES) counts[family] = 0;
  for (const skill of skills) counts[skill.family] += 1;
  return counts;
}
