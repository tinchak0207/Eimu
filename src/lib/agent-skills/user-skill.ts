/**
 * 使用者自建 Skill ⇄ agent-memory 记忆文件（2026-09-27 立）。
 *
 * 定位（**禁造第二套**）：使用者自建 Skill **就是**既有 `agent-memory-store`
 * 的一种记忆文件，不是第二个储存／审核／配额系统。本档只做两件事：
 *   1. `AgentSkillView`（= `AgentSkillSpec` + `source: "user"`）与
 *      `AgentMemoryDocInput` 之间的**纯函式**双向转换；
 *   2. 发布前的栏位验证。
 * 配额（G7）、去重（G5）、结构防线（structure）**一律复用 store**：
 * 写入路径是 `ingestMemoryDocs`，本档不碰 blob/Map，不自己计数。
 *
 * 栏位落位（不改 store、不新增栏位）：`AgentMemoryDocInput` 可用栏位只有
 * scope / ownerKey / domain / slug / description / type / body / links /
 * evidence / evidenceKind / selfScore / promptVersion。故：
 *   - `slug`        ← `skill.id`（`user-<family>-[<ascii>-]<name hash8>`，符合 store
 *                     的 `^[a-z0-9-]{1,64}$`；`user-` 前缀与内建 id 分家，尾端 hash
 *                     保证不同名不撞同一条＝不会静默覆盖）
 *   - `domain`      ← `skill.family`（索引行 `- [family] slug — oneLiner` 可读；
 *                     同时把 G7 的「单 domain ≤8/日」分摊到各家族，不互相挤压）
 *   - `description` ← `skill.oneLiner`（≤24 字，远在 store 的 120 上限内）
 *   - `body`        ← 稳定 markdown（标题＋一句话＋使用场景＋输入＋交付＋
 *                     美学锚＋标签＋工具），供召回语料与人眼阅读
 *   - `links`       ← **机器可读栏位**（source 标记／name／family／output-kind／
 *                     tool／expert／tag），`user-skill:` 前缀，解析的唯一真源
 *   - `type`        ← `workflow`（使用者自建方法；领域知识类走 `domain`）
 *   - `evidenceKind`← `user_confirmed`（作者自陈，非工具结果）
 *
 * 往返契约（硬）：`memoryDocToSkill(skillToMemoryDoc(s))` 等价于 `s`，
 * 其中 `s` 由 `validateUserSkill` 产出（栏位已正规化）。解析不出来一律回
 * `null`（**不得猜**）：`links` 缺 source 标记 / 缺必要栏位、body 缺必要段落、
 * slug 不符形状、tool/expert 不在真源注册表，全部视为非使用者 skill 文件。
 *
 * 注册介面：`registerUserSkillSource(fn)` 的**唯一真源在 `agent-skills/registry.ts`**
 * （2026-09-27 由另一路落地；同日改为 ownerKey 参数化 `(ownerKey) => Promise<AgentSkillView[]>`）。
 * 本档**不再自建第二个插槽**，只 `export { registerUserSkillSource }` 逐字转出（让
 * 呼叫端可从本档一处拿到「转换＋验证＋注册」三件事），并提供 `userSkillLoader(ownerKey)`
 * 这个与插槽同形的载入器（读该 ownerKey 的私有库 → 逐条解析）。
 */

import { createHash } from "node:crypto";
import {
  ingestMemoryDocs,
  listMemoryDocs,
  retractMemoryDocs,
  type AgentMemoryDoc,
  type AgentMemoryDocInput,
  type MemoryIngestResult,
  type MemoryRejectReason,
} from "@/lib/agent-memory-store";
import { EXPERT_REGISTRY } from "@/lib/expert-registry";
import { HARNESS_TOOL_IDS } from "@/lib/harness-tool-registry";
import type { AgentSkillView as RegisteredSkillView } from "./registry";
import type { AgentSkillFamily, AgentSkillOutputKind } from "./types";

/** 使用者 skill 的视图：复用 registry 的单一 `AgentSkillView` 定义，收窄来源为 `"user"`。 */
export type AgentSkillView = RegisteredSkillView & { source: "user" };

