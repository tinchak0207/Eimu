/**
 * 创作流水线 7 步状态机（作品 → 剧集 → 分镜的流程骨架）。
 *
 * 轮子来源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 源档：
 *   1. aid-interface/src/main/java/com/aid/enums/CreationStepEnum.java
 *      （7 步枚举 + isValidStep() 的 1..7 判据）
 *   2. frontend/web/.../createFlowStepMeta.ts（步骤 key 与中文标题）
 * 取得日：2026-09-15
 * 逐字保留：value（1..7，与 `aid_comic_episode.current_step` 同值域）、key、title（→ label）
 * 白名单改写（仅此处）：
 *   1. 不引入 `SERIES_DEFAULT(-1, "剧集默认")` —— 那是 AID 剧集模式下「项目主表固定值」的
 *      储存技巧，本站走 Blob 无此需求（`currentStep` 未开始即 undefined）。
 *   2. `episodeStatusFromAid` 收敛 AID EpisodeStatusEnum 六态 → 本站三态：
 *      0草稿→draft、1制作中→processing、2完成未审核|3审核中|4审核通过→finished、
 *      5审核失败→processing（退回制作）。**本站无审核队列，审核三态不进本站型别。**
 *   3. 不搬 AID 的 description/guide 文案（路由页说明，本站尚无对应页面树）。
 *
 * 本档为纯常数 + 纯函数，无副作用。
 * 消费入口：`CanvasProject.currentStep`（`src/lib/canvas/types.ts`）的合法值域判据。
 *
 * 2026-09-17（G6）：`AID_EPISODE_STATUS_MAP` 的键改由 `aid-enums/creation.ts` 的
 * `AID_EPISODE_STATUS_ENUM` 推导，不再硬编数字。`aid-enums` 是纯常数模组（零 import），
 * 本档仍是零副作用模组，客户端安全。
 */

import { AID_EPISODE_STATUS_ENUM, type AidEpisodeStatusEnumValue } from "./aid-enums/creation";

export interface CreationStep {
  /** 步骤值（1..7，与 AID `aid_comic_episode.current_step` 同值域）。 */
  readonly value: number;
  /** 步骤键（AID 前端路由段 `<key>`，逐字保留）。 */
  readonly key: string;
  /** 步骤显示名（简体，照 AID desc）。 */
  readonly label: string;
}

/** 7 步流水线（顺序即工序顺序）。 */
export const CREATION_STEPS: readonly CreationStep[] = [
  { value: 1, key: "global-setting", label: "项目配置" },
  { value: 2, key: "story-script", label: "剧本创作" },
  { value: 3, key: "scene-character", label: "素材准备" },
  { value: 4, key: "storyboard-script", label: "分镜设计" },
  { value: 5, key: "storyboard-video", label: "视频生成" },
  { value: 6, key: "dubbing", label: "音画同步" },
  { value: 7, key: "preview", label: "成品预览" },
] as const;

/** 步骤值合法判据（照 AID `CreationStepEnum.isValidStep()`：1..7 整数）。 */
export function isValidCreationStep(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7;
}

/** 步骤值 → 步骤元资料；非法值回 undefined。 */
export function creationStepMeta(value: unknown): CreationStep | undefined {
  return isValidCreationStep(value) ? CREATION_STEPS[value - 1] : undefined;
}

/**
 * 单一作品的剧集上限。
 *
 * 用途（两端同值，2026-09-16 收敛为单一常数）：
 *   1. 落盘清洗 `project-store.normalizeEpisodes`（Blob 体积守门）；
 *   2. agent op 载荷清洗 `layout.normalizeProjectMetaPatch`（`set_project_meta`）。
 * 这里是**唯一宣告处**：两处各写一个 200 = 两个漂移点（前者原本就是本地 const）。
 * 为何放本档：本档是纯常数 + 纯函数模组（零 import、客户端安全），
 * `project-store` 有 `node:crypto`/blob 依赖、不可能被客户端载荷清洗端引用。
 */
export const MAX_EPISODES_PER_PROJECT = 200;

/** 本站剧集三态（砍 AID 审核三态）。 */
export type CanvasEpisodeStatus = "draft" | "processing" | "finished";

/**
 * AID `EpisodeStatusEnum` 六态 → 本站三态。
 *
 * 键**由 AID enum 值推导**而非硬编数字：这张表的定义域就是 AID 的 enum 值域，
 * 两处各写一份 = 两个漂移点。`satisfies` 提供穷尽性检查 —— AID 新增第七态时
 * 此处编译失败，而不是静默回 undefined（`readEpisode` 会把该剧集整笔丢掉，
 * 用户看到的是「剧集莫名消失」，最难查的一类 bug）。
 */
const AID_EPISODE_STATUS_MAP = {
  [AID_EPISODE_STATUS_ENUM.DRAFT.value]: "draft",
  [AID_EPISODE_STATUS_ENUM.PROCESSING.value]: "processing",
  [AID_EPISODE_STATUS_ENUM.FINISHED_UNAUDITED.value]: "finished", // 完成未审核
  [AID_EPISODE_STATUS_ENUM.AUDITING.value]: "finished", // 审核中（本站无审核队列 → 制作已完成）
  [AID_EPISODE_STATUS_ENUM.AUDIT_PASSED.value]: "finished", // 审核通过
  [AID_EPISODE_STATUS_ENUM.AUDIT_FAILED.value]: "processing", // 审核失败 → 退回制作
} as const satisfies Record<AidEpisodeStatusEnumValue, CanvasEpisodeStatus>;

/**
 * 查表视图：键域放宽到 `number`。呼叫端拿到的是**未知整数**（AID DB 的 status 栏），
 * 可能落在 AID 值域外 —— 直接索引上面的物件在型别上会是「必有值」，那是谎。
 */
const AID_EPISODE_STATUS_LOOKUP: Readonly<Record<number, CanvasEpisodeStatus | undefined>> = AID_EPISODE_STATUS_MAP;

/** AID `aid_comic_episode.status`（0..5）→ 本站三态；未知值回 undefined。 */
export function episodeStatusFromAid(value: unknown): CanvasEpisodeStatus | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return AID_EPISODE_STATUS_LOOKUP[value];
}
