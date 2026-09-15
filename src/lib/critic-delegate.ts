/**
 * 审核官委托单构造器 + 审核域工具产物 → Expert 交付物组装侧
 * （MOE 评测补课片翻正接线，2026-09-15）。
 *
 * 逐行镜像轮子真源 src/lib/screenwriter-delegate.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：composeDelegation / estimateTokens /
 * 结构化报错铁律 / DI 缺省范式 / collect 分拣链全部同构。白名单差异仅四处：
 *   ① 域字段换审核官版：review_target（必填，被审对象）/scope/checklist[]/
 *      reference_deliverables[]/deliverables 白名单收敛（未知键丢弃，防 payload
 *      注入，对齐 deliverables 白名单收敛同哲学）；无编剧 shotlist 结构化子物件
 *      对应物（spec 白名单外，未知键丢弃），故不搬 shotlistEntryField 取整器
 *      （同 motion-delegate 无该字段即不搬的先例）。委派 prompt 直接按白名单
 *      字段以审核词汇拼接。
 *   ② 交付物栏位：verdict / issues / evidence / qc 四栏（CRITIC_DELIVERABLES，
 *      与 expert-registry critic 行 requiredFields 同源——本档为该清单唯一真源，
 *      registry 行与 persona 均 import，禁手抄第二份）。
 *   ③ 宪法注入：beastMode === true 时把 deploy-staging/expert-gateway/
 *      expert-constitution.md 原文注入 prompt 头；OFF 时一个字不多、档案不触碰。
 *      beastMode 由调用方经 expert-registry.readBeastMode(settings) 计算后传入——
 *      本档不 import expert-registry（registry → persona → delegate 单向依赖，
 *      反向 import 成环，delegate 先载入会在 persona 顶层别名处 TDZ 崩，
 *      记忆 2026-09-08-wave1-b3-music-expert-registration / moe-reform-campaign-closure）。
 *      载入范式照搬 screenwriter-delegate 的 DI 缺省：loadConstitution 可注入，
 *      缺省 fs 读落位稿，读不到带原文死因结构化报错（诚实铁律，禁止静默降级）。
 *   ④ 域无本地工具档：harness 工具真源在 VPS .opencode/tools/（审核官只 search_web
 *      web 查证，见 critic-persona 工具白名单），本地 harness-tool-registry.ts 不
 *      登记该 id；工具回执契约形 CriticToolResult 本地定义（与 screenwriter
 *      ScreenwriterToolResult 同形 {title, output}，禁自造第二份形状）。
 *
 * ExpertId 联合含 "critic"（expert-contract.ts 翻正接线片追加，同 motion/video/
 * editor 各片先例），交付物走全型 ExpertDeliverable / ExpertTaskContract +
 * validateExpertDeliverable 全闸（同 screenwriter 版；critic 行已于 09-15 翻正
 * 部署片删 provisioned 键转正为激活可路由行，本档为其契约真源，运行时零耦合，
 * digest 已失去「（未启用）」标注、routeExpert 按 taskTypes 命中即生效）。
 *
 * screenwriter-delegate.ts / blender-delegate.ts 本体一行不动，本档只 import 其
 * estimateTokens / DELEGATION_TOKEN_BUDGET（单一真源，禁复制值）。
 * 文案一律简体（记忆 agent-gateway-copy-rules）。
 */

import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { DELEGATION_TOKEN_BUDGET, estimateTokens } from "./blender-delegate";
import {
  computeQcSignature,
  validateExpertDeliverable,
  type ExpertDeliverable,
  type ExpertTaskContract,
} from "./expert-contract";

// ─────────────────────────────────────────── ① 委托单构造器

/** 宪法落位稿路径（BEAST_MODE=ON 注入源；VPS gateway 同源引用）。 */
export const EXPERT_CONSTITUTION_PATH = "deploy-staging/expert-gateway/expert-constitution.md" as const;

/** 交付字段白名单（审核官四区块）：expert-registry critic 行 requiredFields 与本档同源。 */
export const CRITIC_DELIVERABLES = ["verdict", "issues", "evidence", "qc"] as const;
export type CriticDeliverable = (typeof CRITIC_DELIVERABLES)[number];

/** 交付物种类（审核域 kind，本档钉死；收口片翻正时对齐）。 */
export const CRITIC_DELIVERABLE_KIND = "quality_review" as const;

/** 工具回执契约形（域无本地工具档，本地定义；与 screenwriter ToolResult 同形）。 */
export type CriticToolResult = { title: string; output: string };

