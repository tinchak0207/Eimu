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
//
// 2026-09-30（對稱差：由現況推導的下一步引導）── 本檔新增 `deriveNextStep`。
// 輪子來源（逐字照其語義，非參考重寫）：
//   `/tmp/symdiff-agnes/agnes-manga-studio/public/js/workflow-state.js:61-66`
//     `next` 流轉：無脚本→脚本、無分镜→分镜、缺图→补图、缺视频→补视频、缺配音→补配音、
//     否則→剪辑。**一步一跳**：每輪只回一個下一步，全部完成才回終態。
//   `/tmp/symdiff-agnes/agnes-manga-studio/public/js/pages/dashboard.js:117-120`（逐字）：
//     `setup feedback is derived from current server data, never from a persisted
//      client-side onboarding flag.`
// 為什麼「不得持久化 onboarding 標記」是硬約束：本站 2026-09-25 已因「創作流程步驟條靜態顯示」
// 被否而整條撤回（`wizard-steps.ts`/`CreationStepBar` 全滅，見記憶
// 2026-09-25-revert-stepbar-slice-and-vercel-content-oracle）；引導只能由**當前真實資料**重算，
// 一旦落盤「已引導過」的旗標，面板就會與畫布真況脫節（假進度）。
// 白名單差異（照對手語義、不照它的實體）：對手逐鏡讀 `linked_image_id`/`linked_video_id` 與
// audio 表；本站**沒有**這種「分鏡→圖/影/配音」的連結建模（無 parent 邊、`shotId` 只由 3D
// 舞台溯源寫入），故本函式的輸入是**呼叫端如實填寫的現況快照**，本檔不自行推導媒體計數、
// 更不補假值（推導口徑見函式上的註解）。

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

// ─────────────────────────── 下一步引導（由當前現況推導；一步一跳）

/**
 * 現況快照（照對手 `episodeWorkflowState` 的 `next` 判據逐項對應）。
 *
 * **全部欄位可缺席，缺席＝不知道**（fail-closed）：呼叫端拿不到某項就別填，
 * 本函式會回 `unknown` 而不是替它猜一個值。這是本站紀律「缺資料時回不知道／未完成，
 * 不補假進度」在型別上的落地（比 optional 更嚴的是：數字必須是非負整數）。
 *
 * 口徑（呼叫端負責如實填，本函式不自行推導、不混算）：
 *   · `hasProject`：作品是否已建立/已設定。本站判定建議用 `summary` 的
 *     `projectTypeLabel || currentStep || episodeCount > 0`（與面板「已設定」同一把尺）。
 *   · `episodes`：`CanvasProject.episodes` 的集數（＝`CreationFlowSummary.episodeCount`）。
 *   · `shots`：**已落畫布**的分鏡節點數（＝`CreationFlowSummary.storyboard.shots`，
 *     真值在節點 metadata.storyboardShot）。**刻意不收 `plannedShots`**：場景外殼自報的
 *     計畫鏡數是另一個數字，兩者混用就是把「已落畫布 / 場景計畫」合成假進度。
 *   · `shotsWithImage` / `shotsWithVideo` / `shotsWithAudio`：**該分鏡已有圖／已有視頻／
 *     已有配音**的鏡數（同一顆鏡只計一次）。本站目前無此連結建模，呼叫端必須有真來源
 *     （上游/agent 回報）才填；填不出來＝留空＝`unknown`，不得以 0 冒充「都沒有」。
 *   · `hasCut`：成片（剪輯產物）是否存在。本站尚無剪輯產物欄位 ⇒ 未建模時應留空。
 */
export interface CreationFlowSnapshot {
  readonly hasProject?: boolean;
  readonly episodes?: number;
  readonly shots?: number;
  readonly shotsWithImage?: number;
  readonly shotsWithVideo?: number;
  readonly shotsWithAudio?: number;
  readonly hasCut?: boolean;
}

/**
 * 下一步 id。工序鏈＝作品 → 集 → 分鏡 → 圖 → 影 → 配音 → 剪輯（照對手 `next` 同序）；
 * `done`＝全數完成（終態）、`unknown`＝資料不足以判斷（**不是**「沒問題」）。
 */
export type CreationNextStepId =
  | "project"
  | "episode"
  | "storyboard"
  | "shot-image"
  | "shot-video"
  | "shot-audio"
  | "cut"
  | "done"
  | "unknown";

/**
 * 下一步要去的**既有**面板／動作面（值域只放本站真的有入口的東西）：
 * · `agent`＝AI 助理對話。本站作品／集／分鏡的唯一寫入口是 agent 的 `set_project_meta`
 *   （`use-canvas-chat.ts:940`）與分鏡生成，沒有對應的表單頁。
 * · `canvas-generation`＝畫布上的生成動作（對分鏡節點出圖／出影／配音；節點 kind=image/video/audio）。
 * · `none`＝終態，無動作。
 */
