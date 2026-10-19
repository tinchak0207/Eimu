/**
 * 动态设计委托单构造器 + 动态域工具产物 → Expert 交付物组装侧
 * （MOE 改革 Wave2b 动态设计域，2026-09-08）。
 *
 * 逐行镜像轮子真源 src/lib/screenwriter-delegate.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：composeDelegation / estimateTokens /
 * 结构化报错铁律 / DI 缺省范式 / collect 分拣链全部同构。白名单差异仅三处：
 *   ① 域字段换动态设计版：motion_spec（必填）/keyframes[]/easing_notes/
 *      duration_hint/deliverable_format（Wave2b spec 钉死五件）；duration_hint
 *      正数秒四舍五入取整（同 music bpm / video duration_hint 取整口径）；
 *      无编剧 shotlist/characters 对应物（spec 白名单外，未知键丢弃防注入）。
 *   ② 交付物栏位：motion_spec / qc 两栏（MOTION_DELIVERABLES，与
 *      expert-registry motion-director 行 requiredFields 同源）；关键帧回显
 *      （keyframes_echo）非空时并入 payload。委托单原件（motion_spec 回写
 *      payload 兜底），故 collect context 含 delegation（同 video 版先例）。
 *   ③ 宪法注入：beastMode === true 时把 deploy-staging/expert-gateway/
 *      expert-constitution.md 原文注入 prompt 头；OFF 时一个字不多、档案不触碰。
 *      beastMode 由调用方经 expert-registry.readBeastMode(settings) 计算后传入——
 *      本档不 import expert-registry（registry → persona → delegate 单向依赖，
 *      反向 import 成环，delegate 先载入会在 persona 顶层别名处 TDZ 崩，
 *      记忆 2026-09-08-wave1-b3-music-expert-registration）。
 *      载入范式照搬 screenwriter-delegate 的 DI 缺省：loadConstitution 可注入，
 *      缺省 fs 读落位稿，读不到带原文死因结构化报错（诚实铁律，禁止静默降级）。
 *
 * ExpertId 联合已含 "motion-director"（expert-contract.ts Wave2a 占位追加），
 * 交付物走全型 ExpertDeliverable / ExpertTaskContract + validateExpertDeliverable
 * 全闸（同 screenwriter 版；Wave2 收口已接线，routeExpert 激活后即生效）。
 *
 * screenwriter-delegate.ts / blender-delegate.ts 本体一行不动，本档只 import 其
 * estimateTokens / DELEGATION_TOKEN_BUDGET（单一真源，禁复制值）。
 * 文案一律简体（记忆 agent-gateway-copy-rules）。
 */

import { loadBundledExpertConstitution } from "./expert-gateway-assets";
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

/** 交付字段白名单：与 expert-registry motion-director 行 requiredFields 一一对应。 */
export const MOTION_DELIVERABLES = ["motion_spec", "qc"] as const;
export type MotionDeliverableField = (typeof MOTION_DELIVERABLES)[number];

/** 交付物种类（动态设计域 kind，本档钉死；收口片翻正时对齐）。 */
export const MOTION_DESIGN_KIND = "motion_design" as const;

/** 工具回执契约形（域无本地工具档，本地定义；与 screenwriter ToolResult 同形）。 */
export type MotionToolResult = { title: string; output: string };

/** 委托单 schema（MOE Wave2b 契约，钉死不得更改）。 */
export interface MotionDelegationInput {
  /** 动态规格（一句人话：什么元素做什么运动、什么节奏与氛围）。 */
  motion_spec: string;
  /** 既有关键帧清单（可选；缺省由动态导演自主拆关键帧）。 */
  keyframes?: string[];
  /** 缓动/节奏笔记（可选：easing/时长分配/物理感约束）。 */
  easing_notes?: string;
  /** 时长档（正数秒，取整存储；缺省=导演按域行情自主定）。 */
  duration_hint?: number;
  /** 交付格式（可选，如 mp4 / gif / png 序列）。 */
  deliverable_format?: string;
  /** 交付字段清单（白名单：MOTION_DELIVERABLES）。 */
  deliverables: MotionDeliverableField[];
}

