// 按集批次：換模型 ＋ 批次重跑（P1-2，對稱差 D12；2026-09-29）。
//
// D12 逐字：「Batch generate videos」＋「Batch switch model…replace all video generation
// models for **this episode's** storyboards」。
//
// 現場盤點（唯一真源是源碼，不是本檔註釋）：
//   · **「集」實體存在**：`CanvasProject.episodes: CanvasEpisode[]`（`src/lib/canvas/types.ts:606`，
//     AID `aid_comic_episode` 白名單化產物：`id` / `episodeNo` / `title` / `status` / `script`），
//     清洗在 `layout.readEpisodes` 與 `project-store.normalizeEpisodes`，寫入口是
//     `CanvasProjectMetaPatch.episodes`（hook 層 `setProjectMeta`）。
//   · **「分鏡→集」的邊不存在**（本輪現場取證，缺口如實回報）：
//       - `CanvasNodeMetadata` 無任何集歸屬欄（grep `episodeId` 在 `src/lib/canvas` 零命中）；
//       - 場景外殼只有 `storyboardScene.sceneName`（AID v2.1.4 廢 `sceneCode`，也無集）；
//       - 畫布沒有 parent 邊（Group 子節點無 `parentId`；`batchChildren` 是批次族專用），
//         所以無法從場景節點推導出子節點的集。
//     故本檔補**一個最小指針**：分鏡節點 `metadata.episodeId`（值＝`CanvasEpisode.id`）。
//     鍵名照現場既有約定 `<domain>Id`（`directorStageId`/`directorSessionId`/`imageTaskId`），
//     不另立詞表；清洗沿用既有的 `trimmedString`（A 端）與 `truthy`（B 端），零新機制。
//     **不臆造**：沒有 `episodeId` 的分鏡不歸任何一集（不猜、不按節點順序切段）。
//
// 「換模型」寫的是分鏡節點的 `metadata.model`（現場既有鍵，Config 卡與重生成都讀它），
// 批次效果＝同一集的每個分鏡節點都被蓋成新模型。重跑計畫（`planEpisodeBatchRerun`）只產
// **純資料**（nodeId / 鏡號 / prompt / 模型），不呼叫任何上游、不扣費。

import { shotNumberOf, shotRerunRequest } from "./storyboard-shots";
import type { StoryboardShotCandidateSet } from "./storyboard-shots";
import type { CanvasNode, CanvasNodeMetadata } from "./types";

/** 集 id 上限（`CanvasEpisode.id` 是自由字串；與同族薄鍵同量級）。 */
export const EPISODE_ID_MAX = 128;

function trimmed(v: unknown, max = EPISODE_ID_MAX): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

// ─────────────────────────────────────────── 集歸屬指針

/** 分鏡節點的集歸屬（`metadata.episodeId`）；缺席＝不歸任何一集。 */
export function shotEpisodeId(node: CanvasNode | undefined): string | undefined {
  return trimmed(node?.metadata?.episodeId);
}

/** 集歸屬指針 → metadata patch（純函式；空值＝空 patch，不寫空殼鍵）。 */
export function episodeIdMetadata(
  episodeId: string | null | undefined,
): Pick<CanvasNodeMetadata, "episodeId"> {
  const id = trimmed(episodeId);
  return id ? { episodeId: id } : {};
}

/** 畫布上**真的有分鏡**的集 id 清單（首見序去重；供集清單/切集 UI 對帳）。 */
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
 * 該集的所有分鏡節點（只認「分鏡節點 ＋ episodeId 逐字相符」）。
 * 排序＝鏡號（`shotNumber` 常是 `001` 這種零填充三位數，故用 numeric 比較：
 * 萬一出現未填充的 `1`/`10` 也不會排出 `10 < 2` 的字典序錯序）。
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

// ─────────────────────────────────────────── 按集批次換模型（D12）

/** 單一節點的模型替換補丁。 */
export interface EpisodeModelPatch {
  nodeId: string;
  /** patch 直接餵 `patchNodeMetadata`。 */
  metadata: Pick<CanvasNodeMetadata, "model">;
}

/** 按集換模型的計畫（純資料；呼叫端逐條套用或整批下發）。 */
export interface EpisodeModelSwitchPlan {
  episodeId: string;
  /** 要換成的模型 id（空字串＝沒有有效模型，`patches` 必為空）。 */
  model: string;
  patches: EpisodeModelPatch[];
  /** 該集的分鏡數（＝`patches.length`；0 ＝該集在畫布上沒有分鏡，如實回報）。 */
  shotCount: number;
}

/**
 * 產生「把**這一集**所有分鏡的生成模型換成 `model`」的批次補丁。
 *
 * 逐字對應 D12（`replace all video generation models for this episode's storyboards`）：
 *   · 只碰 `episodeId` 相符的分鏡節點；其他集／非分鏡節點**零改動**
 *   · 模型 id 空 → 空計畫（不把模型清成空字串＝不製造「無模型」態）
 *   · 該集無分鏡 → 空計畫（`shotCount: 0`），不假裝成功
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
 * 套用計畫（純函式，回傳新陣列；**原陣列與未命中節點物件不動**）。
 * 命中的節點以 `{ ...node, metadata: { ...node.metadata, model } }` 換新物件
 * （不就地改寫輸入，reducer 的參考比較才不會失效）。
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

/** 批次重跑的一條（自帶該格真正用過的 prompt）。 */
export interface EpisodeBatchRerunShot {
  nodeId: string;
  shotNumber: string;
  /** 重跑用 prompt（星標候選的 prompt 優先，其次節點自身 prompt）。 */
  prompt: string;
  model: string;
}

/** 按集批次重跑計畫（純資料；本檔不呼叫上游、不扣費）。 */
export interface EpisodeBatchRerunPlan {
  episodeId: string;
  model: string;
  shots: EpisodeBatchRerunShot[];
  /**
   * 有分鏡但**拿不出 prompt** 的鏡號（誠實回報：這些格子無法重跑，不編造 prompt）。
   * 計畫不會把它們塞進 `shots`——寧可少跑，不可用假 prompt 花錢。
   */
  missingPromptShotNumbers: string[];
}

/**
 * 產生「這一集全部重跑」的計畫：以換好的模型 ＋ 每格自己的 prompt。
 *
 * prompt 真源複用 `shotRerunRequest`（星標候選 prompt → 節點 prompt；都沒有＝`null`），
 * 不另寫一套取 prompt 的邏輯（同源，不漂移）。
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
 * 集維度的讀取端（供 UI/API 用）：把該集分鏡與其候選集併成一個可渲染清單。
 * 純讀、零副作用；候選集缺席＝`null`（該格還沒抽卡，不製造空候選集）。
 */
export interface EpisodeShotSummary {
  nodeId: string;
  shotNumber: string;
  title: string;
  /** 該格的模型（節點 metadata.model；未設＝空字串）。 */
  model: string;
  /** 該格真正用過的 prompt（星標候選優先）；沒有＝`null`。 */
  prompt: string | null;
  candidates: StoryboardShotCandidateSet | null;
  /** 星標選中的候選 id（未選定＝`null`）。 */
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