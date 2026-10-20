import { isValidCreationStep, MAX_EPISODES_PER_PROJECT } from "@/lib/creation-flow-steps";
import type { CanvasReducerState } from "../reducer";
// 版本清单清洗与 project-store 共用同一份（逐项白名单＋裁剪；不制造第二个漂移点）。
import { normalizeNodeVersions } from "../node-versions";
// 风格 id 值域的唯一判据（＝STYLE_LIBRARY 注册面），与 project-store/生成端共用同一份。
import { normalizeProjectStyleId } from "../project-style";
// 解说剧设定（P1-5／D7）：型别值域＋旁白音色值域的唯一清洗入口（与 project-style 同地位）。
import { normalizeProjectNarration, type CanvasScriptType } from "../project-narration";
import { isCanvasProjectType, type CanvasConnection, type CanvasEpisode, type CanvasNode, type CanvasPosition, type CanvasProject, type CanvasProjectMetaPatch, type CanvasProjectType, type CanvasViewport } from "../types";
import { clampScale } from "./geometry";
import { normalizeCanvasNode, num } from "./normalize";

// ─────────────────────────────────────────── 专案序列化（Blob / 汇出汇入）

/** reducer state + 视口 → 可存的 CanvasProject。 */
export function toCanvasProject(
  base: { id: string; title: string; createdAt?: string },
  state: CanvasReducerState,
  viewport: CanvasViewport,
  backgroundMode: "dots" | "lines" | "blank",
  budget?: { totalCoins: number; usedCoins: number },
  cardIds?: string[],
  // 作品/剧集三级状态机（2026-09-15 刀 1 前端接线）：照 cardIds 的既有条件展开范式。
  // 刻意「不清洗」——清洗单一真源在 project-store 的 normalizeProject，
  // 这里只决定「要不要带这个栏位」，否则两处白名单会漂移（见 PRD §3）。
  projectType?: CanvasProjectType,
  currentStep?: number,
  episodes?: CanvasEpisode[],
  // 专案级风格绑定（P1-8／D34）：同样「不清洗」，只决定要不要带键 ——
  // 注册面判据在 project-store 的 normalizeProject（呼叫 normalizeProjectStyleId）。
  styleId?: string,
  // 解说剧设定（P1-5／D7）：第 11、12 个位置参数（照三栏/风格先例往后追加）。
  // 同样「不清洗」——只决定要不要带键，值域判据在 project-store 的 normalizeProject
  // （呼叫 normalizeProjectNarration）。
  scriptType?: string,
  narrationVoice?: string,
): CanvasProject {
  const now = new Date().toISOString();
  // 风格 id 只在此判「有没有合法值」；非法/未知 id 不落盘（落盘端 normalizeProject 同一把尺）。
  const projectStyleId = normalizeProjectStyleId(styleId);
  const narration = normalizeProjectNarration({ scriptType, narrationVoice });
  return {
    id: base.id,
    title: base.title || "未命名画布",
    createdAt: base.createdAt ?? now,
    updatedAt: now,
    // 软删节点仍要落盘（否则 restore API/还原撤销都找不到资料）：
    // 带 deletedAt 随 nodes 一起存，读取端 fromCanvasProject 再拆回 deletedNodes。
    nodes:
      state.deletedNodes && state.deletedNodes.length > 0
        ? [...state.nodes, ...state.deletedNodes]
        : state.nodes,
    connections: state.connections,
    viewport,
    backgroundMode,
    ...(budget ? { budget } : {}),
    ...(cardIds && cardIds.length > 0 ? { cardIds } : {}),
    ...(projectType ? { projectType } : {}),
    ...(isValidCreationStep(currentStep) ? { currentStep } : {}),
    ...(episodes && episodes.length > 0 ? { episodes } : {}),
    // 风格绑定（P1-8／D34）：有合法 id 才带键；缺栏＝无绑定（旧专案形状不变）。
    ...(projectStyleId ? { styleId: projectStyleId } : {}),
    // 解说剧设定（P1-5／D7）：有值才带键；缺栏＝未宣告（旧专案形状不变）。
    ...(narration.scriptType ? { scriptType: narration.scriptType } : {}),
    ...(narration.narrationVoice ? { narrationVoice: narration.narrationVoice } : {}),
    // 版本历史（2026-09-27）：有版本才带键，旧专案形状不变。
    ...(state.nodeVersions && state.nodeVersions.length > 0 ? { nodeVersions: state.nodeVersions } : {}),
  };
}