/** 发布草稿：使用者在浏览器端填的栏位（`id` 可选，供既有 skill 改名以外的更新）。 */
export interface UserSkillDraft {
  id?: unknown;
  name?: unknown;
  oneLiner?: unknown;
  family?: unknown;
  useScenario?: unknown;
  inputType?: unknown;
  outputContent?: unknown;
  outputKind?: unknown;
  toolIds?: unknown;
  expertId?: unknown;
  tags?: unknown;
  aesthetic?: unknown;
}

export type UserSkillValidation =
  | { ok: true; skill: AgentSkillView }
  | { ok: false; reason: string };

export const USER_SKILL_LINK_PREFIX = "user-skill:";
/** 标记：这份记忆文件确实是一条使用者自建 skill（缺它就回 null）。 */
export const USER_SKILL_SOURCE_MARKER = `${USER_SKILL_LINK_PREFIX}source=user`;
export const USER_SKILL_PROMPT_VERSION = "user-skill-v1";
/** 作者自陈、未经 gateway G6 评分：中性分，不假装高分。 */
export const USER_SKILL_SELF_SCORE = 0.5;

export const USER_SKILL_NAME_MAX = 32;
export const USER_SKILL_ONE_LINER_MAX = 24;
export const USER_SKILL_TAGS_MIN = 1;
export const USER_SKILL_TAGS_MAX = 8;
export const USER_SKILL_TAG_MAX = 24;
export const USER_SKILL_TOOL_IDS_MAX = 16;
/** 长文本栏位上界（让 body 稳定落在 store 的 2000 字元上限内）。 */
export const USER_SKILL_TEXT_MAX = 400;
/** store `isStructurallyValid` 对 body 的上限；此处先一步给明确理由。 */
export const USER_SKILL_BODY_MAX = 2000;

const FAMILIES: readonly AgentSkillFamily[] = [
  "cinema-auteur",
  "ad-tvc",
  "short-drama",
  "script",
  "storyboard",
  "casting",
  "ugc",
  "music-mv",
  "travel-life",
  "vfx-animation",
];

const OUTPUT_KINDS: readonly AgentSkillOutputKind[] = [
  "image",
  "text",
  "video",
  "audio",
  "director",
  "mixed",
];

const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
/** 控制字元：允许 \n 与 \t，其余拒绝（\r 也拒，避免 CRLF 破坏段落解析）。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const SECTION_SCENARIO = "使用场景";
const SECTION_INPUT = "输入";
const SECTION_DELIVERABLE = "交付";
const SECTION_AESTHETIC = "美学锚";
const SECTION_TAGS = "标签";
const SECTION_TOOLS = "工具";

// ─────────────────────────── 凭证／秘密闸（最小面）

/**
 * 凭证／秘密扫描（2026-09-27 立）：使用者把「使用场景／输入／交付」等长文本贴进来时，
 * 可能在正文里夹带 `sk-…`、Bearer、私钥、JWT、手机号或 `password=…`。这些内容一旦
 * 写进 agent-memory 就是**永久落库**（`AGENTS.md` 红线：secret／凭证／token／OTP／
 * 私钥永不入 log／memory／commit），故发布前先扫。
 *
 * 界线（**不越权**）：只认「凭证／秘密」这一类的事实；**不做**敏感词库、内容审查、
 * 政治审查或计费闸。命中回传**种类与索引**，永不回传命中的原文——避免秘密经由
 * reason／log／回应体二次外泄（route 只把 `<kind>` 带给客户端）。
 *
 * 纯函式、无 I/O、不抛错（非字串／畸形输入一律回干净）。
 */
export type SensitiveContentKind =
  | "api_key_sk"
  | "bearer_token"
  | "aws_access_key_id"
  | "pem_private_key"
  | "jwt"
  | "cn_mobile"
  | "assigned_secret";

export interface SensitiveHit {
  kind: SensitiveContentKind;
  /** 命中在输入字串中的起始索引（只给定位用，不含原文）。 */
  index: number;
}

export interface SensitiveScanResult {
  clean: boolean;
  hits: SensitiveHit[];
}

