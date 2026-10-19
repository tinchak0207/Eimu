// 画布 chat 的展示型类型与介面（自 use-canvas-chat.ts 外围搬迁，符号名不变）。
// use-canvas-chat.ts 仍是唯一汇出点（barrel），消费端 import 路径零改动。
import { cleanEmitsEntity, toCardMetadataName, toGateConfirm, toNodeFontSize } from "@/lib/canvas/layout";
// 上行白名单的**键集合单一真源**（与还原端 layout.toNodeMetadata 共用同一份清单；
// 漏一端＝回旧会话还原后该键静默消失）。
import {
  AGENT_CONTENT_TRUNCATE_KEEP,
  AGENT_CONTENT_TRUNCATE_TRIGGER,
  AGENT_METADATA_FIELDS,
  AGENT_PROMPT_TRUNCATE_KEEP,
  type AgentFieldCondition,
  type AgentFieldTransform,
} from "@/lib/canvas/node-metadata-fields";
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import { normalizeApprovalState } from "@/lib/character-cards";
import type { CharacterCard } from "@/lib/character-cards";
import type { CanvasScriptType } from "@/lib/canvas/project-narration";
import { compactStoryboardShot, type StoryboardScriptShot } from "@/lib/storyboard-contract";
import type {
  CanvasAgentOpsEvent,
  CanvasConnection,
  CanvasEpisode,
  CanvasNode,
  CanvasNodeMetadata,
  CanvasNodeVersion,
  CanvasPlanEvent,
  CanvasPosition,
  CanvasProject,
  CanvasProjectType,
  CanvasUnit,
  CanvasViewport,
} from "@/lib/canvas/types";

// ─────────────────────────────────────────── 展示型事件状态

/** canvas.plan 的计画卡（左侧栏）。 */
export interface CanvasPlanCard extends CanvasPlanEvent {
  receivedAt: number;
}

/** canvas.derive.started 的指挥解读卡。 */
export interface CanvasDeriveCard {
  unitId: string;
  sourceNodeId: string;
  instruction: string;
  interpretation?: string;
  receivedAt: number;
}

/** canvas.budget.updated 的预算信封。 */
export interface CanvasBudget {
  usedCoins: number;
  remainingCoins: number;
  updatedAt: number;
}

/** 历史画布清单的一列：只带列表渲染需要的栏位，不载入整份 nodes。 */
export interface CanvasProjectSummary {
  id: string;
  title: string;
  updatedAt: string;
  nodeCount: number;
}

/**
 * P2-A 冻结接口（另路 P2-B 按此写）：当前聊天拥有的画布清单的一列。
 * 归属真源＝项目档 `CreativeProject.chats[].canvasIds`（见 types.ts 档头：画布不加反向栏位）。
 */
export interface ChatCanvasEntry {
  id: string;
  /** savedProjects 里的标题；缺失 → "未命名画布"。 */
  title: string;
  /** ms epoch；缺失 → 0。 */
  updatedAt: number;
  /** 是否该聊天的 primaryCanvasId。 */
  isPrimary: boolean;
  /** 是否当前打开。 */
  isActive: boolean;
}

/**
 * `useCanvasChat(sessionId, projectContext?)` 的第二参（可选；缺省＝没有项目上下文＝现状行为）。
 * 由宿主（ImagePlayground）从 `useCreativeProjects()` 取现成动作/查询注入——
 * 本 hook 不自己呼叫 useCreativeProjects，避免多挂一次 refreshProjects。
 */
