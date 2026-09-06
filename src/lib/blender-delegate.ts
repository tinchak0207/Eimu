/**
 * Blender 委託單構造器 + bridge 產物 → 畫布 scene_3d 節點寫入側
 * （Astra 3D 導演工作站 P1-4，片H，2026-09-06）。
 *
 * 兩段職責：
 *   ① composeDelegation —— 主腦 → 3D 導演（Astra subagent）委託單構造器。
 *      schema：{ effect_description, reference_refs?, shot_count,
 *      duration_sec?, style_constraints?, deliverables[] }；序列化後 ≤2k token
 *      校驗，超限結構化報錯。委託單是「能力建設」契約：3D 導演隔離上下文自主
 *      調 blender_* 工具（真源 src/lib/blender-tools.ts），只回資產引用 + 摘要。
 *   ② collectSceneCardFromArtifacts —— bridge POST /v1/execute 回傳
 *      {ok, artifacts:[{path,bytes,kind:"blend|png|mp4|glb|other"}],
 *      scene_summary, stdout_tail, duration_ms}（檔案實體在 .blender-work/out/）
 *      按 kind 分揀成六欄 Scene3dCardMetadata（契約真源
 *      src/lib/canvas/types.ts；讀取端 toScene3dCard 收斂器任一必填欄不符
 *      即整包丟棄——所以這裡必須產全形六欄，缺關鍵產物返回結構化錯誤，
 *      唯一例外：缺 mp4 turntable 時用首張 png 兜底並在 summary 標注）。
 *   ③ buildScene3dCanvasOp —— 產物 → 節點寫入既有通道的輪子：
 *      canvas_apply_ops（agent-tool-contract.ts）的 add_node op 形狀，
 *      gateway 經 canvas.ops SSE 下發 → 前端 canvas-reducer-adapter.ts
 *      case "agent_ops" → normalizeAgentNode（缺尺寸取
 *      CANVAS_NODE_DEFAULT_SIZE[Scene3d] 預設）→ metadata 走讀取端
 *      toNodeMetadata 白名單（layout.ts toScene3dCard 六欄收斂）→
 *      Scene3dCardBody 渲染。與 director 節點同構（記憶
 *      director-frontend-piece5-cards：白名單欄位全形否則剝欄）。
 *
 * 輪子對照（禁自造輪子鐵律）：
 *   - 節點寫入形狀 = agent-tool-contract.ts canvas_apply_ops 的 add_node op
 *     （讀取端 normalizeAgentNode 是唯一消費者，欄位一一對應）。
 *   - 產物 URL = Scene3dCardBody 既有的 /api/canvas/image-proxy 代理形 +
 *     .blend/.glb 下載連結形；bridge 產物在 .blender-work/out/ 由
 *     resolveArtifactUrl（可注入，對齊 blender-tools.ts 依賴注入風格）負責
 *     變成可訪問 URL，本檔不自造上傳通道。
 *   - 文案簡體（記憶 agent-gateway-copy-rules）。
 */

import type { Scene3dCardMetadata } from "./canvas/types";
import type { BlenderArtifact, BlenderExecuteSuccess } from "./blender-tools";

// ─────────────────────────────────────────── ① 委託單構造器

/** 委託單 schema（Astra PRD P1-4 契約，釘死不得更改）。 */
export interface BlenderDelegationInput {
  /** 效果描述（一句話人話，3D 導演據此自主拆解 bpy 腳本）。 */
  effect_description: string;
  /** 參考資產引用（畫布節點 id / 附件 path / URL，原樣透傳）。 */
  reference_refs?: string[];
  /** 鏡頭數（1-12；超界結構化報錯）。 */
  shot_count: number;
  /** 期望時長秒（1-120，缺省 3D 導演自定）。 */
  duration_sec?: number;
  /** 風格約束（渲染引擎/打光/色調等一句話）。 */
  style_constraints?: string;
  /** 交付物清單（白名單：turntable/stills/blend/glb）。 */
  deliverables: BlenderDeliverable[];
}

