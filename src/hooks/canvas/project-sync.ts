"use client";

// ===== S10b — 画布人手改动 → 工程图（设计文档 §3.4「人手改动回写」；§10 S10b）=====
//
// 方向：画布 → 工程图，**只走人手**。S10a（`deploy-staging/gateway/project/bridge-canvas.ts`）
// 是反方向（工程事件 → 既有 `canvas.node.created/updated/connected`）。
//
// 回环抑制的唯一判据＝dispatch 的 action 来源（`CanvasAction` 的判别栏位）：
//   · 用户动作（patch_metadata / remove / delete_many …）→ 组 PatchOp 回写；
//   · 引擎／代理来源（`event` / `agent_ops`）→ **零回写**。
// 模型永远不通过画布写工程图（§3.4 红线；DSL 与画布 op 对工程图只有 `project_patch`
// 一条写路径）。S10a 的 created/updated 帧落进本档时只会走 reducer，不会反弹成补丁，
// 所以「工程图 → 画布 → 工程图」不存在回路。
//
// S10a 留的两个缺口都在本档收敛：
//   ① 契约没有 `node_deleted` 事件 ⇒ 删节点后画布卡滞留：`reconcile()` 对每张工程卡拉
//      公开只读 `GET …/project?view=node` 逐张核对；图里没有的卡移除，`status=orphaned`
//      的卡标 `project_stale`（复用现有 locked 视觉，P2 不新增控件，裁定点 J3）。
//      工程不存在/端点缺席（404）时**不动任何卡**——不把「查不到」当成「都删了」。
//      （S9 公开读面只有 digest/node/events 三种视图、没有整图节点列表：`digest` 只列
//      失败/钉住段，`events` 只给最近 20 行且无删除事件——逐卡存在性探针是唯一能回答
//      「这个 project_node_id 还在不在图里」的公开事实。上限 MAX_PROJECT_PROBES 张/轮。）
//   ② 进程重启会重发 created（泳道坐标）⇒ `preserveProjectCanvasPlacement()` 在 dispatch
//      之前合并画布上已有的 position/width/height/moved（人手布局不被工程桥覆盖）。
//
// 端点：S9 的**公开**补丁路由 `POST /agent/v1/sessions/:id/project/patch`（会话主人鉴权，
// Actor 由网关强制为 `{kind:"user"}`，请求体不带 actor 栏位）。浏览器不持 B 端 key，
// 故走站点同族代理路径 `/api/agent/sessions/:id/project/patch`（与 canvas-state /
// workflow-node-update 同款；站点代理路由属 `src/app/api/**`，不在 S10b 的独占文件内）。

import { useCallback, useEffect, useReducer, useRef, type Dispatch } from "react";
import type { CanvasReducerState } from "@/lib/canvas/reducer";
import type { CanvasNode, CanvasNodeMetadata } from "@/lib/canvas/types";
import type { CanvasAction } from "./canvas-reducer-adapter";

// ─────────────────────────── 工程图补丁形状（S9 `project/types.ts` 的强类型子集）

export type ProjectJson = null | boolean | number | string | ProjectJson[] | { [k: string]: ProjectJson };

/**
 * 人手回写会发出的 PatchOp（S9 `PatchOp` 的逐字子集）。
 * 刻意**不**包含 `add_node`/`connect`/`write_result`：画布不是工程图的建图工具
 *（建图只走 DSL compile → project_patch），人手只改既有节点。
 */
export type ProjectPatchOp =
  | { op: "set"; node: string; path: "params.prompt" | "params.model" | "params.size"; value: ProjectJson }
  | { op: "remove_node"; node: string }
  | { op: "lock"; node: string; fields: "*" }
  | { op: "unlock"; node: string }
  | { op: "replace_output"; node: string; artifactId: string };

export interface ProjectPatchRejection {
  i: number;
  code: string;
  node?: string;
  msg: string;
}

/** S9 `PatchReceipt`（≤1024B）的可读子集。 */
export interface ProjectPatchReceipt {
  ok: boolean;
  version?: number;
  applied?: number;
  rejected?: ProjectPatchRejection[];
  changed?: { node: string; fields: string[] }[];
  stale?: string[];
  drift?: string[];
  warnings?: string[];
}