export interface UseCanvasChatProjectContext {
  /** 当前选中的项目 id（侧栏上下文；本刀行为不据此造归属，仅透传）。 */
  activeProjectId?: string | null;
  /** 把画布挂到会话（store 的 attachCanvasAction：绝不覆盖既有 canvasIds，primary 只补不抢）。 */
  attachCanvas?: (projectId: string, sessionId: string, canvasId: string, title?: string) => Promise<void>;
  /** 会话 → 项目 id（store 查询；同一份共享状态，不另建真源）。 */
  findProjectIdBySession?: (sessionId: string) => string | null;
  /**
   * 画布 id → 创作项目 id（`prj_…`）反查（store 查询 `findProjectIdByCanvas`）。
   * **画布 id（`canvas-…`）与创作项目 id 是两套命名空间**：本 hook 据此反查得到
   * `creativeProjectId` 并一路透到卡域注入集（use-canvas-cards 的 activeCharacterCards），
   * **不得**把画布 id 直接当 creativeProjectId 用。宿主从 `useCreativeProjects()` 注入，零新增真源。
   */
  findProjectIdByCanvas?: (canvasId: string) => string | null;
  /**
   * 会话 → 该聊天条目的画布归属（`canvasIds` + `primaryCanvasId`，store 直传项目档原值）。
   * P2-C：本 hook 用它取「当前聊天的画布清单/主画布」，不再自行 `listProjects()`
   * 绕一轮 `GET /api/projects`。未归属会话 → null。
   */
  findChatBySession?: (sessionId: string) => { canvasIds: string[]; primaryCanvasId?: string } | null;
}

/** 服务端摘要（`?view=summary`）的最小形状：已有节点数，不带节点本体。 */
type CanvasProjectSummaryLike = { id: string; title: string; updatedAt: string; nodeCount: number };

/** CanvasProject[]／服务端摘要 → 清单摘要（滤掉空画布），依 updatedAt 由新到旧。 */
export function toProjectSummaries(projects: ReadonlyArray<CanvasProject | CanvasProjectSummaryLike>): CanvasProjectSummary[] {
  return projects
    .map((p) => ({
      id: p.id,
      title: p.title || "未命名画布",
      updatedAt: p.updatedAt,
      nodeCount: "nodes" in p ? (Array.isArray(p.nodes) ? p.nodes.length : 0) : p.nodeCount,
    }))
    .filter((p) => p.nodeCount > 0)
    .sort((a, b) => {
      const at = Date.parse(a.updatedAt);
      const bt = Date.parse(b.updatedAt);
      const aTs = Number.isFinite(at) ? at : 0;
      const bTs = Number.isFinite(bt) ? bt : 0;
      return bTs - aTs;
    });
}

export type CanvasBackgroundMode = "dots" | "lines" | "blank";

/** 分镜实体卡的 id 阵列清洗（与还原端 `layout.toIdList` 同一把尺）：只留非空字串、
 *  按首次出现序去重；空阵列/非阵列 → undefined（不把空栏位写进快照）。 */
function cleanIdList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
  return out.length > 0 ? out : undefined;
}

/** 分族条件是否命中（工具卡族要求 pipelineCard∈{tool,gate,note}；导演台族要求 =director）。 */
function agentFieldConditionMet(bag: Record<string, unknown>, condition: AgentFieldCondition): boolean {
  const value = bag[condition.key];
  return typeof value === "string" && condition.oneOf.includes(value);
}

/**
 * 依真源的 `transform` 分派。回传 `undefined` ＝「省略该键」（不写空壳）。
 *
 * 每个 transform 的判据与既有 runtime **逐字相同**（含脏值行为：truthy 判断、
 * `typeof === "number"` 不收敛 NaN、非字串 content/prompt 直接读 `.length`/`.slice`）——
 * 本函式只把「哪个键走哪个动作」交给真源，动作本身不改。
 */
