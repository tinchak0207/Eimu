import { Crop, Eraser, Grid3X3, Rotate3D, RotateCw } from "lucide-react";

export type CanvasImageEditMode = "crop" | "split" | "mask" | "rotate" | "angle";

export interface CanvasImageEditResult {
  dataUrl: string;
  width: number;
  height: number;
  label: string;
}

export interface CanvasImageEditorDialogProps {
  open: boolean;
  imageUrl: string;
  nodeTitle: string;
  initialMode?: CanvasImageEditMode;
  onClose: () => void;
  /** 产出一或多张结果（切图多张，其余单张）。由宿主决定怎么落画布。 */
  onProduce: (results: CanvasImageEditResult[], mode: CanvasImageEditMode) => void;
  /**
   * 「角度」模式确认回调：不输出像素，由宿主按 anglePrompt（中文生图指令）
   * 走 AI 重绘。未提供时「角度」tab 不显示。
   */
  onRequestAngleGenerate?: (params: { yawDeg: number; pitchDeg: number; distance: number; anglePrompt: string }) => void;
  /**
   * 抠除的「AI 重绘」确认回调：maskDataUrl 为与原图同尺寸、涂抹区纯白不透明、
   * 其余透明的 PNG；instruction 为用户输入的一行指令。未提供时该选项不显示。
   */
  onRequestInpaint?: (params: { maskDataUrl: string; instruction: string }) => void;
}

export const MODE_TABS: { id: CanvasImageEditMode; label: string; icon: React.ReactNode }[] = [
  { id: "crop", label: "裁剪", icon: <Crop className="h-3.5 w-3.5" /> },
  { id: "split", label: "切图", icon: <Grid3X3 className="h-3.5 w-3.5" /> },
  { id: "mask", label: "抠除", icon: <Eraser className="h-3.5 w-3.5" /> },
  { id: "rotate", label: "旋转", icon: <RotateCw className="h-3.5 w-3.5" /> },
];

export const ANGLE_TAB: { id: CanvasImageEditMode; label: string; icon: React.ReactNode } = {
  id: "angle",
  label: "角度",
  icon: <Rotate3D className="h-3.5 w-3.5" />,
};

export const ASPECT_PRESETS: { label: string; ratio: number | null }[] = [
  { label: "自由", ratio: null },
  { label: "1:1", ratio: 1 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "3:4", ratio: 3 / 4 },
  { label: "16:9", ratio: 16 / 9 },
  { label: "9:16", ratio: 9 / 16 },
];

export type CropHandle = "nw" | "ne" | "sw" | "se" | "move";
export type SplitLineAxis = "x" | "y";

/** 均分线位：count 份 → count-1 条线（四舍五入到整数像素）。 */
export function evenLines(size: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  return Array.from({ length: n - 1 }, (_, i) => Math.round((size * (i + 1)) / n));
}

/** 拖动切割线：clamp 在相邻线（或图界）±8px 之间；空间不足时原地不动。 */
export function moveLineWithin(lines: number[], index: number, value: number, size: number): number[] {
  const min = (index > 0 ? lines[index - 1] : 0) + 8;
  const max = (index < lines.length - 1 ? lines[index + 1] : size) - 8;
  if (min > max) return lines;
  const next = [...lines];
  next[index] = Math.round(Math.min(max, Math.max(min, value)));
  return next;
}