/**
 * 样式表（`source` 以字串保存、每次扫描现场编译）：全域正则带 `lastIndex` 状态，
 * 共用实例会让第二次扫描漏命中，故不共用。
 *
 * - `pem_private_key`：`-----BEGIN [RSA|EC|OPENSSH|…] PRIVATE KEY-----`（私钥块开头）
 * - `api_key_sk`：`sk-` 家族（含 `sk-biz-`／`sk-proj-` 等变体；**要求 ≥8 位后续字元**，
 *   故散文里单独出现的 `sk-` 不误杀）
 * - `aws_access_key_id`：`AKIA` + 16 位大写英数
 * - `jwt`：三段 base64url 以 `.` 相连且首段以 `eyJ` 开头
 * - `bearer_token`：`Bearer <token>`（大小写不敏感）
 * - `cn_mobile`：`1[3-9]` 开头 11 位数；以字母数字作前后界，避免命中长杂凑中的数字串
 * - `assigned_secret`：`password=`／`passwd=`／`secret=`／`token=` 后接非空白值
 */
const SENSITIVE_PATTERNS: ReadonlyArray<{
  kind: SensitiveContentKind;
  source: string;
  flags: string;
}> = [
  {
    kind: "pem_private_key",
    source: "-----BEGIN[A-Z ]{0,40}PRIVATE KEY-----",
    flags: "g",
  },
  { kind: "api_key_sk", source: "sk-[A-Za-z0-9_-]{8,}", flags: "g" },
  { kind: "aws_access_key_id", source: "AKIA[0-9A-Z]{16}", flags: "g" },
  {
    kind: "jwt",
    source: "\\beyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}",
    flags: "g",
  },
  {
    kind: "bearer_token",
    source: "\\bBearer[ \\t]+[A-Za-z0-9._~+/=-]{8,}",
    flags: "gi",
  },
  {
    kind: "cn_mobile",
    source: "(?<![0-9A-Za-z])1[3-9][0-9]{9}(?![0-9])",
    flags: "g",
  },
  {
    kind: "assigned_secret",
    source: "\\b(?:password|passwd|secret|token)\\s*=\\s*[^\\s\"',;}]{1,}",
    flags: "gi",
  },
];

/** 稳定理由前缀：`sensitive_content:<kind>`（route 原样回传，不含命中原文）。 */
export const SENSITIVE_REASON_PREFIX = "sensitive_content:";

/** 扫描一段文字：回 `{ clean, hits }`；`hits` 只含种类与索引，**永不回原文**。 */
export function scanSensitiveContent(text: string): SensitiveScanResult {
  const input = typeof text === "string" ? text : "";
  if (!input) return { clean: true, hits: [] };

  const hits: SensitiveHit[] = [];
  for (const { kind, source, flags } of SENSITIVE_PATTERNS) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(source, flags);
    } catch {
      continue; // 样式表是常数，编译失败视为不影响发布（不抛）
    }
    try {
      for (const match of input.matchAll(pattern)) {
        hits.push({ kind, index: match.index ?? 0 });
      }
    } catch {
      continue;
    }
  }
  hits.sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind));
  return { clean: hits.length === 0, hits };
}

/** 逐栏扫描，回第一条稳定理由（`sensitive_content:<kind>`）或 null。 */
function sensitiveReason(values: readonly string[]): string | null {
  for (const value of values) {
    const scan = scanSensitiveContent(value);
    if (!scan.clean) return `${SENSITIVE_REASON_PREFIX}${scan.hits[0].kind}`;
  }
  return null;
}

