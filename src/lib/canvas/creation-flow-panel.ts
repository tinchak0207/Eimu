// 作品/劇集面板的純資料層（2026-09-16 G2）。
//
// 為什麼要獨立成純函數檔：面板的取值規則（劇集計數、當前步驟標籤、分鏡計數）是
// **可機器驗證**的部分，渲染只是把它印出來。放在 `src/lib/canvas/` 讓驗收測試
// （`src/lib/canvas/*.test.ts`）直接驅動，不必開瀏覽器。
//
// 資料來源（全部已存在，本檔不新增任何欄位）：
//   - `CanvasProject.projectType/currentStep/episodes`（刀 1）→ hook 的
//     `projectType`/`currentStep`/`episodes` 三個出口。
//   - `CanvasNodeMetadata.storyboardShot`（一鏡）/ `.storyboardScene`（場景外殼，刀 2）
//     → 分鏡計數的唯一真實來源，不另存副本、不算「完成」這種未建模的狀態。
//
// 本檔零副作用、純函數、無 IO。

import { creationStepMeta, type CreationStep } from "../creation-flow-steps";
import type { CanvasEpisode, CanvasNode, CanvasProjectType } from "./types";

/** 劇集三態的中文標籤（本站三態；AID 審核三態不進本站型別）。 */
export const EPISODE_STATUS_LABELS: Record<CanvasEpisode["status"], string> = {
  draft: "草稿",
  processing: "制作中",
  finished: "已完成",
};

/** 作品類型的中文標籤；未設定回 undefined（不捏造預設為「电影」）。 */
export function projectTypeLabel(projectType: unknown): string | undefined {
  if (projectType === "movie") return "电影";
  if (projectType === "series") return "剧集";
  return undefined;
}

/**
 * 分鏡計數（照節點 metadata 實數，非估算）。
 *
 * `shots` = 帶 `storyboardShot` 的節點數（真值在節點本身）。
 * `plannedShots` = 所有 `storyboardScene.shotCount` 之和（場景外殼自報的計畫鏡數）。
 * 兩者刻意分開回報：**不宣稱「完成進度」**——「一鏡是否完成」在本站沒有建模
 * （沒有 shot.status 這種欄位），把「已落畫布 / 計畫」說成「完成 N/M」就是灌水。
 */
export interface StoryboardProgress {
  shots: number;
  plannedShots: number;
}

export function countStoryboardProgress(nodes: readonly CanvasNode[]): StoryboardProgress {
  let shots = 0;
  let plannedShots = 0;
  for (const node of nodes) {
    const metadata = node.metadata;
    if (!metadata) continue;
    if (metadata.storyboardShot) shots += 1;
    const planned = metadata.storyboardScene?.shotCount;
    if (typeof planned === "number" && Number.isFinite(planned) && planned > 0) {
      plannedShots += Math.floor(planned);
    }
  }
  return { shots, plannedShots };
}

/** 面板一列（渲染層只負責把它印出來）。 */
export interface EpisodeRow {
  id: string;
  episodeNo: number;
  title: string;
  status: CanvasEpisode["status"];
  statusLabel: string;
  /** 該集是否有劇本原文（長文不進面板，只給指針）。 */
  hasScript: boolean;
}

export interface CreationFlowSummary {
  /** 作品類型中文標籤；未設定為 undefined。 */
  projectTypeLabel?: string;
  /** 當前步驟元資料（含中文 label 與 key）；未開始為 undefined。 */
  currentStep?: CreationStep;
  episodeCount: number;
  finishedCount: number;
  /** 集清單（照 episodeNo 升序；輸入順序不動）。 */
  episodes: EpisodeRow[];
  storyboard: StoryboardProgress;
}

/**
 * 面板資料彙總。輸入一律視為「可能任意形」（state 由清洗層保證，這裡只防炸），
 * 缺欄位就回空值——不補預設、不捏造。
 */
export function summarizeCreationFlow(input: {
  projectType?: CanvasProjectType;
  currentStep?: number;
  episodes?: readonly CanvasEpisode[];
  nodes?: readonly CanvasNode[];
}): CreationFlowSummary {
  const raw = Array.isArray(input.episodes) ? input.episodes : [];
  const rows: EpisodeRow[] = raw
    .filter((e): e is CanvasEpisode => Boolean(e) && typeof e === "object")
    .map((e) => ({
      id: e.id,
      episodeNo: e.episodeNo,
      title: e.title,
      status: e.status,
      statusLabel: EPISODE_STATUS_LABELS[e.status] ?? EPISODE_STATUS_LABELS.draft,
      hasScript: typeof e.script === "string" && e.script.length > 0,
    }))
    // 照集號升序：episodeNo 是集的唯一權威序（輸入順序可能是 agent 亂序寫入的）。
    .sort((a, b) => a.episodeNo - b.episodeNo);

  return {
    ...(projectTypeLabel(input.projectType) ? { projectTypeLabel: projectTypeLabel(input.projectType)! } : {}),
    ...(creationStepMeta(input.currentStep) ? { currentStep: creationStepMeta(input.currentStep)! } : {}),
    episodeCount: rows.length,
    finishedCount: rows.filter((r) => r.status === "finished").length,
    episodes: rows,
    storyboard: countStoryboardProgress(Array.isArray(input.nodes) ? input.nodes : []),
  };
}
