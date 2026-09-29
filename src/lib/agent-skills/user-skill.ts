/**
 * 使用者自建 Skill ⇄ agent-memory 記憶文件（2026-09-27 立）。
 *
 * 定位（**禁造第二套**）：使用者自建 Skill **就是**既有 `agent-memory-store`
 * 的一種記憶文件，不是第二個儲存／審核／配額系統。本檔只做兩件事：
 *   1. `AgentSkillView`（= `AgentSkillSpec` + `source: "user"`）與
 *      `AgentMemoryDocInput` 之間的**純函式**雙向轉換；
 *   2. 發布前的欄位驗證。
 * 配額（G7）、去重（G5）、結構防線（structure）**一律複用 store**：
 * 寫入路徑是 `ingestMemoryDocs`，本檔不碰 blob/Map，不自己計數。
 *
 * 欄位落位（不改 store、不新增欄位）：`AgentMemoryDocInput` 可用欄位只有
 * scope / ownerKey / domain / slug / description / type / body / links /
 * evidence / evidenceKind / selfScore / promptVersion。故：
 *   - `slug`        ← `skill.id`（`user-<family>-[<ascii>-]<name hash8>`，符合 store
 *                     的 `^[a-z0-9-]{1,64}$`；`user-` 前綴與內建 id 分家，尾端 hash
 *                     保證不同名不撞同一條＝不會靜默覆蓋）
 *   - `domain`      ← `skill.family`（索引行 `- [family] slug — oneLiner` 可讀；
 *                     同時把 G7 的「單 domain ≤8/日」分攤到各家族，不互相擠壓）
 *   - `description` ← `skill.oneLiner`（≤24 字，遠在 store 的 120 上限內）
 *   - `body`        ← 穩定 markdown（標題＋一句話＋使用場景＋輸入＋交付＋
 *                     美學錨＋標籤＋工具），供召回語料與人眼閱讀
 *   - `links`       ← **機器可讀欄位**（source 標記／name／family／output-kind／
 *                     tool／expert／tag），`user-skill:` 前綴，解析的唯一真源
 *   - `type`        ← `workflow`（使用者自建方法；領域知識類走 `domain`）
 *   - `evidenceKind`← `user_confirmed`（作者自陳，非工具結果）
 *
 * 往返契約（硬）：`memoryDocToSkill(skillToMemoryDoc(s))` 等價於 `s`，
 * 其中 `s` 由 `validateUserSkill` 產出（欄位已正規化）。解析不出來一律回
 * `null`（**不得猜**）：`links` 缺 source 標記 / 缺必要欄位、body 缺必要段落、
 * slug 不符形狀、tool/expert 不在真源註冊表，全部視為非使用者 skill 文件。
 *
 * 註冊介面：`registerUserSkillSource(fn)` 的**唯一真源在 `agent-skills/registry.ts`**
 * （2026-09-27 由另一路落地；同日改為 ownerKey 參數化 `(ownerKey) => Promise<AgentSkillView[]>`）。
 * 本檔**不再自建第二個插槽**，只 `export { registerUserSkillSource }` 逐字轉出（讓
 * 呼叫端可從本檔一處拿到「轉換＋驗證＋註冊」三件事），並提供 `userSkillLoader(ownerKey)`
 * 這個與插槽同形的載入器（讀該 ownerKey 的私有庫 → 逐條解析）。
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

/** 使用者 skill 的視圖：複用 registry 的單一 `AgentSkillView` 定義，收窄來源為 `"user"`。 */
export type AgentSkillView = RegisteredSkillView & { source: "user" };

/** 發布草稿：使用者在瀏覽器端填的欄位（`id` 可選，供既有 skill 改名以外的更新）。 */
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
/** 標記：這份記憶文件確實是一條使用者自建 skill（缺它就回 null）。 */
export const USER_SKILL_SOURCE_MARKER = `${USER_SKILL_LINK_PREFIX}source=user`;
export const USER_SKILL_PROMPT_VERSION = "user-skill-v1";
/** 作者自陳、未經 gateway G6 評分：中性分，不假裝高分。 */
export const USER_SKILL_SELF_SCORE = 0.5;

