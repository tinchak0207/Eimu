/**
 * Blender 委托单构造器 + bridge 产物 → 画布 scene_3d 节点写入侧
 * （Astra 3D 导演工作站 P1-4，片H，2026-09-06）。
 *
 * 两段职责：
 *   ① composeDelegation —— 主脑 → 3D 导演（Astra subagent）委托单构造器。
 *      schema：{ effect_description, reference_refs?, shot_count,
 *      duration_sec?, style_constraints?, deliverables[] }；序列化后 ≤2k token
 *      校验，超限结构化报错。委托单是「能力建设」契约：3D 导演隔离上下文自主
 *      调 blender_* 工具（真源 src/lib/blender-tools.ts），只回资产引用 + 摘要。
 *   ② collectSceneCardFromArtifacts —— bridge POST /v1/execute 回传
 *      {ok, artifacts:[{path,bytes,kind:"blend|png|mp4|glb|other"}],
 *      scene_summary, stdout_tail, duration_ms}（档案实体在 .blender-work/out/）
 *      按 kind 分拣成六栏 Scene3dCardMetadata（契约真源
 *      src/lib/canvas/types.ts；读取端 toScene3dCard 收敛器任一必填栏不符
 *      即整包丢弃——所以这里必须产全形六栏，缺关键产物返回结构化错误，
 *      唯一例外：缺 mp4 turntable 时用首张 png 兜底并在 summary 标注）。
 *   ③ buildScene3dCanvasOp —— 产物 → 节点写入既有通道的轮子：
 *      canvas_apply_ops（agent-tool-contract.ts）的 add_node op 形状，
 *      gateway 经 canvas.ops SSE 下发 → 前端 canvas-reducer-adapter.ts
 *      case "agent_ops" → normalizeAgentNode（缺尺寸取
 *      CANVAS_NODE_DEFAULT_SIZE[Scene3d] 预设）→ metadata 走读取端
 *      toNodeMetadata 白名单（layout.ts toScene3dCard 六栏收敛）→
 *      Scene3dCardBody 渲染。与 director 节点同构（记忆
 *      director-frontend-piece5-cards：白名单栏位全形否则剥栏）。
 *
 * 轮子对照（禁自造轮子铁律）：
 *   - 节点写入形状 = agent-tool-contract.ts canvas_apply_ops 的 add_node op
 *     （读取端 normalizeAgentNode 是唯一消费者，栏位一一对应）。
 *   - 产物 URL = Scene3dCardBody 既有的 /api/canvas/image-proxy 代理形 +
 *     .blend/.glb 下载连结形；bridge 产物在 .blender-work/out/ 由
 *     resolveArtifactUrl（可注入，对齐 blender-tools.ts 依赖注入风格）负责
 *     变成可访问 URL，本档不自造上传通道。
 *   - 文案简体（记忆 agent-gateway-copy-rules）。
 */

import type { Scene3dCardMetadata } from "./canvas/types";
import type { BlenderArtifact, BlenderExecuteSuccess } from "./blender-tools";

// ─────────────────────────────────────────── ① 委托单构造器

/** 委托单 schema（Astra PRD P1-4 契约，钉死不得更改）。 */
export interface BlenderDelegationInput {
  /** 效果描述（一句话人话，3D 导演据此自主拆解 bpy 脚本）。 */
  effect_description: string;
  /** 参考资产引用（画布节点 id / 附件 path / URL，原样透传）。 */
  reference_refs?: string[];
  /** 镜头数（1-12；超界结构化报错）。 */
  shot_count: number;
  /** 期望时长秒（1-120，缺省 3D 导演自定）。 */
  duration_sec?: number;
  /** 风格约束（渲染引擎/打光/色调等一句话）。 */
  style_constraints?: string;
  /** 交付物清单（白名单：turntable/stills/blend/glb）。 */
  deliverables: BlenderDeliverable[];
}

/** 交付物白名单：与 Scene3dCardMetadata 六栏一一对应。 */
export const BLENDER_DELIVERABLES = ["turntable", "stills", "blend", "glb"] as const;
export type BlenderDeliverable = (typeof BLENDER_DELIVERABLES)[number];

/** 委托单形（gateway 收到 JSON 后原样透传给 3D 导演 subagent）。 */
export type BlenderDelegation = BlenderDelegationInput;