/**
 * CanvasProject → reducer state。units 一律回空阵列：
 * 单元是「这次会话的生成批次」，跨刷新没有意义，节点/连线才是画布本体。
 */
export function fromCanvasProject(project: {
  nodes?: unknown;
  connections?: unknown;
  nodeVersions?: unknown;
}): CanvasReducerState {
  const rawNodes = Array.isArray(project.nodes) ? project.nodes : [];
  const allNodes = rawNodes.flatMap((n) => {
    if (!n || typeof n !== "object") return [];
    const r = n as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length === 0) return [];
    const node = normalizeCanvasNode({
      id: r.id,
      type: String(r.type ?? ""),
      title: String(r.title ?? ""),
      ...(r.position && typeof r.position === "object"
        ? { position: r.position as CanvasPosition }
        : {}),
      ...(num(r.width) !== undefined ? { width: num(r.width) } : {}),
      ...(num(r.height) !== undefined ? { height: num(r.height) } : {}),
      ...(r.metadata && typeof r.metadata === "object" ? { metadata: r.metadata as Record<string, unknown> } : {}),
      ...(typeof r.deletedAt === "string" && r.deletedAt.length > 0 ? { deletedAt: r.deletedAt } : {}),
    });
    // 存档里的座标要原样还原（normalizeCanvasNode 只在缺座标时给 0,0）。
    const pos = r.position as CanvasPosition | undefined;
    return [pos && num(pos.x) !== undefined && num(pos.y) !== undefined ? { ...node, position: { x: pos.x, y: pos.y } } : node];
  });
  // 软删节点（有 deletedAt）不进可见 nodes，收进 deletedNodes（可经 restore 还原）。
  const nodes = allNodes.filter((n) => !n.deletedAt);
  const deletedNodes = allNodes.filter((n) => n.deletedAt);
  const ids = new Set(nodes.map((n) => n.id));
  const rawConns = Array.isArray(project.connections) ? project.connections : [];
  const connections = rawConns.flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const r = c as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.fromNodeId !== "string" || typeof r.toNodeId !== "string") return [];
    // 悬空连线不还原：一头找不到节点的线画出来是一条指向虚空的曲线。
    if (!ids.has(r.fromNodeId) || !ids.has(r.toNodeId)) return [];
    return [{ id: r.id, fromNodeId: r.fromNodeId, toNodeId: r.toNodeId }];
  });
  const nodeVersions = normalizeNodeVersions(project.nodeVersions);
  return {
    units: [],
    nodes,
    connections,
    ...(deletedNodes.length > 0 ? { deletedNodes } : {}),
    ...(nodeVersions ? { nodeVersions } : {}),
  };
}

/**
 * 读取侧防炸校验：只确认「型别不会让下游炸」，不重复 project-store 的完整清洗。
 *
 * 分工（勿混）：store `normalizeProject` 是落盘白名单（截断字串、补时间戳、
 * episodeNo 去重、上限 200）；这里是从任意 JSON（快照/汇入档/旧 Blob）取用时的
 * 最小防护——非法项一律丢弃，绝不捏造栏位。两者刻意不共用，避免读取路径反向
 * 影响落盘语义。
 */
function readEpisode(payload: unknown): CanvasEpisode | null {
  if (!payload || typeof payload !== "object") return null;
  const e = payload as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length === 0) return null;
  if (typeof e.title !== "string" || e.title.length === 0) return null;
  if (typeof e.episodeNo !== "number" || !Number.isInteger(e.episodeNo) || e.episodeNo < 1) return null;
  if (e.status !== "draft" && e.status !== "processing" && e.status !== "finished") return null;
  return {
    id: e.id,
    episodeNo: e.episodeNo,
    title: e.title,
    status: e.status,
    ...(typeof e.script === "string" ? { script: e.script } : {}),
    createdAt: typeof e.createdAt === "string" ? e.createdAt : "",
    updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : "",
  };
}