export const USER_SKILL_NAME_MAX = 32;
export const USER_SKILL_ONE_LINER_MAX = 24;
export const USER_SKILL_TAGS_MIN = 1;
export const USER_SKILL_TAGS_MAX = 8;
export const USER_SKILL_TAG_MAX = 24;
export const USER_SKILL_TOOL_IDS_MAX = 16;
/** 長文本欄位上界（讓 body 穩定落在 store 的 2000 字元上限內）。 */
export const USER_SKILL_TEXT_MAX = 400;
/** store `isStructurallyValid` 對 body 的上限；此處先一步給明確理由。 */
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
/** 控制字元：允許 \n 與 \t，其餘拒絕（\r 也拒，避免 CRLF 破壞段落解析）。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const SECTION_SCENARIO = "使用場景";
const SECTION_INPUT = "輸入";
const SECTION_DELIVERABLE = "交付";
const SECTION_AESTHETIC = "美學錨";
const SECTION_TAGS = "標籤";
const SECTION_TOOLS = "工具";

// ─────────────────────────── 憑證／秘密閘（最小面）

/**
 * 憑證／秘密掃描（2026-09-27 立）：使用者把「使用場景／輸入／交付」等長文本貼進來時，
 * 可能在正文裡夾帶 `sk-…`、Bearer、私鑰、JWT、手機號或 `password=…`。這些內容一旦
 * 寫進 agent-memory 就是**永久落庫**（`AGENTS.md` 紅線：secret／憑證／token／OTP／
 * 私鑰永不入 log／memory／commit），故發布前先掃。
 *
 * 界線（**不越權**）：只認「憑證／秘密」這一類的事實；**不做**敏感詞庫、內容審查、
 * 政治審查或計費閘。命中回傳**種類與索引**，永不回傳命中的原文——避免秘密經由
 * reason／log／回應體二次外洩（route 只把 `<kind>` 帶給客戶端）。
 *
 * 純函式、無 I/O、不拋錯（非字串／畸形輸入一律回乾淨）。
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
  /** 命中在輸入字串中的起始索引（只給定位用，不含原文）。 */
  index: number;
}

export interface SensitiveScanResult {
  clean: boolean;
  hits: SensitiveHit[];
}

/**
 * 樣式表（`source` 以字串保存、每次掃描現場編譯）：全域正則帶 `lastIndex` 狀態，
 * 共用實例會讓第二次掃描漏命中，故不共用。
 *
 * - `pem_private_key`：`-----BEGIN [RSA|EC|OPENSSH|…] PRIVATE KEY-----`（私鑰塊開頭）
 * - `api_key_sk`：`sk-` 家族（含 `sk-biz-`／`sk-proj-` 等變體；**要求 ≥8 位後續字元**，
 *   故散文裡單獨出現的 `sk-` 不誤殺）
 * - `aws_access_key_id`：`AKIA` + 16 位大寫英數
 * - `jwt`：三段 base64url 以 `.` 相連且首段以 `eyJ` 開頭
 * - `bearer_token`：`Bearer <token>`（大小寫不敏感）
 * - `cn_mobile`：`1[3-9]` 開頭 11 位數；以字母數字作前後界，避免命中長雜湊中的數字串
 * - `assigned_secret`：`password=`／`passwd=`／`secret=`／`token=` 後接非空白值
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

/** 穩定理由前綴：`sensitive_content:<kind>`（route 原樣回傳，不含命中原文）。 */
export const SENSITIVE_REASON_PREFIX = "sensitive_content:";

/** 掃描一段文字：回 `{ clean, hits }`；`hits` 只含種類與索引，**永不回原文**。 */
export function scanSensitiveContent(text: string): SensitiveScanResult {
  const input = typeof text === "string" ? text : "";
  if (!input) return { clean: true, hits: [] };

  const hits: SensitiveHit[] = [];
  for (const { kind, source, flags } of SENSITIVE_PATTERNS) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(source, flags);
    } catch {
      continue; // 樣式表是常數，編譯失敗視為不影響發布（不拋）
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

/** 逐欄掃描，回第一條穩定理由（`sensitive_content:<kind>`）或 null。 */
function sensitiveReason(values: readonly string[]): string | null {
  for (const value of values) {
    const scan = scanSensitiveContent(value);
    if (!scan.clean) return `${SENSITIVE_REASON_PREFIX}${scan.hits[0].kind}`;
  }
  return null;
}

// ─────────────────────────── 欄位驗證

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 文字欄位通用防線：控制字元、行首 heading 偽造（會破壞段落往返）。 */
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
 * 使用者 skill 的 id：`user-<family>-<name 派生 ascii 前綴>-<name sha256 前 8 位>`。
 * - `user-` 前綴與內建 id 天然分家；
 * - 尾端 hash 保證「不同名 ≠ 同 id」——只靠 ascii 前綴會讓「AI 口播」「AI 剪輯」
 *   撞成同一條，發布第二條時**靜默覆蓋**第一條（真實事故，故不接受）；
 * - CJK 名 ascii 段為空 → 只留 hash，仍決定性（同名重發布＝更新，非新增）。
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
 * 草稿驗證（正規化）：trim、去重、長度與註冊表成員檢查。
 * 合法 → `{ ok: true, skill }`；任何一項不合 → `{ ok: false, reason }`（穩定的
 * snake_case 理由字串，route 原樣回給客戶端）。
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

  // 憑證閘：所有**會落進記憶正文**的欄位（含 links 取用的 name／tags／aesthetic）
  // 一律先掃；命中即拒。reason 只帶種類代碼，命中原文不進 reason／log／回應。
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

/** 機器可讀欄位（links）：解析的唯一真源，順序固定。 */
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

/** 可讀正文（穩定、可反向解析）：標題＋一句話＋使用場景＋輸入＋交付＋美學錨＋標籤＋工具。 */
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
 * skill → store 輸入。**純函式**，不碰存儲；配額／去重／結構防線交給
 * `ingestMemoryDocs`。scope 固定 `private`（使用者私有庫）；`ownerKey` 空字串
 * 時由 store 的 structure 防線拒收（本檔不代它判、不拋）。
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
    evidence: "使用者自建並發布的 skill（作者自陳，未經 gateway 評分）。",
    evidenceKind: "user_confirmed",
    selfScore: USER_SKILL_SELF_SCORE,
    promptVersion: USER_SKILL_PROMPT_VERSION,
  };
}

