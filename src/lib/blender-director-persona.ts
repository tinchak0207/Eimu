/**
 * 3D 导演 persona 契约真源（Astra 3D 导演工作站 P1-4，片 J，2026-09-06）。
 *
 * 本档是「3D 导演（文案简体「3D 导演」）」persona 的单一契约定义档：
 *   ① 名称/文案（简体，记忆 agent-gateway-copy-rules）
 *   ② 工具白名单（blender_exec / blender_render / blender_export_gltf / image_quote）
 *   ③ SKILL 挂载引用（repo 内 skills/blender-director/SKILL.md 的语义定位；
 *      VPS 侧经 opencode.json agent 条目的 prompt 段引用该路径，见
 *      deploy-staging/blender-director-persona/ 三落位稿）
 *   ④ 委托单入参契约（composeDelegation schema）+ 回传契约
 *      （bridge ExecuteResult → collectSceneCardFromArtifacts →
 *      buildScene3dCanvasOp）——全部 import 型别，零重定义。
 *   ⑤ MOE Wave1-A Expert 框架接线：野兽模式（expert-registry.readBeastMode）
 *      ON 时委托单 prompt 注入 Expert 宪法头部（deploy-staging/expert-gateway/
 *      expert-constitution.md 路径常量，同 SKILL_PATH 单一真源范式）、回覆走
 *      交付物契约（blenderArtifactToEvidence → ExpertDeliverable →
 *      computeQcSignature → validateExpertDeliverable 闸门）并附契约摘要一行；
 *      OFF 时所有组装与现状逐栏位一致（零回归）。registry 反向 import 有
 *      TDZ 模组环，readBeastMode 一律 call-time 动态 import。
 *
 * 为什么是「契约档」而非运行时：persona 的运行时真源（模型绑定
 * agent-models.json bindings、subagent 派遣 gateway/subagent.ts、agent prompt
 * / AGENTS.md）都在 VPS /opt/agent-harness（记忆 agent-persona-bound-model-
 * reasoning、subagent-ui-menu-gateway-reasoning-filter），本地 repo 无 gateway
 * 真源可改（.tmp-home/subagent.ts 是 08-31 派遣用镜像非活码）。本档钉死契约
 * 四要素并被委托单/回传两端 import，Astra 真模型上线日只换
 * VPS agent-models.json 的 bindings.persona.director 一个 id。
 *
 * 隔离铁律：3D 导演回传只含资产引用 + 场景树摘要（sceneCard 六栏 +
 * scene_summary ≤500 token），过程（stdout/脚本/多轮痕迹）不出 subagent——
 * 对应 gateway subagent.ts 既有隔离语义（subagent.delta 只透 text、
 * summary 截 600 字、子会话用后即删），本档不新增通道。
 */

import {
  BLENDER_DELIVERABLES,
  buildScene3dCanvasOp,
  composeDelegation,
  estimateTokens,
  sceneCardOpFromExecuteResult,
  type BlenderDelegation,
  type DelegationResult,
} from "./blender-delegate";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundledExpertConstitution } from "./expert-gateway-assets";
import { BLENDER_HARNESS_TOOL_IDS, type BlenderExecuteSuccess } from "./blender-tools";
import {
  blenderArtifactToEvidence,
  computeQcSignature,
  validateExpertDeliverable,
  type ExpertDeliverable,
} from "./expert-contract";

// ─────────────────────────────────────────── ① persona 身份与文案

/** persona 键名（gateway bindings / 设定 UI / 日志统一用此 id）。 */
export const DIRECTOR_PERSONA_ID = "director" as const;

/** 展示名（简体文案；选单/卡片/日志统一取此值）。 */
export const DIRECTOR_PERSONA_LABEL = "3D 导演" as const;

/** persona 一句话定位（设定页/选单描述用）。 */
export const DIRECTOR_PERSONA_DESCRIPTION =
  "专属 3D 导演：接委托单自主驱动 Blender 产出骨架动画与场景资产，只回资产引用与场景摘要，过程不出子代理。" as const;

// ─────────────────────────────────────────── ② 工具白名单

/**
 * 3D 导演可调用的工具白名单（PRD P1-4 钉死；禁给全工具面——3D 导演
 * 不需要画视频/写 workflow）。
 *
 * - blender_exec / blender_render / blender_export_gltf：直接取
 *   blender-tools.ts 的 BLENDER_HARNESS_TOOL_IDS（禁止手抄 id 字串面）。
 * - image_quote：报价查询（harness 既有 id，harness-tool-registry 登记在案）。
 */
