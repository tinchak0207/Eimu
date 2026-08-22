// node-view/constants —— CanvasNodeView 的類型/標籤映射與手勢常量。
// 純資料，無副作用；符號名與遷移前一致（契約測試逐名斷言）。

import type { CSSProperties } from "react";
import { CanvasNodeType, type CanvasNodeStatus } from "@/lib/canvas/types";

export const MIN_WIDTH = 120;
export const MIN_HEIGHT = 90;
/** 螢幕 px 死區：低於此距離視為點選而非拖動 */
export const MOVE_THRESHOLD_PX = 5;

export const STATUS_COLOR: Record<CanvasNodeStatus, string> = {
  idle: "bg-black/20",
  success: "bg-ios-green",
  loading: "bg-ios-blue",
  error: "bg-destructive",
};

export const STATUS_LABEL: Record<CanvasNodeStatus, string> = {
  idle: "待处理",
  loading: "生成中…",
  success: "已完成",
  error: "失败",
};

export const TYPE_LABEL: Record<CanvasNodeType, string> = {
  [CanvasNodeType.Image]: "图片",
  [CanvasNodeType.Text]: "文本",
  [CanvasNodeType.Config]: "生成配置",
  [CanvasNodeType.Video]: "视频",
  [CanvasNodeType.Group]: "组",
  [CanvasNodeType.CharacterCard]: "角色卡",
  [CanvasNodeType.SceneCard]: "场景卡",
  [CanvasNodeType.Audio]: "音频",
  [CanvasNodeType.Prompt]: "提示词",
  [CanvasNodeType.Reference]: "参考图",
};

export interface ResizeCfg {
  moveX: boolean;
  moveY: boolean;
}

export const RESIZE_HANDLES: { id: string; pos: CSSProperties; cfg: ResizeCfg }[] = [
  { id: "nw", pos: { left: 0, top: 0, cursor: "nwse-resize" }, cfg: { moveX: true, moveY: true } },
  { id: "ne", pos: { right: 0, top: 0, cursor: "nesw-resize" }, cfg: { moveX: false, moveY: true } },
  { id: "sw", pos: { left: 0, bottom: 0, cursor: "nesw-resize" }, cfg: { moveX: true, moveY: false } },
  { id: "se", pos: { right: 0, bottom: 0, cursor: "nwse-resize" }, cfg: { moveX: false, moveY: false } },
];
