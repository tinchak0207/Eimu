/**
 * 编剧委托单构造器 + 编剧域工具产物 → Expert 交付物组装侧
 * （MOE 改革 Wave2b 片，2026-09-08）。
 *
 * 逐行镜像轮子真源 src/lib/music-delegate.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：composeDelegation / estimateTokens /
 * 结构化报错铁律 / DI 缺省范式全部同构。白名单差异仅四处：
 *   ① 域字段换编剧版：logline/genre/tone/beats/shotlist/characters/world_refs
 *      白名单收敛（未知键丢弃，防 payload 注入，对齐 deliverables 白名单
 *      收敛同哲学）；数值栏位如场次（shotlist 条目 scene）与镜头时长
 *      （duration_sec）四舍五入取整（同 music 版 bpm 取整口径）。
 *      无 Lyria 风格 prompt 构建器（buildLyriaStylePrompt 为音乐域专属），
 *      委派 prompt 直接按白名单字段拼接。
 *   ② 交付物栏位：beats / shotlist / qc 三栏（SCREENWRITER_DELIVERABLES，
 *      与 expert-registry screenwriter 行 requiredFields 同源）。
 *   ③ 宪法注入：beastMode === true 时把 deploy-staging/expert-gateway/
 *      expert-constitution.md 原文注入 prompt 头；OFF 时一个字不多、档案不触碰。
 *      beastMode 由调用方经 expert-registry.readBeastMode(settings) 计算后传入——
 *      本档不 import expert-registry（registry → persona → delegate 单向依赖，
 *      反向 import 成环，delegate 先载入会在 persona 顶层别名处 TDZ 崩，
 *      记忆 2026-09-08-wave1-b3-music-expert-registration）。
 *      载入范式照搬 music-delegate 的 DI 缺省：loadConstitution 可注入，
 *      缺省 fs 读落位稿，读不到带原文死因结构化报错（诚实铁律，禁止静默降级）。
 *   ④ 域无本地工具档：harness 工具（script_scene_parse 等）真源在 VPS
 *      .opencode/tools/，本地 harness-tool-registry.ts 只登记 id；工具回执
 *      契约形 ScreenwriterToolResult 本地定义（与 music-tools MusicToolResult
 *      同形 {title, output}，禁自造第二份形状）。
 *
 * music-delegate.ts / blender-delegate.ts 本体一行不动，本档只 import 其
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
  type ScreenwriterDeliverablePayload,
} from "./expert-contract";

// ─────────────────────────────────────────── ① 委托单构造器

/** 宪法落位稿路径（BEAST_MODE=ON 注入源；VPS gateway 同源引用）。 */
export const EXPERT_CONSTITUTION_PATH = "deploy-staging/expert-gateway/expert-constitution.md" as const;

/** 交付字段白名单：与 expert-registry screenwriter 行 requiredFields 一一对应。 */
export const SCREENWRITER_DELIVERABLES = ["beats", "shotlist", "qc"] as const;
export type ScreenwriterDeliverable = (typeof SCREENWRITER_DELIVERABLES)[number];

/** 交付物种类（编剧域 kind，本档钉死；收口片翻正时对齐）。 */
export const SCREENWRITER_DELIVERABLE_KIND = "screenplay_storyboard" as const;

/** 工具回执契约形（域无本地工具档，本地定义；与 music-tools MusicToolResult 同形）。 */
export type ScreenwriterToolResult = { title: string; output: string };

/** 分镜清单条目（场次数/镜头时长为数值栏位，收敛时四舍五入取整；未知键丢弃）。 */
export interface ShotlistEntry {
  /** 场次描述（一句人话）。 */
  description: string;
  /** 场次号（正数，取整）。 */
  scene?: number;
  /** 镜头时长秒（正数，取整）。 */
  duration_sec?: number;
}

/** 委托单 schema（MOE Wave2b 契约，钉死不得更改）。 */
export interface ScreenwriterDelegationInput {
  /** 故事内核（一句话人话：谁在何处想干什么、遇到什么阻力）。 */
  logline: string;
  /** 题材（可选，如「科幻剧情」）。 */
  genre?: string;
  /** 基调（可选，如「冷峻而温暖」）。 */
  tone?: string;
  /** 既有故事节拍（可选；缺省由编剧分镜自主拆解）。 */
  beats?: string[];
  /** 既有分镜清单（可选；缺省由编剧分镜自主产出）。 */
  shotlist?: ShotlistEntry[];
  /** 角色清单（可选，名字+一句话人设）。 */
  characters?: string[];
  /** 世界观/素材引用（画布节点 id / 附件 path / URL，原样透传）。 */
  world_refs?: string[];
  /** 交付字段清单（白名单：SCREENWRITER_DELIVERABLES）。 */
  deliverables: ScreenwriterDeliverable[];
}