function applyAgentFieldTransform(transform: AgentFieldTransform, raw: unknown): unknown {
  switch (transform) {
    case "content": {
      // 超预算只留前 N 字＋省略号（门槛/保留字数＝真源 AGENT_TRUNCATION_BUDGETS）。
      if (!raw) return undefined;
      const text = raw as string;
      return text.length > AGENT_CONTENT_TRUNCATE_TRIGGER
        ? `${text.slice(0, AGENT_CONTENT_TRUNCATE_KEEP)}…`
        : text;
    }
    case "prompt": {
      if (!raw) return undefined;
      return (raw as string).slice(0, AGENT_PROMPT_TRUNCATE_KEEP);
    }
    case "truthy":
      return raw ? raw : undefined;
    case "number":
      return typeof raw === "number" ? raw : undefined;
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "defined":
      return raw !== undefined ? raw : undefined;
    case "pipelineCard":
      // 四值枚举；未列举值（含 step_head——前端模板路径直产、后端不送）照旧丢弃。
      return raw === "tool" || raw === "gate" || raw === "note" || raw === "director" ? raw : undefined;
    case "idList":
      return cleanIdList(raw);
    case "cardName":
      return toCardMetadataName(raw);
    case "storyboardShot":
      // 栏位清单只准一份（storyboard-contract.ts），压缩下放纯函数，未来加栏自动跟上。
      return raw ? compactStoryboardShot(raw as StoryboardScriptShot) : undefined;
    case "emitsEntity":
      return cleanEmitsEntity(raw);
    case "fontSize":
      return toNodeFontSize(raw);
    case "gateConfirm":
      return toGateConfirm(raw);
    case "approval":
      // `normalizeApprovalState` 用 `null` 表示「整包丢弃」，本函式的 `undefined` 才是
      // 「省略键」——不转换会写出 `approval: null` 的空壳键。
      return normalizeApprovalState(raw) ?? undefined;
  }
}

/**
 * agent 快照的 metadata 压缩（上行端白名单）。
 *
 * **键集合不写在本档**：唯一真源＝`src/lib/canvas/node-metadata-fields.ts` 的
 * `AGENT_METADATA_FIELDS`（键、分族条件、截断预算与排除理由都在那里）。
 * 与还原端 `layout.toNodeMetadata` 构成双白名单：任一端漏键＝回旧会话/换装置还原后
 * 该键静默消失（2026-09-03 导演台空壳、2026-09-24 `emitsEntity` 当下被剥两次事故）。
 */
