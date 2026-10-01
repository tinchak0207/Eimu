// 批次父子節點工具函式：批次管理、佈局、建立子節點。
//
// 批次父節點是一個帶 batchChildren 的 CanvasNode，展開時顯示多個子圖片
// 節點，收起時只顯示 batchPrimaryImageId 指定的主圖片。

import { CanvasNodeType, CANVAS_NODE_DEFAULT_SIZE } from '@/lib/canvas/types';
import type {
  CanvasNode,
  CanvasNodeMetadata,
  CanvasNodeStatus,
  CanvasPosition,
} from '@/lib/canvas/types';

/** 水平間距（子節點之間） */
const BATCH_GAP_X = 24;

/** 垂直間距（子節點換行時） */
const BATCH_GAP_Y = 24;

/** 每行最大子節點數 */
const BATCH_ROW_CAPACITY = 4;

/**
 * 判斷節點是否為批次父節點（有 batchChildren 且非空）。
 * 純粹的 JavaScript 檢查：不處理 undefined 以外的邊界情況。
 */
export function hasBatchChildren(node: CanvasNode): boolean {
  return !!node.batchChildren && node.batchChildren.length > 0;
}

/**
 * 彙總批次子節點的整體狀態與進度。
 *
 * 狀態優先級：error > loading > success > idle。
 * 進度 = 所有子節點進度的平均值（success 有 100，idle 為 0）。
 *
 * @param batchChildren - 子節點陣列（必須是已 resolve 的完整 CanvasNode 實體）。
 * @returns 彙總 status 與平均 progress（0–100）。
 */
export function getBatchStatusSummary(
  batchChildren: CanvasNode[],
): { status: CanvasNodeStatus; progress: number } {
  if (batchChildren.length === 0) {
    return { status: 'idle', progress: 0 };
  }

  let hasError = false;
  let hasLoading = false;
  let allSuccess = true;
  let progressSum = 0;
  let progressCount = 0;

  for (const child of batchChildren) {
    const s = child.metadata?.status;
    if (s === 'error') hasError = true;
    if (s === 'loading') hasLoading = true;
    if (s !== 'success') allSuccess = false;

    const p = child.metadata?.progress;
    if (typeof p === 'number' && Number.isFinite(p)) {
      progressSum += p;
      progressCount++;
    }
  }

  // 決定彙總 status
  let status: CanvasNodeStatus;
  if (hasError) {
    status = 'error';
  } else if (hasLoading) {
    status = 'loading';
  } else if (allSuccess) {
    status = 'success';
  } else {
    status = 'idle';
  }

  // 決定彙總 progress
  const progress =
    progressCount > 0
      ? Math.round(progressSum / progressCount)
      : status === 'success'
        ? 100
        : 0;

  return { status, progress };
}

/**
 * 計算批次子節點在畫布上的位置。
 *
 * 佈局策略：子節點排列在父節點右側，每行 BATCH_ROW_CAPACITY 個，
 * 超出換行。子節點尺寸取 Image 預設值（340×240）。
 *
 * @param parent - 批次父節點。
 * @param childIndex - 子節點在批次中的順序索引（0-based）。
 * @param _totalCount - 批次總數（用於控制換行，目前僅用於傳遞語意）。
 * @returns 子節點的左上角位置。
 */
export function computeBatchChildPosition(
  parent: CanvasNode,
  childIndex: number,
  _totalCount: number,
): CanvasPosition {
  const childSize = CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Image];
  const row = Math.floor(childIndex / BATCH_ROW_CAPACITY);
  const col = childIndex % BATCH_ROW_CAPACITY;

  return {
    x: parent.position.x + parent.width + BATCH_GAP_X + col * (childSize.width + BATCH_GAP_X),
    y: parent.position.y + row * (childSize.height + BATCH_GAP_Y),
  };
}

/** createBatchChildNode 的選項參數。 */
export interface CreateBatchChildNodeOptions {
  /** 子節點 id（預設為 `${parent.id}-b${childIndex}`） */
  id?: string;
  /** 子節點標題（預設為 `${parent.title} #${childIndex + 1}`） */
  title?: string;
  /** 額外的 metadata 覆蓋（會與預設值合併） */
  metadata?: Partial<CanvasNodeMetadata>;
  /** 強制指定子節點 type（預設 Image） */
  type?: CanvasNodeType;
}

/**
 * 建立一個批次子節點。
 *
 * 自動設定位置（由 computeBatchChildPosition 計算）、尺寸（取 Image 預設）、
 * metadata.content（圖片 URL）、batchIndex、batchTotal 及 status。
 *
 * @param parent - 批次父節點。
 * @param imageUrl - 圖片 URL（設為 metadata.content）。
 * @param childIndex - 子節點索引（0-based）。
 * @param totalCount - 批次總數。
 * @param options - 可選覆蓋參數。
 * @returns 完整的 CanvasNode 實體。
 */
export function createBatchChildNode(
  parent: CanvasNode,
  imageUrl: string,
  childIndex: number,
  totalCount: number,
  options?: CreateBatchChildNodeOptions,
): CanvasNode {
  const childSize = CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Image];
  const type = options?.type ?? CanvasNodeType.Image;

  const node: CanvasNode = {
    id: options?.id ?? `${parent.id}-b${childIndex}`,
    type,
    title: options?.title ?? `${parent.title} #${childIndex + 1}`,
    position: computeBatchChildPosition(parent, childIndex, totalCount),
    width: childSize.width,
    height: childSize.height,
    metadata: {
      content: imageUrl,
      batchIndex: childIndex,
      batchTotal: totalCount,
      status: 'success',
      ...options?.metadata,
    },
  };

  return node;
}