// ─────────────────────────── memory doc → skill

/** 取 `\n## <header>\n` 到下一個 `\n## ` 之間的段落（值已 trim）；缺段落回 null。 */
function readSection(body: string, header: string): string | null {
  const marker = `\n## ${header}\n`;
  const start = body.indexOf(marker);
  if (start < 0) return null;
  const rest = body.slice(start + marker.length);
  const next = rest.indexOf("\n## ");
  const text = (next < 0 ? rest : rest.slice(0, next)).trim();
  return text || null;
}

/** links → 機器欄位；任何缺失／非法回 null（不得猜）。 */
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
 * memory doc → skill view。不是使用者 skill 文件／欄位不全／值域非法 → `null`，
 * 任何情況都不拋（畸形 `links`、非字串 body 等）。
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

/** 把一串記憶文件轉成 skill 視圖（非 skill 文件自動濾掉）。純函式。 */
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

// ─────────────────────────── 私有 CRUD（route 的業務本體，可獨立行為測）

/** store 的拒絕理由 → 本端 HTTP 語義（reason 原樣帶出，不改寫）。 */
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
 * 建立／更新**自己**的私有 skill（`POST /api/skills/mine` 的業務本體）。
 *
 * 歸屬判定：`draft.id` 存在 **且該 id 就在自己的私有庫** → 更新（沿用同 id，store
 * 做 revision+1）；否則一律**建立**，且**丟掉 caller 帶來的 id** 改由驗證器派生——
 * 不允許使用者用自帶 id 造殼，也讓「拿別人的 id 來寫」自然落成自己庫裡的新條目
 * （既不改到別人、也不以 403/409 洩漏他人資源存在性）。
 *
 * 配額（G7）、去重（G5）、結構防線全在 store 的 `ingestMemoryDocs`，本函式
 * **零自造閘門**，只把 store 的拒絕理由映射成 HTTP 語義。
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
  if (result.accepted.length === 0) {
    return { ok: false, status: 400, error: "invalid_skill", reason: "structure" };
  }
  return { ok: true, skill, created: !existing };
}

export type DeleteMySkillResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: string };

/**
 * 刪除**自己**的私有 skill（`DELETE /api/skills/mine/<id>` 的業務本體）。
 *
 * 只在呼叫者自己的 private 庫裡按 slug 找，且該 doc 必須仍解析得出 skill
 * （避免拿這個端點誤刪同庫裡的普通記憶文件）；找不到／不是自己的 → **404**，
 * 不用 403，不以狀態碼洩漏他人資源存在性。刪除複用 store 的 `retractMemoryDocs`
 * （status=retracted + 索引移除，檔案留證），**不自造第二套刪除**。
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

// ─────────────────────────── 註冊（複用 registry 的單一插槽）

export { registerUserSkillSource } from "./registry";

/**
 * 載入器：**本身就是 registry 插槽期待的形狀** `(ownerKey) => Promise<AgentSkillView[]>`
 * ——讀該 ownerKey 的私有庫並逐條解析成 skill。
 * 用法：`registerUserSkillSource(userSkillLoader)`。
 *
 * 隔離紀律：ownerKey 空（未登入／無 key）→ 回空集合，**永不回全體**；插槽只認這個
 * 帶 ownerKey 的簽名，沒有「無參數版本」可退回，故不存在「回傳所有人資料」的介面。
 *
 * 讀取失敗（blob 不可達等）→ 回空集合不拋：個人 skill 故障不該拖垮全庫列舉
 * （與 registry 對來源拋錯的處理同款，這裡先一步吞掉，錯誤不進使用者視野）。
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
