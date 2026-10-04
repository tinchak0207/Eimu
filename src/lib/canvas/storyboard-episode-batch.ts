// 按集批次：换模型 ＋ 批次重跑（P1-2，对称差 D12；2026-09-29）。
//
// D12 逐字：「Batch generate videos」＋「Batch switch model…replace all video generation
// models for **this episode's** storyboards」。
//
// 现场盘点（唯一真源是源码，不是本档注释）：
//   · **「集」实体存在**：`CanvasProject.episodes: CanvasEpisode[]`（`src/lib/canvas/types.ts:606`，
//     AID `aid_comic_episode` 白名单化产物：`id` / `episodeNo` / `title` / `status` / `script`），
//     清洗在 `layout.readEpisodes` 与 `project-store.normalizeEpisodes`，写入口是
//     `CanvasProjectMetaPatch.episodes`（hook 层 `setProjectMeta`）。
//   · **「分镜→集」的边不存在**（本轮现场取证，缺口如实回报）：
//       - `CanvasNodeMetadata` 无任何集归属栏（grep `episodeId` 在 `src/lib/canvas` 零命中）；
//       - 场景外壳只有 `storyboardScene.sceneName`（AID v2.1.4 废 `sceneCode`，也无集）；
//       - 画布没有 parent 边（Group 子节点无 `parentId`；`batchChildren` 是批次族专用），
//         所以无法从场景节点推导出子节点的集。
//     故本档补**一个最小指针**：分镜节点 `metadata.episodeId`（值＝`CanvasEpisode.id`）。
//     键名照现场既有约定 `<domain>Id`（`directorStageId`/`directorSessionId`/`imageTaskId`），
//     不另立词表；清洗沿用既有的 `trimmedString`（A 端）与 `truthy`（B 端），零新机制。
//     **不臆造**：没有 `episodeId` 的分镜不归任何一集（不猜、不按节点顺序切段）。
//
// 「换模型」写的是分镜节点的 `metadata.model`（现场既有键，Config 卡与重生成都读它），
// 批次效果＝同一集的每个分镜节点都被盖成新模型。重跑计画（`planEpisodeBatchRerun`）只产
// **纯资料**（nodeId / 镜号 / prompt / 模型），不呼叫任何上游、不扣费。

import { shotNumberOf, shotRerunRequest } from "./storyboard-shots";
import type { StoryboardShotCandidateSet } from "./storyboard-shots";
import type { CanvasNode, CanvasNodeMetadata } from "./types";

/** 集 id 上限（`CanvasEpisode.id` 是自由字串；与同族薄键同量级）。 */
export const EPISODE_ID_MAX = 128;

function trimmed(v: unknown, max = EPISODE_ID_MAX): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

// ─────────────────────────────────────────── 集归属指针

/** 分镜节点的集归属（`metadata.episodeId`）；缺席＝不归任何一集。 */
export function shotEpisodeId(node: CanvasNode | undefined): string | undefined {
  return trimmed(node?.metadata?.episodeId);
}

/** 集归属指针 → metadata patch（纯函式；空值＝空 patch，不写空壳键）。 */
export function episodeIdMetadata(
  episodeId: string | null | undefined,
): Pick<CanvasNodeMetadata, "episodeId"> {
  const id = trimmed(episodeId);
  return id ? { episodeId: id } : {};
}