export const DIRECTOR_PERSONA_TOOL_IDS = [
  ...BLENDER_HARNESS_TOOL_IDS, // blender_exec / blender_render / blender_export_gltf
  "image_quote",
] as const;

export type DirectorPersonaToolId = (typeof DIRECTOR_PERSONA_TOOL_IDS)[number];

// ─────────────────────────────────────────── ③ SKILL 挂载引用

/**
 * SKILL 挂载点：repo 内 3D 导演配方库（片B 交付，五阶段管线 + 12 份上游配方）。
 * VPS 侧 opencode.json 的 director agent 条目 prompt 段引用同内容路径
 * （AGENTS.md 路由：Blender/bpy 委托一律先读该 SKILL 再动手）。
 * 本地只持有路径与用途声明，不复制内容（单一真源防漂移）。
 */
export const DIRECTOR_PERSONA_SKILL_PATH = "skills/blender-director/SKILL.md" as const;

// ─────────────────────────────────────────── ④ 委托单 + 回传契约（import，零重定义）

/**
 * 委托单入参契约 = blender-delegate.ts composeDelegation 的 schema。
 * 型别全 import（BlenderDelegation / DelegationResult），此处零重定义。
 */
export type { BlenderDelegation, DelegationResult };

/** bridge 成功体回传契约（blender-tools.ts 原型 import）。 */
export type { BlenderExecuteSuccess };

/** 委托单回传（隔离铁律形）：资产引用 + 场景摘要，≤500 token。 */
export type DirectorDelegationReply =
  | {
      ok: true;
      /** 画布节点写入 op（scene_3d add_node；gateway 经 canvas.ops SSE 下发）。 */
      scene_op: ReturnType<typeof buildScene3dCanvasOp>;
      /** 场景树摘要（≤500 token，隔离铁律：过程不出 subagent）。 */
      scene_summary: string;
      /**
       * MOE Wave1-A：野兽模式 ON 时附的契约交付物（已过
       * validateExpertDeliverable 闸门）；OFF 时缺席 = 回覆键集合与现状一致。
       */
      deliverable?: ExpertDeliverable;
    }
  | { ok: false; code: string; hint: string };

/** 回传摘要 token 帽（隔离铁律钉死值）。 */
export const DIRECTOR_REPLY_SUMMARY_TOKEN_CAP = 500 as const;

/**
 * 3D 导演回传组装（唯一出口）：bridge ExecuteResult → sceneCard →
 * canvas add_node op。两端函数均 import 自 blender-delegate.ts，本档只做
 * 序列（不新增校验、不改 op 形状）。
 *
 * MOE Wave1-A 野兽模式分支（assembleDirectorReplyOptions.settings 提供时生效）：
 *   ON（readBeastMode === true）→ 交付物契约路径：sceneCard 六栏 payload 经
 *   blenderArtifactToEvidence 组 evidence、computeQcSignature 签名、
 *   validateExpertDeliverable 校验，不过 = 结构化报错如实透传（诚实铁律，
 *   禁静默回退现状形）；回覆附契约摘要一行（expertId/kind/签名前 8 位）。
 *   OFF / settings 缺省 → 现状逐栏位一致（零回归，reply 不带 deliverable）。
 *   readBeastMode 经 readBeastModeSync（registry 动态 import 快取 + 同义
 *   内联后备，见 primeExpertRegistry）读取。
 */
export interface AssembleDirectorReplyOptions {
  /** 设定记录（readBeastMode 消费 beast_mode 栏位；提供即启用野兽分支）。 */
  settings?: unknown;
  /** 野兽模式 ON 时回填契约的原始委托单（materials 回指用，可缺省）。 */
  delegation?: BlenderDelegation;
}