/** 委托单形（gateway 收到 JSON 后原样透传给编剧分镜 subagent）。 */
export type ScreenwriterDelegation = ScreenwriterDelegationInput;

export type ScreenwriterDelegationResult =
  | { ok: true; delegation: ScreenwriterDelegation; serialized: string; estimated_tokens: number }
  | { ok: false; code: "invalid_delegation"; hint: string; fields: string[] };

/** 故事内核长度上限（防主脑塞整篇剧本进委托单；同 music 版 effect_description 口径）。 */
const LOGLINE_MAX = 600;
/** 题材/基调长度上限。 */
const GENRE_TONE_MAX = 120;
/** 故事节拍条数/单条长度上限。 */
const BEATS_MAX = 24;
const BEAT_MAX_LEN = 200;
/** 分镜清单场数/单场描述长度上限。 */
const SHOTLIST_MAX = 48;
const SHOT_DESCRIPTION_MAX = 200;
/** 角色条数/单条长度上限。 */
const CHARACTERS_MAX = 12;
const CHARACTER_MAX_LEN = 120;
/** 世界观引用条数/单条长度上限（同 music 版 reference_refs 口径）。 */
const WORLD_REFS_MAX = 8;
const WORLD_REF_MAX_LEN = 200;

/**
 * 主脑 → 编剧分镜委托单构造器。纯函数零副作用：校验不过返回结构化错误
 * （code/hint/fields），绝不 throw 原始错误（对齐 music-delegate 错误铁律）。
 */
