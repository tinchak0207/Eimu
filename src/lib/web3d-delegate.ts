/**
 * Web3D 委托单构造器 + Web3D 域工具产物 → Expert 交付物组装侧
 * （MOE 改革 Wave2b Web3D 域，2026-09-08）。
 *
 * 逐行镜像轮子真源 src/lib/screenwriter-delegate.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：composeDelegation / estimateTokens /
 * 结构化报错铁律 / DI 缺省范式 / collect 分拣链全部同构。白名单差异仅三处：
 *   ① 域字段换 Web3D 版：scene_spec（必填）/interactions[]/camera_notes/
 *      bundle_hint（Wave2b spec 钉死四件）；无编剧 shotlist/characters 对应物
 *      （spec 白名单外，未知键丢弃防注入）。bundle_ref 走交付物指针
 *      （artifact_path 或 url），不是委托单入参——资产链产物由 subagent
 *      干活后回传，主脑只给 bundle_hint 提示。
 *   ② 交付物栏位：scene_spec / bundle_ref / qc 三栏（WEB3D_DELIVERABLES，
 *      与 expert-registry web3d-director 行 requiredFields 同源）。
 *   ③ 宪法注入：beastMode === true 时把 deploy-staging/expert-gateway/
 *      expert-constitution.md 原文注入 prompt 头；OFF 时一个字不多、档案不触碰。
 *      beastMode 由调用方经 expert-registry.readBeastMode(settings) 计算后传入——
 *      本档不 import expert-registry（registry → persona → delegate 单向依赖，
 *      反向 import 成环，delegate 先载入会在 persona 顶层别名处 TDZ 崩，
 *      记忆 2026-09-08-wave1-b3-music-expert-registration）。
 *      载入范式照搬 screenwriter-delegate 的 DI 缺省：loadConstitution 可注入，
 *      缺省 fs 读落位稿，读不到带原文死因结构化报错（诚实铁律，禁止静默降级）。
 *
 * ExpertId 联合已含 "web3d-director"（expert-contract.ts Wave2a 占位追加），
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

/** 交付字段白名单：与 expert-registry web3d-director 行 requiredFields 一一对应。 */
export const WEB3D_DELIVERABLES = ["scene_spec", "bundle_ref", "qc"] as const;
export type Web3dDeliverableField = (typeof WEB3D_DELIVERABLES)[number];

/** 交付物种类（Web3D 域 kind，本档钉死；收口片翻正时对齐）。 */
export const WEB3D_SCENE_KIND = "web3d_scene" as const;

/** 工具回执契约形（域无本地工具档，本地定义；与 screenwriter ToolResult 同形）。 */
export type Web3dToolResult = { title: string; output: string };

/** 委托单 schema（MOE Wave2b 契约，钉死不得更改）。 */
export interface Web3dDelegationInput {
  /** 场景规格（一句人话：什么场景、什么视觉目标、跑在什么页面）。 */
  scene_spec: string;
  /** 交互清单（可选：点击/拖拽/滚轮/悬停等交互行为逐条描述）。 */
  interactions?: string[];
  /** 相机笔记（可选：机位/轨道/视场/降级约束）。 */
  camera_notes?: string;
  /** 资产链提示（可选：GLB 来源/资产包 id/纹理口径；产物 bundle_ref 由 subagent 干活后回传）。 */
  bundle_hint?: string;
  /** 交付字段清单（白名单：WEB3D_DELIVERABLES）。 */
  deliverables: Web3dDeliverableField[];
}

/** 委托单形（gateway 收到 JSON 后原样透传给 Web3D 导演 subagent）。 */
export type Web3dDelegation = Web3dDelegationInput;

export type Web3dDelegationResult =
  | { ok: true; delegation: Web3dDelegation; serialized: string; estimated_tokens: number }
  | { ok: false; code: "invalid_delegation"; hint: string; fields: string[] };

/** 场景规格长度上限（防主脑塞整篇规格书进委托单；同 screenwriter logline 口径）。 */
const SCENE_SPEC_MAX = 600;
/** 相机笔记/资产链提示长度上限。 */
const CAMERA_NOTES_MAX = 1200;
const BUNDLE_HINT_MAX = 300;
/** 交互条数/单条长度上限。 */
const INTERACTIONS_MAX = 16;
const INTERACTION_MAX_LEN = 200;

/**
 * 主脑 → Web3D 导演委托单构造器。纯函数零副作用：校验不过返回结构化错误
 * （code/hint/fields），绝不 throw 原始错误（对齐 screenwriter-delegate 错误铁律）。
 * 未知键一律丢弃（委托单对象只由白名单字段构建，防 payload 注入）。
 */