export function assembleDirectorReply(
  result: BlenderExecuteSuccess,
  ctx: Parameters<typeof sceneCardOpFromExecuteResult>[1] = {},
  options?: AssembleDirectorReplyOptions,
): DirectorDelegationReply {
  const assembled = sceneCardOpFromExecuteResult(result, ctx);
  if (!assembled.ok) {
    return { ok: false, code: assembled.code, hint: assembled.hint };
  }
  const summary = typeof result.scene_summary === "string" ? result.scene_summary.trim() : "";
  const beastOn =
    options !== undefined &&
    "settings" in options &&
    readBeastModeSync(options.settings);
  if (!beastOn) {
    return {
      ok: true,
      scene_op: assembled.op,
      scene_summary: summary,
    };
  }

  // ── 野兽模式 ON：交付物契约路径（Wave1-A）──
  const delegationRefs = options?.delegation?.reference_refs;
  const deliverable: ExpertDeliverable = {
    expertId: "director3d",
    kind: DIRECTOR_DELIVERABLE_KIND,
    payload: { sceneCard: assembled.op.node.metadata.sceneCard },
    evidence: blenderArtifactToEvidence(pickPrimaryArtifact(result.artifacts)),
    contract: {
      expertId: "director3d",
      intent:
        typeof ctx.title === "string" && ctx.title.trim() !== ""
          ? ctx.title.trim()
          : summary,
      materials: Array.isArray(delegationRefs) ? [...delegationRefs] : [],
      acceptance: [],
    },
    qcSignature: "",
  };
  deliverable.qcSignature = computeQcSignature(deliverable);
  const validation = validateExpertDeliverable(deliverable);
  if (!validation.ok) {
    return { ok: false, code: "deliverable_gate_failed", hint: validation.errors.join("；") };
  }
  return {
    ok: true,
    scene_op: assembled.op,
    scene_summary: capSceneSummaryWithLine(summary, buildDeliverableSummaryLine(deliverable)),
    deliverable,
  };
}

/** 交付物种类（scene_3d 节点域，与 buildScene3dCanvasOp 的 node.type 对齐）。 */
export const DIRECTOR_DELIVERABLE_KIND = "scene_3d" as const;

/**
 * 交付物主指针：优先 mp4（turntable 真身）、其次 png、否则首个产物
 * （collectSceneCardFromArtifacts 的 turntable 选取同序）。
 */
function pickPrimaryArtifact(artifacts: BlenderExecuteSuccess["artifacts"]): BlenderExecuteSuccess["artifacts"][number] {
  const list = Array.isArray(artifacts) ? artifacts : [];
  return list.find((a) => a.kind === "mp4") ?? list.find((a) => a.kind === "png") ?? list[0] ?? { path: "", bytes: 0, kind: "" };
}

/** 契约摘要一行（不超 DIRECTOR_REPLY_SUMMARY_TOKEN_CAP）：expertId/kind/签名前 8 位。 */
export function buildDeliverableSummaryLine(d: ExpertDeliverable): string {
  const line = `deliverable expertId=${d.expertId} kind=${d.kind} qc=${d.qcSignature.slice(0, 8)}`;
  return estimateTokens(line) > DIRECTOR_REPLY_SUMMARY_TOKEN_CAP ? line.slice(0, DIRECTOR_REPLY_SUMMARY_TOKEN_CAP) : line;
}

/**
 * ON 模式摘要帽（仅野兽分支用；OFF 路径零回归不截断）：契约行永不截除，
 * base 摘要从尾部对半收缩至 总长 ≤ DIRECTOR_REPLY_SUMMARY_TOKEN_CAP。
 */
function capSceneSummaryWithLine(base: string, line: string): string {
  let head = base;
  let out = head ? `${head}\n${line}` : line;
  while (head.length > 0 && estimateTokens(out) > DIRECTOR_REPLY_SUMMARY_TOKEN_CAP) {
    head = head.slice(0, Math.floor(head.length / 2));
    out = head ? `${head}\n${line}` : line;
  }
  return out;
}

/**
 * 主脑 → 3D 导演委托单构造（唯一入口）：直接透传 composeDelegation
 * （import 轮子，零包装逻辑）。persona 层不做第二套校验。
 */
export const composeDirectorDelegation = composeDelegation;

/** 交付物白名单 re-export（契约钉死：与 Scene3dCardMetadata 六栏一一对应）。 */
export { BLENDER_DELIVERABLES };

// ─────────────────────────────────────────── ⑤ MOE Wave1-A：宪法注入 + settings 入口

/**
 * Expert 宪法档路径（repo 内相对路径，单一真源 = deploy-staging/expert-gateway/
 * expert-constitution.md）。注入范式同 ③ 的 DIRECTOR_PERSONA_SKILL_PATH：
 * 本地只持有路径与用途声明，内容由 readFileSync 在组装 prompt 时读取
 * （测试端同款读法，见 blender-director-persona.test.ts ③；服务端 runtime
 * 读取走 composeDirectorDelegationForSettings 的 try/catch 后备 inline）。
 */
export const DIRECTOR_EXPERT_CONSTITUTION_PATH =
  "deploy-staging/expert-gateway/expert-constitution.md" as const;

/**
 * 交付前自检节（诚实门禁，2026-09-08）：渲染后必须抽帧亲眼看、逐项对照
 * 委托单、不符如实报、「全部完成」只在自检全过后才许出现。宪法级行为——
 * 随宪法注入走（ON 分支 prompt 宪法与委托单 JSON 之间），OFF 裸单契约
 * （serialized 原文一个字不多，blender-expert-frame.test.ts 钉死）不动。
 * 导出为单一真源常量：VPS persona 层（OFF 模式的提示面）日后引用同源文本。
 */
