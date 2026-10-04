// 作品/剧集面板的纯资料层（2026-09-16 G2）。
//
// 为什么要独立成纯函数档：面板的取值规则（剧集计数、当前步骤标签、分镜计数）是
// **可机器验证**的部分，渲染只是把它印出来。放在 `src/lib/canvas/` 让验收测试
// （`src/lib/canvas/*.test.ts`）直接驱动，不必开浏览器。
//
// 资料来源（全部已存在，本档不新增任何栏位）：
//   - `CanvasProject.projectType/currentStep/episodes`（刀 1）→ hook 的
//     `projectType`/`currentStep`/`episodes` 三个出口。
//   - `CanvasNodeMetadata.storyboardShot`（一镜）/ `.storyboardScene`（场景外壳，刀 2）
//     → 分镜计数的唯一真实来源，不另存副本、不算「完成」这种未建模的状态。
//
// 本档零副作用、纯函数、无 IO。
//
// 2026-09-30（对称差：由现况推导的下一步引导）── 本档新增 `deriveNextStep`。
// 轮子来源（逐字照其语义，非参考重写）：
//   `/tmp/symdiff-agnes/agnes-manga-studio/public/js/workflow-state.js:61-66`
//     `next` 流转：无脚本→脚本、无分镜→分镜、缺图→补图、缺视频→补视频、缺配音→补配音、
//     否则→剪辑。**一步一跳**：每轮只回一个下一步，全部完成才回终态。
//   `/tmp/symdiff-agnes/agnes-manga-studio/public/js/pages/dashboard.js:117-120`（逐字）：
//     `setup feedback is derived from current server data, never from a persisted
//      client-side onboarding flag.`
// 为什么「不得持久化 onboarding 标记」是硬约束：本站 2026-09-25 已因「创作流程步骤条静态显示」
// 被否而整条撤回（`wizard-steps.ts`/`CreationStepBar` 全灭，见记忆
// 2026-09-25-revert-stepbar-slice-and-vercel-content-oracle）；引导只能由**当前真实资料**重算，
// 一旦落盘「已引导过」的旗标，面板就会与画布真况脱节（假进度）。
// 白名单差异（照对手语义、不照它的实体）：对手逐镜读 `linked_image_id`/`linked_video_id` 与
// audio 表；本站**没有**这种「分镜→图/影/配音」的连结建模（无 parent 边、`shotId` 只由 3D
// 舞台溯源写入），故本函式的输入是**呼叫端如实填写的现况快照**，本档不自行推导媒体计数、
// 更不补假值（推导口径见函式上的注解）。

import { creationStepMeta, type CreationStep } from "../creation-flow-steps";
import type { CanvasEpisode, CanvasNode, CanvasProjectType } from "./types";

/** 剧集三态的中文标签（本站三态；AID 审核三态不进本站型别）。 */
export const EPISODE_STATUS_LABELS: Record<CanvasEpisode["status"], string> = {
  draft: "草稿",
  processing: "制作中",
  finished: "已完成",
};

/** 作品类型的中文标签；未设定回 undefined（不捏造预设为「电影」）。 */
export function projectTypeLabel(projectType: unknown): string | undefined {
  if (projectType === "movie") return "电影";
  if (projectType === "series") return "剧集";
  return undefined;
}

/**
 * 分镜计数（照节点 metadata 实数，非估算）。
 *
 * `shots` = 带 `storyboardShot` 的节点数（真值在节点本身）。
 * `plannedShots` = 所有 `storyboardScene.shotCount` 之和（场景外壳自报的计画镜数）。
 * 两者刻意分开回报：**不宣称「完成进度」**——「一镜是否完成」在本站没有建模
 * （没有 shot.status 这种栏位），把「已落画布 / 计画」说成「完成 N/M」就是灌水。
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

/** 面板一列（渲染层只负责把它印出来）。 */
export interface EpisodeRow {
  id: string;
  episodeNo: number;
  title: string;
  status: CanvasEpisode["status"];
  statusLabel: string;
  /** 该集是否有剧本原文（长文不进面板，只给指针）。 */
  hasScript: boolean;
}

export interface CreationFlowSummary {
  /** 作品类型中文标签；未设定为 undefined。 */
  projectTypeLabel?: string;
  /** 当前步骤元资料（含中文 label 与 key）；未开始为 undefined。 */
  currentStep?: CreationStep;
  episodeCount: number;
  finishedCount: number;
  /** 集清单（照 episodeNo 升序；输入顺序不动）。 */
  episodes: EpisodeRow[];
  storyboard: StoryboardProgress;
}