// ─────────────────────────── 栏位验证

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 文字栏位通用防线：控制字元、行首 heading 伪造（会破坏段落往返）。 */
function textFieldReject(value: string, max: number): string | null {
  if (CONTROL_CHARS.test(value)) return "control_char";
  for (const line of value.split("\n")) {
    if (line.trimStart().startsWith("## ")) return "heading_like_line";
  }
  if (Array.from(value).length > max) return "too_long";
  return null;
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = asTrimmedString(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 使用者 skill 的 id：`user-<family>-<name 派生 ascii 前缀>-<name sha256 前 8 位>`。
 * - `user-` 前缀与内建 id 天然分家；
 * - 尾端 hash 保证「不同名 ≠ 同 id」——只靠 ascii 前缀会让「AI 口播」「AI 剪辑」
 *   撞成同一条，发布第二条时**静默覆盖**第一条（真实事故，故不接受）；
 * - CJK 名 ascii 段为空 → 只留 hash，仍决定性（同名重发布＝更新，非新增）。
 */
export function userSkillId(name: string, family: AgentSkillFamily): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  const hash = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8);
  const slug = `user-${family}-${ascii ? `${ascii}-` : ""}${hash}`;
  return SLUG_PATTERN.test(slug) ? slug : "";
}

/**
 * 草稿验证（正规化）：trim、去重、长度与注册表成员检查。
 * 合法 → `{ ok: true, skill }`；任何一项不合 → `{ ok: false, reason }`（稳定的
 * snake_case 理由字串，route 原样回给客户端）。
 */
export function validateUserSkill(input: UserSkillDraft | null | undefined): UserSkillValidation {
  const draft = (input ?? {}) as UserSkillDraft;

  const name = asTrimmedString(draft.name);
  if (!name) return { ok: false, reason: "name_required" };
  if (Array.from(name).length > USER_SKILL_NAME_MAX) return { ok: false, reason: "name_too_long" };
  if (CONTROL_CHARS.test(name) || name.includes("\n")) return { ok: false, reason: "name_invalid" };

  const oneLiner = asTrimmedString(draft.oneLiner);
  if (!oneLiner) return { ok: false, reason: "one_liner_required" };
  if (Array.from(oneLiner).length > USER_SKILL_ONE_LINER_MAX) {
    return { ok: false, reason: "one_liner_too_long" };
  }
  const oneLinerReject = textFieldReject(oneLiner, USER_SKILL_ONE_LINER_MAX);
  if (oneLinerReject) return { ok: false, reason: `one_liner_${oneLinerReject}` };

  const family = asTrimmedString(draft.family) as AgentSkillFamily;
  if (!FAMILIES.includes(family)) return { ok: false, reason: "family_invalid" };

  const outputKind = asTrimmedString(draft.outputKind) as AgentSkillOutputKind;
  if (!OUTPUT_KINDS.includes(outputKind)) return { ok: false, reason: "output_kind_invalid" };

  const useScenario = asTrimmedString(draft.useScenario);
  if (!useScenario) return { ok: false, reason: "use_scenario_required" };
  const scenarioReject = textFieldReject(useScenario, USER_SKILL_TEXT_MAX);
  if (scenarioReject) return { ok: false, reason: `use_scenario_${scenarioReject}` };

  const inputType = asTrimmedString(draft.inputType);
  if (!inputType) return { ok: false, reason: "input_type_required" };
  const inputReject = textFieldReject(inputType, USER_SKILL_TEXT_MAX);
  if (inputReject) return { ok: false, reason: `input_type_${inputReject}` };

  const outputContent = asTrimmedString(draft.outputContent);
  if (!outputContent) return { ok: false, reason: "output_content_required" };
  const outputReject = textFieldReject(outputContent, USER_SKILL_TEXT_MAX);
  if (outputReject) return { ok: false, reason: `output_content_${outputReject}` };

  const toolIds = normalizeList(draft.toolIds);
  if (toolIds.length === 0) return { ok: false, reason: "tool_ids_required" };
  if (toolIds.length > USER_SKILL_TOOL_IDS_MAX) return { ok: false, reason: "tool_ids_count" };
  for (const toolId of toolIds) {
    if (!HARNESS_TOOL_IDS.has(toolId)) return { ok: false, reason: "tool_id_not_found" };
  }

  const tags = normalizeList(draft.tags);
  if (tags.length < USER_SKILL_TAGS_MIN) return { ok: false, reason: "tags_required" };
  if (tags.length > USER_SKILL_TAGS_MAX) return { ok: false, reason: "tags_count" };
  for (const tag of tags) {
    if (CONTROL_CHARS.test(tag) || tag.includes("\n")) return { ok: false, reason: "tag_invalid" };
    if (Array.from(tag).length > USER_SKILL_TAG_MAX) return { ok: false, reason: "tag_too_long" };
  }

  const expertIdRaw = asTrimmedString(draft.expertId);
  if (expertIdRaw && !Object.prototype.hasOwnProperty.call(EXPERT_REGISTRY, expertIdRaw)) {
    return { ok: false, reason: "expert_not_found" };
  }

  const aesthetic = asTrimmedString(draft.aesthetic);
  if (aesthetic) {
    const aestheticReject = textFieldReject(aesthetic, USER_SKILL_TEXT_MAX);
    if (aestheticReject) return { ok: false, reason: `aesthetic_${aestheticReject}` };
  }

  const requestedId = asTrimmedString(draft.id);
  if (requestedId && (!SLUG_PATTERN.test(requestedId) || !requestedId.startsWith("user-"))) {
    return { ok: false, reason: "id_invalid" };
  }
  const id = requestedId || userSkillId(name, family);
  if (!id) return { ok: false, reason: "id_invalid" };

  // 凭证闸：所有**会落进记忆正文**的栏位（含 links 取用的 name／tags／aesthetic）
  // 一律先扫；命中即拒。reason 只带种类代码，命中原文不进 reason／log／回应。
  const sensitive = sensitiveReason([
    useScenario,
    inputType,
    outputContent,
    name,
    oneLiner,
    ...(aesthetic ? [aesthetic] : []),
    ...tags,
  ]);
  if (sensitive) return { ok: false, reason: sensitive };

  const skill: AgentSkillView = {
    id,
    name,
    oneLiner,
    family,
    useScenario,
    inputType,
    outputContent,
    outputKind,
    toolIds,
    tags,
    source: "user",
    ...(expertIdRaw ? { expertId: expertIdRaw } : {}),
    ...(aesthetic ? { aesthetic } : {}),
  };

  if (Array.from(serializeSkillBody(skill)).length > USER_SKILL_BODY_MAX) {
    return { ok: false, reason: "content_too_long" };
  }

  return { ok: true, skill };
}