export type CreationNextSurface = "agent" | "canvas-generation" | "none";

export interface NextCreationStep {
  readonly id: CreationNextStepId;
  /** 一句人話（照面板既有簡體文案體例）。 */
  readonly label: string;
  /** 指向哪個既有面板／動作。 */
  readonly surface: CreationNextSurface;
  /**
   * 對應 7 步流水線的那一步（`CREATION_STEPS`）。
   * **本目錄未建模的階段缺席**：`分鏡圖`在 AID 7 步裡沒有獨立步（素材準備 3 與視頻生成 5
   * 都可能被解讀成它），不猜；`unknown` 也不落步。
   */
  readonly pipelineStep?: CreationStep;
}

/** 非負整數判據（SSE/Blob 讀回的值不可信，一律過此；NaN/Infinity/負數/小數＝不知道）。 */
function isFlowCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function nextStep(
  id: CreationNextStepId,
  label: string,
  surface: CreationNextSurface,
  pipelineStepValue?: number,
): NextCreationStep {
  const pipelineStep = pipelineStepValue === undefined ? undefined : creationStepMeta(pipelineStepValue);
  return { id, label, surface, ...(pipelineStep ? { pipelineStep } : {}) };
}

/**
 * 由現況推導**唯一下一步**（一步一跳）。純函式：同輸入同輸出、不讀任何持久化標記、
 * 不改輸入、不呼叫 IO。全部完成才回終態 `done`；資料不足以判斷回 `unknown`。
 *
 * 順序即工序（照對手 `next` 的 if 鏈）：作品 → 集 → 分鏡 → 分鏡圖 → 視頻 → 配音 → 剪輯。
 * 判據一律用「**已有／總數**」，不合成「完成度百分比」。
 */
export function deriveNextStep(snapshot: CreationFlowSnapshot = {}): NextCreationStep {
  const { hasProject, episodes, shots, shotsWithImage, shotsWithVideo, shotsWithAudio, hasCut } =
    snapshot ?? {};

  if (typeof hasProject !== "boolean") {
    return nextStep("unknown", "还不确定作品是否已建立——先在 AI 助理里核对", "agent");
  }
  if (!hasProject) {
    return nextStep("project", "先建立作品：让 AI 助理设定作品类型", "agent", 1);
  }
  // 作品已建立之後，工序數字缺一項就無法**唯一**決定下一步 —— 回 unknown，不猜。
  if (
    !isFlowCount(episodes) ||
    !isFlowCount(shots) ||
    !isFlowCount(shotsWithImage) ||
    !isFlowCount(shotsWithVideo) ||
    !isFlowCount(shotsWithAudio) ||
    typeof hasCut !== "boolean"
  ) {
    return nextStep("unknown", "作品/集/分镜的计数不全——先在 AI 助理里核对，不猜下一步", "agent");
  }
  // 互相矛盾的計數（帶素材的鏡數多過分鏡總數）＝資料壞了：不挑一個看起來合理的答案。
  if (shotsWithImage > shots || shotsWithVideo > shots || shotsWithAudio > shots) {
    return nextStep("unknown", "计数互相矛盾（带素材的镜数超过分镜总数）——先核对分镜资料", "agent");
  }

  if (episodes === 0) {
    return nextStep("episode", "建立分集与剧本（这部作品还没有分集）", "agent", 2);
  }
  if (shots === 0) {
    return nextStep("storyboard", "把剧本拆成分镜（画布上还没有分镜）", "agent", 4);
  }
  if (shotsWithImage < shots) {
    // 分鏡圖在 AID 7 步裡沒有獨立步 ⇒ 不落 pipelineStep（不猜它是素材準備還是視頻生成）。
    return nextStep(
      "shot-image",
      `补齐分镜图（${shots - shotsWithImage} 个分镜还没有图）`,
      "canvas-generation",
    );
  }
  if (shotsWithVideo < shots) {
    return nextStep(
      "shot-video",
      `补齐分镜视频（${shots - shotsWithVideo} 个分镜还没有视频）`,
      "canvas-generation",
      5,
    );
  }
  if (shotsWithAudio < shots) {
    return nextStep(
      "shot-audio",
      `补齐配音（${shots - shotsWithAudio} 个分镜还没有配音）`,
      "canvas-generation",
      6,
    );
  }
  if (!hasCut) {
    return nextStep("cut", "素材齐了，进入剪辑出片（本站还没有剪辑面板，交给 AI 助理）", "agent", 7);
  }
  return nextStep("done", "全流程已完成 · 预览成片", "none", 7);
}
