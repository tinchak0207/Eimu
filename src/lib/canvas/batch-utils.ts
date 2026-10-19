// 批次父子节点工具函式：批次管理、布局、建立子节点。
//
// 批次父节点是一个带 batchChildren 的 CanvasNode，展开时显示多个子图片
// 节点，收起时只显示 batchPrimaryImageId 指定的主图片。

import { CanvasNodeType, CANVAS_NODE_DEFAULT_SIZE } from '@/lib/canvas/types';
import type {
  CanvasNode,
  CanvasNodeMetadata,
  CanvasNodeStatus,
  CanvasPosition,
} from '@/lib/canvas/types';

/** 水平间距（子节点之间） */
const BATCH_GAP_X = 24;

/** 垂直间距（子节点换行时） */
const BATCH_GAP_Y = 24;

/** 每行最大子节点数 */
const BATCH_ROW_CAPACITY = 4;

/**
 * 判断节点是否为批次父节点（有 batchChildren 且非空）。
 * 纯粹的 JavaScript 检查：不处理 undefined 以外的边界情况。
 */
export function hasBatchChildren(node: CanvasNode): boolean {
  return !!node.batchChildren && node.batchChildren.length > 0;
}

/**
 * 汇总批次子节点的整体状态与进度。
 *
 * 状态优先级：error > loading > success > idle。
 * 进度 = 所有子节点进度的平均值（success 有 100，idle 为 0）。
 *
 * @param batchChildren - 子节点阵列（必须是已 resolve 的完整 CanvasNode 实体）。
 * @returns 汇总 status 与平均 progress（0–100）。
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

  // 决定汇总 status
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

  // 决定汇总 progress
  const progress =
    progressCount > 0
      ? Math.round(progressSum / progressCount)
      : status === 'success'
        ? 100
        : 0;

  return { status, progress };
}

/**
 * 计算批次子节点在画布上的位置。
 *
 * 布局策略：子节点排列在父节点右侧，每行 BATCH_ROW_CAPACITY 个，
 * 超出换行。子节点尺寸取 Image 预设值（340×240）。
 *
 * @param parent - 批次父节点。
 * @param childIndex - 子节点在批次中的顺序索引（0-based）。
 * @param _totalCount - 批次总数（用于控制换行，目前仅用于传递语意）。
 * @returns 子节点的左上角位置。
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

/** createBatchChildNode 的选项参数。 */
export interface CreateBatchChildNodeOptions {
  /** 子节点 id（预设为 `${parent.id}-b${childIndex}`） */
  id?: string;
  /** 子节点标题（预设为 `${parent.title} #${childIndex + 1}`） */
  title?: string;
  /** 额外的 metadata 覆盖（会与预设值合并） */
  metadata?: Partial<CanvasNodeMetadata>;
  /** 强制指定子节点 type（预设 Image） */
  type?: CanvasNodeType;
}

/**
 * 建立一个批次子节点。
 *
 * 自动设定位置（由 computeBatchChildPosition 计算）、尺寸（取 Image 预设）、
 * metadata.content（图片 URL）、batchIndex、batchTotal 及 status。
 *
 * @param parent - 批次父节点。
 * @param imageUrl - 图片 URL（设为 metadata.content）。
 * @param childIndex - 子节点索引（0-based）。
 * @param totalCount - 批次总数。
 * @param options - 可选覆盖参数。
 * @returns 完整的 CanvasNode 实体。
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