/** 画布上**真的有分镜**的集 id 清单（首见序去重；供集清单/切集 UI 对帐）。 */
export function shotEpisodeIds(nodes: readonly CanvasNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (!shotNumberOf(node)) continue;
    const id = shotEpisodeId(node);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 该集的所有分镜节点（只认「分镜节点 ＋ episodeId 逐字相符」）。
 * 排序＝镜号（`shotNumber` 常是 `001` 这种零填充三位数，故用 numeric 比较：
 * 万一出现未填充的 `1`/`10` 也不会排出 `10 < 2` 的字典序错序）。
 */
export function storyboardShotsOfEpisode(
  nodes: readonly CanvasNode[],
  episodeId: string,
): CanvasNode[] {
  const id = trimmed(episodeId);
  if (!id) return [];
  return nodes
    .filter((node) => shotEpisodeId(node) === id && shotNumberOf(node) !== undefined)
    .sort((a, b) =>
      (shotNumberOf(a) ?? "").localeCompare(shotNumberOf(b) ?? "", undefined, { numeric: true }),
    );
}

// ─────────────────────────────────────────── 按集批次换模型（D12）

/** 单一节点的模型替换补丁。 */
export interface EpisodeModelPatch {
  nodeId: string;
  /** patch 直接喂 `patchNodeMetadata`。 */
  metadata: Pick<CanvasNodeMetadata, "model">;
}

/** 按集换模型的计画（纯资料；呼叫端逐条套用或整批下发）。 */
export interface EpisodeModelSwitchPlan {
  episodeId: string;
  /** 要换成的模型 id（空字串＝没有有效模型，`patches` 必为空）。 */
  model: string;
  patches: EpisodeModelPatch[];
  /** 该集的分镜数（＝`patches.length`；0 ＝该集在画布上没有分镜，如实回报）。 */
  shotCount: number;
}

/**
 * 产生「把**这一集**所有分镜的生成模型换成 `model`」的批次补丁。
 *
 * 逐字对应 D12（`replace all video generation models for this episode's storyboards`）：
 *   · 只碰 `episodeId` 相符的分镜节点；其他集／非分镜节点**零改动**
 *   · 模型 id 空 → 空计画（不把模型清成空字串＝不制造「无模型」态）
 *   · 该集无分镜 → 空计画（`shotCount: 0`），不假装成功
 */
export function planEpisodeModelSwitch(
  nodes: readonly CanvasNode[],
  episodeId: string,
  model: string,
): EpisodeModelSwitchPlan {
  const id = trimmed(episodeId) ?? "";
  const nextModel = trimmed(model, 256) ?? "";
  const patches: EpisodeModelPatch[] = [];
  if (id && nextModel) {
    for (const node of storyboardShotsOfEpisode(nodes, id)) {
      patches.push({ nodeId: node.id, metadata: { model: nextModel } });
    }
  }
  return { episodeId: id, model: nextModel, patches, shotCount: patches.length };
}

/**
 * 套用计画（纯函式，回传新阵列；**原阵列与未命中节点物件不动**）。
 * 命中的节点以 `{ ...node, metadata: { ...node.metadata, model } }` 换新物件
 * （不就地改写输入，reducer 的参考比较才不会失效）。
 */
export function applyEpisodeModelSwitch(
  nodes: readonly CanvasNode[],
  plan: EpisodeModelSwitchPlan,
): CanvasNode[] {
  if (plan.patches.length === 0) return [...nodes];
  const patchByNode = new Map(plan.patches.map((patch) => [patch.nodeId, patch.metadata]));
  return nodes.map((node) => {
    const patch = patchByNode.get(node.id);
    if (!patch) return node;
    return { ...node, metadata: { ...node.metadata, ...patch } };
  });
}

// ─────────────────────────────────────────── 按集批次重跑（Batch generate）

/** 批次重跑的一条（自带该格真正用过的 prompt）。 */
export interface EpisodeBatchRerunShot {
  nodeId: string;
  shotNumber: string;
  /** 重跑用 prompt（星标候选的 prompt 优先，其次节点自身 prompt）。 */
  prompt: string;
  model: string;
}

/** 按集批次重跑计画（纯资料；本档不呼叫上游、不扣费）。 */
export interface EpisodeBatchRerunPlan {
  episodeId: string;
  model: string;
  shots: EpisodeBatchRerunShot[];
  /**
   * 有分镜但**拿不出 prompt** 的镜号（诚实回报：这些格子无法重跑，不编造 prompt）。
   * 计画不会把它们塞进 `shots`——宁可少跑，不可用假 prompt 花钱。
   */
  missingPromptShotNumbers: string[];
}

/**
 * 产生「这一集全部重跑」的计画：以换好的模型 ＋ 每格自己的 prompt。
 *
 * prompt 真源复用 `shotRerunRequest`（星标候选 prompt → 节点 prompt；都没有＝`null`），
 * 不另写一套取 prompt 的逻辑（同源，不漂移）。
 */
export function planEpisodeBatchRerun(
  nodes: readonly CanvasNode[],
  episodeId: string,
  model: string,
): EpisodeBatchRerunPlan {
  const switchPlan = planEpisodeModelSwitch(nodes, episodeId, model);
  const shots: EpisodeBatchRerunShot[] = [];
  const missingPromptShotNumbers: string[] = [];
  for (const node of storyboardShotsOfEpisode(nodes, switchPlan.episodeId)) {
    const request = shotRerunRequest(node);
    const shotNumber = request?.shotNumber ?? shotNumberOf(node) ?? "";
    if (!request) {
      missingPromptShotNumbers.push(shotNumber);
      continue;
    }
    shots.push({
      nodeId: request.nodeId,
      shotNumber: request.shotNumber,
      prompt: request.prompt,
      model: switchPlan.model || request.model || "",
    });
  }
  return {
    episodeId: switchPlan.episodeId,
    model: switchPlan.model,
    shots,
    missingPromptShotNumbers,
  };
}

/**
 * 集维度的读取端（供 UI/API 用）：把该集分镜与其候选集并成一个可渲染清单。
 * 纯读、零副作用；候选集缺席＝`null`（该格还没抽卡，不制造空候选集）。
 */
export interface EpisodeShotSummary {
  nodeId: string;
  shotNumber: string;
  title: string;
  /** 该格的模型（节点 metadata.model；未设＝空字串）。 */
  model: string;
  /** 该格真正用过的 prompt（星标候选优先）；没有＝`null`。 */
  prompt: string | null;
  candidates: StoryboardShotCandidateSet | null;
  /** 星标选中的候选 id（未选定＝`null`）。 */
  selectedCandidateId: string | null;
}

export function summarizeEpisodeShots(
  nodes: readonly CanvasNode[],
  episodeId: string,
): EpisodeShotSummary[] {
  return storyboardShotsOfEpisode(nodes, episodeId).map((node) => {
    const request = shotRerunRequest(node);
    const candidates = node.metadata?.shotCandidates ?? null;
    return {
      nodeId: node.id,
      shotNumber: shotNumberOf(node) ?? "",
      title: node.title,
      model: typeof node.metadata?.model === "string" ? node.metadata.model : "",
      prompt: request?.prompt ?? null,
      candidates,
      selectedCandidateId:
        typeof candidates?.selectedId === "string" ? candidates.selectedId : null,
    };
  });
}