// ─────────────────────────── skill → memory doc

/** 机器可读栏位（links）：解析的唯一真源，顺序固定。 */
function skillLinks(skill: AgentSkillView): string[] {
  const links = [
    USER_SKILL_SOURCE_MARKER,
    `${USER_SKILL_LINK_PREFIX}name=${skill.name}`,
    `${USER_SKILL_LINK_PREFIX}family=${skill.family}`,
    `${USER_SKILL_LINK_PREFIX}output-kind=${skill.outputKind}`,
  ];
  for (const toolId of skill.toolIds) links.push(`${USER_SKILL_LINK_PREFIX}tool=${toolId}`);
  if (skill.expertId) links.push(`${USER_SKILL_LINK_PREFIX}expert=${skill.expertId}`);
  for (const tag of skill.tags) links.push(`${USER_SKILL_LINK_PREFIX}tag=${tag}`);
  return links;
}

/** 可读正文（稳定、可反向解析）：标题＋一句话＋使用场景＋输入＋交付＋美学锚＋标签＋工具。 */
export function serializeSkillBody(skill: AgentSkillView): string {
  const parts = [
    `# ${skill.name}`,
    "",
    skill.oneLiner,
    "",
    `## ${SECTION_SCENARIO}`,
    skill.useScenario,
    "",
    `## ${SECTION_INPUT}`,
    skill.inputType,
    "",
    `## ${SECTION_DELIVERABLE}`,
    skill.outputContent,
  ];
  if (skill.aesthetic) {
    parts.push("", `## ${SECTION_AESTHETIC}`, skill.aesthetic);
  }
  parts.push(
    "",
    `## ${SECTION_TAGS}`,
    skill.tags.join("、"),
    "",
    `## ${SECTION_TOOLS}`,
    skill.toolIds.join(", "),
  );
  return parts.join("\n").trim();
}