/** 委托单 schema（审核官契约，钉死不得更改）。 */
export interface CriticDelegationInput {
  /** 被审对象（一句话人话：审哪个交付物/声称、验什么收）。 */
  review_target: string;
  /** 审核范围/重点（可选，如「只核对数字可复算性」）。 */
  scope?: string;
  /** 审核要点清单（可选；缺省由审核官按交付契约自行展开）。 */
  checklist?: string[];
  /** 跨档对表的交付物指针（画布节点 id / 附件 path / URL，原样透传）。 */
  reference_deliverables?: string[];
  /** 交付字段清单（白名单：CRITIC_DELIVERABLES）。 */
  deliverables: CriticDeliverable[];
}

/** 委托单形（gateway 收到 JSON 后原样透传给审核官 subagent）。 */
export type CriticDelegation = CriticDelegationInput;

export type CriticDelegationResult =
  | { ok: true; delegation: CriticDelegation; serialized: string; estimated_tokens: number }
  | { ok: false; code: "invalid_delegation"; hint: string; fields: string[] };

/** 被审对象长度上限（防主脑塞整份交付物进委托单；同 screenwriter logline 口径）。 */
const REVIEW_TARGET_MAX = 600;
/** 审核范围/重点长度上限（同 screenwriter genre/tone 口径）。 */
const SCOPE_MAX = 120;
/** 审核要点条数/单条长度上限（同 screenwriter beats 口径）。 */
const CHECKLIST_MAX = 24;
const CHECKLIST_ITEM_MAX = 200;
/** 对表交付物指针条数/单条长度上限（同 screenwriter world_refs 口径）。 */
const REFERENCE_DELIVERABLES_MAX = 8;
const REFERENCE_DELIVERABLE_MAX_LEN = 200;

/**
 * 主脑 → 审核官委托单构造器。纯函数零副作用：校验不过返回结构化错误
 * （code/hint/fields），绝不 throw 原始错误（对齐 screenwriter-delegate 错误铁律）。
 */
