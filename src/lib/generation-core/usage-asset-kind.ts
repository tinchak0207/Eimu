// 用量按生成物类别切分（P2-2／对称差 D8b「角色／场景／道具／分镜影片」）。
//
// 对标口径（唯一）：`Dramagic对称差-决策表-0928.md:50` 逐字
// 「P2-2 | D8b 用量按生成物类别切分（角色/场景/道具/分镜影片） | **做**」。
//
// ── 现场真相（2026-09-29 实查；本档所有判准都对应到落盘事实，没有一条是猜的）──────
// 帐本行（`statistics-projection.ts` 的 `LedgerConsumptionRow`）只有：jobId／modelId／
// 渠道／金额／日——**没有生成物类别**。所以类别只能从 `generation_job` 的落盘栏位推：
//   1. `kind`（`db/migrations/001_generation_control_plane.sql:109`：
//      `image_generate` / `image_edit` / `video_generate`）：
//      **`video_generate` ⇒「分镜影片」**（现场只有这一条影片提交路径；D8b 的四类之一
//      就是「分镜影片」）。
//   2. 节点类型（`CanvasNodeType`）——**现况没有任何提交路径把它落盘**：
//      `/api/canvas/generate` 收到的是 `CanvasGenerateRequest`（prompt/model/size/count/
//      source_image/reference_images/negative_prompt/style_id），节点类型是**浏览器状态**，
//      不进请求（`src/components/canvas/embed/use-canvas-generation.ts:198-208`）。
//   3. 「集」有落盘（`metadata.episodeId`，P1-2），但那是分镜节点在**画布**上的归属，
//      同样不进生成请求。
//   ⇒ **角色／场景／道具目前无任何落盘事实可判**（诚实回报，不臆造）：
//      唯一能落地的是「分镜影片」与「其他」。
//
// ── 判准（本档唯一决策函式）────────────────────────────────────────────────
//   video_generate                                   → `shot_video`（分镜影片）
//   image_generate / image_edit                      → `still_image`（其他图片）
//   kind 缺席或未知                                   → `unclassified`（不猜）
//   四类的另外三类（character／scene／prop）**保留在值域里但不指派**——
//   值域先钉住，等提交端把类别盖章落盘（`workflow_json` 免 migration）之后，
//   本函式改成「有章用章、无章 unclassified」，报告的形状不必再改。
//
// 叶模组：只有常数与纯函式，不 import DB／`node:*`（会被投影与 CSV 汇出共用）。

/** 用量类别值域（D8b 的四类 ＋ 我方诚实需要的两桶）。 */
export type UsageAssetKind =
  /** 分镜影片（`video_generate`）。 */
  | "shot_video"
  /** 一般静态图（图片生成／编辑；D8b 的角色/场景/道具在提交端尚未盖章，暂归此桶）。 */
  | "still_image"
  /** D8b 指名但**目前无落盘事实**的三类（值域保留，尚未指派）。 */
  | "character"
  | "scene"
  | "prop"
  /** 无法归类（kind 缺席／未知）：不猜、不摊进任何类别。 */
  | "unclassified";

/** 目前**真的会出现**的桶（呼叫端与 UI 可据此知道哪些是空的，而不是以为漏算）。 */
export const ASSIGNED_USAGE_ASSET_KINDS: readonly UsageAssetKind[] = ["shot_video", "still_image", "unclassified"];

/** 值域全集（含尚未指派的 D8b 三类）。 */
export const USAGE_ASSET_KINDS: readonly UsageAssetKind[] = [
  "character",
  "scene",
  "prop",
  "shot_video",
  "still_image",
  "unclassified",
];

export const USAGE_ASSET_KIND_LABELS: Readonly<Record<UsageAssetKind, string>> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  shot_video: "分镜影片",
  still_image: "一般图片",
  unclassified: "未归类",
};

/** 落盘的 `generation_job.kind`（迁移档 001:109 的白名单，逐字）。 */
const KIND_TO_ASSET_KIND: Readonly<Record<string, UsageAssetKind>> = {
  video_generate: "shot_video",
  image_generate: "still_image",
  image_edit: "still_image",
};

/** 由 `generation_job.kind` 判类别；认不出来＝`unclassified`（不猜、不推导）。 */
export function usageAssetKindForJobKind(kind: unknown): UsageAssetKind {
  if (typeof kind !== "string") return "unclassified";
  return KIND_TO_ASSET_KIND[kind.trim()] ?? "unclassified";
}

/**
 * 用量列 → 类别桶键。桶键＝类别值域本身（呼叫端不必再做映射）。
 * 这是我方目前**唯一**能把帐本数字切成 D8b 四类的地方：切得出来的就切，
 * 切不出来的一律 unclassified，且报表要能看出这一桶有多大。
 */
export function usageAssetKindForRow(row: { jobKind?: unknown; kind?: unknown }): UsageAssetKind {
  return usageAssetKindForJobKind(row.jobKind ?? row.kind);
}

/** 值域守门（外部 payload 进来时用；非法值不进桶）。 */
export function isUsageAssetKind(value: unknown): value is UsageAssetKind {
  return typeof value === "string" && (USAGE_ASSET_KINDS as readonly string[]).includes(value);
}
