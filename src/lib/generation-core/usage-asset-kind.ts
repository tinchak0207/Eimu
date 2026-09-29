// 用量按生成物類別切分（P2-2／對稱差 D8b「角色／場景／道具／分鏡影片」）。
//
// 對標口徑（唯一）：`Dramagic對稱差-決策表-0928.md:50` 逐字
// 「P2-2 | D8b 用量按生成物類別切分（角色/场景/道具/分镜影片） | **做**」。
//
// ── 現場真相（2026-09-29 實查；本檔所有判準都對應到落盤事實，沒有一條是猜的）──────
// 帳本行（`statistics-projection.ts` 的 `LedgerConsumptionRow`）只有：jobId／modelId／
// 渠道／金額／日——**沒有生成物類別**。所以類別只能從 `generation_job` 的落盤欄位推：
//   1. `kind`（`db/migrations/001_generation_control_plane.sql:109`：
//      `image_generate` / `image_edit` / `video_generate`）：
//      **`video_generate` ⇒「分鏡影片」**（現場只有這一條影片提交路徑；D8b 的四類之一
//      就是「分鏡影片」）。
//   2. 節點類型（`CanvasNodeType`）——**現況沒有任何提交路徑把它落盤**：
//      `/api/canvas/generate` 收到的是 `CanvasGenerateRequest`（prompt/model/size/count/
//      source_image/reference_images/negative_prompt/style_id），節點類型是**瀏覽器狀態**，
//      不進請求（`src/components/canvas/embed/use-canvas-generation.ts:198-208`）。
//   3. 「集」有落盤（`metadata.episodeId`，P1-2），但那是分鏡節點在**畫布**上的歸屬，
//      同樣不進生成請求。
//   ⇒ **角色／場景／道具目前無任何落盤事實可判**（誠實回報，不臆造）：
//      唯一能落地的是「分鏡影片」與「其他」。
//
// ── 判準（本檔唯一決策函式）────────────────────────────────────────────────
//   video_generate                                   → `shot_video`（分鏡影片）
//   image_generate / image_edit                      → `still_image`（其他圖片）
//   kind 缺席或未知                                   → `unclassified`（不猜）
//   四類的另外三類（character／scene／prop）**保留在值域裡但不指派**——
//   值域先釘住，等提交端把類別蓋章落盤（`workflow_json` 免 migration）之後，
//   本函式改成「有章用章、無章 unclassified」，報告的形狀不必再改。
//
// 葉模組：只有常數與純函式，不 import DB／`node:*`（會被投影與 CSV 匯出共用）。

/** 用量類別值域（D8b 的四類 ＋ 我方誠實需要的兩桶）。 */
export type UsageAssetKind =
  /** 分鏡影片（`video_generate`）。 */
  | "shot_video"
  /** 一般靜態圖（圖片生成／編輯；D8b 的角色/場景/道具在提交端尚未蓋章，暫歸此桶）。 */
  | "still_image"
  /** D8b 指名但**目前無落盤事實**的三類（值域保留，尚未指派）。 */
  | "character"
  | "scene"
  | "prop"
  /** 無法歸類（kind 缺席／未知）：不猜、不攤進任何類別。 */
  | "unclassified";

/** 目前**真的會出現**的桶（呼叫端與 UI 可據此知道哪些是空的，而不是以為漏算）。 */
export const ASSIGNED_USAGE_ASSET_KINDS: readonly UsageAssetKind[] = ["shot_video", "still_image", "unclassified"];

/** 值域全集（含尚未指派的 D8b 三類）。 */
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

/** 落盤的 `generation_job.kind`（遷移檔 001:109 的白名單，逐字）。 */
const KIND_TO_ASSET_KIND: Readonly<Record<string, UsageAssetKind>> = {
  video_generate: "shot_video",
  image_generate: "still_image",
  image_edit: "still_image",
};

/** 由 `generation_job.kind` 判類別；認不出來＝`unclassified`（不猜、不推導）。 */
export function usageAssetKindForJobKind(kind: unknown): UsageAssetKind {
  if (typeof kind !== "string") return "unclassified";
  return KIND_TO_ASSET_KIND[kind.trim()] ?? "unclassified";
}

/**
 * 用量列 → 類別桶鍵。桶鍵＝類別值域本身（呼叫端不必再做映射）。
 * 這是我方目前**唯一**能把帳本數字切成 D8b 四類的地方：切得出來的就切，
 * 切不出來的一律 unclassified，且報表要能看出這一桶有多大。
 */
export function usageAssetKindForRow(row: { jobKind?: unknown; kind?: unknown }): UsageAssetKind {
  return usageAssetKindForJobKind(row.jobKind ?? row.kind);
}

/** 值域守門（外部 payload 進來時用；非法值不進桶）。 */
export function isUsageAssetKind(value: unknown): value is UsageAssetKind {
  return typeof value === "string" && (USAGE_ASSET_KINDS as readonly string[]).includes(value);
}
