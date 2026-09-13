/**
 * 视频委托单构造器 + 视频工具产物 → Expert 交付物组装侧
 * （MOE 改革 Wave2b 视频导演域，2026-09-08）。
 *
 * 逐行镜像轮子真源 src/lib/music-delegate.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：composeDelegation / estimateTokens /
 * 结构化报错铁律 / DI 缺省范式全部同构。白名单差异仅三处：
 *   ① prompt 组装：无 Lyria 风格拼接类比（src/lib 无视频版 buildLyriaStylePrompt），
 *      委托单域字段（subject/action/shots/时长/分辨率/模型提示/镜头笔记）直接
 *      平铺进任务段；bpm 取整逻辑对应改成时长秒取整（duration_hint 正数取整）；
 *   ② 交付物栏位：shots / duration_sec / model_hint / qc
 *      （VIDEO_DELIVERABLES 四栏，Wave2b spec 钉死；registry video-director 行
 *      requiredFields 已对账一致，Wave2 收口接线完成）；
 *   ③ 宪法注入：beastMode === true 时把 deploy-staging/expert-gateway/
 *      expert-constitution.md 原文注入 prompt 头；OFF 时一个字不多、档案不触碰。
 *      beastMode 由调用方经 expert-registry.readBeastMode(settings) 计算后传入——
 *      本档不 import expert-registry（registry → persona → delegate 单向依赖，
 *      反向 import 成环，delegate 先载入会在 persona 顶层别名处 TDZ 崩）。
 *      载入范式照搬 music-delegate.ts 的 DI 缺省（loadConstitution 可注入），
 *      读不到带原文死因结构化报错（诚实铁律，禁止静默降级）。
 *
 * 与 music 版的域差异（白名单内）：src/lib 无 video-tools.ts 真源（视频工具
 * handler 在 VPS .opencode/tools/，本地只有 harness-tool-registry 登记），故
 * VideoToolResult 回执契约在本档钉死（ok()/fail() JSON 字符串形，同 music-tools
 * MusicToolResult 同构）；交付物走全型 ExpertDeliverable（expert-contract.ts 契约，
 * expertId 钉死 "video-director"，Wave2 收口接线后零 cast 零放宽），组装闸门
 * 直接用 validateExpertDeliverable 全闸。
 *
 * blender-delegate.ts 本体一行不动（只 import 其 estimateTokens /
 * DELEGATION_TOKEN_BUDGET，单一真源，禁复制值）。
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

/** 交付字段白名单：Wave2b spec 钉死（片09 registry 行 requiredFields 以此对账）。 */
export const VIDEO_DELIVERABLES = ["shots", "duration_sec", "model_hint", "qc"] as const;
export type VideoDeliverableField = (typeof VIDEO_DELIVERABLES)[number];

/** 交付物种类（本域 kind 字面量，Wave2b spec 钉死）。 */
export const VIDEO_CLIP_KIND = "video_clip" as const;

/** 本域 persona id（交付物 expertId 钉死值；与 video-director-persona.ts 同值）。 */
export const VIDEO_DELIVERABLE_EXPERT_ID = "video-director" as const;

/** 视频工具回执契约（ok()/fail() JSON 字符串形，同 music-tools.ts MusicToolResult 同构；src/lib 无 video-tools.ts，本档钉死形状）。 */
export type VideoToolResult = { title: string; output: string };

/** 视频交付 payload 词表（四栏与 registry 行 requiredFields 同源；成片 URL 走 evidence.url；expert-contract.ts VideoDirectorDeliverablePayload 同一形状，单一真源禁复制）。 */
export type VideoDeliverablePayload = {
  shots?: string[];
  duration_sec?: number;
  model_hint?: string;
  qc?: string;
  [key: string]: unknown;
};

/**
 * 交付物（Wave2 收口翻正式：全型 expert-contract.ts ExpertDeliverable，
 * expertId 钉死 "video-director" 已在 ExpertId 联合内，零 cast）。
 * 类型别名保留导出（persona/测试档 import 面），形状与 ExpertDeliverable 等价。
 */
export type VideoDeliverable = ExpertDeliverable;

/** 派工契约（Wave2 收口翻正式：全型 expert-contract.ts ExpertTaskContract 别名）。 */
export type VideoTaskContract = ExpertTaskContract;

