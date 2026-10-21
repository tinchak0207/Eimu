import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";

export interface CanvasEmbedProps {
  /** useCanvasChat 的完整 return（chat 部分由宿主另外用，这里只用画布部分）。 */
  canvas: UseCanvasChatReturn;
  /** embed 高度；不传则撑满父容器。 */
  height?: string;
  /** 面板关闭（回到 ImageDisplay 模式）时触发。 */
  onClose?: () => void;
  /** 全屏展开态：顶部薄条改显示「收合」。 */
  expanded?: boolean;
  /** 展开/收合切换：compact 时显示「展开」、全屏时显示「收合」。 */
  onToggleExpand?: () => void;
}