/**
 * skill → store 输入。**纯函式**，不碰存储；配额／去重／结构防线交给
 * `ingestMemoryDocs`。scope 固定 `private`（使用者私有库）；`ownerKey` 空字串
 * 时由 store 的 structure 防线拒收（本档不代它判、不抛）。
 */
export function skillToMemoryDoc(
  skill: AgentSkillView,
  options: { ownerKey?: string | null } = {},
): AgentMemoryDocInput {
  return {
    scope: "private",
    ownerKey: asTrimmedString(options?.ownerKey),
    domain: skill.family,
    slug: skill.id,
    description: skill.oneLiner,
    type: "workflow",
    body: serializeSkillBody(skill),
    links: skillLinks(skill),
    evidence: "使用者自建并发布的 skill（作者自陈，未经 gateway 评分）。",
    evidenceKind: "user_confirmed",
    selfScore: USER_SKILL_SELF_SCORE,
    promptVersion: USER_SKILL_PROMPT_VERSION,
  };
}

// ─────────────────────────── memory doc → skill

/** 取 `\n## <header>\n` 到下一个 `\n## ` 之间的段落（值已 trim）；缺段落回 null。 */
function readSection(body: string, header: string): string | null {
  const marker = `\n## ${header}\n`;
  const start = body.indexOf(marker);
  if (start < 0) return null;
  const rest = body.slice(start + marker.length);
  const next = rest.indexOf("\n## ");
  const text = (next < 0 ? rest : rest.slice(0, next)).trim();
  return text || null;
}

/** links → 机器栏位；任何缺失／非法回 null（不得猜）。 */
function readSkillLinks(links: readonly string[]): {
  name: string;
  family: AgentSkillFamily;
  outputKind: AgentSkillOutputKind;
  toolIds: string[];
  expertId?: string;
  tags: string[];
} | null {
  const values = new Map<string, string[]>();
  let hasMarker = false;
  for (const link of links) {
    if (typeof link !== "string" || !link.startsWith(USER_SKILL_LINK_PREFIX)) continue;
    const payload = link.slice(USER_SKILL_LINK_PREFIX.length);
    const eq = payload.indexOf("=");
    if (eq <= 0) continue;
    const key = payload.slice(0, eq);
    const value = payload.slice(eq + 1);
    if (!value) continue;
    if (key === "source") {
      if (value === "user") hasMarker = true;
      continue;
    }
    const bucket = values.get(key) ?? [];
    bucket.push(value);
    values.set(key, bucket);
  }
  if (!hasMarker) return null;

  const name = values.get("name")?.[0] ?? "";
  const family = values.get("family")?.[0] ?? "";
  const outputKind = values.get("output-kind")?.[0] ?? "";
  const toolIds = values.get("tool") ?? [];
  const tags = values.get("tag") ?? [];
  const expertId = values.get("expert")?.[0];

  if (!name || Array.from(name).length > USER_SKILL_NAME_MAX) return null;
  if (!FAMILIES.includes(family as AgentSkillFamily)) return null;
  if (!OUTPUT_KINDS.includes(outputKind as AgentSkillOutputKind)) return null;
  if (toolIds.length === 0 || toolIds.length > USER_SKILL_TOOL_IDS_MAX) return null;
  if (toolIds.some((id) => !HARNESS_TOOL_IDS.has(id))) return null;
  if (tags.length < USER_SKILL_TAGS_MIN || tags.length > USER_SKILL_TAGS_MAX) return null;
  if (expertId && !Object.prototype.hasOwnProperty.call(EXPERT_REGISTRY, expertId)) return null;

  return {
    name,
    family: family as AgentSkillFamily,
    outputKind: outputKind as AgentSkillOutputKind,
    toolIds,
    tags,
    ...(expertId ? { expertId } : {}),
  };
}

/**
 * memory doc → skill view。不是使用者 skill 文件／栏位不全／值域非法 → `null`，
 * 任何情况都不抛（畸形 `links`、非字串 body 等）。
 */
