/**
 * sceneCard × 相機軌跡 → 視頻生成融合層（Astra 3D 導演工作站 P2 視頻嵌合，片AC，2026-09-06）。
 *
 * 只調用片 Z 成品（禁改契約）：
 * - blender-to-video-bridge.buildSceneFrameReferenceCard：sceneCard stills → GenerationReference
 * - camera-trajectory-to-prompt.describeCameraTrajectory：軌跡 → 六槽 Camera 槽描述詞
 *
 * 職責 = 寬容解析（unknown → 契約形 | null）＋融合。任何形狀不合/缺欄回 null，
 * 呼叫方以 null 短路 = 零行為變化（絕不因髒欄位阻斷視頻生成）。
 *
 * 軌跡來源裁定（片 AC）：sceneCard 六欄不含軌跡（片 Z 裁定不動雙白名單契約）——
 * 軌跡由調用方顯式傳遞：agent 工具調用時從會話上下文（3D 導演回傳摘要的 L1 move id）
 * 填入 camera_trajectory；C 端請求 body 同名欄位直傳。不從 canvas 節點反查（造解引用 =
 * 新增 gateway 依賴，違最小侵入）。
 */

import { buildSceneFrameReferenceCard, type SceneFrameReferenceCard } from "./blender-to-video-bridge";
import { describeCameraTrajectory, type CameraTrajectory } from "./camera-trajectory-to-prompt";
import type { Scene3dCardMetadata } from "./canvas/types";

/** 融合產物：DirectorOptions 直通對（sceneCard/cameraTrajectory）＋參考卡＋Camera 詞。 */
export interface SceneVideoFusion {
  sceneCard: Scene3dCardMetadata;
  cameraTrajectory: CameraTrajectory;
  /** sceneCard stills → 參考卡（i2v 首/尾幀通道 cap 2；previz 檔 compositionOnly）。 */
  frameCard: SceneFrameReferenceCard;
  /** 軌跡 → 完整 Camera 槽描述詞（含 "Camera: " 前綴；不可翻譯時為空串）。 */
  cameraDirective: string;
}

/** sceneCard 寬容解析：物件且 stills_urls 為字串陣列才收（六欄其餘欄位由 bridge notes 兜底）。 */
export function parseSceneCard(value: unknown): Scene3dCardMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const card = value as Record<string, unknown>;
  if (!Array.isArray(card.stills_urls) || card.stills_urls.some((item) => typeof item !== "string")) {
    return null;
  }
  return value as Scene3dCardMetadata;
}

/** 相機軌跡寬容解析：moves / keyframes / summary 任一在場即可翻譯（camera-trajectory-to-prompt 契約）。 */
export function parseCameraTrajectory(value: unknown): CameraTrajectory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const trajectory = value as CameraTrajectory;
  const hasMoves = Array.isArray(trajectory.moves) && trajectory.moves.length > 0;
  const hasKeyframes = Array.isArray(trajectory.keyframes) && trajectory.keyframes.length > 0;
  const hasSummary = typeof trajectory.summary === "string" && trajectory.summary.trim() !== "";
  return hasMoves || hasKeyframes || hasSummary ? trajectory : null;
}

/**
 * 融合入口：sceneCard＋cameraTrajectory 同時在場（且形狀合法）才產融合物件，
 * 缺一 = null（與 invisible-prompt-director 的 cameraRule 門控同構：兩者在場才生效）。
 */
export function fuseSceneVideo(sceneCard: unknown, cameraTrajectory: unknown): SceneVideoFusion | null {
  const card = parseSceneCard(sceneCard);
  const trajectory = parseCameraTrajectory(cameraTrajectory);
  if (!card || !trajectory) return null;
  return {
    sceneCard: card,
    cameraTrajectory: trajectory,
    frameCard: buildSceneFrameReferenceCard({ sceneCard: card }),
    cameraDirective: describeCameraTrajectory(trajectory),
  };
}