/** 单节点存在性探针（`GET …/project?view=node` 的回执归一化）。 */
export interface ProjectNodeProbe {
  /** 工程本身可读（false＝工程不存在/端点缺席 → 本次收敛整体跳过）。 */
  projectExists: boolean;
  /** 该 project_node_id 是否仍在图里。 */
  present: boolean;
  /** 图里的节点状态（`orphaned` 用来标 stale）。 */
  status?: string;
}

export interface ProjectSyncTransport {
  patch(sessionId: string, ops: ProjectPatchOp[], opts?: { baseVersion?: number }): Promise<ProjectPatchReceipt>;
  probeNode(sessionId: string, projectNodeId: string): Promise<ProjectNodeProbe>;
}

// ─────────────────────────── 端点

/** 站点代理路径（S9 公开补丁路由的同族代理；Actor 由网关强制 user）。 */
export function projectPatchPath(sessionId: string): string {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/project/patch`;
}

/** 公开只读节点视图（S9 `GET /agent/v1/sessions/:id/project?view=node`）。 */
export function projectNodePath(sessionId: string, projectNodeId: string): string {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/project?view=node&detail=summary&node=${encodeURIComponent(projectNodeId)}`;
}

/** 默认传输：真 fetch。失败抛错（由呼叫端的 onError 收敛成静默最佳努力）。 */
export function createProjectFetchTransport(fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args)): ProjectSyncTransport {
  return {
    async patch(sessionId, ops, opts) {
      const res = await fetchImpl(projectPatchPath(sessionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ops, ...(typeof opts?.baseVersion === "number" ? { baseVersion: opts.baseVersion } : {}) }),
      });
      if (!res.ok) throw new Error(`project patch HTTP ${res.status}`);
      return (await res.json()) as ProjectPatchReceipt;
    },
    async probeNode(sessionId, projectNodeId) {
      const res = await fetchImpl(projectNodePath(sessionId, projectNodeId), {
        method: "GET",
        headers: { accept: "application/json" },
      });
      // 404＝会话/工程不可读：这不是「节点不在图里」，而是「问不到」→ 整体跳过收敛。
      if (res.status === 404) return { projectExists: false, present: false };
      if (!res.ok) throw new Error(`project get HTTP ${res.status}`);
      const receipt = (await res.json()) as { ok?: unknown; node?: { status?: unknown } | null };
      const node = receipt?.node;
      return {
        projectExists: true,
        present: receipt?.ok === true && !!node && typeof node === "object",
        ...(node && typeof node.status === "string" ? { status: node.status } : {}),
      };
    },
  };
}

// ─────────────────────────── 画布卡 ↔ 工程节点

function metadataBag(node: { metadata?: unknown } | undefined): Record<string, unknown> | undefined {
  const md = node?.metadata;
  return md && typeof md === "object" && !Array.isArray(md) ? (md as Record<string, unknown>) : undefined;
}

