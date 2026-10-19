// node-view/constants —— CanvasNodeView 的类型/标签映射与手势常量。
// 纯资料，无副作用；符号名与迁移前一致（契约测试逐名断言）。

import type { CSSProperties } from "react";
import { CanvasNodeType, type CanvasNodeStatus } from "@/lib/canvas/types";

export const MIN_WIDTH = 120;
export const MIN_HEIGHT = 90;
/** 萤幕 px 死区：低于此距离视为点选而非拖动 */
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
  [CanvasNodeType.Director]: "3D 导演",
  [CanvasNodeType.Scene3d]: "3D 场景卡",
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