export function composeCriticDelegation(input: unknown): CriticDelegationResult {
  const missing: string[] = [];
  const bad: string[] = [];
  const v = (input ?? {}) as Record<string, unknown>;

  // 必填栏位
  const reviewTarget = strField(v.review_target);
  if (reviewTarget === undefined) missing.push("review_target");
  const deliverables = v.deliverables;
  if (!Array.isArray(deliverables) || deliverables.length === 0) {
    missing.push("deliverables");
  }

  if (missing.length > 0 || !Array.isArray(deliverables) || reviewTarget === undefined) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单缺少必填字段：${missing.join("、")}。review_target 一句话被审对象（审哪个交付物/声称、验什么收）、deliverables 交付字段清单（${CRITIC_DELIVERABLES.join("/")}）均为必填。`,
      fields: missing,
    };
  }

  // deliverables 白名单收敛
  const cleanedDeliverables: CriticDeliverable[] = [];
  for (const d of deliverables) {
    if (typeof d === "string" && (CRITIC_DELIVERABLES as readonly string[]).includes(d)) {
      if (!cleanedDeliverables.includes(d as CriticDeliverable)) cleanedDeliverables.push(d as CriticDeliverable);
    } else {
      bad.push("deliverables");
      break;
    }
  }

  // 边界校验
  if (reviewTarget.length > REVIEW_TARGET_MAX) bad.push("review_target");
  const scope = strField(v.scope);
  if (scope !== undefined && scope.length > SCOPE_MAX) bad.push("scope");
  let checklist: string[] | undefined;
  if (v.checklist !== undefined) {
    if (Array.isArray(v.checklist)) {
      checklist = v.checklist.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
      if (checklist.length > CHECKLIST_MAX) bad.push("checklist");
      if (checklist.some((s) => s.length > CHECKLIST_ITEM_MAX)) bad.push("checklist");
    } else {
      bad.push("checklist");
    }
  }
  let referenceDeliverables: string[] | undefined;
  if (v.reference_deliverables !== undefined) {
    if (Array.isArray(v.reference_deliverables)) {
      referenceDeliverables = v.reference_deliverables
        .filter((r): r is string => typeof r === "string" && r.trim() !== "")
        .map((r) => r.trim());
      if (referenceDeliverables.length > REFERENCE_DELIVERABLES_MAX) bad.push("reference_deliverables");
      if (referenceDeliverables.some((r) => r.length > REFERENCE_DELIVERABLE_MAX_LEN)) bad.push("reference_deliverables");
    } else {
      bad.push("reference_deliverables");
    }
  }
  if (cleanedDeliverables.length === 0) bad.push("deliverables");

  if (bad.length > 0) {
    const unique = [...new Set(bad)];
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单字段超出契约边界：${unique.join("、")}。review_target ≤${REVIEW_TARGET_MAX} 字、scope ≤${SCOPE_MAX} 字、checklist ≤${CHECKLIST_MAX} 条（各 ≤${CHECKLIST_ITEM_MAX} 字）、reference_deliverables ≤${REFERENCE_DELIVERABLES_MAX} 条（各 ≤${REFERENCE_DELIVERABLE_MAX_LEN} 字）、deliverables 只接受 ${CRITIC_DELIVERABLES.join("、")}。`,
      fields: unique,
    };
  }

  const delegation: CriticDelegation = {
    review_target: reviewTarget,
    ...(scope !== undefined ? { scope } : {}),
    ...(checklist !== undefined && checklist.length > 0 ? { checklist } : {}),
    ...(referenceDeliverables !== undefined && referenceDeliverables.length > 0 ? { reference_deliverables: referenceDeliverables } : {}),
    deliverables: cleanedDeliverables,
  };
  const serialized = JSON.stringify(delegation);
  const estimated_tokens = estimateTokens(serialized);
  if (estimated_tokens > DELEGATION_TOKEN_BUDGET) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单超过 2k token 预算（估算 ${estimated_tokens} > ${DELEGATION_TOKEN_BUDGET}）。请精简 review_target / checklist 或减少 reference_deliverables。`,
      fields: ["review_target", "checklist", "reference_deliverables"],
    };
  }
  return { ok: true, delegation, serialized, estimated_tokens };
}

/** 粗估 token：复用 blender-delegate 单一真源（禁复制），口径 CJK 记 1、其余 ~0.25。 */
export { estimateTokens };

function strField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

// ─────────────────────────────────────────── ② 委派 prompt 组装（宪法注入挂点）

export interface CriticPromptAssemblyContext {
  /**
   * 野兽模式开关：调用方经 expert-registry.readBeastMode(settings) 计算后传入。
   * 本档不 import expert-registry（避免 registry → persona → delegate 依赖成环，
   * 见档头说明）。缺省 false = OFF = 宪法一个字不注入、档案不触碰。
   */
  beastMode?: boolean;
  /**
   * 宪法原文载入（DI，范式同 screenwriter/music-delegate loadConstitution）；
   * 缺省 fs 读 EXPERT_CONSTITUTION_PATH 落位稿。
   */
  loadConstitution?: () => string;
}

export type CriticPromptAssemblyResult =
  | { ok: true; prompt: string }
  | { ok: false; code: "constitution_unavailable"; hint: string };

/** 缺省宪法载入：fs 读落位稿（cwd = repo 根；VPS 侧可经 loadConstitution 整体替换）。 */
function defaultLoadConstitution(): string {
  return readFileSync(nodePath.resolve(process.cwd(), EXPERT_CONSTITUTION_PATH), "utf8");
}

/**
 * 审核官委派 prompt 组装（唯一出口）：宪法（仅 BEAST_MODE=ON，注入头部）+
 * 委托单任务段（白名单字段按审核域词汇直接拼接）。OFF 时一个字不多：宪法
 * 原文不出现、落位稿不被读取。宪法载入失败结构化报错（code/hint 带原文死因），
 * 绝不静默降级成无宪法派遣。
 */
export function assembleCriticPrompt(
  delegation: CriticDelegation,
  context: CriticPromptAssemblyContext = {},
): CriticPromptAssemblyResult {
  const checklist = delegation.checklist ?? [];
  const references = delegation.reference_deliverables ?? [];
  const body = [
    "# 审核官委托单",
    `被审对象：${delegation.review_target}`,
    `审核范围：${delegation.scope ?? "（未指定：逐栏全面核对交付契约）"}`,
    `审核要点（checklist）：${checklist.length > 0 ? checklist.join("；") : "（无；由审核官按交付契约自行展开）"}`,
    `对表交付物（reference_deliverables）：${references.length > 0 ? references.join("；") : "（无）"}`,
    `交付字段：${delegation.deliverables.join("、")}`,
  ].join("\n");

  if (context.beastMode !== true) {
    return { ok: true, prompt: body };
  }

  let constitution: string;
  try {
    constitution = (context.loadConstitution ?? defaultLoadConstitution)();
  } catch (e) {
    return {
      ok: false,
      code: "constitution_unavailable",
      hint: `宪法原文载入失败（${EXPERT_CONSTITUTION_PATH}）：${(e as Error)?.message ?? String(e)}。BEAST_MODE=ON 时宪法必须注入 prompt 头，禁止无宪法派遣；请确认落位稿存在，或经 loadConstitution 注入。`,
    };
  }
  return { ok: true, prompt: `${constitution}\n\n${body}` };
}

// ─────────────────────────────────────────── ③ 工具产物 → Expert 交付物（QC 签名 + 组装闸门）

/** collect 的依赖：派工契约（回指可追溯）。 */
export interface CriticDeliverableCollectContext {
  /** 派工契约（ExpertDeliverable.contract 回指，可追溯）。 */
  contract: ExpertTaskContract;
}

export type CriticDeliverableCollectResult =
  | { ok: true; deliverable: ExpertDeliverable }
  | {
      ok: false;
      code: "no_output" | "missing_deliverables" | "deliverable_invalid";
      hint: string;
      missing: string[];
    };

function strArrayField(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
}

/**
 * 审核域工具回执 → 四栏交付 payload → QC 签名 → 组装闸门自检。
 *
 * 契约（registry critic 行 requiredFields，钉死）：payload 四栏全形
 * （verdict/issues/evidence/qc），缺关键栏位返回结构化错误，不产半形数据（对齐
 * screenwriter-delegate collect 铁律）：
 *   - 工具回执 ok:false 或非 JSON = 未交付（no_output），禁止拿失败回执组装。
 *   - verdict 非空字符串、issues/evidence 为数组（审核通过时 issues 可为空数组，
 *     但键必须在场）、qc 非空、交付物指针（artifact_path 或 url 任一）非空——
 *     缺任一 = missing_deliverables。
 *   - 组装后 validateExpertDeliverable 不过 = deliverable_invalid（不外流）。
 */
export function collectCriticDeliverableFromToolResult(
  result: CriticToolResult,
  context: CriticDeliverableCollectContext,
): CriticDeliverableCollectResult {
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw: unknown = JSON.parse(typeof result?.output === "string" ? result.output : "");
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) parsed = raw as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      ok: false,
      code: "no_output",
      hint: "审核域工具回执不是合法 JSON 物件：output 必须是工具层 ok()/fail() 产出的 JSON 字符串，禁止手拼。",
      missing: ["output"],
    };
  }
  if (parsed.ok !== true) {
    const err = (parsed.error ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      code: "no_output",
      hint: `审核域工具回执 ok:false（未产出任何交付内容）：code=${String(err.code ?? "?")}，hint=${String(err.hint ?? "?")}。工具失败 = 未交付，禁止拿失败回执组装交付物。`,
      missing: ["ok"],
    };
  }

  const verdict = strField(parsed.verdict);
  const issues = Array.isArray(parsed.issues) ? (strArrayField(parsed.issues) ?? []) : undefined;
  const evidenceList = Array.isArray(parsed.evidence) ? (strArrayField(parsed.evidence) ?? []) : undefined;
  const qc = strField(parsed.qc);
  const artifactPath = strField(parsed.artifact_path);
  const url = strField(parsed.url);
  const missing: string[] = [];
  if (!verdict) missing.push("verdict（审核结论缺失）");
  if (issues === undefined) missing.push("issues（驳回清单须为数组；通过时可为空数组，但键必须在场）");
  if (evidenceList === undefined) missing.push("evidence（复算过程与指针须为数组；键必须在场）");
  if (!qc) missing.push("qc（自检结论缺失）");
  if (!artifactPath && !url) missing.push("交付物指针（artifact_path/url 均缺）");
  if (missing.length > 0) {
    const seen = Object.keys(parsed).join("、") || "（无）";
    return {
      ok: false,
      code: "missing_deliverables",
      hint: `交付物分拣缺关键栏位：${missing.join("、")}。payload 四栏必须全形（${CRITIC_DELIVERABLES.join("、")}，缺栏组装闸门不过），且必须附 artifact_path 或 url 交付物指针。回执实际字段：${seen}。`,
      missing,
    };
  }

  const payload: Record<string, unknown> = {
    verdict,
    issues,
    evidence: evidenceList,
    qc: `verdict=${verdict}; issues=${issues?.length ?? 0}; evidence=${evidenceList?.length ?? 0}; self_check=${qc}`,
  };

  const evidence: ExpertDeliverable["evidence"] = artifactPath ? { artifactPath } : { url: url as string };

  const deliverable: ExpertDeliverable = {
    expertId: "critic",
    kind: CRITIC_DELIVERABLE_KIND,
    payload,
    evidence,
    qcSignature: computeQcSignature({
      expertId: "critic",
      kind: CRITIC_DELIVERABLE_KIND,
      payload,
      evidence,
      contract: context.contract,
    }),
    contract: context.contract,
  };

  // 组装闸门自检：出厂即全形，闸门不过 = 内部缺陷，结构化报错不外流半形产物。
  const gate = validateExpertDeliverable(deliverable);
  if (!gate.ok) {
    return {
      ok: false,
      code: "deliverable_invalid",
      hint: `交付物组装闸门不过（内部自检）：${gate.errors.join("；")}`,
      missing: [],
    };
  }
  return { ok: true, deliverable };
}
