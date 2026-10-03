/**
 * 剪辑委托单构造器 + 剪辑域工具产物 → Expert 交付物组装侧
 * （MOE 改革 Wave2b 剪辑师域，2026-09-08）。
 *
 * 逐行镜像轮子真源 src/lib/video-delegate.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：composeDelegation / estimateTokens /
 * 结构化报错铁律 / DI 缺省范式全部同构。白名单差异仅三处：
 *   ① prompt 组装：无视频版分镜/分辨率拼接（剪辑域任务段按白名单字段直接
 *      平铺：源素材/时间线操作/节奏笔记/混音笔记/时长/交付规格）；
 *      bpm 取整逻辑对应改成时长秒取整（duration_hint 正数取整，同 video 版）。
 *   ② 交付物栏位：timeline_ops / duration_sec / qc 三栏
 *      （EDITOR_DELIVERABLES，与 expert-registry editor 行 requiredFields
 *      ["timeline_ops","duration_sec","qc"] 同源，2026-09-08 现场核验）。
 *   ③ 宪法注入：beastMode === true 时把 deploy-staging/expert-gateway/
 *      expert-constitution.md 原文注入 prompt 头；OFF 时一个字不多、档案不触碰。
 *      beastMode 由调用方经 expert-registry.readBeastMode(settings) 计算后传入——
 *      本档不 import expert-registry（registry → persona → delegate 单向依赖，
 *      反向 import 成环，delegate 先载入会在 persona 顶层别名处 TDZ 崩，
 *      记忆 2026-09-08-wave1-b3-music-expert-registration）。
 *      载入范式照搬 music-delegate.ts 的 DI 缺省（loadConstitution 可注入），
 *      读不到带原文死因结构化报错（诚实铁律，禁止静默降级）。
 *
 * 与 video 版的域差异（白名单内）：剪辑域工具（timeline_* 八件套/editing_manifest/
 * audio_first_timeline/video_upload）handler 真源在 VPS .opencode/tools/，本地
 * harness-tool-registry.ts 只登记 id，故 EditorToolResult 回执契约在本档钉死
 * （ok()/fail() JSON 字符串形，同 music-tools MusicToolResult 同构）；交付物
 * 走全型 ExpertDeliverable（expert-contract.ts 契约，expertId 钉死 "editor"，
 * Wave2 收口接线后零 cast 零放宽），组装闸门直接用 validateExpertDeliverable
 * 全闸。
 *
 * video-delegate.ts 本体一行不动（只 import 其 estimateTokens / blender-delegate
 * DELEGATION_TOKEN_BUDGET，单一真源，禁复制值）。
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

/** 交付字段白名单：与 expert-registry editor 行 requiredFields 一一对应。 */
export const EDITOR_DELIVERABLES = ["timeline_ops", "duration_sec", "qc"] as const;
export type EditorDeliverableField = (typeof EDITOR_DELIVERABLES)[number];

/** 交付物种类（本域 kind 字面量，本档钉死；收口片翻正时对齐）。 */
export const EDITOR_TIMELINE_KIND = "edited_timeline" as const;

/** 本域 persona id（交付物 expertId 钉死值；与 editor-persona.ts 同值）。 */
export const EDITOR_DELIVERABLE_EXPERT_ID = "editor" as const;

/** 剪辑域工具回执契约（ok()/fail() JSON 字符串形，同 music-tools.ts MusicToolResult 同构；src/lib 无 editor-tools.ts，本档钉死形状）。 */
export type EditorToolResult = { title: string; output: string };

/** 剪辑交付 payload 词表（三栏与 registry 行 requiredFields 同源；成片 URL 走 evidence.url）。 */
export type EditorDeliverablePayload = {
  timeline_ops?: string[];
  duration_sec?: number;
  qc?: string;
  [key: string]: unknown;
};

/** 派工契约（Wave2 收口翻正式：全型 expert-contract.ts ExpertTaskContract 别名）。 */
export type EditorTaskContract = ExpertTaskContract;

/**
 * 交付物（Wave2 收口翻正式：全型 expert-contract.ts ExpertDeliverable，
 * expertId 钉死 "editor" 已在 ExpertId 联合内，零 cast）。
 * 类型别名保留导出（persona/测试档 import 面），形状与 ExpertDeliverable 等价。
 */