/** 交付物白名單：與 Scene3dCardMetadata 六欄一一對應。 */
export const BLENDER_DELIVERABLES = ["turntable", "stills", "blend", "glb"] as const;
export type BlenderDeliverable = (typeof BLENDER_DELIVERABLES)[number];

/** 委託單形（gateway 收到 JSON 後原樣透傳給 3D 導演 subagent）。 */
export type BlenderDelegation = BlenderDelegationInput;

/** 預算的 token 計量口徑（與文案一致暴露給測試）。 */
export const DELEGATION_TOKEN_BUDGET = 2_000;

export type DelegationResult =
  | { ok: true; delegation: BlenderDelegation; serialized: string; estimated_tokens: number }
  | { ok: false; code: "invalid_delegation"; hint: string; fields: string[] };

/** 效果描述長度上限（防主腦塞整篇劇本進委託單）。 */
const EFFECT_DESCRIPTION_MAX = 600;
const STYLE_CONSTRAINTS_MAX = 300;
const REFERENCE_REFS_MAX = 8;

/**
 * 主腦 → 3D 導演委託單構造器。純函數零副作用：校驗不過返回結構化錯誤
 * （code/hint/fields），絕不 throw 原始錯誤（對齊 blender-tools.ts 錯誤鐵律）。
 */
export function composeDelegation(input: unknown): DelegationResult {
  const missing: string[] = [];
  const bad: string[] = [];
  const v = (input ?? {}) as Record<string, unknown>;

  // 必填欄位
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
      hint: `委託单缺少必填字段：${missing.join("、")}。effect_description 一句话效果描述、deliverables 交付物清单（${BLENDER_DELIVERABLES.join("/")}）、shot_count 镜头数均为必填。`,
      fields: missing,
    };
  }

  // deliverables 白名單收斂
  const cleanedDeliverables: BlenderDeliverable[] = [];
  for (const d of deliverables) {
    if (typeof d === "string" && (BLENDER_DELIVERABLES as readonly string[]).includes(d)) {
      if (!cleanedDeliverables.includes(d as BlenderDeliverable)) cleanedDeliverables.push(d as BlenderDeliverable);
    } else {
      bad.push("deliverables");
      break;
    }
  }

  // 邊界校驗
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
      hint: `委託单字段超出契约边界：${unique.join("、")}。effect_description ≤${EFFECT_DESCRIPTION_MAX} 字、style_constraints ≤${STYLE_CONSTRAINTS_MAX} 字、reference_refs ≤${REFERENCE_REFS_MAX} 条（各 ≤200 字）、shot_count 整数 1-12、duration_sec 1-120、deliverables 只接受 ${BLENDER_DELIVERABLES.join("、")}。`,
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
      hint: `委託单超过 2k token 预算（估算 ${estimated_tokens} > ${DELEGATION_TOKEN_BUDGET}）。请精简 effect_description / style_constraints 或减少 reference_refs。`,
      fields: ["effect_description", "style_constraints", "reference_refs"],
    };
  }
  return { ok: true, delegation, serialized, estimated_tokens };
}

/** 粗估 token：CJK 字元記 1、其餘連續非空白段記 ~0.25（4 char/token）。 */
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

// ─────────────────────────────────────────── ② 產物分揀 → 六欄 sceneCard

/** collect 的依賴：bridge 成功體 + 產物→URL 映射（既有通道，可注入 mock）。 */
export interface SceneCardCollectContext {
  /**
   * 產物 → 可訪問 URL。真源走既有通道（Scene3dCardBody 的
   * /api/canvas/image-proxy 代理形 + .blend/.glb 下載連結形）；bridge 檔案
   * 實體在 .blender-work/out/，映射本體由宿主環境提供，本檔不自造上傳通道。
   */
  resolveArtifactUrl?: (artifact: BlenderArtifact) => string;
}

export type SceneCardCollectResult =
  | { ok: true; sceneCard: Scene3dCardMetadata; /** true=缺 mp4，用首張 png 兜底。 */ turntable_fallback: boolean }
  | { ok: false; code: "no_artifacts" | "missing_deliverables"; hint: string; missing: string[] };

