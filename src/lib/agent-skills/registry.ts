/**
 * Agent Skill 統一註冊表——四來源薄層（2026-09-27 立）。
 *
 * 四來源（本檔只投影/聚合，不改任何來源檔）：
 * - `builtin`  = `./index` 的 AGENT_SKILLS（11 檔 133 條，輕量能力條目；數字以現場實測為準）。
 * - `recipe`   = `../recipe-templates` 的 BUILT_IN_RECIPE_TEMPLATES（六槽配方快照）投影成
 *                同一種 view（id 加 `recipe-` 前綴）；配方不是 skill，但消費面要能一列舉。
 * - `template` = `../agent-templates` 的 AGENT_TEMPLATES（重模板：8 環 pipeline）投影
 *                （id 加 `tpl-` 前綴，`templateId` 指回原 id，family 由 domain 對映）。
 * - `user`     = 使用者**私有**自建（`./user-skill` 落地）。本檔**只留介面**：
 *                `registerUserSkillSource((ownerKey) => …)`；未註冊或來源拋錯時 fallback
 *                回 `[]`，不在此實作 user 來源。
 *
 * **公開／私有分離（2026-09-27 立，核心隔離）**：本檔有兩族列舉函式，語義不得互混——
 * - **公開族** `listPublicSkills` / `searchPublicSkills` / `getSkillByIdPublic`：
 *   只含 `builtin + recipe + template`，**永不**讀 user 來源插槽，故呼叫者是否登入
 *   都不會把任何人的私有 skill 併進公開集合（公開列舉與身份完全無關）。
 * - **私有族** `listMySkills` / `searchMySkills` / `getMySkillById`：**必帶 ownerKey**，
 *   只回該 ownerKey 的私有 skill；無 ownerKey 一律回空（寧可空，不回全體）。
 * 兩族命名即語義，**不留**「listAllSkills 卻只回公開」這種同名陷阱（已於本次改名刪除）。
 *
 * 硬約束：view 的 `toolIds` / `expertId` / `templateId` 對外都必須指向真源 id
 * （HARNESS_TOOL_IDS / EXPERT_REGISTRY / AGENT_TEMPLATES），由 `registry.test.ts` 行為斷言。
 */

import { AGENT_SKILLS, AGENT_SKILL_FAMILY_LABELS, skillMatchesQuery } from "./index";
import type { AgentSkillFamily, AgentSkillOutputKind, AgentSkillSpec } from "./types";
import { BUILT_IN_RECIPE_TEMPLATES } from "../recipe-templates";
import { AGENT_TEMPLATES } from "../agent-templates";
import type { AgentTemplateDomain } from "../agent-templates/types";

export type AgentSkillSource = "builtin" | "recipe" | "template" | "user";

/** 統一視圖：skill 規格 + 來源標記。 */
export interface AgentSkillView extends AgentSkillSpec {
  source: AgentSkillSource;
}

/** 四來源全集（含 `user`）；`user` 只走私有族列舉，永不出現在公開集合。 */
export const AGENT_SKILL_SOURCES: readonly AgentSkillSource[] = ["builtin", "recipe", "template", "user"];

/** 公開列舉可選來源：`user` **不在其中**（私有來源不得經公開面篩選露出）。 */
export const PUBLIC_SKILL_SOURCES: readonly AgentSkillSource[] = ["builtin", "recipe", "template"];

/** 配方投影可調用的 harness 工具（配方落在六槽生圖表單，實際出口 = 風格錨 + 生圖）。 */
const RECIPE_TOOL_IDS: readonly string[] = ["style_anchor_sref", "image_generate"];

/** 起手模板投影可調用的 harness 工具（模板以 workflow_start 起鏈、workflow_status 輪詢、workflow_generate 出片）。 */
const TEMPLATE_TOOL_IDS: readonly string[] = ["workflow_start", "workflow_status", "workflow_generate"];

/** 配方模板無 family 欄位；六槽風格快照最接近「電影美學·作者風格」的視覺語言層。 */
const RECIPE_FAMILY: AgentSkillFamily = "cinema-auteur";

