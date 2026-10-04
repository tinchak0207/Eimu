/**
 * sceneCard × 相机轨迹 → 视频生成融合层（Astra 3D 导演工作站 P2 视频嵌合，片AC，2026-09-06）。
 *
 * 只调用片 Z 成品（禁改契约）：
 * - blender-to-video-bridge.buildSceneFrameReferenceCard：sceneCard stills → GenerationReference
 * - camera-trajectory-to-prompt.describeCameraTrajectory：轨迹 → 六槽 Camera 槽描述词
 *
 * 职责 = 宽容解析（unknown → 契约形 | null）＋融合。任何形状不合/缺栏回 null，
 * 呼叫方以 null 短路 = 零行为变化（绝不因脏栏位阻断视频生成）。
 *
 * 轨迹来源裁定（片 AC）：sceneCard 六栏不含轨迹（片 Z 裁定不动双白名单契约）——
 * 轨迹由调用方显式传递：agent 工具调用时从会话上下文（3D 导演回传摘要的 L1 move id）
 * 填入 camera_trajectory；C 端请求 body 同名栏位直传。不从 canvas 节点反查（造解引用 =
 * 新增 gateway 依赖，违最小侵入）。
 */

import { buildSceneFrameReferenceCard, type SceneFrameReferenceCard } from "./blender-to-video-bridge";
import { describeCameraTrajectory, type CameraTrajectory } from "./camera-trajectory-to-prompt";
import type { Scene3dCardMetadata } from "./canvas/types";

/** 融合产物：DirectorOptions 直通对（sceneCard/cameraTrajectory）＋参考卡＋Camera 词。 */
export interface SceneVideoFusion {
  sceneCard: Scene3dCardMetadata;
  cameraTrajectory: CameraTrajectory;
  /** sceneCard stills → 参考卡（i2v 首/尾帧通道 cap 2；previz 档 compositionOnly）。 */
  frameCard: SceneFrameReferenceCard;
  /** 轨迹 → 完整 Camera 槽描述词（含 "Camera: " 前缀；不可翻译时为空串）。 */
  cameraDirective: string;
}

/** sceneCard 宽容解析：物件且 stills_urls 为字串阵列才收（六栏其余栏位由 bridge notes 兜底）。 */
export function parseSceneCard(value: unknown): Scene3dCardMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const card = value as Record<string, unknown>;
  if (!Array.isArray(card.stills_urls) || card.stills_urls.some((item) => typeof item !== "string")) {
    return null;
  }
  return value as Scene3dCardMetadata;
}

/** 相机轨迹宽容解析：moves / keyframes / summary 任一在场即可翻译（camera-trajectory-to-prompt 契约）。 */
export function parseCameraTrajectory(value: unknown): CameraTrajectory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const trajectory = value as CameraTrajectory;
  const hasMoves = Array.isArray(trajectory.moves) && trajectory.moves.length > 0;
  const hasKeyframes = Array.isArray(trajectory.keyframes) && trajectory.keyframes.length > 0;
  const hasSummary = typeof trajectory.summary === "string" && trajectory.summary.trim() !== "";
  return hasMoves || hasKeyframes || hasSummary ? trajectory : null;
}

/**
 * 融合入口：sceneCard＋cameraTrajectory 同时在场（且形状合法）才产融合物件，
 * 缺一 = null（与 invisible-prompt-director 的 cameraRule 门控同构：两者在场才生效）。
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