export function composeScreenwriterDelegation(input: unknown): ScreenwriterDelegationResult {
  const missing: string[] = [];
  const bad: string[] = [];
  const v = (input ?? {}) as Record<string, unknown>;

  // 必填栏位
  const logline = strField(v.logline);
  if (logline === undefined) missing.push("logline");
  const deliverables = v.deliverables;
  if (!Array.isArray(deliverables) || deliverables.length === 0) {
    missing.push("deliverables");
  }

  if (missing.length > 0 || !Array.isArray(deliverables) || logline === undefined) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单缺少必填字段：${missing.join("、")}。logline 一句话故事内核（谁在何处想干什么、遇到什么阻力）、deliverables 交付字段清单（${SCREENWRITER_DELIVERABLES.join("/")}）均为必填。`,
      fields: missing,
    };
  }

  // deliverables 白名单收敛
  const cleanedDeliverables: ScreenwriterDeliverable[] = [];
  for (const d of deliverables) {
    if (typeof d === "string" && (SCREENWRITER_DELIVERABLES as readonly string[]).includes(d)) {
      if (!cleanedDeliverables.includes(d as ScreenwriterDeliverable)) cleanedDeliverables.push(d as ScreenwriterDeliverable);
    } else {
      bad.push("deliverables");
      break;
    }
  }

  // 边界校验
  if (logline.length > LOGLINE_MAX) bad.push("logline");
  const genre = strField(v.genre);
  if (genre !== undefined && genre.length > GENRE_TONE_MAX) bad.push("genre");
  const tone = strField(v.tone);
  if (tone !== undefined && tone.length > GENRE_TONE_MAX) bad.push("tone");
  let beats: string[] | undefined;
  if (v.beats !== undefined) {
    if (Array.isArray(v.beats)) {
      beats = v.beats.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
      if (beats.length > BEATS_MAX) bad.push("beats");
      if (beats.some((s) => s.length > BEAT_MAX_LEN)) bad.push("beats");
    } else {
      bad.push("beats");
    }
  }
  let shotlist: ShotlistEntry[] | undefined;
  if (v.shotlist !== undefined) {
    if (Array.isArray(v.shotlist)) {
      shotlist = [];
      for (const e of v.shotlist) {
        const entry = shotlistEntryField(e);
        if (entry === undefined) {
          bad.push("shotlist");
          break;
        }
        shotlist.push(entry);
      }
      if (!bad.includes("shotlist") && shotlist.length > SHOTLIST_MAX) bad.push("shotlist");
    } else {
      bad.push("shotlist");
    }
  }
  let characters: string[] | undefined;
  if (v.characters !== undefined) {
    if (Array.isArray(v.characters)) {
      characters = v.characters.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
      if (characters.length > CHARACTERS_MAX) bad.push("characters");
      if (characters.some((s) => s.length > CHARACTER_MAX_LEN)) bad.push("characters");
    } else {
      bad.push("characters");
    }
  }
  let worldRefs: string[] | undefined;
  if (v.world_refs !== undefined) {
    if (Array.isArray(v.world_refs)) {
      worldRefs = v.world_refs.filter((r): r is string => typeof r === "string" && r.trim() !== "").map((r) => r.trim());
      if (worldRefs.length > WORLD_REFS_MAX) bad.push("world_refs");
      if (worldRefs.some((r) => r.length > WORLD_REF_MAX_LEN)) bad.push("world_refs");
    } else {
      bad.push("world_refs");
    }
  }
  if (cleanedDeliverables.length === 0) bad.push("deliverables");

  if (bad.length > 0) {
    const unique = [...new Set(bad)];
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单字段超出契约边界：${unique.join("、")}。logline ≤${LOGLINE_MAX} 字、genre/tone ≤${GENRE_TONE_MAX} 字、beats ≤${BEATS_MAX} 条（各 ≤${BEAT_MAX_LEN} 字）、shotlist ≤${SHOTLIST_MAX} 场（每场 description ≤${SHOT_DESCRIPTION_MAX} 字）、characters ≤${CHARACTERS_MAX} 条（各 ≤${CHARACTER_MAX_LEN} 字）、world_refs ≤${WORLD_REFS_MAX} 条（各 ≤${WORLD_REF_MAX_LEN} 字）、deliverables 只接受 ${SCREENWRITER_DELIVERABLES.join("、")}。`,
      fields: unique,
    };
  }

  const delegation: ScreenwriterDelegation = {
    logline,
    ...(genre !== undefined ? { genre } : {}),
    ...(tone !== undefined ? { tone } : {}),
    ...(beats !== undefined && beats.length > 0 ? { beats } : {}),
    ...(shotlist !== undefined && shotlist.length > 0 ? { shotlist } : {}),
    ...(characters !== undefined && characters.length > 0 ? { characters } : {}),
    ...(worldRefs !== undefined && worldRefs.length > 0 ? { world_refs: worldRefs } : {}),
    deliverables: cleanedDeliverables,
  };
  const serialized = JSON.stringify(delegation);
  const estimated_tokens = estimateTokens(serialized);
  if (estimated_tokens > DELEGATION_TOKEN_BUDGET) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单超过 2k token 预算（估算 ${estimated_tokens} > ${DELEGATION_TOKEN_BUDGET}）。请精简 logline / beats / shotlist 或减少 world_refs。`,
      fields: ["logline", "beats", "shotlist", "world_refs"],
    };
  }
  return { ok: true, delegation, serialized, estimated_tokens };
}

/** 粗估 token：复用 blender-delegate 单一真源（禁复制），口径 CJK 记 1、其余 ~0.25。 */
export { estimateTokens };

function strField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * 分镜条目收敛（白名单栏位形）：只认 ShotlistEntry 已知键，description 必填
 * 非空字符串；scene / duration_sec 正数四舍五入取整（同 music 版 bpm 取整口径）；
 * 未知键丢弃（防 payload 注入）。
 */
function shotlistEntryField(v: unknown): ShotlistEntry | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const description = strField(raw.description);
  if (description === undefined || description.length > SHOT_DESCRIPTION_MAX) return undefined;
  const entry: ShotlistEntry = { description };
  if (typeof raw.scene === "number" && Number.isFinite(raw.scene) && raw.scene > 0) entry.scene = Math.round(raw.scene);
  if (typeof raw.duration_sec === "number" && Number.isFinite(raw.duration_sec) && raw.duration_sec > 0) entry.duration_sec = Math.round(raw.duration_sec);
  return entry;
}

// ─────────────────────────────────────────── ② 委派 prompt 组装（宪法注入挂点）

export interface ScreenwriterPromptAssemblyContext {
  /**
   * 野兽模式开关：调用方经 expert-registry.readBeastMode(settings) 计算后传入。
   * 本档不 import expert-registry（避免 registry → persona → delegate 依赖成环，
   * 见档头说明）。缺省 false = OFF = 宪法一个字不注入、档案不触碰。
   */
  beastMode?: boolean;
  /**
   * 宪法原文载入（DI，范式同 music-delegate loadConstitution / blender-delegate
   * resolveArtifactUrl）；缺省 fs 读 EXPERT_CONSTITUTION_PATH 落位稿。
   */
  loadConstitution?: () => string;
}

export type ScreenwriterPromptAssemblyResult =
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
 * 编剧分镜委派 prompt 组装（唯一出口）：宪法（仅 BEAST_MODE=ON，注入头部）+
 * 委托单任务段（白名单字段按编剧域词汇直接拼接）。OFF 时一个字不多：宪法
 * 原文不出现、落位稿不被读取。宪法载入失败结构化报错（code/hint 带原文死因），
 * 绝不静默降级成无宪法派遣。
 */
export function assembleScreenwriterPrompt(
  delegation: ScreenwriterDelegation,
  context: ScreenwriterPromptAssemblyContext = {},
): ScreenwriterPromptAssemblyResult {
  const beats = delegation.beats ?? [];
  const shotlist = delegation.shotlist ?? [];
  const body = [
    "# 编剧分镜委托单",
    `故事内核：${delegation.logline}`,
    `题材：${delegation.genre ?? "（未指定）"}`,
    `基调：${delegation.tone ?? "（未指定）"}`,
    `故事节拍（既有 beats）：${beats.length > 0 ? beats.join("；") : "（无；由编剧分镜自主拆解）"}`,
    `分镜清单（既有 shotlist）：${shotlist.length > 0 ? shotlist.map((s) => (typeof s.scene === "number" ? `第${s.scene}场：${s.description}` : s.description)).join("；") : "（无；由编剧分镜自主产出）"}`,
    `角色：${delegation.characters && delegation.characters.length > 0 ? delegation.characters.join("；") : "无"}`,
    `世界观引用：${delegation.world_refs && delegation.world_refs.length > 0 ? delegation.world_refs.join("；") : "无"}`,
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
export interface ScreenwriterDeliverableCollectContext {
  /** 派工契约（ExpertDeliverable.contract 回指，可追溯）。 */
  contract: ExpertTaskContract;
}

export type ScreenwriterDeliverableCollectResult =
  | { ok: true; deliverable: ExpertDeliverable }
  | {
      ok: false;
      code: "no_output" | "missing_deliverables" | "deliverable_invalid";
      hint: string;
      missing: string[];
    };

/**
 * 编剧域工具回执 → 三栏交付 payload → QC 签名 → 组装闸门自检。
 *
 * 契约（registry screenwriter 行 requiredFields，钉死）：payload 三栏全形
 * （beats/shotlist/qc），缺关键栏位返回结构化错误，不产半形数据（对齐
 * music-delegate collect 铁律）：
 *   - 工具回执 ok:false 或非 JSON = 未交付（no_output），禁止拿失败回执组装。
 *   - beats / shotlist 非空数组、qc 非空字符串、交付物指针
 *     （artifact_path 或 url 任一）非空——缺任一 = missing_deliverables。
 *   - 组装后 validateExpertDeliverable 不过 = deliverable_invalid（不外流）。
 */
export function collectScreenwriterDeliverableFromToolResult(
  result: ScreenwriterToolResult,
  context: ScreenwriterDeliverableCollectContext,
): ScreenwriterDeliverableCollectResult {
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
      hint: "编剧域工具回执不是合法 JSON 物件：output 必须是工具层 ok()/fail() 产出的 JSON 字符串，禁止手拼。",
      missing: ["output"],
    };
  }
  if (parsed.ok !== true) {
    const err = (parsed.error ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      code: "no_output",
      hint: `编剧域工具回执 ok:false（未产出任何交付内容）：code=${String(err.code ?? "?")}，hint=${String(err.hint ?? "?")}。工具失败 = 未交付，禁止拿失败回执组装交付物。`,
      missing: ["ok"],
    };
  }

  const beats = Array.isArray(parsed.beats) ? parsed.beats : [];
  const shotlist = Array.isArray(parsed.shotlist) ? parsed.shotlist : [];
  const qc = strField(parsed.qc);
  const artifactPath = strField(parsed.artifact_path);
  const url = strField(parsed.url);
  const missing: string[] = [];
  if (beats.length === 0) missing.push("beats（故事节拍为空）");
  if (shotlist.length === 0) missing.push("shotlist（分镜清单为空）");
  if (!qc) missing.push("qc（QC 结论缺失）");
  if (!artifactPath && !url) missing.push("交付物指针（artifact_path/url 均缺）");
  if (missing.length > 0) {
    const seen = Object.keys(parsed).join("、") || "（无）";
    return {
      ok: false,
      code: "missing_deliverables",
      hint: `交付物分拣缺关键栏位：${missing.join("、")}。payload 三栏必须全形（${SCREENWRITER_DELIVERABLES.join("、")}，缺栏组装闸门不过），且必须附 artifact_path 或 url 交付物指针。回执实际字段：${seen}。`,
      missing,
    };
  }

  const payload: ScreenwriterDeliverablePayload = {
    beats,
    shotlist,
    qc: `beats=${beats.length}; shots=${shotlist.length}; verdict=${qc}`,
  };

  const evidence: ExpertDeliverable["evidence"] = artifactPath ? { artifactPath } : { url: url as string };

  const deliverable: ExpertDeliverable = {
    expertId: "screenwriter",
    kind: SCREENWRITER_DELIVERABLE_KIND,
    payload,
    evidence,
    qcSignature: computeQcSignature({
      expertId: "screenwriter",
      kind: SCREENWRITER_DELIVERABLE_KIND,
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