export function composeWeb3dDelegation(input: unknown): Web3dDelegationResult {
  const missing: string[] = [];
  const bad: string[] = [];
  const v = (input ?? {}) as Record<string, unknown>;

  // 必填栏位
  const sceneSpec = strField(v.scene_spec);
  if (sceneSpec === undefined) missing.push("scene_spec");
  const deliverables = v.deliverables;
  if (!Array.isArray(deliverables) || deliverables.length === 0) {
    missing.push("deliverables");
  }

  if (missing.length > 0 || !Array.isArray(deliverables) || sceneSpec === undefined) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单缺少必填字段：${missing.join("、")}。scene_spec 一句话场景规格（什么场景、什么视觉目标）、deliverables 交付字段清单（${WEB3D_DELIVERABLES.join("/")}）均为必填。`,
      fields: missing,
    };
  }

  // deliverables 白名单收敛
  const cleanedDeliverables: Web3dDeliverableField[] = [];
  for (const d of deliverables) {
    if (typeof d === "string" && (WEB3D_DELIVERABLES as readonly string[]).includes(d)) {
      if (!cleanedDeliverables.includes(d as Web3dDeliverableField)) cleanedDeliverables.push(d as Web3dDeliverableField);
    } else {
      bad.push("deliverables");
      break;
    }
  }

  // 边界校验
  if (sceneSpec.length > SCENE_SPEC_MAX) bad.push("scene_spec");
  const cameraNotes = strField(v.camera_notes);
  if (cameraNotes !== undefined && cameraNotes.length > CAMERA_NOTES_MAX) bad.push("camera_notes");
  const bundleHint = strField(v.bundle_hint);
  if (bundleHint !== undefined && bundleHint.length > BUNDLE_HINT_MAX) bad.push("bundle_hint");
  let interactions: string[] | undefined;
  if (v.interactions !== undefined) {
    if (Array.isArray(v.interactions)) {
      interactions = v.interactions.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
      if (interactions.length > INTERACTIONS_MAX) bad.push("interactions");
      if (interactions.some((s) => s.length > INTERACTION_MAX_LEN)) bad.push("interactions");
    } else {
      bad.push("interactions");
    }
  }
  if (cleanedDeliverables.length === 0) bad.push("deliverables");

  if (bad.length > 0) {
    const unique = [...new Set(bad)];
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单字段超出契约边界：${unique.join("、")}。scene_spec ≤${SCENE_SPEC_MAX} 字、camera_notes ≤${CAMERA_NOTES_MAX} 字、interactions ≤${INTERACTIONS_MAX} 条（各 ≤${INTERACTION_MAX_LEN} 字）、bundle_hint ≤${BUNDLE_HINT_MAX} 字、deliverables 只接受 ${WEB3D_DELIVERABLES.join("、")}。`,
      fields: unique,
    };
  }

  const delegation: Web3dDelegation = {
    scene_spec: sceneSpec,
    ...(interactions !== undefined && interactions.length > 0 ? { interactions } : {}),
    ...(cameraNotes !== undefined ? { camera_notes: cameraNotes } : {}),
    ...(bundleHint !== undefined ? { bundle_hint: bundleHint } : {}),
    deliverables: cleanedDeliverables,
  };
  const serialized = JSON.stringify(delegation);
  const estimated_tokens = estimateTokens(serialized);
  if (estimated_tokens > DELEGATION_TOKEN_BUDGET) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单超过 2k token 预算（估算 ${estimated_tokens} > ${DELEGATION_TOKEN_BUDGET}）。请精简 scene_spec / camera_notes / bundle_hint 或减少 interactions。`,
      fields: ["scene_spec", "interactions", "camera_notes", "bundle_hint"],
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

export interface Web3dPromptAssemblyContext {
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

export type Web3dPromptAssemblyResult =
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
 * Web3D 导演委派 prompt 组装（唯一出口）：宪法（仅 BEAST_MODE=ON，注入头部）+
 * 委托单任务段（白名单字段按 Web3D 域词汇直接拼接）。OFF 时一个字不多：
 * 宪法原文不出现、落位稿不被读取。宪法载入失败结构化报错（code/hint 带原文
 * 死因），绝不静默降级成无宪法派遣。
 */
export function assembleWeb3dPrompt(
  delegation: Web3dDelegation,
  context: Web3dPromptAssemblyContext = {},
): Web3dPromptAssemblyResult {
  const interactions = delegation.interactions ?? [];
  const body = [
    "# Web3D 委托单",
    `场景规格：${delegation.scene_spec}`,
    `交互清单（既有）：${interactions.length > 0 ? interactions.join("；") : "（无；由 Web3D 导演自主设计）"}`,
    `相机笔记：${delegation.camera_notes?.trim() ? delegation.camera_notes.trim() : "无"}`,
    `资产链提示：${delegation.bundle_hint?.trim() ? delegation.bundle_hint.trim() : "无"}`,
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

/** collect 的依赖：派工契约（回指可追溯）。 */
export interface Web3dDeliverableCollectContext {
  /** 派工契约（ExpertDeliverable.contract 回指，可追溯）。 */
  contract: ExpertTaskContract;
}

export type Web3dDeliverableCollectResult =
  | { ok: true; deliverable: ExpertDeliverable }
  | {
      ok: false;
      code: "no_output" | "missing_deliverables" | "deliverable_invalid";
      hint: string;
      missing: string[];
    };

/**
 * Web3D 域工具回执 → 三栏交付 payload → QC 签名 → 组装闸门自检。
 *
 * 契约（registry web3d-director 行 requiredFields，钉死）：payload 三栏全形
 * （scene_spec/bundle_ref/qc），缺关键栏位返回结构化错误，不产半形数据
 * （对齐 screenwriter-delegate collect 铁律）：
 *   - 工具回执 ok:false 或非 JSON = 未交付（no_output），禁止拿失败回执组装。
 *   - scene_spec（工具回显 → 委托单兜底）、bundle_ref（GLB/打包产物指针，
 *     工具回显 → 交付物指针兜底）、qc 非空——缺任一 = missing_deliverables。
 *   - 组装后 validateExpertDeliverable 不过 = deliverable_invalid（不外流）。
 */
export function collectWeb3dDeliverableFromToolResult(
  result: Web3dToolResult,
  context: Web3dDeliverableCollectContext,
): Web3dDeliverableCollectResult {
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
      hint: "Web3D 域工具回执不是合法 JSON 物件：output 必须是工具层 ok()/fail() 产出的 JSON 字符串，禁止手拼。",
      missing: ["output"],
    };
  }
  if (parsed.ok !== true) {
    const err = (parsed.error ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      code: "no_output",
      hint: `Web3D 域工具回执 ok:false（未产出任何交付内容）：code=${String(err.code ?? "?")}，hint=${String(err.hint ?? "?")}。工具失败 = 未交付，禁止拿失败回执组装交付物。`,
      missing: ["ok"],
    };
  }

  const sceneSpec = strField(parsed.scene_spec);
  const bundleRef = strField(parsed.bundle_ref) ?? strField(parsed.artifact_path) ?? strField(parsed.url);
  const qc = strField(parsed.qc);
  // 三栏任一为空即早退（合成单一条件，TS 在此之后正确收窄为 string，
  // 对齐 screenwriter collect「缺关键栏位 = missing_deliverables」语义）。
  if (!sceneSpec || !bundleRef || !qc) {
    const missing: string[] = [];
    if (!sceneSpec) missing.push("scene_spec（场景规格为空）");
    if (!bundleRef) missing.push("bundle_ref（GLB/打包产物指针缺失）");
    if (!qc) missing.push("qc（QC 结论缺失）");
    const seen = Object.keys(parsed).join("、") || "（无）";
    return {
      ok: false,
      code: "missing_deliverables",
      hint: `交付物分拣缺关键栏位：${missing.join("、")}。payload 三栏必须全形（${WEB3D_DELIVERABLES.join("、")}，缺栏组装闸门不过），bundle_ref 必须是可核验的 GLB/打包产物指针。回执实际字段：${seen}。`,
      missing,
    };
  }

  const payload: Record<string, unknown> = {
    scene_spec: sceneSpec,
    bundle_ref: bundleRef,
    qc: `scene_spec_len=${sceneSpec.length}; bundle=${bundleRef}; verdict=${qc}`,
  };

  // bundle_ref 指针既是 payload 栏也是 evidence 本体：http(s) URL 走 url，
  // 其余（本地/相对路径产物，如 .blender-work/out/*.glb）走 artifactPath。
  const evidence: ExpertDeliverable["evidence"] = /^https?:\/\//.test(bundleRef)
    ? { url: bundleRef }
    : { artifactPath: bundleRef };

  const deliverable: ExpertDeliverable = {
    expertId: "web3d-director",
    kind: WEB3D_SCENE_KIND,
    payload,
    evidence,
    qcSignature: computeQcSignature({
      expertId: "web3d-director",
      kind: WEB3D_SCENE_KIND,
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