/** 画布卡上的工程节点 id；非工程卡回 undefined。 */
export function projectNodeIdOf(node: { metadata?: unknown } | undefined): string | undefined {
  const raw = metadataBag(node)?.project_node_id;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** 画布节点索引（一次 dispatch 只建一次）。 */
function nodeIndex(nodes: readonly CanvasNode[]): Map<string, CanvasNode> {
  const map = new Map<string, CanvasNode>();
  for (const n of nodes) map.set(n.id, n);
  return map;
}

// ─────────────────────────── 用户动作 → PatchOp

/**
 * 单个 metadata 补丁 → PatchOp（只收工程图认得的字段）。
 * 只改画布表现、不改工程语义的键（status/content/字号/批次…）在这里被丢弃：
 * 引擎状态由 S10a 的 `canvas.node.updated` 回灌，不需要人手回写。
 */
function patchOpsForMetadata(node: CanvasNode, patch: Partial<CanvasNodeMetadata> & Record<string, unknown>): ProjectPatchOp[] {
  const projectNodeId = projectNodeIdOf(node);
  if (!projectNodeId) return [];
  const ops: ProjectPatchOp[] = [];
  const bag = patch as Record<string, unknown>;
  // 状态栏位出现＝生成流程的自家补丁（`use-canvas-generation` 的 `{status:"loading", prompt,
  // model, size}`），它写的是**合成后**的提示词（角色卡注入前缀已拼进去）。把合成词写回
  // 工程图会让下一次生成再注入一次（双注入）。作者编辑（文本直编/提示词面板）不带 status。
  if (bag.status === undefined) {
    // §3.5 keyframe 的 signedParams：prompt/model/size 任一改动都会改变签名（下游重跑由引擎负责）。
    for (const key of ["prompt", "model", "size"] as const) {
      const value = bag[key];
      if (typeof value === "string" && value.length > 0) {
        ops.push({ op: "set", node: projectNodeId, path: `params.${key}`, value });
      }
    }
  }
  // 锁定：画布 metadata.locked（boolean 旗标）→ 工程图整节点作者锁；解锁即移除。
  if (bag.locked === true) ops.push({ op: "lock", node: projectNodeId, fields: "*" });
  else if (bag.locked === false) ops.push({ op: "unlock", node: projectNodeId });
  return ops;
}

/**
 * 用户 dispatch → 工程图补丁。
 *
 * **来源过滤就是回环抑制本体**：`event`（引擎/工程桥帧）与 `agent_ops`（模型批量操作）
 * 永远回空阵列；其余 action 才是人手动作。删除是软删（画布可撤销），但工程图是硬删
 *（`remove_node`）——用户按下删除时点图应同步，撤销画布不影响已落的工程决策。
 */
export function userPatchOpsForAction(action: CanvasAction, nodes: readonly CanvasNode[]): ProjectPatchOp[] {
  switch (action.type) {
    case "patch_metadata": {
      const node = nodeIndex(nodes).get(action.nodeId);
      return node ? patchOpsForMetadata(node, action.patch as Record<string, unknown>) : [];
    }
    case "remove": {
      const node = nodeIndex(nodes).get(action.nodeId);
      const projectNodeId = projectNodeIdOf(node);
      return projectNodeId ? [{ op: "remove_node", node: projectNodeId }] : [];
    }
    case "delete_many": {
      const index = nodeIndex(nodes);
      const ops: ProjectPatchOp[] = [];
      for (const canvasNodeId of action.nodeIds) {
        const projectNodeId = projectNodeIdOf(index.get(canvasNodeId));
        if (projectNodeId) ops.push({ op: "remove_node", node: projectNodeId });
      }
      return ops;
    }
    // event / agent_ops：引擎与模型来源，零回写（防回环）。
    // move / resize / load / clear / rename / undo 无关动作：工程图不存布局与画布历史。
    default:
      return [];
  }
}

/** 「替换产物」的显式入口：画布目前没有携带 artifactId 的控件（版本史只存 URL），
 * 由将来接入版本选择/产物库的呼叫端显式呼叫；不猜测 artifactId（S9 只收内容寻址 id）。 */
export function replaceOutputOp(projectNodeId: string, artifactId: string): ProjectPatchOp | null {
  if (!projectNodeId || !artifactId) return null;
  return { op: "replace_output", node: projectNodeId, artifactId };
}

// ─────────────────────────── 缺口②：重同步保留人手位置/尺寸

/**
 * 工程桥重发 `canvas.node.created` 时，用画布上已有的位置/尺寸覆盖来帧（返回**新** action）。
 *
 * reducer 的 `upsertNode` 已保留 position/moved，但 width/height 会被来帧的泳道预设覆写；
 * 而「先读当前画布快照」是本档的责任（缺口②）。非 created 帧、未知节点、非工程卡
 * 原样返回（不改任何既有行为）。
 */
export function preserveProjectCanvasPlacement(action: CanvasAction, nodes: readonly CanvasNode[]): CanvasAction {
  if (action.type !== "event") return action;
  const event = action.event;
  if (event.name !== "canvas.node.created") return action;
  const incoming = event.data?.node;
  if (!incoming || typeof incoming.id !== "string") return action;
  // 只有工程桥的卡才合并：旧工作流路径的 created 行为必须逐字不变。
  if (!projectNodeIdOf(incoming)) return action;
  const existing = nodeIndex(nodes).get(incoming.id);
  if (!existing) return action;
  // SSE 契约的 created.node 是宽松形状（无 position/width/height 宣告），工程桥实际会带；
  // 合并结果按原事件型别回转（判别栏位不变，只补布局栏位）。
  const mergedNode = {
    ...incoming,
    position: existing.position,
    width: existing.width,
    height: existing.height,
    ...(existing.moved === true ? { moved: true } : {}),
  };
  const mergedEvent = { ...event, data: { ...event.data, node: mergedNode } } as unknown as typeof event;
  return { type: "event", event: mergedEvent };
}

// ─────────────────────────── 缺口①：删除收敛

export interface ProjectConvergePlan {
  /** 图里已经没有对应工程节点的画布卡（按画布节点 id，交给 delete_many）。 */
  removeCanvasNodeIds: string[];
  /** 图里仍在但 status=orphaned 的卡（标 project_stale，不删）。 */
  markStale: { canvasNodeId: string; projectNodeId: string }[];
}

/**
 * 纯收敛计划：拿「画布工程卡」与「探针结果」求差。
 *
 * - 探针缺席（没问过/网络失败）→ 不动这张卡；
 * - `projectExists=false`（工程 404/端点缺席）→ **整批不动**（不把问不到当删除）；
 * - 图里没有 → 移除；
 * - `status === "orphaned"` → 标 stale（每张卡只在尚未标记时标一次，否则每轮都写状态）。
 */
export function planProjectConvergence(
  nodes: readonly CanvasNode[],
  probes: ReadonlyMap<string, ProjectNodeProbe>,
): ProjectConvergePlan {
  const plan: ProjectConvergePlan = { removeCanvasNodeIds: [], markStale: [] };
  for (const node of nodes) {
    const projectNodeId = projectNodeIdOf(node);
    if (!projectNodeId) continue;
    const probe = probes.get(projectNodeId);
    if (!probe || !probe.projectExists) continue;
    if (!probe.present) {
      plan.removeCanvasNodeIds.push(node.id);
      continue;
    }
    if (probe.status === "orphaned" && metadataBag(node)?.project_stale !== true) {
      plan.markStale.push({ canvasNodeId: node.id, projectNodeId });
    }
  }
  return plan;
}

/** 单轮收敛最多探几张卡（防止一次会话切换打出一串请求）。 */
export const MAX_PROJECT_PROBES = 40;

// ─────────────────────────── 同步器

export interface ProjectSyncOptions {
  getSessionId: () => string | null | undefined;
  transport: ProjectSyncTransport;
  /** 补丁回执（`ok:false`/rejected 都从这里出去；画面不弹窗，只记账）。 */
  onReceipt?: (receipt: ProjectPatchReceipt, ops: readonly ProjectPatchOp[]) => void;
  /** 网络/端点错误（最佳努力：不打断画布）。 */
  onError?: (error: unknown, ops: readonly ProjectPatchOp[]) => void;
}

export interface ProjectSync {
  /** 用户来源 action → 本次发出的补丁 ops（空阵列＝不回写）。同步触发、不等回执。 */
  noteUserAction(action: CanvasAction, nodes: readonly CanvasNode[]): ProjectPatchOp[];
  /** 显式发一批补丁（替换产物等）。无会话 → null。 */
  patchUserOps(ops: readonly ProjectPatchOp[], opts?: { baseVersion?: number }): Promise<ProjectPatchReceipt | null>;
  /** 拉工程图逐卡核对并回收敛计划（不 dispatch；由 hook 负责落地）。 */
  reconcile(nodes: readonly CanvasNode[]): Promise<ProjectConvergePlan>;
}

export function createProjectSync(opts: ProjectSyncOptions): ProjectSync {
  const sessionOf = () => {
    const sid = opts.getSessionId();
    return typeof sid === "string" && sid.length > 0 ? sid : null;
  };

  const patchUserOps: ProjectSync["patchUserOps"] = async (ops, patchOpts) => {
    const sid = sessionOf();
    if (!sid || ops.length === 0) return null;
    try {
      const receipt = await opts.transport.patch(sid, [...ops], patchOpts);
      opts.onReceipt?.(receipt, ops);
      return receipt;
    } catch (error) {
      opts.onError?.(error, ops);
      return null;
    }
  };

  return {
    noteUserAction(action, nodes) {
      const ops = userPatchOpsForAction(action, nodes);
      if (ops.length === 0) return ops;
      void patchUserOps(ops);
      return ops;
    },
    patchUserOps,
    async reconcile(nodes) {
      const empty: ProjectConvergePlan = { removeCanvasNodeIds: [], markStale: [] };
      const sid = sessionOf();
      if (!sid) return empty;
      const cards = nodes.filter((n) => projectNodeIdOf(n) !== undefined).slice(0, MAX_PROJECT_PROBES);
      if (cards.length === 0) return empty;
      const probes = new Map<string, ProjectNodeProbe>();
      for (const card of cards) {
        const projectNodeId = projectNodeIdOf(card);
        if (!projectNodeId || probes.has(projectNodeId)) continue;
        try {
          const probe = await opts.transport.probeNode(sid, projectNodeId);
          probes.set(projectNodeId, probe);
          // 工程整体不可读：继续探也没有意义，按「问不到」收手（不删任何卡）。
          if (!probe.projectExists) break;
        } catch (error) {
          opts.onError?.(error, []);
        }
      }
      return planProjectConvergence(nodes, probes);
    },
  };
}

// ─────────────────────────── React 挂接点（useCanvasChat 的唯一 dispatch 收口）

/**
 * `useReducer(canvasReducer, …)` 的等价替代：同一 reducer、同一 state，dispatch 多两步：
 *   1. 用户来源 action 先按当前节点快照组补丁（`event`/`agent_ops` 回空，不回写）；
 *   2. created 帧先合并画布上已有的位置/尺寸（缺口②）。
 * 会话切换／工程卡集合变化时后台跑一次删除收敛（缺口①），内部动作用 WeakSet 标记，
 * 避免收敛自己的 delete_many 又被当成「用户删除」回写一次。
 */
export function useProjectSyncCanvasReducer(
  reducer: (state: CanvasReducerState, action: CanvasAction) => CanvasReducerState,
  initialState: CanvasReducerState,
  sessionId: string | null | undefined,
  transport?: ProjectSyncTransport,
): [CanvasReducerState, Dispatch<CanvasAction>] {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sessionRef = useRef<string | null | undefined>(sessionId);
  sessionRef.current = sessionId;
  const transportRef = useRef<ProjectSyncTransport>(transport ?? createProjectFetchTransport());
  const syncRef = useRef<ProjectSync | null>(null);
  if (syncRef.current === null) {
    syncRef.current = createProjectSync({
      getSessionId: () => sessionRef.current,
      transport: {
        patch: (sid, ops, opts) => transportRef.current.patch(sid, ops, opts),
        probeNode: (sid, nodeId) => transportRef.current.probeNode(sid, nodeId),
      },
    });
  }
  const internalRef = useRef<WeakSet<object>>(new WeakSet<object>());

  const dispatch = useCallback<Dispatch<CanvasAction>>((action) => {
    // 内部动作（收敛产生的删除/标记）不是人手动作，跳过回写。
    if (!internalRef.current.has(action)) {
      syncRef.current?.noteUserAction(action, stateRef.current.nodes);
    }
    rawDispatch(preserveProjectCanvasPlacement(action, stateRef.current.nodes));
  }, []);

  // 工程卡集合指纹：卡片增删才重跑收敛（标 stale 不改集合 → 不会自激）。
  const projectCardKey = state.nodes
    .filter((n) => projectNodeIdOf(n) !== undefined)
    .map((n) => n.id)
    .sort()
    .join(",");

  useEffect(() => {
    if (!sessionId || !projectCardKey) return;
    let cancelled = false;
    void syncRef.current
      ?.reconcile(stateRef.current.nodes)
      .then((plan) => {
        if (cancelled) return;
        if (plan.removeCanvasNodeIds.length > 0) {
          const action: CanvasAction = { type: "delete_many", nodeIds: plan.removeCanvasNodeIds };
          internalRef.current.add(action);
          dispatch(action);
          return;
        }
        for (const mark of plan.markStale) {
          const action: CanvasAction = {
            type: "patch_metadata",
            nodeId: mark.canvasNodeId,
            // project_stale 是工程桥键（CanvasNodeMetadata 未宣告，读取端以宽化袋子读）。
            patch: { project_stale: true } as unknown as Partial<CanvasNodeMetadata>,
          };
          internalRef.current.add(action);
          dispatch(action);
        }
      })
      .catch(() => {
        // 收敛是最佳努力：端点缺席/网络失败都不影响画布本身。
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, projectCardKey, dispatch]);

  return [state, dispatch];
}