export type EditorDeliverable = ExpertDeliverable;

/** 委托单 schema（MOE Wave2b 契约，钉死不得更改）。 */
export interface EditorDelegationInput {
  /** 源素材清单（一句话人话：每个素材是什么，剪辑师据此自主排时间线）。 */
  source_clips: string[];
  /** 时间线操作意图（可选清单：剪切顺序/转场/字幕卡点等，缺省=剪辑师自主编排）。 */
  timeline_ops?: string[];
  /** 节奏笔记（可选：卡点/情绪曲线/段落停顿约束）。 */
  rhythm_notes?: string;
  /** 混音笔记（可选：旁白/BGM/SFX 层级与 ducking 约束）。 */
  mix_notes?: string;
  /** 时长档（正数秒，取整存储；缺省=剪辑师按素材与节奏自主定）。 */
  duration_hint?: number;
  /** 交付规格（可选，如 1080p H.264 + AAC、竖屏 9:16）。 */
  delivery_spec?: string;
  /** 参考素材引用（画布节点 id / 附件 path / URL，原样透传）。 */
  reference_refs?: string[];
  /** 交付字段清单（白名单：EDITOR_DELIVERABLES）。 */
  deliverables: EditorDeliverableField[];
}

/** 委托单形（gateway 收到 JSON 后原样透传给剪辑师 subagent）。 */
export type EditorDelegation = EditorDelegationInput;

export type EditorDelegationResult =
  | { ok: true; delegation: EditorDelegation; serialized: string; estimated_tokens: number }
  | { ok: false; code: "invalid_delegation"; hint: string; fields: string[] };

/** 源素材单条长度上限（防主脑塞整篇素材清单进委托单；同 video 版 subject 口径）。 */
const SOURCE_CLIP_MAX = 300;
/** 源素材条数上限。 */
const SOURCE_CLIPS_MAX = 30;
/** 时间线操作条数/单条长度上限。 */
const TIMELINE_OPS_MAX = 40;
const TIMELINE_OP_MAX = 200;
/** 节奏/混音笔记长度上限。 */
const RHYTHM_NOTES_MAX = 1200;
const MIX_NOTES_MAX = 1200;
/** 交付规格长度上限。 */
const DELIVERY_SPEC_MAX = 200;
const REFERENCE_REFS_MAX = 8;

/**
 * 主脑 → 剪辑师委托单构造器。纯函数零副作用：校验不过返回结构化错误
 * （code/hint/fields），绝不 throw 原始错误（对齐 music-delegate.ts 错误铁律）。
 * 未知键一律丢弃（委托单对象只由白名单字段构建，防 payload 注入）。
 */
