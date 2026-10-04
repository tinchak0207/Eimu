// 画布生成结果 → 节点 metadata 补丁（手动面板原地回填与批次子节点共用）。
//
// imageTaskId 是 LOD3 工程透析面板查 `GET /api/generation-jobs/{id}` 的唯一指针：
//   · durable 路径回 job id → 写入；
//   · legacy 路径没有 job（task_id: null）→ 明确写 undefined 清掉旧指针——同一节点重生成后
//     若残留上一次的 id，面板会展示「上一张图」的参数（张冠李戴比缺席更糟）。
// 与 settler 的关系：本补丁总是与 content（图片 URL）同时落地，节点不再满足
// isPendingSettledNode（要求 content 为空），gateway image.done 对帐不会误配这些节点。

import type { CanvasNodeMetadata } from "./types";

/** `/api/canvas/generate` 回应里单张图的形状（与路由 CanvasImageResult 同源；task_id 旧回应可能缺席）。 */
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