/** 委托单 schema（MOE Wave2b 契约，钉死不得更改）。 */
export interface VideoDelegationInput {
  /** 主题（一句话人话：拍什么/给谁看，视频导演据此自主拆镜头）。 */
  subject: string;
  /** 动作/剧情描述（画面里发生什么）。 */
  action: string;
  /** 分镜列表（可选；缺省=导演自主分镜）。 */
  shots?: string[];
  /** 时长档（正数秒，取整存储；缺省=导演按域行情自主定）。 */
  duration_hint?: number;
  /** 分辨率档（可选，如 720p/1080p）。 */
  resolution?: string;
  /** 模型提示（可选，如 seedance-2.5 / kling；导演自主终选）。 */
  model_hint?: string;
  /** 镜头笔记（可选：运镜/光影/节奏约束）。 */
  camera_notes?: string;
  /** 参考素材引用（画布节点 id / 附件 path / URL，原样透传）。 */
  reference_refs?: string[];
  /** 交付字段清单（白名单：VIDEO_DELIVERABLES）。 */
  deliverables: VideoDeliverableField[];
}

/** 委托单形（gateway 收到 JSON 后原样透传给视频导演 subagent）。 */
export type VideoDelegation = VideoDelegationInput;

export type VideoDelegationResult =
  | { ok: true; delegation: VideoDelegation; serialized: string; estimated_tokens: number }
  | { ok: false; code: "invalid_delegation"; hint: string; fields: string[] };

/** 主题长度上限（防主脑塞整篇剧本进委托单；同 blender/music 口径）。 */
const SUBJECT_MAX = 600;
/** 动作/剧情长度上限。 */
const ACTION_MAX = 1200;
/** 镜头笔记长度上限。 */
const CAMERA_NOTES_MAX = 1200;
const SHOTS_MAX = 20;
const SHOT_MAX = 300;
const RESOLUTION_MAX = 20;
const MODEL_HINT_MAX = 100;
const REFERENCE_REFS_MAX = 8;

/**
 * 主脑 → 视频导演委托单构造器。纯函数零副作用：校验不过返回结构化错误
 * （code/hint/fields），绝不 throw 原始错误（对齐 music-delegate.ts 错误铁律）。
 * 未知键一律丢弃（委托单对象只由白名单字段构建，防 payload 注入）。
 */