/** 起手模板 domain → 題材家族（domain 只有 4 值，見 agent-templates/types.ts）。 */
export const TEMPLATE_FAMILY_BY_DOMAIN: Record<AgentTemplateDomain, AgentSkillFamily> = {
  novel: "script",
  ecommerce: "ad-tvc",
  shortdrama: "short-drama",
  art: "cinema-auteur",
};

/** 起手模板 domain → 使用者輸入面（投影文案，不複製模板 payload）。 */
const TEMPLATE_INPUT_BY_DOMAIN: Record<AgentTemplateDomain, string> = {
  novel: "一段小说正文或故事大纲",
  ecommerce: "产品资料与卖点清单",
  shortdrama: "剧本或题材设定",
  art: "主题或品牌关键词",
};

/** recipe 來源（10 條，投影自 BUILT_IN_RECIPE_TEMPLATES）。 */
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

/** template 來源（8 條，投影自 AGENT_TEMPLATES；templateId 指回原 id）。 */
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
 * user 來源載入器：**必帶 ownerKey**（`user-skill.ts` 的 `userSkillLoader` 即為此形狀）。
 * 簽名帶 ownerKey 是隔離的骨架——插槽本身沒有「無參數回全體」的形狀可用，
 * 呼叫端不可能靠漏傳參數把別人的私有 skill 拉進來。
 */
type UserSkillSourceLoader = (ownerKey: string) => Promise<AgentSkillView[]>;

let userSkillSource: UserSkillSourceLoader | null = null;

/**
 * 註冊 user 來源載入器（`user-skill.ts` 的 `userSkillLoader` 可直接餵入）。
 * 未註冊 = 空集合；ownerKey 空 = 空集合（**不回全體**）；
 * 來源拋錯 = 誠實吞成空集合（不讓個人 skill 故障拖垮全庫列舉）。
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

// ─────────────────────────── 公開族（builtin + recipe + template，永不含 user）

/**
 * 公開列舉：`builtin → recipe → template`。**恆不讀 user 插槽**，
 * 故與呼叫者身份無關——登入與否回傳同一集合。
 */
export async function listPublicSkills(): Promise<AgentSkillView[]> {
  return [...AGENT_SKILLS, ...RECIPE_SKILLS, ...TEMPLATE_SKILLS];
}

/** 公開集搜尋（匹配語意與 builtin 共用 `skillMatchesQuery`）。 */
export async function searchPublicSkills(q: string): Promise<AgentSkillView[]> {
  const all = await listPublicSkills();
  return all.filter((skill) => skillMatchesQuery(skill, q));
}

/**
 * 公開集按 id 取單條；找不到回 undefined。
 * **不得**以 `id` 直接命中任何 user 技能——私有 id 不在公開集合裡，
 * 這裡天然回 undefined（不查 user 來源、不做 id 猜測）。
 */
export async function getSkillByIdPublic(id: string): Promise<AgentSkillView | undefined> {
  const key = id.trim();
  if (!key) return undefined;
  return (await listPublicSkills()).find((skill) => skill.id === key);
}

// ─────────────────────────── 私有族（只回該 ownerKey 的 user 技能）

/** 我的私有 skill 列舉：ownerKey 空 / 未註冊來源 → 空集合。 */
export async function listMySkills(ownerKey: string | null | undefined): Promise<AgentSkillView[]> {
  return loadUserSkills(typeof ownerKey === "string" ? ownerKey : "");
}

/** 我的私有 skill 搜尋（只在該 ownerKey 的集合內匹配）。 */
export async function searchMySkills(
  ownerKey: string | null | undefined,
  q: string,
): Promise<AgentSkillView[]> {
  const mine = await listMySkills(ownerKey);
  return mine.filter((skill) => skillMatchesQuery(skill, q));
}

/** 我的私有 skill 按 id 取單條；別人的 id（或不存在）一律 undefined。 */
export async function getMySkillById(
  ownerKey: string | null | undefined,
  id: string,
): Promise<AgentSkillView | undefined> {
  const key = typeof id === "string" ? id.trim() : "";
  if (!key) return undefined;
  return (await listMySkills(ownerKey)).find((skill) => skill.id === key);
}

/** 家族列舉（id + 簡體標籤 + 條目數；含 0 條的家族）。 */
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