/** 委托单形（gateway 收到 JSON 后原样透传给动态设计 subagent）。 */
export type MotionDelegation = MotionDelegationInput;

export type MotionDelegationResult =
  | { ok: true; delegation: MotionDelegation; serialized: string; estimated_tokens: number }
  | { ok: false; code: "invalid_delegation"; hint: string; fields: string[] };

/** 动态规格长度上限（防主脑塞整篇规格书进委托单；同 screenwriter logline 口径）。 */
const MOTION_SPEC_MAX = 600;
/** 缓动/节奏笔记长度上限。 */
const EASING_NOTES_MAX = 1200;
/** 交付格式长度上限。 */
const DELIVERABLE_FORMAT_MAX = 40;
/** 关键帧条数/单条长度上限。 */
const KEYFRAMES_MAX = 24;
const KEYFRAME_MAX_LEN = 200;

/**
 * 主脑 → 动态设计委托单构造器。纯函数零副作用：校验不过返回结构化错误
 * （code/hint/fields），绝不 throw 原始错误（对齐 screenwriter-delegate 错误铁律）。
 * 未知键一律丢弃（委托单对象只由白名单字段构建，防 payload 注入）。
 */
export function composeMotionDelegation(input: unknown): MotionDelegationResult {
  const missing: string[] = [];
  const bad: string[] = [];
  const v = (input ?? {}) as Record<string, unknown>;

  // 必填栏位
  const motionSpec = strField(v.motion_spec);
  if (motionSpec === undefined) missing.push("motion_spec");
  const deliverables = v.deliverables;
  if (!Array.isArray(deliverables) || deliverables.length === 0) {
    missing.push("deliverables");
  }

  if (missing.length > 0 || !Array.isArray(deliverables) || motionSpec === undefined) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单缺少必填字段：${missing.join("、")}。motion_spec 一句话动态规格（什么元素做什么运动、什么节奏）、deliverables 交付字段清单（${MOTION_DELIVERABLES.join("/")}）均为必填。`,
      fields: missing,
    };
  }

  // deliverables 白名单收敛
  const cleanedDeliverables: MotionDeliverableField[] = [];
  for (const d of deliverables) {
    if (typeof d === "string" && (MOTION_DELIVERABLES as readonly string[]).includes(d)) {
      if (!cleanedDeliverables.includes(d as MotionDeliverableField)) cleanedDeliverables.push(d as MotionDeliverableField);
    } else {
      bad.push("deliverables");
      break;
    }
  }

  // 边界校验
  if (motionSpec.length > MOTION_SPEC_MAX) bad.push("motion_spec");
  const easingNotes = strField(v.easing_notes);
  if (easingNotes !== undefined && easingNotes.length > EASING_NOTES_MAX) bad.push("easing_notes");
  const deliverableFormat = strField(v.deliverable_format);
  if (deliverableFormat !== undefined && deliverableFormat.length > DELIVERABLE_FORMAT_MAX) bad.push("deliverable_format");
  // 时长秒取整（镜像 screenwriter/music 版取整口径：正有限数才收，Math.round 存整）。
  let durationHint: number | undefined;
  if (v.duration_hint !== undefined) {
    if (typeof v.duration_hint === "number" && Number.isFinite(v.duration_hint) && v.duration_hint > 0) {
      durationHint = Math.round(v.duration_hint);
    } else {
      bad.push("duration_hint");
    }
  }
  let keyframes: string[] | undefined;
  if (v.keyframes !== undefined) {
    if (Array.isArray(v.keyframes)) {
      keyframes = v.keyframes.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
      if (keyframes.length > KEYFRAMES_MAX) bad.push("keyframes");
      if (keyframes.some((s) => s.length > KEYFRAME_MAX_LEN)) bad.push("keyframes");
    } else {
      bad.push("keyframes");
    }
  }
  if (cleanedDeliverables.length === 0) bad.push("deliverables");

  if (bad.length > 0) {
    const unique = [...new Set(bad)];
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单字段超出契约边界：${unique.join("、")}。motion_spec ≤${MOTION_SPEC_MAX} 字、easing_notes ≤${EASING_NOTES_MAX} 字、keyframes ≤${KEYFRAMES_MAX} 条（各 ≤${KEYFRAME_MAX_LEN} 字）、duration_hint 只接受正数秒（自动取整）、deliverable_format ≤${DELIVERABLE_FORMAT_MAX} 字、deliverables 只接受 ${MOTION_DELIVERABLES.join("、")}。`,
      fields: unique,
    };
  }

  const delegation: MotionDelegation = {
    motion_spec: motionSpec,
    ...(keyframes !== undefined && keyframes.length > 0 ? { keyframes } : {}),
    ...(easingNotes !== undefined ? { easing_notes: easingNotes } : {}),
    ...(durationHint !== undefined ? { duration_hint: durationHint } : {}),
    ...(deliverableFormat !== undefined ? { deliverable_format: deliverableFormat } : {}),
    deliverables: cleanedDeliverables,
  };
  const serialized = JSON.stringify(delegation);
  const estimated_tokens = estimateTokens(serialized);
  if (estimated_tokens > DELEGATION_TOKEN_BUDGET) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单超过 2k token 预算（估算 ${estimated_tokens} > ${DELEGATION_TOKEN_BUDGET}）。请精简 motion_spec / easing_notes 或减少 keyframes。`,
      fields: ["motion_spec", "keyframes", "easing_notes"],
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

export interface MotionPromptAssemblyContext {
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

export type MotionPromptAssemblyResult =
  | { ok: true; prompt: string }
  | { ok: false; code: "constitution_unavailable"; hint: string };

/**
 * 缺省宪法载入：读静态 import 的 src/lib/expert-gateway-assets.json 镜像
 * （Vercel 拿不到 deploy-staging/，见该 JSON 生成注释；VPS 侧可经 loadConstitution
 * 整体替换）。镜像空资产抛错，由下方 catch 转 constitution_unavailable。
 */
function defaultLoadConstitution(): string {
  return loadBundledExpertConstitution();
}

/**
 * 动态设计委派 prompt 组装（唯一出口）：宪法（仅 BEAST_MODE=ON，注入头部）+
 * 委托单任务段（白名单字段按动态设计域词汇直接拼接）。OFF 时一个字不多：
 * 宪法原文不出现、落位稿不被读取。宪法载入失败结构化报错（code/hint 带原文
 * 死因），绝不静默降级成无宪法派遣。
 */
export function assembleMotionPrompt(
  delegation: MotionDelegation,
  context: MotionPromptAssemblyContext = {},
): MotionPromptAssemblyResult {
  const keyframes = delegation.keyframes ?? [];
  const body = [
    "# 动态设计委托单",
    `动态规格：${delegation.motion_spec}`,
    `关键帧（既有）：${keyframes.length > 0 ? keyframes.join("；") : "（无；由动态导演自主拆解）"}`,
    `缓动/节奏笔记：${delegation.easing_notes?.trim() ? delegation.easing_notes.trim() : "无"}`,
    `时长：${typeof delegation.duration_hint === "number" ? `${delegation.duration_hint} 秒` : "（导演按域行情自主定）"}`,
    `交付格式：${delegation.deliverable_format ?? "（导演按域行情自主定，如 mp4/gif/png 序列）"}`,
    `交付字段：${delegation.deliverables.join("、")}`,
  ].join("\n");

  if (context.beastMode !== true) {
    return { ok: true, prompt: body };
  }

  let constitution: string;
  try {
    const raw = (context.loadConstitution ?? defaultLoadConstitution)();
    // 空值视为不可用（跟随 blender-director-persona 同款范式）：空字串／全空白
    // 不得视为「已注入宪法」，否则产出无宪法派遣（裸奔，诚实铁律禁止）。
    if (raw.trim() === "") {
      throw new Error("载入器回传空内容（空或全空白）");
    }
    constitution = raw;
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

/** collect 的依赖：委托单原件（motion_spec 回写 payload 兜底）+ 派工契约（回指可追溯）。 */
export interface MotionDeliverableCollectContext {
  /** 委托单原件（工具未回显 motion_spec 时兜底回写 payload）。 */
  delegation: MotionDelegation;
  /** 派工契约（ExpertDeliverable.contract 回指，可追溯）。 */
  contract: ExpertTaskContract;
}

export type MotionDeliverableCollectResult =
  | { ok: true; deliverable: ExpertDeliverable }
  | {
      ok: false;
      code: "no_output" | "missing_deliverables" | "deliverable_invalid";
      hint: string;
      missing: string[];
    };

function strArrayField(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
  return arr.length > 0 ? arr : undefined;
}

/**
 * 动态域工具回执 → 两栏交付 payload → QC 签名 → 组装闸门自检。
 *
 * 契约（registry motion-director 行 requiredFields，钉死）：payload 两栏全形
 * （motion_spec/qc；关键帧回显非空时并入），缺关键栏位返回结构化错误，不产
 * 半形数据（对齐 screenwriter-delegate collect 铁律）：
 *   - 工具回执 ok:false 或非 JSON = 未交付（no_output），禁止拿失败回执组装。
 *   - motion_spec（工具回显 → 委托单兜底）、qc 非空、交付物指针
 *     （artifact_path 或 url 任一）非空——缺任一 = missing_deliverables。
 *   - 组装后 validateExpertDeliverable 不过 = deliverable_invalid（不外流）。
 */
export function collectMotionDeliverableFromToolResult(
  result: MotionToolResult,
  context: MotionDeliverableCollectContext,
): MotionDeliverableCollectResult {
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
      hint: "动态域工具回执不是合法 JSON 物件：output 必须是工具层 ok()/fail() 产出的 JSON 字符串，禁止手拼。",
      missing: ["output"],
    };
  }
  if (parsed.ok !== true) {
    const err = (parsed.error ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      code: "no_output",
      hint: `动态域工具回执 ok:false（未产出任何交付内容）：code=${String(err.code ?? "?")}，hint=${String(err.hint ?? "?")}。工具失败 = 未交付，禁止拿失败回执组装交付物。`,
      missing: ["ok"],
    };
  }

  const motionSpec = strField(parsed.motion_spec) ?? context.delegation.motion_spec;
  const qc = strField(parsed.qc);
  const artifactPath = strField(parsed.artifact_path);
  const url = strField(parsed.url);
  const keyframesEcho = strArrayField(parsed.keyframes_echo);
  const missing: string[] = [];
  if (!motionSpec) missing.push("motion_spec（动态规格为空）");
  if (!qc) missing.push("qc（QC 结论缺失）");
  if (!artifactPath && !url) missing.push("交付物指针（artifact_path/url 均缺）");
  if (missing.length > 0) {
    const seen = Object.keys(parsed).join("、") || "（无）";
    return {
      ok: false,
      code: "missing_deliverables",
      hint: `交付物分拣缺关键栏位：${missing.join("、")}。payload 两栏必须全形（${MOTION_DELIVERABLES.join("、")}，缺栏组装闸门不过），且必须附 artifact_path 或 url 交付物指针。回执实际字段：${seen}。`,
      missing,
    };
  }

  const payload: Record<string, unknown> = {
    motion_spec: motionSpec,
    ...(keyframesEcho !== undefined ? { keyframes: keyframesEcho } : {}),
    qc: `motion_spec_len=${motionSpec.length}; frames=${keyframesEcho ? keyframesEcho.length : context.delegation.keyframes?.length ?? 0}; verdict=${qc}`,
  };

  const evidence: ExpertDeliverable["evidence"] = artifactPath ? { artifactPath } : { url: url as string };

  const deliverable: ExpertDeliverable = {
    expertId: "motion-director",
    kind: MOTION_DESIGN_KIND,
    payload,
    evidence,
    qcSignature: computeQcSignature({
      expertId: "motion-director",
      kind: MOTION_DESIGN_KIND,
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