/**
 * 从 CanvasProject 取出专案级栏位（给 hook 还原用；缺栏位/非法值一律省略）。
 *
 * 刻意独立于 `fromCanvasProject`：后者回 `CanvasReducerState`（只有 nodes/connections/
 * units），改它的回传型别会炸一票消费端；三栏是「专案级」状态，不是 reducer 状态。
 * （`styleId` 是同一批专案级栏位的第四员，P1-8／D34；`scriptType`／`narrationVoice` 是
 * 第五、六员，P1-5／D7；合法性判据共用 `project-style.ts` 与 `project-narration.ts`。）
 */
export function canvasProjectMeta(project: {
  projectType?: unknown;
  currentStep?: unknown;
  episodes?: unknown;
  styleId?: unknown;
  scriptType?: unknown;
  narrationVoice?: unknown;
}): {
  projectType?: CanvasProjectType;
  currentStep?: number;
  episodes?: CanvasEpisode[];
  styleId?: string;
  scriptType?: CanvasScriptType;
  narrationVoice?: string;
} {
  if (!project || typeof project !== "object") return {};
  const episodes = Array.isArray(project.episodes)
    ? project.episodes.flatMap((item) => {
        const episode = readEpisode(item);
        return episode ? [episode] : [];
      })
    : [];
  const styleId = normalizeProjectStyleId(project.styleId);
  // 解说剧设定（P1-5／D7）：清洗入口与落盘端同一份（逐栏独立、非法省略该键）。
  const narration = normalizeProjectNarration({ scriptType: project.scriptType, narrationVoice: project.narrationVoice });
  return {
    ...(isCanvasProjectType(project.projectType) ? { projectType: project.projectType } : {}),
    ...(isValidCreationStep(project.currentStep) ? { currentStep: project.currentStep } : {}),
    ...(episodes.length > 0 ? { episodes } : {}),
    ...(styleId ? { styleId } : {}),
    ...(narration.scriptType ? { scriptType: narration.scriptType } : {}),
    ...(narration.narrationVoice ? { narrationVoice: narration.narrationVoice } : {}),
  };
}

/**
 * agent op 载荷清洗：`set_project_meta` 的 patch（2026-09-16 G1）。
 *
 * 为何需要第三个清洗层：agent 送进来的 patch 与 UI 的 `setProjectMeta` 走同一个写入口，
 * 但来源不可信（模型输出，可能带 AID 审核态、超长 script、非 1..7 的 step）。这里只做
 * 「能不能进 state」的守门；完整落盘白名单仍在 `project-store.normalizeProject`（两层互不取代）。
 *
 * 语义（与 store/读取端既有范式一致 + 一处刻意不同）：
 *   - 逐栏独立：某栏非法只丢该栏，不整包作废（同 `normalizeEpisodes` 逐项丢弃）。
 *   - 非法值**省略该键**，不是写 `undefined` —— 省略 = `setProjectMeta` 不动该栏。
 *     刻意不同于 UI 路径的「`undefined` = 清除」：agent 打错一个 enum 值不该清掉
 *     用户已填的剧集清单。**代价（诚实标记）**：agent 无法藉此 op 清空栏位。
 *   - `episodes` 逐项走 `readEpisode`（缺 id/title、episodeNo 非正整数、status 非三态 → 丢该项）
 *     → `episodeNo` 去重（保留首见）→ 上限 `MAX_EPISODES_PER_PROJECT`。
 *     去重/截断刻意在此就做（不只靠落盘端）：否则 UI 显示的集数与 Blob 存下的不一致
 *     （`normalizeProject` 也会去重截断），即「介面显示 ≠ 实际资料」。
 *   - `episodes: []` 与非法值同义（省略）：不制造「空壳已设定」的假象；要清空留下次机会。
 */