export function composeVideoDelegation(input: unknown): VideoDelegationResult {
  const missing: string[] = [];
  const bad: string[] = [];
  const v = (input ?? {}) as Record<string, unknown>;

  // 必填栏位
  const subject = strField(v.subject);
  if (subject === undefined) missing.push("subject");
  const action = strField(v.action);
  if (action === undefined) missing.push("action");
  const deliverables = v.deliverables;
  if (!Array.isArray(deliverables) || deliverables.length === 0) {
    missing.push("deliverables");
  }

  if (missing.length > 0 || !Array.isArray(deliverables) || subject === undefined || action === undefined) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单缺少必填字段：${missing.join("、")}。subject 一句话主题、action 动作/剧情描述、deliverables 交付字段清单（${VIDEO_DELIVERABLES.join("/")}）均为必填。`,
      fields: missing,
    };
  }

  // deliverables 白名单收敛
  const cleanedDeliverables: VideoDeliverableField[] = [];
  for (const d of deliverables) {
    if (typeof d === "string" && (VIDEO_DELIVERABLES as readonly string[]).includes(d)) {
      if (!cleanedDeliverables.includes(d as VideoDeliverableField)) cleanedDeliverables.push(d as VideoDeliverableField);
    } else {
      bad.push("deliverables");
      break;
    }
  }

  // 边界校验
  if (subject.length > SUBJECT_MAX) bad.push("subject");
  if (action.length > ACTION_MAX) bad.push("action");
  const cameraNotes = strField(v.camera_notes);
  if (cameraNotes !== undefined && cameraNotes.length > CAMERA_NOTES_MAX) bad.push("camera_notes");
  const resolution = strField(v.resolution);
  if (resolution !== undefined && resolution.length > RESOLUTION_MAX) bad.push("resolution");
  const modelHint = strField(v.model_hint);
  if (modelHint !== undefined && modelHint.length > MODEL_HINT_MAX) bad.push("model_hint");
  // 时长秒取整（镜像 music 版 bpm 取整逻辑：正有限数才收，Math.round 存整）。
  let durationHint: number | undefined;
  if (v.duration_hint !== undefined) {
    if (typeof v.duration_hint === "number" && Number.isFinite(v.duration_hint) && v.duration_hint > 0) {
      durationHint = Math.round(v.duration_hint);
    } else {
      bad.push("duration_hint");
    }
  }
  let shots: string[] | undefined;
  if (v.shots !== undefined) {
    if (Array.isArray(v.shots)) {
      shots = v.shots.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
      if (shots.length > SHOTS_MAX) bad.push("shots");
      if (shots.some((s) => s.length > SHOT_MAX)) bad.push("shots");
    } else {
      bad.push("shots");
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
      hint: `委托单字段超出契约边界：${unique.join("、")}。subject ≤${SUBJECT_MAX} 字、action ≤${ACTION_MAX} 字、camera_notes ≤${CAMERA_NOTES_MAX} 字、shots ≤${SHOTS_MAX} 条（各 ≤${SHOT_MAX} 字）、duration_hint 只接受正数秒（自动取整）、resolution ≤${RESOLUTION_MAX} 字、model_hint ≤${MODEL_HINT_MAX} 字、reference_refs ≤${REFERENCE_REFS_MAX} 条（各 ≤200 字）、deliverables 只接受 ${VIDEO_DELIVERABLES.join("、")}。`,
      fields: unique,
    };
  }

  const delegation: VideoDelegation = {
    subject,
    action,
    ...(shots !== undefined && shots.length > 0 ? { shots } : {}),
    ...(durationHint !== undefined ? { duration_hint: durationHint } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(modelHint !== undefined ? { model_hint: modelHint } : {}),
    ...(cameraNotes !== undefined ? { camera_notes: cameraNotes } : {}),
    ...(refs !== undefined && refs.length > 0 ? { reference_refs: refs } : {}),
    deliverables: cleanedDeliverables,
  };
  const serialized = JSON.stringify(delegation);
  const estimated_tokens = estimateTokens(serialized);
  if (estimated_tokens > DELEGATION_TOKEN_BUDGET) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单超过 2k token 预算（估算 ${estimated_tokens} > ${DELEGATION_TOKEN_BUDGET}）。请精简 subject / action / camera_notes 或减少 shots / reference_refs。`,
      fields: ["subject", "action", "shots", "reference_refs"],
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

export interface VideoPromptAssemblyContext {
  /**
   * 野兽模式开关：调用方经 expert-registry.readBeastMode(settings) 计算后传入。
   * 本档不 import expert-registry（避免 registry → persona → delegate 依赖成环，
   * 见档头说明）。缺省 false = OFF = 宪法一个字不注入、档案不触碰。
   */
  beastMode?: boolean;
  /**
   * 宪法原文载入（DI，范式同 music-delegate loadConstitution）；缺省 fs 读
   * EXPERT_CONSTITUTION_PATH 落位稿。
   */
  loadConstitution?: () => string;
}

export type VideoPromptAssemblyResult =
  | { ok: true; prompt: string }
  | { ok: false; code: "constitution_unavailable"; hint: string };

/** 缺省宪法载入：fs 读落位稿（cwd = repo 根；VPS 侧可经 loadConstitution 整体替换）。 */
function defaultLoadConstitution(): string {
  return readFileSync(nodePath.resolve(process.cwd(), EXPERT_CONSTITUTION_PATH), "utf8");
}

/**
 * 视频导演委派 prompt 组装（唯一出口）：宪法（仅 BEAST_MODE=ON，注入头部）+
 * 委托单任务段（域字段平铺：主题/动作/分镜/时长/分辨率/模型提示/镜头笔记）。
 * OFF 时一个字不多：宪法原文不出现、落位稿不被读取。宪法载入失败结构化报错
 * （code/hint 带原文死因），绝不静默降级成无宪法派遣。
 */
export function assembleVideoDirectorPrompt(
  delegation: VideoDelegation,
  context: VideoPromptAssemblyContext = {},
): VideoPromptAssemblyResult {
  const body = [
    "# 视频导演委托单",
    `主题：${delegation.subject}`,
    `动作/剧情：${delegation.action}`,
    `分镜：${delegation.shots && delegation.shots.length > 0 ? delegation.shots.join("、") : "（导演自主分镜）"}`,
    `时长：${typeof delegation.duration_hint === "number" ? `${delegation.duration_hint} 秒` : "（导演按域行情自主定）"}`,
    `分辨率：${delegation.resolution ?? "（导演按域行情自主定）"}`,
    `模型提示：${delegation.model_hint ?? "（导演自主选型，seedance/kling 系）"}`,
    `镜头笔记：${delegation.camera_notes?.trim() ? delegation.camera_notes.trim() : "无"}`,
    `交付字段：${delegation.deliverables.join("、")}`,
    `参考素材：${delegation.reference_refs && delegation.reference_refs.length > 0 ? delegation.reference_refs.join("、") : "无"}`,
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

/** collect 的依赖：委托单原件（shots/model_hint 回写 payload）+ 派工契约（回指可追溯）。 */
export interface VideoDeliverableCollectContext {
  /** 委托单原件（shots / model_hint 回写 payload）。 */
  delegation: VideoDelegation;
  /** 派工契约（VideoDeliverable.contract 回指，可追溯）。 */
  contract: ExpertTaskContract;
}

export type VideoDeliverableCollectResult =
  | { ok: true; deliverable: VideoDeliverable }
  | {
      ok: false;
      code: "no_output" | "missing_deliverables" | "deliverable_invalid";
      hint: string;
      missing: string[];
    };

/**
 * 视频工具回执 → 四栏交付 payload → QC 签名 → 组装闸门自检。
 *
 * 契约（Wave2b spec 钉死，registry 行 requiredFields 以此对账）：payload 四栏
 * 全形（shots/duration_sec/model_hint/qc），成片 URL 走 evidence.url，缺关键
 * 栏位返回结构化错误，不产半形数据（对齐 music-delegate collect 铁律）：
 *   - 工具回执 ok:false 或非 JSON = 未交付（no_output），禁止拿失败回执组装。
 *   - 无 url（视频未上传 gateway）或无 duration_seconds = missing_deliverables。
 *   - 组装后 validateExpertDeliverable 不过 = deliverable_invalid（不外流）。
 * shots 取值链：工具回显 shots_echo（实际分镜）→ 委托单 shots → 占位
 * 「导演自主分镜」（镜像 music 版 lyrics 兜底占位范式）。
 */
export function collectVideoDeliverableFromToolResult(
  result: VideoToolResult,
  context: VideoDeliverableCollectContext,
): VideoDeliverableCollectResult {
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
      hint: "视频工具回执不是合法 JSON 物件：output 必须是工具层 ok()/fail() 产出的 JSON 字符串，禁止手拼。",
      missing: ["output"],
    };
  }
  if (parsed.ok !== true) {
    const err = (parsed.error ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      code: "no_output",
      hint: `视频工具回执 ok:false（未生成任何视频）：code=${String(err.code ?? "?")}，hint=${String(err.hint ?? "?")}。工具失败 = 未交付，禁止拿失败回执组装交付物。`,
      missing: ["ok"],
    };
  }

  const url = strField(parsed.url);
  const durationSeconds =
    typeof parsed.duration_seconds === "number" && Number.isFinite(parsed.duration_seconds) && parsed.duration_seconds > 0
      ? parsed.duration_seconds
      : undefined;
  const missing: string[] = [];
  if (!url) missing.push("video_url（视频未上传 gateway，无公网 URL）");
  if (durationSeconds === undefined) missing.push("duration_sec");
  if (missing.length > 0) {
    const seen = Object.keys(parsed).join("、") || "（无）";
    return {
      ok: false,
      code: "missing_deliverables",
      hint: `交付物分拣缺关键栏位：${missing.join("、")}。payload 四栏必须全形（${VIDEO_DELIVERABLES.join("、")}，缺栏组装闸门不过）。回执实际字段：${seen}。`,
      missing,
    };
  }

  const shotsEcho = strArrayField(parsed.shots_echo);
  const shots = shotsEcho ?? (context.delegation.shots && context.delegation.shots.length > 0 ? context.delegation.shots : ["（导演自主分镜，未显式指定）"]);
  const modelHint = strField(parsed.model) ?? (context.delegation.model_hint?.trim() ? context.delegation.model_hint.trim() : "未知");
  const videoBytes = typeof parsed.video_bytes === "number" && Number.isFinite(parsed.video_bytes) && parsed.video_bytes > 0 ? parsed.video_bytes : 0;

  const payload: VideoDeliverablePayload = {
    shots,
    duration_sec: durationSeconds,
    model_hint: modelHint,
    qc: `duration_sec=${durationSeconds}; mime=${strField(parsed.mime_type) ?? "未知"}; bytes=${videoBytes}; model=${strField(parsed.model) ?? "未知"}`,
  };

  const evidence: ExpertDeliverable["evidence"] = { url };
  if (videoBytes > 0) evidence.bytes = videoBytes;
  evidence.durationSec = durationSeconds;

  const deliverable: VideoDeliverable = {
    expertId: VIDEO_DELIVERABLE_EXPERT_ID,
    kind: VIDEO_CLIP_KIND,
    payload,
    evidence,
    qcSignature: computeQcSignature({
      expertId: VIDEO_DELIVERABLE_EXPERT_ID,
      kind: VIDEO_CLIP_KIND,
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
