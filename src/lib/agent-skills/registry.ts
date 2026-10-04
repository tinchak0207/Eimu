/**
 * Agent Skill 统一注册表——四来源薄层（2026-09-27 立）。
 *
 * 四来源（本档只投影/聚合，不改任何来源档）：
 * - `builtin`  = `./index` 的 AGENT_SKILLS（11 档 133 条，轻量能力条目；数字以现场实测为准）。
 * - `recipe`   = `../recipe-templates` 的 BUILT_IN_RECIPE_TEMPLATES（六槽配方快照）投影成
 *                同一种 view（id 加 `recipe-` 前缀）；配方不是 skill，但消费面要能一列举。
 * - `template` = `../agent-templates` 的 AGENT_TEMPLATES（重模板：8 环 pipeline）投影
 *                （id 加 `tpl-` 前缀，`templateId` 指回原 id，family 由 domain 对映）。
 * - `user`     = 使用者**私有**自建（`./user-skill` 落地）。本档**只留介面**：
 *                `registerUserSkillSource((ownerKey) => …)`；未注册或来源抛错时 fallback
 *                回 `[]`，不在此实作 user 来源。
 *
 * **公开／私有分离（2026-09-27 立，核心隔离）**：本档有两族列举函式，语义不得互混——
 * - **公开族** `listPublicSkills` / `searchPublicSkills` / `getSkillByIdPublic`：
 *   只含 `builtin + recipe + template`，**永不**读 user 来源插槽，故呼叫者是否登入
 *   都不会把任何人的私有 skill 并进公开集合（公开列举与身份完全无关）。
 * - **私有族** `listMySkills` / `searchMySkills` / `getMySkillById`：**必带 ownerKey**，
 *   只回该 ownerKey 的私有 skill；无 ownerKey 一律回空（宁可空，不回全体）。
 * 两族命名即语义，**不留**「listAllSkills 却只回公开」这种同名陷阱（已于本次改名删除）。
 *
 * 硬约束：view 的 `toolIds` / `expertId` / `templateId` 对外都必须指向真源 id
 * （HARNESS_TOOL_IDS / EXPERT_REGISTRY / AGENT_TEMPLATES），由 `registry.test.ts` 行为断言。
 */

import { AGENT_SKILLS, AGENT_SKILL_FAMILY_LABELS, skillMatchesQuery } from "./index";
import type { AgentSkillFamily, AgentSkillOutputKind, AgentSkillSpec } from "./types";
import { BUILT_IN_RECIPE_TEMPLATES } from "../recipe-templates";
import { AGENT_TEMPLATES } from "../agent-templates";
import type { AgentTemplateDomain } from "../agent-templates/types";

export type AgentSkillSource = "builtin" | "recipe" | "template" | "user";

/** 统一视图：skill 规格 + 来源标记。 */
export interface AgentSkillView extends AgentSkillSpec {
  source: AgentSkillSource;
}

/** 四来源全集（含 `user`）；`user` 只走私有族列举，永不出现在公开集合。 */
export const AGENT_SKILL_SOURCES: readonly AgentSkillSource[] = ["builtin", "recipe", "template", "user"];

/** 公开列举可选来源：`user` **不在其中**（私有来源不得经公开面筛选露出）。 */
export const PUBLIC_SKILL_SOURCES: readonly AgentSkillSource[] = ["builtin", "recipe", "template"];

/** 配方投影可调用的 harness 工具（配方落在六槽生图表单，实际出口 = 风格锚 + 生图）。 */
const RECIPE_TOOL_IDS: readonly string[] = ["style_anchor_sref", "image_generate"];

/** 起手模板投影可调用的 harness 工具（模板以 workflow_start 起链、workflow_status 轮询、workflow_generate 出片）。 */
const TEMPLATE_TOOL_IDS: readonly string[] = ["workflow_start", "workflow_status", "workflow_generate"];

/** 配方模板无 family 栏位；六槽风格快照最接近「电影美学·作者风格」的视觉语言层。 */
const RECIPE_FAMILY: AgentSkillFamily = "cinema-auteur";

/** 起手模板 domain → 题材家族（domain 只有 4 值，见 agent-templates/types.ts）。 */
export const TEMPLATE_FAMILY_BY_DOMAIN: Record<AgentTemplateDomain, AgentSkillFamily> = {
  novel: "script",
  ecommerce: "ad-tvc",
  shortdrama: "short-drama",
  art: "cinema-auteur",
};

/** 起手模板 domain → 使用者输入面（投影文案，不复制模板 payload）。 */
const TEMPLATE_INPUT_BY_DOMAIN: Record<AgentTemplateDomain, string> = {
  novel: "一段小说正文或故事大纲",
  ecommerce: "产品资料与卖点清单",
  shortdrama: "剧本或题材设定",
  art: "主题或品牌关键词",
};

/** recipe 来源（10 条，投影自 BUILT_IN_RECIPE_TEMPLATES）。 */
export const RECIPE_SKILLS: readonly AgentSkillView[] = BUILT_IN_RECIPE_TEMPLATES.map((template) => ({
  id: `recipe-${template.id}`,
  name: template.name,
  oneLiner: template.note,
  family: RECIPE_FAMILY,
  useScenario: template.note,
  inputType: "一句主体描述（套用后在画面描述槽替换占位主体）",
  outputContent: "按该风格出的一张成图（可再改主体重跑）",
  outputKind: "image" satisfies AgentSkillOutputKind,
  toolIds: RECIPE_TOOL_IDS,
  tags: [
    "配方模板",
    "风格模板",
    template.name,
    ...(template.slots.styleTemplateId ? [template.slots.styleTemplateId] : []),
    ...(template.slots.qualityProfile ? [template.slots.qualityProfile] : []),
  ],
  ...(template.slots.prompt ? { aesthetic: template.slots.prompt } : {}),
  source: "recipe" as const,
}));