export function normalizeProjectMetaPatch(payload: unknown): CanvasProjectMetaPatch {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const p = payload as Record<string, unknown>;
  const out: CanvasProjectMetaPatch = {};
  if (isCanvasProjectType(p.projectType)) out.projectType = p.projectType;
  if (isValidCreationStep(p.currentStep)) out.currentStep = p.currentStep;
  // 风格绑定（P1-8／D34）：未注册 id 省略该键＝不动专案已绑的风格
  // （同其余栏位：模型打错一个 id 不该把用户绑好的风格清掉）。
  const styleId = normalizeProjectStyleId(p.styleId);
  if (styleId) out.styleId = styleId;
  // 解说剧设定（P1-5／D7）：同款逐栏判——型别值域外省略该键（模型打错型别不该清掉
  // 用户选好的解说剧设定），音色未在语音库里也省略该键。
  const narration = normalizeProjectNarration({ scriptType: p.scriptType, narrationVoice: p.narrationVoice });
  if (narration.scriptType) out.scriptType = narration.scriptType;
  if (narration.narrationVoice) out.narrationVoice = narration.narrationVoice;
  if (Array.isArray(p.episodes)) {
    const seen = new Set<number>();
    const episodes: CanvasEpisode[] = [];
    for (const item of p.episodes) {
      const episode = readEpisode(item);
      if (!episode) continue;
      if (seen.has(episode.episodeNo)) continue; // episodeNo 去重，保留首见
      seen.add(episode.episodeNo);
      episodes.push(episode);
      if (episodes.length >= MAX_EPISODES_PER_PROJECT) break;
    }
    if (episodes.length > 0) out.episodes = episodes;
  }
  return out;
}

/** 汇出档的信封（带 kind/version，汇入时才能认出这不是别的 JSON）。 */
export const CANVAS_EXPORT_KIND = "image-studio.canvas";
export const CANVAS_EXPORT_VERSION = 1;

export interface CanvasExportFile {
  kind: typeof CANVAS_EXPORT_KIND;
  version: number;
  exportedAt: string;
  project: CanvasProject;
}

export function buildExportFile(project: CanvasProject): CanvasExportFile {
  return {
    kind: CANVAS_EXPORT_KIND,
    version: CANVAS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    project,
  };
}

/** 汇入：认信封也认裸 project（别人手改过的档案不该直接失败）。回 null = 不是画布档。 */
export function parseImportFile(raw: unknown): {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport?: CanvasViewport;
  backgroundMode?: "dots" | "lines" | "blank";
  title?: string;
  projectType?: CanvasProjectType;
  currentStep?: number;
  episodes?: CanvasEpisode[];
  /** 专案级风格绑定（P1-8／D34）：汇出→汇入带著走（否则静默丢风格）。 */
  styleId?: string;
  /** 解说剧型别（P1-5／D7）：同样带著走（否则「汇出→汇入」会静默丢掉解说剧设定）。 */
  scriptType?: CanvasScriptType;
  /** 旁白音色（P1-5／D7）：同上。 */
  narrationVoice?: string;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const env = raw as Record<string, unknown>;
  const project = (env.kind === CANVAS_EXPORT_KIND && env.project && typeof env.project === "object"
    ? (env.project as Record<string, unknown>)
    : env) as Record<string, unknown>;
  if (!Array.isArray(project.nodes)) return null;
  const state = fromCanvasProject(project as { nodes?: unknown; connections?: unknown });
  const vp = project.viewport as CanvasViewport | undefined;
  const bg = project.backgroundMode;
  // 作品/剧集三栏：汇出档带著走（否则「汇出→汇入」会静默丢掉剧集清单）。
  const meta = canvasProjectMeta(project);
  return {
    nodes: state.nodes,
    connections: state.connections,
    ...(vp && num(vp.x) !== undefined && num(vp.y) !== undefined && num(vp.k) !== undefined
      ? { viewport: { x: vp.x, y: vp.y, k: clampScale(vp.k) } }
      : {}),
    ...(bg === "dots" || bg === "lines" || bg === "blank" ? { backgroundMode: bg } : {}),
    ...(typeof project.title === "string" ? { title: project.title } : {}),
    ...meta,
  };
}
