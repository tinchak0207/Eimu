/**
 * 創作流水線 7 步狀態機（作品 → 劇集 → 分鏡的流程骨架）。
 *
 * 輪子來源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 源檔：
 *   1. aid-interface/src/main/java/com/aid/enums/CreationStepEnum.java
 *      （7 步枚舉 + isValidStep() 的 1..7 判據）
 *   2. frontend/web/.../createFlowStepMeta.ts（步驟 key 與中文標題）
 * 取得日：2026-09-15
 * 逐字保留：value（1..7，與 `aid_comic_episode.current_step` 同值域）、key、title（→ label）
 * 白名單改寫（僅此處）：
 *   1. 不引入 `SERIES_DEFAULT(-1, "剧集默认")` —— 那是 AID 劇集模式下「項目主表固定值」的
 *      儲存技巧，本站走 Blob 無此需求（`currentStep` 未開始即 undefined）。
 *   2. `episodeStatusFromAid` 收斂 AID EpisodeStatusEnum 六態 → 本站三態：
 *      0草稿→draft、1制作中→processing、2完成未审核|3审核中|4审核通过→finished、
 *      5审核失败→processing（退回製作）。**本站無審核隊列，審核三態不進本站型別。**
 *   3. 不搬 AID 的 description/guide 文案（路由頁說明，本站尚無對應頁面樹）。
 *
 * 本檔為純常數 + 純函數，無副作用。
 * 消費入口：`CanvasProject.currentStep`（`src/lib/canvas/types.ts`）的合法值域判據。
 */

export interface CreationStep {
  /** 步驟值（1..7，與 AID `aid_comic_episode.current_step` 同值域）。 */
  readonly value: number;
  /** 步驟鍵（AID 前端路由段 `<key>`，逐字保留）。 */
  readonly key: string;
  /** 步驟顯示名（簡體，照 AID desc）。 */
  readonly label: string;
}

/** 7 步流水線（順序即工序順序）。 */
export const CREATION_STEPS: readonly CreationStep[] = [
  { value: 1, key: "global-setting", label: "项目配置" },
  { value: 2, key: "story-script", label: "剧本创作" },
  { value: 3, key: "scene-character", label: "素材准备" },
  { value: 4, key: "storyboard-script", label: "分镜设计" },
  { value: 5, key: "storyboard-video", label: "视频生成" },
  { value: 6, key: "dubbing", label: "音画同步" },
  { value: 7, key: "preview", label: "成品预览" },
] as const;

/** 步驟值合法判據（照 AID `CreationStepEnum.isValidStep()`：1..7 整數）。 */
export function isValidCreationStep(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7;
}

/** 步驟值 → 步驟元資料；非法值回 undefined。 */
export function creationStepMeta(value: unknown): CreationStep | undefined {
  return isValidCreationStep(value) ? CREATION_STEPS[value - 1] : undefined;
}

/**
 * 單一作品的劇集上限。
 *
 * 用途（兩端同值，2026-09-16 收斂為單一常數）：
 *   1. 落盤清洗 `project-store.normalizeEpisodes`（Blob 體積守門）；
 *   2. agent op 載荷清洗 `layout.normalizeProjectMetaPatch`（`set_project_meta`）。
 * 這裡是**唯一宣告處**：兩處各寫一個 200 = 兩個漂移點（前者原本就是本地 const）。
 * 為何放本檔：本檔是純常數 + 純函數模組（零 import、客戶端安全），
 * `project-store` 有 `node:crypto`/blob 依賴、不可能被客戶端載荷清洗端引用。
 */
export const MAX_EPISODES_PER_PROJECT = 200;

/** 本站劇集三態（砍 AID 審核三態）。 */
export type CanvasEpisodeStatus = "draft" | "processing" | "finished";

const AID_EPISODE_STATUS_MAP: Record<number, CanvasEpisodeStatus> = {
  0: "draft",
  1: "processing",
  2: "finished", // 完成未审核
  3: "finished", // 审核中（本站無審核隊列 → 製作已完成）
  4: "finished", // 审核通过
  5: "processing", // 审核失败 → 退回製作
};

/** AID `aid_comic_episode.status`（0..5）→ 本站三態；未知值回 undefined。 */
export function episodeStatusFromAid(value: unknown): CanvasEpisodeStatus | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return AID_EPISODE_STATUS_MAP[value];
}