export const DIRECTOR_SELF_CHECK_SECTION = `## 交付前自检（硬流程，跳过=事故）

渲染完成 ≠ 交付完成。以下四步一步不许跳，违反任何一步即为事故，不是建议。（镜面立方体事故：宣称「metallic 1.0 镜面反光扫过、全部完成」，实际抽帧是哑光深灰＋构图裁顶——话术编出的细节救不了画面。）

1. **亲眼看，才许开口。** 渲染完成后必须抽 ≥2 帧或读 stills 逐张亲眼看（用现场可用的读图通路）。没有读图通路时必须明说「无法自检，需暴君终验」，禁止假装看过，禁止拿 stdout／日志脑补画面。
2. **逐项对照委托单。** 材质关键词（镜面／金属／哑光／透明…）在帧里真的可见吗？主体完整入框吗（无裁顶裁边）？机位构图与委托一致吗？
3. **不符就如实报。** 回覆写「自检未过：X 项不符（逐项列出）」：可修 → 修后重渲、重过自检；不可修 → 明说未达委托单，禁止包装。「全部完成」只在自检全过后才许出现。
4. **自检结果写进回覆。** 末行附「自检：材质✓ 构图✓ 机位✓」（不符项标 ✗ 并写死因），与交付物摘要行的 qc 签名并列——只有 qc 没有自检行 = 视同未自检 = 未交付。` as const;

/**
 * readBeastMode 的同域同步封装：registry 为避 TDZ 模组环（registry 顶层
 * 解引用本档常量）走 call-time 动态 import。primeExpertRegistry 先行预载
 * 失败时，按 registry 同一判准（beast_mode 栏 === true）内联后备，语义
 * 逐位元组一致；两态皆记档待查（诚实铁律：静默降级必留痕）。
 */
export type ExpertRegistryModule = {
  readBeastMode(settings: unknown): boolean;
};

let expertRegistryModule: ExpertRegistryModule | undefined;
let expertRegistryLoadFailureState: string | undefined;
/**
 * 测试注入的 loader（仅经 primeExpertRegistry 的可选参数设定）。生产呼叫端
 * 一律不传参 → 恒走动态 import 真源；注入值在本模组生命周期内生效，使不传
 * 参的生产呼叫端（如 composeDirectorDelegationPrompt）亦能覆现载入失败路径。
 */
let expertRegistryLoaderOverride: (() => Promise<unknown>) | undefined;

export async function primeExpertRegistry(
  loadExpertRegistry?: () => Promise<unknown>,
): Promise<boolean> {
  if (expertRegistryModule) return true;
  if (loadExpertRegistry !== undefined) expertRegistryLoaderOverride = loadExpertRegistry;
  const load = expertRegistryLoaderOverride ?? (() => import("./expert-registry"));
  try {
    expertRegistryModule = (await load()) as ExpertRegistryModule;
    expertRegistryLoadFailureState = undefined;
    return true;
  } catch (err) {
    expertRegistryLoadFailureState = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return false;
  }
}

/** 动态 import expert-registry 失败的死因（成功／未 prime 时为 undefined）。诚实铁律：两态皆记档待查，此为唯一出口。 */
export function getExpertRegistryLoadFailure(): string | undefined {
  return expertRegistryLoadFailureState;
}

/** 测试专用：清空 registry 动态 import 快取（野兽分支读取路径回退测试用）。 */
export function __resetExpertRegistryForTest(): void {
  expertRegistryModule = undefined;
  expertRegistryLoadFailureState = undefined;
  expertRegistryLoaderOverride = undefined;
}

function readBeastModeSync(settings: unknown): boolean {
  if (expertRegistryModule) return expertRegistryModule.readBeastMode(settings);
  // 后备路径：判准与 expert-registry.readBeastMode 逐位元组同义（缺栏/非布林/false 一律 OFF）。
  if (typeof settings !== "object" || settings === null) return false;
  return (settings as Record<string, unknown>).beast_mode === true;
}

/**
 * 委托单 prompt 头部组装：OFF / 宪法档读取失败（异常或空档）时返回
 * serialized 原文（一个字都不多）；ON 时把宪法全文注入头部，其后紧接
 * 交付前自检节（DIRECTOR_SELF_CHECK_SECTION，诚实门禁 2026-09-08），再以
 * 分隔线接原委托单 JSON。ON 且宪法文本缺席 = 结构化报错（不静默裸奔，诚实铁律）。
 */