/**
 * 按 kind 分揀 bridge 產物 → 六欄 Scene3dCardMetadata。
 *
 * 契約（P1-4，釘死）：turntable=mp4、stills=png 清單、blend/glb=路徑；
 * 讀取端 toScene3dCard 六欄任一缺失整包丟棄，故本函數只產全形：
 *   - 缺 mp4 turntable → turntable_url 用首張 png 兜底 + summary 前綴标注。
 *   - 缺 blend 或 glb、或（無 mp4 也無 png）→ 結構化錯誤，不產半形數據。
 * URL 解析走 context.resolveArtifactUrl（缺省 = 檔名當相對路徑，下載連結形）。
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
      hint: "bridge 回傳零產物（artifacts 為空）：腳本沒有寫出任何檔案。請確認 bpy 腳本把產物寫到橋工作目錄相對路徑（.blender-work/out/），再重跑 blender_render / blender_export_gltf。",
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
      hint: `產物分揀缺關鍵交付物：${missing.join("、")}。sceneCard 六欄必須全形（缺欄讀取端整包丟棄）。實際收到：${[...seen].join("、") || "（無）"}。`,
      missing,
    };
  }

  // turntable：首個 mp4；缺 mp4 時首張 png 兜底（summary 標注）。
  const turntable = mp4s[0] ?? pngs[0];
  const turntableFallback = mp4s.length === 0;
  // stills：png 清單（兜底場景至少含被用作 turntable 的那張）。
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

/** collect 直接吃 bridge 成功體（blender-tools.ts bridgeExecute 回傳形）。 */
export function sceneCardFromExecuteResult(
  result: BlenderExecuteSuccess,
  ctx: SceneCardCollectContext = {},
): SceneCardCollectResult {
  return collectSceneCardFromArtifacts(result.artifacts, {
    scene_summary: typeof result.scene_summary === "string" && result.scene_summary.trim() !== "" ? result.scene_summary.trim() : "3D 場景交付",
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
 * 缺省映射：Scene3dCardBody 的 isHttpUrl 同款判定——絕對 URL / 站內絕對路徑
 * / data: 原樣（讀取端既認），純檔名（.blender-work/out/ 產物）落成站內
 * 絕對路徑 = 下載連結形，走站內代理/靜態通道，不自造新 URL 形。
 */
function defaultResolveArtifactUrl(a: BlenderArtifact): string {
  const p = a.path.replace(/^\/+/, "");
  if (/^https?:\/\//i.test(p) || p.startsWith("data:")) return p;
  return `/${p}`;
}

// ─────────────────────────────────────────── ③ 節點寫入 op（canvas_apply_ops 輪子）

/** add_node op 的 node 形（Partial<CanvasNode> & {id,type}，契約見 canvas/types.ts）。 */
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
 * sceneCard → canvas_apply_ops 的 add_node op（既有節點寫入通道輪子）。
 *
 * gateway 把 op 塞進 canvas.ops SSE（CanvasAgentOpsEvent）→ 前端
 * canvas-reducer-adapter case "agent_ops" → normalizeAgentNode：
 * type=scene_3d 在 CanvasNodeType 枚舉內（不降級文本）、缺尺寸自動取
 * CANVAS_NODE_DEFAULT_SIZE[Scene3d]=420×360、position 缺省 (40,40) 進自動排版。
 * metadata 只給 sceneCard 一欄（雙白名單已透傳整族，見 canvas-chat-types.ts L101）。
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

/** 一行組裝：bridge 成功體 → add_node op（寫入側唯一入口，接線最小面）。 */
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

/** sceneCard 內容指紋（同產物重觸發 = 同 id，撞 normalizeAgentNode 去重丟棄）。 */
function stableId(sceneCard: Scene3dCardMetadata): string {
  const raw = `${sceneCard.turntable_url}|${sceneCard.blend_path}|${sceneCard.glb_path}|${sceneCard.duration_ms}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