export function memoryDocToSkill(
  doc: AgentMemoryDoc | null | undefined,
): AgentSkillView | null {
  if (!doc || typeof doc !== "object") return null;
  const slug = typeof doc.slug === "string" ? doc.slug : "";
  if (!SLUG_PATTERN.test(slug) || !slug.startsWith("user-")) return null;
  const oneLiner = typeof doc.description === "string" ? doc.description.trim() : "";
  if (!oneLiner) return null;
  const body = typeof doc.body === "string" ? doc.body : "";
  if (!body) return null;
  const links = Array.isArray(doc.links) ? doc.links : [];

  const machine = readSkillLinks(links);
  if (!machine) return null;

  const useScenario = readSection(body, SECTION_SCENARIO);
  const inputType = readSection(body, SECTION_INPUT);
  const outputContent = readSection(body, SECTION_DELIVERABLE);
  if (!useScenario || !inputType || !outputContent) return null;
  const aesthetic = readSection(body, SECTION_AESTHETIC);

  return {
    id: slug,
    name: machine.name,
    oneLiner,
    family: machine.family,
    useScenario,
    inputType,
    outputContent,
    outputKind: machine.outputKind,
    toolIds: machine.toolIds,
    tags: machine.tags,
    source: "user",
    ...(machine.expertId ? { expertId: machine.expertId } : {}),
    ...(aesthetic ? { aesthetic } : {}),
  };
}

/** 把一串记忆文件转成 skill 视图（非 skill 文件自动滤掉）。纯函式。 */
export function userSkillsFromMemoryDocs(
  docs: readonly AgentMemoryDoc[] | null | undefined,
): AgentSkillView[] {
  const out: AgentSkillView[] = [];
  for (const doc of docs ?? []) {
    const skill = memoryDocToSkill(doc);
    if (skill) out.push(skill);
  }
  return out;
}

// ─────────────────────────── 私有 CRUD（route 的业务本体，可独立行为测）

/** store 的拒绝理由 → 本端 HTTP 语义（reason 原样带出，不改写）。 */
export function skillRejectionStatus(reason: MemoryRejectReason): { status: number; error: string } {
  if (reason === "duplicate") return { status: 409, error: "duplicate" };
  if (reason === "quota_scope" || reason === "quota_domain") {
    return { status: 429, error: "quota_exceeded" };
  }
  return { status: 400, error: "invalid_skill" };
}

export type SaveMySkillResult =
  | { ok: true; skill: AgentSkillView; created: boolean }
  | { ok: false; status: number; error: string; reason: string };

/**
 * 建立／更新**自己**的私有 skill（`POST /api/skills/mine` 的业务本体）。
 *
 * 归属判定：`draft.id` 存在 **且该 id 就在自己的私有库** → 更新（沿用同 id，store
 * 做 revision+1）；否则一律**建立**，且**丢掉 caller 带来的 id** 改由验证器派生——
 * 不允许使用者用自带 id 造壳，也让「拿别人的 id 来写」自然落成自己库里的新条目
 * （既不改到别人、也不以 403/409 泄漏他人资源存在性）。
 *
 * 配额（G7）、去重（G5）、结构防线全在 store 的 `ingestMemoryDocs`，本函式
 * **零自造闸门**，只把 store 的拒绝理由映射成 HTTP 语义。
 */