/** template 来源（8 条，投影自 AGENT_TEMPLATES；templateId 指回原 id）。 */
export const TEMPLATE_SKILLS: readonly AgentSkillView[] = AGENT_TEMPLATES.map((template) => ({
  id: `tpl-${template.id}`,
  name: template.name,
  oneLiner: template.note,
  family: TEMPLATE_FAMILY_BY_DOMAIN[template.domain] ?? RECIPE_FAMILY,
  useScenario: template.painPoint,
  inputType: TEMPLATE_INPUT_BY_DOMAIN[template.domain],
  outputContent: template.pipeline.summary,
  outputKind: "mixed" satisfies AgentSkillOutputKind,
  toolIds: TEMPLATE_TOOL_IDS,
  templateId: template.id,
  tags: ["起手模板", template.domain, template.name],
  source: "template" as const,
}));

/**
 * user 来源载入器：**必带 ownerKey**（`user-skill.ts` 的 `userSkillLoader` 即为此形状）。
 * 签名带 ownerKey 是隔离的骨架——插槽本身没有「无参数回全体」的形状可用，
 * 呼叫端不可能靠漏传参数把别人的私有 skill 拉进来。
 */
type UserSkillSourceLoader = (ownerKey: string) => Promise<AgentSkillView[]>;

let userSkillSource: UserSkillSourceLoader | null = null;

/**
 * 注册 user 来源载入器（`user-skill.ts` 的 `userSkillLoader` 可直接喂入）。
 * 未注册 = 空集合；ownerKey 空 = 空集合（**不回全体**）；
 * 来源抛错 = 诚实吞成空集合（不让个人 skill 故障拖垮全库列举）。
 */
export function registerUserSkillSource(fn: UserSkillSourceLoader): void {
  userSkillSource = fn;
}

async function loadUserSkills(ownerKey: string): Promise<AgentSkillView[]> {
  const owner = typeof ownerKey === "string" ? ownerKey.trim() : "";
  if (!owner || !userSkillSource) return [];
  try {
    const items = await userSkillSource(owner);
    return Array.isArray(items) ? items : [];
  } catch (error) {
    console.error("[agent-skills] user skill source failed", error);
    return [];
  }
}

// ─────────────────────────── 公开族（builtin + recipe + template，永不含 user）

/**
 * 公开列举：`builtin → recipe → template`。**恒不读 user 插槽**，
 * 故与呼叫者身份无关——登入与否回传同一集合。
 */
export async function listPublicSkills(): Promise<AgentSkillView[]> {
  return [...AGENT_SKILLS, ...RECIPE_SKILLS, ...TEMPLATE_SKILLS];
}

/** 公开集搜寻（匹配语意与 builtin 共用 `skillMatchesQuery`）。 */
export async function searchPublicSkills(q: string): Promise<AgentSkillView[]> {
  const all = await listPublicSkills();
  return all.filter((skill) => skillMatchesQuery(skill, q));
}

/**
 * 公开集按 id 取单条；找不到回 undefined。
 * **不得**以 `id` 直接命中任何 user 技能——私有 id 不在公开集合里，
 * 这里天然回 undefined（不查 user 来源、不做 id 猜测）。
 */
export async function getSkillByIdPublic(id: string): Promise<AgentSkillView | undefined> {
  const key = id.trim();
  if (!key) return undefined;
  return (await listPublicSkills()).find((skill) => skill.id === key);
}

// ─────────────────────────── 私有族（只回该 ownerKey 的 user 技能）

/** 我的私有 skill 列举：ownerKey 空 / 未注册来源 → 空集合。 */
export async function listMySkills(ownerKey: string | null | undefined): Promise<AgentSkillView[]> {
  return loadUserSkills(typeof ownerKey === "string" ? ownerKey : "");
}

/** 我的私有 skill 搜寻（只在该 ownerKey 的集合内匹配）。 */
export async function searchMySkills(
  ownerKey: string | null | undefined,
  q: string,
): Promise<AgentSkillView[]> {
  const mine = await listMySkills(ownerKey);
  return mine.filter((skill) => skillMatchesQuery(skill, q));
}

/** 我的私有 skill 按 id 取单条；别人的 id（或不存在）一律 undefined。 */
export async function getMySkillById(
  ownerKey: string | null | undefined,
  id: string,
): Promise<AgentSkillView | undefined> {
  const key = typeof id === "string" ? id.trim() : "";
  if (!key) return undefined;
  return (await listMySkills(ownerKey)).find((skill) => skill.id === key);
}

/** 家族列举（id + 简体标签 + 条目数；含 0 条的家族）。 */
export function listSkillFamilies(
  skills: readonly AgentSkillSpec[],
): { id: AgentSkillFamily; label: string; count: number }[] {
  const counts = new Map<AgentSkillFamily, number>();
  for (const family of Object.keys(AGENT_SKILL_FAMILY_LABELS) as AgentSkillFamily[]) counts.set(family, 0);
  for (const skill of skills) counts.set(skill.family, (counts.get(skill.family) ?? 0) + 1);
  return (Object.keys(AGENT_SKILL_FAMILY_LABELS) as AgentSkillFamily[]).map((id) => ({
    id,
    label: AGENT_SKILL_FAMILY_LABELS[id],
    count: counts.get(id) ?? 0,
  }));
}