export function compactMetadataForAgent(metadata: CanvasNodeMetadata | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const bag = metadata as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of AGENT_METADATA_FIELDS) {
    if (field.requires && !agentFieldConditionMet(bag, field.requires)) continue;
    const value = applyAgentFieldTransform(field.transform, bag[field.key]);
    if (value !== undefined) out[field.key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const SAVE_DEBOUNCE_MS = 400;
export const PLAN_CARD_LIMIT = 30;
export const DERIVE_CARD_LIMIT = 20;
/** 进度节流窗（行动端）：canvas.node.generating 可能高频送达（后端进度流），
 *  低阶装置上每帧整张画布重渲染会掉帧。同节点每窗最多落地一次 reducer，
 *  窗内只留最新一笔、窗末补送——最后的 progress 不会遗失。 */
export const PROGRESS_THROTTLE_MS = 120;

export interface UseCanvasChatReturn {
  // ── 事件入口：外部 chat（AgentChatSurface 的 useAgentChat onCanvasEvent）转交这里。
  feedCanvasEvent: (event: AgentSseEvent) => void;
  /** 每次 send 上送的画布摘要（供外部挂到 chat 的 canvasStateProvider）。 */
  summarize: () => unknown;
  // ── 画布状态
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  units: CanvasUnit[];
  /** 节点内容版本历史（append-only；右键「恢复上一版」据此判断可用）。 */
  nodeVersions: CanvasNodeVersion[];
  plans: CanvasPlanCard[];
  derives: CanvasDeriveCard[];
  budget: CanvasBudget | null;
  // ── 视口
  viewport: CanvasViewport;
  setViewport: (next: CanvasViewport | ((prev: CanvasViewport) => CanvasViewport)) => void;
  backgroundMode: CanvasBackgroundMode;
  cycleBackground: () => void;
  fitView: (width: number, height: number) => void;
  centerOn: (world: CanvasPosition, viewportWidth: number, viewportHeight: number) => void;
  // ── 选取 / 编辑
  selectedNodeId: string | null;
  selectNode: (nodeId: string | null) => void;
  moveNode: (nodeId: string, position: CanvasPosition) => void;
  resizeNode: (nodeId: string, width: number, height: number) => void;
  removeNode: (nodeId: string) => void;
  commitInteraction: () => void;
  // ── Phase 3 画布交互（群组拖动 / 贴上 / 多删 / 手动连线）
  moveNodes: (moves: { nodeId: string; position: CanvasPosition }[]) => void;
  addNodes: (nodes: CanvasNode[], connections?: CanvasConnection[]) => void;
  /** 同 workflow 重铺（2026-08-26 模板卡重点=替换）：先删同 workflow_id 旧节点及其连线，再 add_nodes；一格历史。 */
  replaceWorkflowNodes: (workflowId: string, nodes: CanvasNode[], connections?: CanvasConnection[]) => void;
  deleteNodes: (nodeIds: string[]) => void;
  addConnection: (fromNodeId: string, toNodeId: string) => void;
  removeConnection: (connectionId: string) => void;
  /**
   * 回跳作废下游（决策 15）：把该节点全部下游已完成结果清成待生成（一格历史）。
   * 作废真权威在网关（updateNode BFS／rerunFrom），本函式是画布侧投影；
   * 重跑交宿主既有 rerun 入口。回传被作废的节点 id（BFS 序）。
   */
  revokeDownstream: (nodeId: string) => string[];
  // ── 批次操作（Phase 4）
  addBatchChild: (parentId: string, child: CanvasNode) => void;
  setBatchPrimary: (parentId: string, childId: string) => void;
  /** 节点内容回退：version 省略＝上一版；回退本身也落一版，可再撤销。 */
  revertNode: (nodeId: string, version?: number) => void;
  deleteBatchChild: (parentId: string, childId: string) => void;
  toggleBatchExpanded: (parentId: string) => void;
  // ── @引用
  addReference: (nodeId: string, referenceNodeId: string) => void;
  removeReference: (nodeId: string, referenceNodeId: string) => void;
  // ── Wave A：就地编辑
  renameNode: (nodeId: string, title: string) => void;
  patchNodeMetadata: (nodeId: string, patch: Partial<CanvasNodeMetadata>, opts?: { history?: boolean }) => void;
  // ── B2：飞行聚焦
  flyTo: (world: CanvasPosition, viewportWidth: number, viewportHeight: number, targetK?: number) => void;
  // ── Wave C：agent 操作画布（自动执行；可 undo/redo 撤销）
  pendingAgentOps: CanvasAgentOpsEvent | null;
  applyAgentOps: () => { runGeneration: { nodeId: string; prompt?: string; model?: string; size?: string; count?: number }[] };
  dismissAgentOps: (reason?: string) => void;
  // ── 历史
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  // ── 专案
  projectTitle: string;
  setProjectTitle: (title: string) => void;
  loading: boolean;
  saveState: "idle" | "saving" | "saved" | "error" | "offline";
  loadProject: (project: { nodes?: unknown; connections?: unknown; viewport?: CanvasViewport; backgroundMode?: CanvasBackgroundMode; title?: string; projectType?: unknown; currentStep?: unknown; episodes?: unknown; styleId?: unknown; scriptType?: unknown; narrationVoice?: unknown }) => void;
  exportProject: () => CanvasProject;
  clearCanvas: () => void;
  newCanvasSession: () => void;
  // ── 聊天内多画布（P2-A：一个聊天 → 多张画布）
  /** 当前聊天拥有的画布清单（未归属会话 → 只含当前这一张）。 */
  canvasList: ChatCanvasEntry[];
  /** 当前打开的画布 id（随 projectIdRef 同步；建号前 null）。 */
  activeCanvasId: string | null;
  /** 切到当前聊天内已有的某张画布（切前先 flush 当前画布存档）。 */
  switchCanvas: (canvasId: string) => void;
  /**
   * 在当前聊天内新建一张画布并切过去，回新 id（用于 UI 下拉「新建画布」）。
   * 无当前会话时回 null（不造无主画布）。若会话已归属某项目则把新画布挂上去（primary 不动）。
   */
  createCanvas: (title?: string) => string | null;
  // ── 历史清单
  savedProjects: CanvasProjectSummary[];
  refreshSavedProjects: () => Promise<void>;
  openSavedCanvas: (id: string) => Promise<void>;
  /** Agent 快照下行回填（resume 到已有历史的会话）：nodes>0 才落地；不进撤销栈、清选取。 */
  restoreAgentSnapshot: (snapshot: {
    nodes?: unknown;
    connections?: unknown;
    viewport?: CanvasViewport;
    projectType?: unknown;
    currentStep?: unknown;
    episodes?: unknown;
    styleId?: unknown;
    scriptType?: unknown;
    narrationVoice?: unknown;
  }) => boolean;
  /**
   * REQ-B2 团队资产空间：读当前画布项目 id（尚未建号回 null）。
   * 真源仍是 canvas-project-sync 的 projectIdRef（不新增第二份状态，避免两处漂移）。
   */
  getProjectId: () => string | null;
  // ── 作品/剧集三级状态机（刀 1 前端接线；持久化在 CanvasProject 顶层三栏）
  /** 作品类型：undefined = 未设定。 */
  projectType: CanvasProjectType | undefined;
  /** 7 步流程当前步骤（1..7）；undefined = 未开始。 */
  currentStep: number | undefined;
  /** 剧集分集清单（电影为空阵列）。 */
  episodes: CanvasEpisode[];
  /**
   * 专案级风格绑定（P1-8／对称差 D34）：`StyleTemplate.id`（`@/lib/style-library` 注册面）；
   * undefined = 无绑定（旧专案语义）。生成时呼叫端把这个 id 带进 `/api/canvas/generate` 的 `style_id`。
   */
  styleId: string | undefined;
  /** 解说剧型别（P1-5／D7）：`plot`｜`monologue`（＝解说剧）；undefined＝未宣告。 */
  scriptType: CanvasScriptType | undefined;
  /** 旁白音色（P1-5／D7）：voice-library 的 id；undefined＝用上游预设。 */
  narrationVoice: string | undefined;
  /** 专案级栏位的唯一写入口（UI 面板与 agent 驱动路径共用）；栏位传 undefined 即清除。 */
  setProjectMeta: (patch: { projectType?: CanvasProjectType; currentStep?: number; episodes?: CanvasEpisode[]; styleId?: string; scriptType?: string; narrationVoice?: string }) => void;
  // ── 角色/场景卡（P2 跨镜头一致性）：卡列表 + 项目级锁定
  characterCards: CharacterCard[];
  /** 锁定到当前画布项目的卡 id（持久化在 CanvasProject.cardIds）。 */
  activeCardIds: string[];
  /** 锁定中的卡实体（生成时自动注入：片段前缀 + 参考图 + 负面词）。 */
  activeCharacterCards: CharacterCard[];
  /**
   * REQ-B2b：挂用（copy-on-use）产生的本地副本锁定/解锁。
   * 项目资产库面板挂用后把回应的 `localCopyIds` 传进来（解除挂用则把副本解锁）。
   * 这是「画面标已挂用」与「生成真的注入副本」之间唯一的接线。
   */
  applyMountCopyChange: (change: { locked: string[]; unlocked: string[] }) => Promise<void>;
  /**
   * 2026-10-09 标签驱动注入：资产面板改了某资产的 `projectIds` 后呼叫，重读卡库
   * 让注入集当场重组（打标签立即生效，不需刷新页面）。
   */
  refreshCharacterCards: () => Promise<void>;
  /** 建卡/更新卡（upsert）。 */
  upsertCharacterCard: (card: CharacterCard) => Promise<boolean>;
  /** 删卡（同时解除锁定）。 */
  removeCharacterCard: (id: string) => Promise<boolean>;
  /** 锁定/解锁（解锁=从项目卡列表移除，历史结果不受影响）。 */
  toggleCharacterCard: (id: string) => void;
  // ── 几何工具（元件用）
  pathFor: (connection: CanvasConnection) => string | null;
}