export async function composeDirectorDelegationPrompt(
  input: unknown,
  settings?: unknown,
  opts: { constitutionPath?: string } = {},
): Promise<
  | {
      ok: true;
      prompt: string;
      constitutionInjected: boolean;
      estimated_tokens: number;
      /** 野兽分支 registry 动态 import 失败死因（成功时缺席）；诚实铁律唯一出口。 */
      registry_load_failure?: string;
    }
  | { ok: false; code: string; hint: string; fields?: string[] }
> {
  const composed = composeDelegation(input);
  if (!composed.ok) return composed;
  const on = readBeastModeSync(settings);
  if (!on) {
    return {
      ok: true,
      prompt: composed.serialized,
      constitutionInjected: false,
      estimated_tokens: composed.estimated_tokens,
    };
  }
  // 决策现场留痕（诚实铁律）：接住 prime 结果，失败时 additive 补死因出口。
  const primed = await primeExpertRegistry();
  let constitution: string | undefined;
  let constitutionError: string | undefined;
  try {
    // 显式 override（opts.constitutionPath）仍走 fs 读该档（保留既有注入 seam 与
    // 测试：指向不存在／空档时结构化拒绝）；未给才走静态 import 的 bundle 镜像
    // （Vercel 拿不到 deploy-staging/，见 src/lib/expert-gateway-assets.ts 档头）。
    const raw = opts.constitutionPath
      ? readFileSync(
          path.resolve(fileURLToPath(import.meta.url), "../../..", opts.constitutionPath),
          "utf8",
        )
      : loadBundledExpertConstitution();
    if (raw.trim() !== "") constitution = raw;
  } catch (err) {
    // 死因留痕（诚实铁律）：读取异常进结构化 hint，不进 log（secret 卫生铁律）。
    constitutionError = err instanceof Error ? err.message : String(err);
  }
  if (constitution === undefined) {
    return {
      ok: false,
      code: "constitution_unavailable",
      hint: `野兽模式已开但 Expert 宪法档不可读（${DIRECTOR_EXPERT_CONSTITUTION_PATH}${constitutionError ? `：${constitutionError}` : "：档案为空"}）：拒绝裸奔派单，请修复宪法档部署或暂时关闭 beast_mode。`,
    };
  }
  // 自检节随宪法注入（宪法级：ON 必有；顺序=宪法 → 自检 → 分隔线 → 委托单 JSON）。
  const prompt = `${constitution.trimEnd()}\n\n${DIRECTOR_SELF_CHECK_SECTION}\n\n---\n\n${composed.serialized}`;
  return {
    ok: true,
    prompt,
    constitutionInjected: true,
    estimated_tokens: estimateTokens(prompt),
    ...(primed ? {} : { registry_load_failure: getExpertRegistryLoadFailure() ?? "unknown" }),
  };
}

/**
 * settings 入口（Wave1-A 接线面）：主脑调用方把 settings 记录传进来即可——
 * OFF 时返回值与 composeDirectorDelegation 逐栏位一致（ok/delegation/
 * serialized/estimated_tokens 四栏原样），ON 时多出 prompt 头部注入宪法。
 * （composeDelegation 为纯函数，本包装与 prompt 组装各调一次，幂等零副作用。）
 */
export async function composeDirectorDelegationForSettings(
  input: unknown,
  settings?: unknown,
): Promise<
  | (Extract<DelegationResult, { ok: true }> & {
      constitutionInjected: boolean;
      prompt: string;
      /** 野兽分支 registry 动态 import 失败死因（成功时缺席）；透传自 prompt 组装。 */
      registry_load_failure?: string;
    })
  | Extract<DelegationResult, { ok: false }>
  | { ok: false; code: "constitution_unavailable"; hint: string }
> {
  const promptResult = await composeDirectorDelegationPrompt(input, settings);
  if (!promptResult.ok) {
    if (promptResult.code === "constitution_unavailable") {
      return { ok: false, code: promptResult.code, hint: promptResult.hint };
    }
    return {
      ok: false,
      code: "invalid_delegation",
      hint: promptResult.hint,
      fields: promptResult.fields ?? [],
    };
  }  const composed = composeDelegation(input);
  if (!composed.ok) return composed;
  return {
    ...composed,
    constitutionInjected: promptResult.constitutionInjected,
    prompt: promptResult.prompt,
    ...(promptResult.registry_load_failure !== undefined
      ? { registry_load_failure: promptResult.registry_load_failure }
      : {}),
  };
}