/** 预算的 token 计量口径（与文案一致暴露给测试）。 */
export const DELEGATION_TOKEN_BUDGET = 2_000;

export type DelegationResult =
  | { ok: true; delegation: BlenderDelegation; serialized: string; estimated_tokens: number }
  | { ok: false; code: "invalid_delegation"; hint: string; fields: string[] };

/** 效果描述长度上限（防主脑塞整篇剧本进委托单）。 */
const EFFECT_DESCRIPTION_MAX = 600;
const STYLE_CONSTRAINTS_MAX = 300;
const REFERENCE_REFS_MAX = 8;

/**
 * 主脑 → 3D 导演委托单构造器。纯函数零副作用：校验不过返回结构化错误
 * （code/hint/fields），绝不 throw 原始错误（对齐 blender-tools.ts 错误铁律）。
 */
export function composeDelegation(input: unknown): DelegationResult {
  const missing: string[] = [];
  const bad: string[] = [];
  const v = (input ?? {}) as Record<string, unknown>;

  // 必填栏位
  const effect = strField(v.effect_description);
  if (effect === undefined) missing.push("effect_description");
  const deliverables = v.deliverables;
  if (!Array.isArray(deliverables) || deliverables.length === 0) {
    missing.push("deliverables");
  }
  const shotCount = numField(v.shot_count);
  if (shotCount === undefined) missing.push("shot_count");

  if (missing.length > 0 || !Array.isArray(deliverables) || effect === undefined || shotCount === undefined) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单缺少必填字段：${missing.join("、")}。effect_description 一句话效果描述、deliverables 交付物清单（${BLENDER_DELIVERABLES.join("/")}）、shot_count 镜头数均为必填。`,
      fields: missing,
    };
  }

  // deliverables 白名单收敛
  const cleanedDeliverables: BlenderDeliverable[] = [];
  for (const d of deliverables) {
    if (typeof d === "string" && (BLENDER_DELIVERABLES as readonly string[]).includes(d)) {
      if (!cleanedDeliverables.includes(d as BlenderDeliverable)) cleanedDeliverables.push(d as BlenderDeliverable);
    } else {
      bad.push("deliverables");
      break;
    }
  }

  // 边界校验
  if (effect.length > EFFECT_DESCRIPTION_MAX) bad.push("effect_description");
  if (shotCount < 1 || shotCount > 12 || !Number.isInteger(shotCount)) bad.push("shot_count");
  const durationSec = numField(v.duration_sec);
  if (durationSec !== undefined && (durationSec < 1 || durationSec > 120)) bad.push("duration_sec");
  const style = strField(v.style_constraints);
  if (style !== undefined && style.length > STYLE_CONSTRAINTS_MAX) bad.push("style_constraints");
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
      hint: `委托单字段超出契约边界：${unique.join("、")}。effect_description ≤${EFFECT_DESCRIPTION_MAX} 字、style_constraints ≤${STYLE_CONSTRAINTS_MAX} 字、reference_refs ≤${REFERENCE_REFS_MAX} 条（各 ≤200 字）、shot_count 整数 1-12、duration_sec 1-120、deliverables 只接受 ${BLENDER_DELIVERABLES.join("、")}。`,
      fields: unique,
    };
  }

  const delegation: BlenderDelegation = {
    effect_description: effect,
    ...(refs !== undefined && refs.length > 0 ? { reference_refs: refs } : {}),
    shot_count: shotCount,
    ...(durationSec !== undefined ? { duration_sec: durationSec } : {}),
    ...(style !== undefined ? { style_constraints: style } : {}),
    deliverables: cleanedDeliverables,
  };
  const serialized = JSON.stringify(delegation);
  const estimated_tokens = estimateTokens(serialized);
  if (estimated_tokens > DELEGATION_TOKEN_BUDGET) {
    return {
      ok: false,
      code: "invalid_delegation",
      hint: `委托单超过 2k token 预算（估算 ${estimated_tokens} > ${DELEGATION_TOKEN_BUDGET}）。请精简 effect_description / style_constraints 或减少 reference_refs。`,
      fields: ["effect_description", "style_constraints", "reference_refs"],
    };
  }
  return { ok: true, delegation, serialized, estimated_tokens };
}

/** 粗估 token：CJK 字元记 1、其余连续非空白段记 ~0.25（4 char/token）。 */
export function estimateTokens(s: string): number {
  let cjk = 0;
  for (const ch of s) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1;
  }
  const other = s.length - cjk;
  return Math.ceil(cjk * 1 + other / 4);
}

function strField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function numField(v: unknown): number | undefined {
  const n = Number(v);
  return typeof v === "number" && Number.isFinite(n) ? n : undefined;
}

// ─────────────────────────────────────────── ② 产物分拣 → 六栏 sceneCard

/** collect 的依赖：bridge 成功体 + 产物→URL 映射（既有通道，可注入 mock）。 */
export interface SceneCardCollectContext {
  /**
   * 产物 → 可访问 URL。真源走既有通道（Scene3dCardBody 的
   * /api/canvas/image-proxy 代理形 + .blend/.glb 下载连结形）；bridge 档案
   * 实体在 .blender-work/out/，映射本体由宿主环境提供，本档不自造上传通道。
   */
  resolveArtifactUrl?: (artifact: BlenderArtifact) => string;
}

export type SceneCardCollectResult =
  | { ok: true; sceneCard: Scene3dCardMetadata; /** true=缺 mp4，用首张 png 兜底。 */ turntable_fallback: boolean }
  | { ok: false; code: "no_artifacts" | "missing_deliverables"; hint: string; missing: string[] };

/**
 * 按 kind 分拣 bridge 产物 → 六栏 Scene3dCardMetadata。
 *
 * 契约（P1-4，钉死）：turntable=mp4、stills=png 清单、blend/glb=路径；
 * 读取端 toScene3dCard 六栏任一缺失整包丢弃，故本函数只产全形：
 *   - 缺 mp4 turntable → turntable_url 用首张 png 兜底 + summary 前缀标注。
 *   - 缺 blend 或 glb、或（无 mp4 也无 png）→ 结构化错误，不产半形数据。
 * URL 解析走 context.resolveArtifactUrl（缺省 = 档名当相对路径，下载连结形）。
 */
export function collectSceneCardFromArtifacts(
  artifacts: BlenderArtifact[],
  context: { scene_summary: string; duration_ms: number } & SceneCardCollectContext,
): SceneCardCollectResult {
  const list = Array.isArray(artifacts) ? artifacts.filter((a): a is BlenderArtifact => isArtifact(a)) : [];
  if (list.length === 0) {
    return {
      ok: false,
      code: "no_artifacts",
      hint: "bridge 回传零产物（artifacts 为空）：脚本没有写出任何档案。请确认 bpy 脚本把产物写到桥工作目录相对路径（.blender-work/out/），再重跑 blender_render / blender_export_gltf。",
      missing: ["artifacts"],
    };
  }

  const resolve = context.resolveArtifactUrl ?? defaultResolveArtifactUrl;
  const mp4s = list.filter((a) => a.kind === "mp4");
  const pngs = list.filter((a) => a.kind === "png");
  const blends = list.filter((a) => a.kind === "blend");
  const glbs = list.filter((a) => a.kind === "glb");

  const missing: string[] = [];
  if (mp4s.length === 0 && pngs.length === 0) missing.push("turntable(mp4) 或 stills(png)");
  if (blends.length === 0) missing.push("blend");
  if (glbs.length === 0) missing.push("glb");
  if (missing.length > 0) {
    const seen = new Set(list.map((a) => `${a.kind}:${a.path}`));
    return {
      ok: false,
      code: "missing_deliverables",
      hint: `产物分拣缺关键交付物：${missing.join("、")}。sceneCard 六栏必须全形（缺栏读取端整包丢弃）。实际收到：${[...seen].join("、") || "（无）"}。`,
      missing,
    };
  }

  // turntable：首个 mp4；缺 mp4 时首张 png 兜底（summary 标注）。
  const turntable = mp4s[0] ?? pngs[0];
  const turntableFallback = mp4s.length === 0;
  // stills：png 清单（兜底场景至少含被用作 turntable 的那张）。
  const stills = (turntableFallback ? pngs : pngs.length > 0 ? pngs : [turntable]).map(resolve);

  const summary = turntableFallback
    ? `（turntable 缺席，以首帧静帧兜底）${context.scene_summary}`
    : context.scene_summary;

  return {
    ok: true,
    turntable_fallback: turntableFallback,
    sceneCard: {
      turntable_url: resolve(turntable),
      stills_urls: stills,
      blend_path: resolve(blends[0]),
      glb_path: resolve(glbs[0]),
      scene_summary: summary,
      duration_ms: Math.max(0, Math.round(context.duration_ms)),
    },
  };
}

/** collect 直接吃 bridge 成功体（blender-tools.ts bridgeExecute 回传形）。 */
export function sceneCardFromExecuteResult(
  result: BlenderExecuteSuccess,
  ctx: SceneCardCollectContext = {},
): SceneCardCollectResult {
  return collectSceneCardFromArtifacts(result.artifacts, {
    scene_summary: typeof result.scene_summary === "string" && result.scene_summary.trim() !== "" ? result.scene_summary.trim() : "3D 场景交付",
    duration_ms: result.duration_ms,
    ...ctx,
  });
}

function isArtifact(a: unknown): a is BlenderArtifact {
  return (
    !!a &&
    typeof a === "object" &&
    typeof (a as BlenderArtifact).path === "string" &&
    (a as BlenderArtifact).path !== "" &&
    typeof (a as BlenderArtifact).kind === "string"
  );
}

/**
 * 缺省映射：Scene3dCardBody 的 isHttpUrl 同款判定——绝对 URL / 站内绝对路径
 * / data: 原样（读取端既认），纯档名（.blender-work/out/ 产物）落成站内
 * 绝对路径 = 下载连结形，走站内代理/静态通道，不自造新 URL 形。
 */
function defaultResolveArtifactUrl(a: BlenderArtifact): string {
  const p = a.path.replace(/^\/+/, "");
  if (/^https?:\/\//i.test(p) || p.startsWith("data:")) return p;
  return `/${p}`;
}

// ─────────────────────────────────────────── ③ 节点写入 op（canvas_apply_ops 轮子）

/** add_node op 的 node 形（Partial<CanvasNode> & {id,type}，契约见 canvas/types.ts）。 */
export type Scene3dAddNodeOp = {
  type: "add_node";
  node: {
    id: string;
    type: "scene_3d";
    title?: string;
    metadata: { sceneCard: Scene3dCardMetadata };
  };
};

/**
 * sceneCard → canvas_apply_ops 的 add_node op（既有节点写入通道轮子）。
 *
 * gateway 把 op 塞进 canvas.ops SSE（CanvasAgentOpsEvent）→ 前端
 * canvas-reducer-adapter case "agent_ops" → normalizeAgentNode：
 * type=scene_3d 在 CanvasNodeType 枚举内（不降级文本）、缺尺寸自动取
 * CANVAS_NODE_DEFAULT_SIZE[Scene3d]=420×360、position 缺省 (40,40) 进自动排版。
 * metadata 只给 sceneCard 一栏（双白名单已透传整族，见 canvas-chat-types.ts L101）。
 */
export function buildScene3dCanvasOp(
  sceneCard: Scene3dCardMetadata,
  opts?: { node_id?: string; title?: string },
): Scene3dAddNodeOp {
  const id = typeof opts?.node_id === "string" && opts.node_id.trim() !== "" ? opts.node_id.trim() : `scene3d-${stableId(sceneCard)}`;
  return {
    type: "add_node",
    node: {
      id,
      type: "scene_3d",
      ...(opts?.title && opts.title.trim() !== "" ? { title: opts.title.trim().slice(0, 120) } : {}),
      metadata: { sceneCard },
    },
  };
}

/** 一行组装：bridge 成功体 → add_node op（写入侧唯一入口，接线最小面）。 */
export function sceneCardOpFromExecuteResult(
  result: BlenderExecuteSuccess,
  ctx: SceneCardCollectContext & { node_id?: string; title?: string } = {},
): { ok: true; op: Scene3dAddNodeOp; turntable_fallback: boolean } | { ok: false; code: string; hint: string; missing: string[] } {
  const collected = sceneCardFromExecuteResult(result, ctx);
  if (!collected.ok) return collected;
  return {
    ok: true,
    turntable_fallback: collected.turntable_fallback,
    op: buildScene3dCanvasOp(collected.sceneCard, { node_id: ctx.node_id, title: ctx.title }),
  };
}

/** sceneCard 内容指纹（同产物重触发 = 同 id，撞 normalizeAgentNode 去重丢弃）。 */
function stableId(sceneCard: Scene3dCardMetadata): string {
  const raw = `${sceneCard.turntable_url}|${sceneCard.blend_path}|${sceneCard.glb_path}|${sceneCard.duration_ms}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
