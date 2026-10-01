// 畫布生成結果 → 節點 metadata 補丁（手動面板原地回填與批次子節點共用）。
//
// imageTaskId 是 LOD3 工程透析面板查 `GET /api/generation-jobs/{id}` 的唯一指針：
//   · durable 路徑回 job id → 寫入；
//   · legacy 路徑沒有 job（task_id: null）→ 明確寫 undefined 清掉舊指針——同一節點重生成後
//     若殘留上一次的 id，面板會展示「上一張圖」的參數（張冠李戴比缺席更糟）。
// 與 settler 的關係：本補丁總是與 content（圖片 URL）同時落地，節點不再滿足
// isPendingSettledNode（要求 content 為空），gateway image.done 對帳不會誤配這些節點。

import type { CanvasNodeMetadata } from "./types";

/** `/api/canvas/generate` 回應裡單張圖的形狀（與路由 CanvasImageResult 同源；task_id 舊回應可能缺席）。 */
export interface CanvasGeneratedImage {
  url: string;
  cost_coins: number | null;
  natural_width: number | null;
  natural_height: number | null;
  task_id?: string | null;
}

export function generatedImageMetadata(img: CanvasGeneratedImage): Partial<CanvasNodeMetadata> {
  const taskId = typeof img.task_id === "string" && img.task_id.trim() ? img.task_id.trim() : undefined;
  return {
    ...(typeof img.cost_coins === "number" ? { cost_coins: img.cost_coins } : {}),
    ...(img.natural_width ? { naturalWidth: img.natural_width } : {}),
    ...(img.natural_height ? { naturalHeight: img.natural_height } : {}),
    imageTaskId: taskId,
  };
}