export function composeEditorDelegation(input: unknown): EditorDelegationResult {
  const missing: string[] = [];
  const bad: string[] = [];
  const v = (input ?? {}) as Record<string, unknown>;

  // 必填栏位
  const sourceClips = strArrayField(v.source_clips);
  if (sourceClips === undefined) missing.push("source_clips");
  const deliverables = v.deliverables;
  if (!Array.isArray(deliverables) || deliverables.length === 0) {
    missing.push("deliverables");
  }

  if (missing.length > 0 || !Array.isArray(deliverables) || sourceClips === undefined) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单缺少必填字段：${missing.join("、")}。source_clips 源素材清单（每条一句话人话）、deliverables 交付字段清单（${EDITOR_DELIVERABLES.join("/")}）均为必填。`,
      fields: missing,
    };
  }

  // deliverables 白名单收敛
  const cleanedDeliverables: EditorDeliverableField[] = [];
  for (const d of deliverables) {
    if (typeof d === "string" && (EDITOR_DELIVERABLES as readonly string[]).includes(d)) {
      if (!cleanedDeliverables.includes(d as EditorDeliverableField)) cleanedDeliverables.push(d as EditorDeliverableField);
    } else {
      bad.push("deliverables");
      break;
    }
  }

  // 边界校验
  if (sourceClips.length > SOURCE_CLIPS_MAX) bad.push("source_clips");
  if (sourceClips.some((s) => s.length > SOURCE_CLIP_MAX)) bad.push("source_clips");
  const timelineOps = strArrayField(v.timeline_ops);
  if (timelineOps !== undefined && (timelineOps.length > TIMELINE_OPS_MAX || timelineOps.some((s) => s.length > TIMELINE_OP_MAX))) bad.push("timeline_ops");
  const rhythmNotes = strField(v.rhythm_notes);
  if (rhythmNotes !== undefined && rhythmNotes.length > RHYTHM_NOTES_MAX) bad.push("rhythm_notes");
  const mixNotes = strField(v.mix_notes);
  if (mixNotes !== undefined && mixNotes.length > MIX_NOTES_MAX) bad.push("mix_notes");
  const deliverySpec = strField(v.delivery_spec);
  if (deliverySpec !== undefined && deliverySpec.length > DELIVERY_SPEC_MAX) bad.push("delivery_spec");
  // 时长秒取整（镜像 video/music 版取整逻辑：正有限数才收，Math.round 存整）。
  let durationHint: number | undefined;
  if (v.duration_hint !== undefined) {
    if (typeof v.duration_hint === "number" && Number.isFinite(v.duration_hint) && v.duration_hint > 0) {
      durationHint = Math.round(v.duration_hint);
    } else {
      bad.push("duration_hint");
    }
  }
  let refs: string[] | undefined;
  if (v.reference_refs !== undefined) {
    if (Array.isArray(v.reference_refs)) {
      refs = v.reference_refs.filter((r): r is string => typeof r === "string" && r.trim() !== "").map((r) => r.trim());
      if (refs.length > REFERENCE_REFS_MAX) bad.push("reference_refs");
      if (refs.some((r) => r.length > 200)) bad.push("reference_refs");
    } else {
      bad.push("reference_refs");
    }
  }
  if (cleanedDeliverables.length === 0) bad.push("deliverables");

  if (bad.length > 0) {
    const unique = [...new Set(bad)];
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单字段超出契约边界：${unique.join("、")}。source_clips ≤${SOURCE_CLIPS_MAX} 条（各 ≤${SOURCE_CLIP_MAX} 字）、timeline_ops ≤${TIMELINE_OPS_MAX} 条（各 ≤${TIMELINE_OP_MAX} 字）、rhythm_notes ≤${RHYTHM_NOTES_MAX} 字、mix_notes ≤${MIX_NOTES_MAX} 字、duration_hint 只接受正数秒（自动取整）、delivery_spec ≤${DELIVERY_SPEC_MAX} 字、reference_refs ≤${REFERENCE_REFS_MAX} 条（各 ≤200 字）、deliverables 只接受 ${EDITOR_DELIVERABLES.join("、")}。`,
      fields: unique,
    };
  }

  const delegation: EditorDelegation = {
    source_clips: sourceClips,
    ...(timelineOps !== undefined && timelineOps.length > 0 ? { timeline_ops: timelineOps } : {}),
    ...(rhythmNotes !== undefined ? { rhythm_notes: rhythmNotes } : {}),
    ...(mixNotes !== undefined ? { mix_notes: mixNotes } : {}),
    ...(durationHint !== undefined ? { duration_hint: durationHint } : {}),
    ...(deliverySpec !== undefined ? { delivery_spec: deliverySpec } : {}),
    ...(refs !== undefined && refs.length > 0 ? { reference_refs: refs } : {}),
    deliverables: cleanedDeliverables,
  };
  const serialized = JSON.stringify(delegation);
  const estimated_tokens = estimateTokens(serialized);
  if (estimated_tokens > DELEGATION_TOKEN_BUDGET) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单超过 2k token 预算（估算 ${estimated_tokens} > ${DELEGATION_TOKEN_BUDGET}）。请精简 source_clips / rhythm_notes / mix_notes 或减少 timeline_ops / reference_refs。`,
      fields: ["source_clips", "timeline_ops", "rhythm_notes", "mix_notes"],
    };
  }
  return { ok: true, delegation, serialized, estimated_tokens };
}

/** 粗估 token：复用 blender-delegate 单一真源（禁复制），口径 CJK 记 1、其余 ~0.25。 */
export { estimateTokens };

function strField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function strArrayField(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
  return arr.length > 0 ? arr : undefined;
}

// ─────────────────────────────────────────── ② 委派 prompt 组装（宪法注入挂点）

export interface EditorPromptAssemblyContext {
  /**
   * 野兽模式开关：调用方经 expert-registry.readBeastMode(settings) 计算后传入。
   * 本档不 import expert-registry（避免 registry → persona → delegate 依赖成环，
   * 见档头说明）。缺省 false = OFF = 宪法一个字不注入、档案不触碰。
   */
  beastMode?: boolean;
  /**
   * 宪法原文载入（DI，范式同 music/video-delegate loadConstitution）；缺省 fs 读
   * EXPERT_CONSTITUTION_PATH 落位稿。
   */
  loadConstitution?: () => string;
}

export type EditorPromptAssemblyResult =
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
 * 剪辑师委派 prompt 组装（唯一出口）：宪法（仅 BEAST_MODE=ON，注入头部）+
 * 委托单任务段（域字段平铺：源素材/时间线操作/节奏笔记/混音笔记/时长/交付规格）
 * + 质检闸硬规则段（2026-09-27 刀2 纪律层：timeline_lint 是闸门，must 未清不得
 * 交付，qc 必须是 lint/master 真实结论；机器层对应 = 本档 collect 对缺 qc 回执
 * 直接判 missing_deliverables）。
 * OFF 时一个字不多：宪法原文不出现、落位稿不被读取。宪法载入失败结构化报错
 * （code/hint 带原文死因），绝不静默降级成无宪法派遣。
 */
export function assembleEditorPrompt(
  delegation: EditorDelegation,
  context: EditorPromptAssemblyContext = {},
): EditorPromptAssemblyResult {
  const body = [
    "# 剪辑师委托单",
    `源素材：${delegation.source_clips.join("、")}`,
    `时间线操作：${delegation.timeline_ops && delegation.timeline_ops.length > 0 ? delegation.timeline_ops.join("、") : "（剪辑师自主编排）"}`,
    `节奏笔记：${delegation.rhythm_notes?.trim() ? delegation.rhythm_notes.trim() : "无"}`,
    `混音笔记：${delegation.mix_notes?.trim() ? delegation.mix_notes.trim() : "无"}`,
    `时长：${typeof delegation.duration_hint === "number" ? `${delegation.duration_hint} 秒` : "（剪辑师按素材与节奏自主定）"}`,
    `交付规格：${delegation.delivery_spec ?? "（剪辑师按域行情自主定）"}`,
    `交付字段：${delegation.deliverables.join("、")}`,
    `参考素材：${delegation.reference_refs && delegation.reference_refs.length > 0 ? delegation.reference_refs.join("、") : "无"}`,
    // ↓ 2026-09-27 刀2 纪律层硬规则（活化为「不调用就过不去」的 prompt 面；
    //   机器层同款语义由本档 collect 闸门执行：回执缺 qc = missing_deliverables）。
    "硬规则（质检闸，未过不得交付）：成片交付前必须调用 timeline_lint 过闸（must 级未清不得交付），并以 timeline_master 聚合质检后导出；回执 qc 栏必须是 timeline_lint / timeline_master 的真实质检结论，qc 缺失或未过 lint 视为未交付。剪辑结构变更一律走 timeline_ops 批量原子（禁 run_py 手搓 ffmpeg 绕过）。",
  ].join("\n");

  if (context.beastMode !== true) {
    return { ok: true, prompt: body };
  }

  let constitution: string;
  try {
    const raw = (context.loadConstitution ?? defaultLoadConstitution)();
    // 空值視為不可用（跟隨 blender-director-persona 同款範式）：空字串／全空白
    // 不得視為「已注入憲法」，否則產出無憲法派遣（裸奔，誠實鐵律禁止）。
    if (raw.trim() === "") {
      throw new Error("载入器回傳空內容（空或全空白）");
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

/** collect 的依赖：委托单原件（timeline_ops 回写 payload）+ 派工契约（回指可追溯）。 */
export interface EditorDeliverableCollectContext {
  /** 委托单原件（timeline_ops 回写 payload）。 */
  delegation: EditorDelegation;
  /** 派工契约（EditorDeliverable.contract 回指，可追溯）。 */
  contract: EditorTaskContract;
}

export type EditorDeliverableCollectResult =
  | { ok: true; deliverable: EditorDeliverable }
  | {
      ok: false;
      code: "no_output" | "missing_deliverables" | "deliverable_invalid";
      hint: string;
      missing: string[];
    };

/**
 * 剪辑域工具回执 → 三栏交付 payload → QC 签名 → 组装闸门自检。
 *
 * 契约（expert-registry editor 行 requiredFields 钉死）：payload 三栏全形
 * （timeline_ops/duration_sec/qc），成片 URL 走 evidence.url，缺关键栏位返回
 * 结构化错误，不产半形数据（对齐 music/video-delegate collect 铁律）：
 *   - 工具回执 ok:false 或非 JSON = 未交付（no_output），禁止拿失败回执组装。
 *   - 无 url（母带未导出上传 gateway）或无 duration_seconds 或无 qc（质检结论）
 *     = missing_deliverables。
 *   - 组装后 validateExpertDeliverable 不过 = deliverable_invalid（不外流）。
 * timeline_ops 取值链：工具回显 timeline_ops_echo（实际执行的操作）→ 委托单
 * timeline_ops → 占位「剪辑师自主编排」（镜像 video 版 shots 兜底占位范式）。
 * qc 取值链（与 video 版构造式不同，白名单偏离已注记）：必读回执 qc 字段
 * （timeline_lint/timeline_master 质检结论），缺失即 missing_deliverables——
 * Wave2b spec 测试「缺 qc 拒」钉死，镜像 screenwriter 版 qc 语义。
 */
export function collectEditorDeliverableFromToolResult(
  result: EditorToolResult,
  context: EditorDeliverableCollectContext,
): EditorDeliverableCollectResult {
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
      hint: "剪辑域工具回执不是合法 JSON 物件：output 必须是工具层 ok()/fail() 产出的 JSON 字符串，禁止手拼。",
      missing: ["output"],
    };
  }
  if (parsed.ok !== true) {
    const err = (parsed.error ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      code: "no_output",
      hint: `剪辑域工具回执 ok:false（未产出任何成片）：code=${String(err.code ?? "?")}，hint=${String(err.hint ?? "?")}。工具失败 = 未交付，禁止拿失败回执组装交付物。`,
      missing: ["ok"],
    };
  }

  const url = strField(parsed.url);
  const durationSeconds =
    typeof parsed.duration_seconds === "number" && Number.isFinite(parsed.duration_seconds) && parsed.duration_seconds > 0
      ? parsed.duration_seconds
      : undefined;
  const opsEcho = strArrayField(parsed.timeline_ops_echo);
  const qc = strField(parsed.qc);
  const missing: string[] = [];
  if (!url) missing.push("video_url（成片未上传 gateway，无公网 URL）");
  if (durationSeconds === undefined) missing.push("duration_sec");
  if (!qc) missing.push("qc（QC 结论缺失：timeline_lint/timeline_master 质检结论必须随回执上交）");
  if (missing.length > 0) {
    const seen = Object.keys(parsed).join("、") || "（无）";
    return {
      ok: false,
      code: "missing_deliverables",
      hint: `交付物分拣缺关键栏位：${missing.join("、")}。payload 三栏必须全形（${EDITOR_DELIVERABLES.join("、")}，缺栏组装闸门不过）。回执实际字段：${seen}。`,
      missing,
    };
  }

  const timelineOps = opsEcho ?? (context.delegation.timeline_ops && context.delegation.timeline_ops.length > 0 ? context.delegation.timeline_ops : ["（剪辑师自主编排，未显式指定）"]);
  const videoBytes = typeof parsed.video_bytes === "number" && Number.isFinite(parsed.video_bytes) && parsed.video_bytes > 0 ? parsed.video_bytes : 0;

  const payload: EditorDeliverablePayload = {
    timeline_ops: timelineOps,
    duration_sec: durationSeconds,
    qc: `ops=${timelineOps.length}; duration_sec=${durationSeconds}; verdict=${qc}`,
  };

  const evidence: ExpertDeliverable["evidence"] = { url };
  if (videoBytes > 0) evidence.bytes = videoBytes;
  evidence.durationSec = durationSeconds;

  const deliverable: EditorDeliverable = {
    expertId: EDITOR_DELIVERABLE_EXPERT_ID,
    kind: EDITOR_TIMELINE_KIND,
    payload,
    evidence,
    qcSignature: computeQcSignature({
      expertId: EDITOR_DELIVERABLE_EXPERT_ID,
      kind: EDITOR_TIMELINE_KIND,
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