/**
 * 面板资料汇总。输入一律视为「可能任意形」（state 由清洗层保证，这里只防炸），
 * 缺栏位就回空值——不补预设、不捏造。
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
    // 照集号升序：episodeNo 是集的唯一权威序（输入顺序可能是 agent 乱序写入的）。
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

// ─────────────────────────── 下一步引导（由当前现况推导；一步一跳）

/**
 * 现况快照（照对手 `episodeWorkflowState` 的 `next` 判据逐项对应）。
 *
 * **全部栏位可缺席，缺席＝不知道**（fail-closed）：呼叫端拿不到某项就别填，
 * 本函式会回 `unknown` 而不是替它猜一个值。这是本站纪律「缺资料时回不知道／未完成，
 * 不补假进度」在型别上的落地（比 optional 更严的是：数字必须是非负整数）。
 *
 * 口径（呼叫端负责如实填，本函式不自行推导、不混算）：
 *   · `hasProject`：作品是否已建立/已设定。本站判定建议用 `summary` 的
 *     `projectTypeLabel || currentStep || episodeCount > 0`（与面板「已设定」同一把尺）。
 *   · `episodes`：`CanvasProject.episodes` 的集数（＝`CreationFlowSummary.episodeCount`）。
 *   · `shots`：**已落画布**的分镜节点数（＝`CreationFlowSummary.storyboard.shots`，
 *     真值在节点 metadata.storyboardShot）。**刻意不收 `plannedShots`**：场景外壳自报的
 *     计画镜数是另一个数字，两者混用就是把「已落画布 / 场景计画」合成假进度。
 *   · `shotsWithImage` / `shotsWithVideo` / `shotsWithAudio`：**该分镜已有图／已有视频／
 *     已有配音**的镜数（同一颗镜只计一次）。本站目前无此连结建模，呼叫端必须有真来源
 *     （上游/agent 回报）才填；填不出来＝留空＝`unknown`，不得以 0 冒充「都没有」。
 *   · `hasCut`：成片（剪辑产物）是否存在。本站尚无剪辑产物栏位 ⇒ 未建模时应留空。
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
 * 下一步 id。工序链＝作品 → 集 → 分镜 → 图 → 影 → 配音 → 剪辑（照对手 `next` 同序）；
 * `done`＝全数完成（终态）、`unknown`＝资料不足以判断（**不是**「没问题」）。
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
 * 下一步要去的**既有**面板／动作面（值域只放本站真的有入口的东西）：
 * · `agent`＝AI 助理对话。本站作品／集／分镜的唯一写入口是 agent 的 `set_project_meta`
 *   （`use-canvas-chat.ts:940`）与分镜生成，没有对应的表单页。
 * · `canvas-generation`＝画布上的生成动作（对分镜节点出图／出影／配音；节点 kind=image/video/audio）。
 * · `none`＝终态，无动作。
 */
export type CreationNextSurface = "agent" | "canvas-generation" | "none";

export interface NextCreationStep {
  readonly id: CreationNextStepId;
  /** 一句人话（照面板既有简体文案体例）。 */
  readonly label: string;
  /** 指向哪个既有面板／动作。 */
  readonly surface: CreationNextSurface;
  /**
   * 对应 7 步流水线的那一步（`CREATION_STEPS`）。
   * **本目录未建模的阶段缺席**：`分镜图`在 AID 7 步里没有独立步（素材准备 3 与视频生成 5
   * 都可能被解读成它），不猜；`unknown` 也不落步。
   */
  readonly pipelineStep?: CreationStep;
}

/** 非负整数判据（SSE/Blob 读回的值不可信，一律过此；NaN/Infinity/负数/小数＝不知道）。 */
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
 * 由现况推导**唯一下一步**（一步一跳）。纯函式：同输入同输出、不读任何持久化标记、
 * 不改输入、不呼叫 IO。全部完成才回终态 `done`；资料不足以判断回 `unknown`。
 *
 * 顺序即工序（照对手 `next` 的 if 链）：作品 → 集 → 分镜 → 分镜图 → 视频 → 配音 → 剪辑。
 * 判据一律用「**已有／总数**」，不合成「完成度百分比」。
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
  // 作品已建立之后，工序数字缺一项就无法**唯一**决定下一步 —— 回 unknown，不猜。
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
  // 互相矛盾的计数（带素材的镜数多过分镜总数）＝资料坏了：不挑一个看起来合理的答案。
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
    // 分镜图在 AID 7 步里没有独立步 ⇒ 不落 pipelineStep（不猜它是素材准备还是视频生成）。
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