export async function saveMySkill(
  ownerKey: string | null | undefined,
  draft: UserSkillDraft | null | undefined,
): Promise<SaveMySkillResult> {
  const owner = asTrimmedString(ownerKey);
  if (!owner) return { ok: false, status: 401, error: "unauthorized", reason: "not_signed_in" };

  const requestedId = asTrimmedString((draft ?? {}).id);
  const existing = requestedId
    ? (await userSkillLoader(owner)).find((skill) => skill.id === requestedId)
    : undefined;

  const validated = validateUserSkill({ ...(draft ?? {}), id: existing ? existing.id : undefined });
  if (!validated.ok) {
    return { ok: false, status: 400, error: "invalid_skill", reason: validated.reason };
  }
  const skill = validated.skill;

  const doc = skillToMemoryDoc(skill, { ownerKey: owner });
  const batchId = `user-skill-${owner.slice(0, 12)}-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")}`;

  let result: MemoryIngestResult;
  try {
    result = await ingestMemoryDocs({
      batchId,
      promptVersion: USER_SKILL_PROMPT_VERSION,
      docs: [doc],
    });
  } catch {
    return { ok: false, status: 500, error: "internal_error", reason: "store_unavailable" };
  }

  const rejected = result.rejected.find((entry) => entry.slug === doc.slug);
  if (rejected) {
    const mapped = skillRejectionStatus(rejected.reason);
    return { ok: false, status: mapped.status, error: mapped.error, reason: rejected.reason };
  }
  // private reconcile 的 NOOP：候选与同库既有 skill 被判为「同一事实」，只刷新
  // lastConfirmedAt，不新增文档、不进 accepted。对本端点而言这就是重复发布
  // （store 的 G5 duplicate 在 reconcile 之后才轮到这里）——映射成 409 duplicate，
  // 不得落进下面的 400 invalid_skill/structure。
  if ((result.noop?.length ?? 0) > 0) {
    const mapped = skillRejectionStatus("duplicate");
    return { ok: false, status: mapped.status, error: mapped.error, reason: "duplicate" };
  }
  if (result.accepted.length === 0) {
    return { ok: false, status: 400, error: "invalid_skill", reason: "structure" };
  }
  return { ok: true, skill, created: !existing };
}

export type DeleteMySkillResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: string };

/**
 * 删除**自己**的私有 skill（`DELETE /api/skills/mine/<id>` 的业务本体）。
 *
 * 只在呼叫者自己的 private 库里按 slug 找，且该 doc 必须仍解析得出 skill
 * （避免拿这个端点误删同库里的普通记忆文件）；找不到／不是自己的 → **404**，
 * 不用 403，不以状态码泄漏他人资源存在性。删除复用 store 的 `retractMemoryDocs`
 * （status=retracted + 索引移除，档案留证），**不自造第二套删除**。
 */
export async function deleteMySkill(
  ownerKey: string | null | undefined,
  id: string | null | undefined,
): Promise<DeleteMySkillResult> {
  const owner = asTrimmedString(ownerKey);
  if (!owner) return { ok: false, status: 401, error: "unauthorized" };
  const key = asTrimmedString(id);
  if (!key) return { ok: false, status: 404, error: "not_found" };

  let docs: AgentMemoryDoc[];
  try {
    docs = await listMemoryDocs({ scope: "private", ownerKey: owner });
  } catch {
    return { ok: false, status: 500, error: "internal_error" };
  }
  const doc = docs.find((entry) => entry.slug === key && memoryDocToSkill(entry) !== null);
  if (!doc) return { ok: false, status: 404, error: "not_found" };

  try {
    const { retracted } = await retractMemoryDocs({ docIds: [doc.id] });
    if (!retracted.includes(doc.id)) return { ok: false, status: 500, error: "internal_error" };
  } catch {
    return { ok: false, status: 500, error: "internal_error" };
  }
  return { ok: true, id: key };
}

// ─────────────────────────── 注册（复用 registry 的单一插槽）

export { registerUserSkillSource } from "./registry";

/**
 * 载入器：**本身就是 registry 插槽期待的形状** `(ownerKey) => Promise<AgentSkillView[]>`
 * ——读该 ownerKey 的私有库并逐条解析成 skill。
 * 用法：`registerUserSkillSource(userSkillLoader)`。
 *
 * 隔离纪律：ownerKey 空（未登入／无 key）→ 回空集合，**永不回全体**；插槽只认这个
 * 带 ownerKey 的签名，没有「无参数版本」可退回，故不存在「回传所有人资料」的介面。
 *
 * 读取失败（blob 不可达等）→ 回空集合不抛：个人 skill 故障不该拖垮全库列举
 * （与 registry 对来源抛错的处理同款，这里先一步吞掉，错误不进使用者视野）。
 */
export async function userSkillLoader(ownerKey: string | null | undefined): Promise<AgentSkillView[]> {
  const owner = asTrimmedString(ownerKey);
  if (!owner) return [];
  try {
    return userSkillsFromMemoryDocs(await listMemoryDocs({ scope: "private", ownerKey: owner }));
  } catch {
    return [];
  }
}
