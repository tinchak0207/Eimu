/**
 * Camera trajectory → 六槽公式 Camera 槽描述词翻译层。
 *
 * 把 3D 场景卡（scene_3d 节点）附带的机位/运动种子——L1 director-engine 运镜 id
 * 或 bpy 相机轨迹关键帧摘要——翻译成 Seedance 六槽公式 Camera 槽的精确英文描述词。
 * 反向映射表 = `skills/blender-director/seed-mapping.md` §1.2（21 运镜对照）对
 * `src/lib/director-engine/cameraPresets.ts` CAMERA_MOVES（现场真源，20 个 id）的
 * 反向：id → prompt 语义（seed-mapping 正向是 id→bpy keyframe，此处反向 id→prompt）。
 *
 * 本档为纯函数层，不 import invisible-prompt-director（避免环）；注入规则本体在
 * invisible-prompt-director.directVideoPrompt 的 cameraRule 接线（≤10 行）。
 */

/** L1 运镜 id（cameraPresets.ts CAMERA_MOVES）→ 六槽 Camera 槽精确描述词。
 *  语义对齐 seed-mapping.md §1.2 每行的 bpy 落地方案（推近=location 沿视线、
 *  pan=rotation_euler[2]、orbit=父级空物体 0→360°、dollyzoom=lens 反向补偿）。 */
export const CAMERA_MOVE_TO_PROMPT: Readonly<Record<string, string>> = {
  "dolly-in": "slow dolly-in pushing toward the subject",
  "dolly-out": "slow dolly-out pulling back to reveal the environment",
  pan: "horizontal pan sweeping across the scene",
  tilt: "vertical tilt rising from low to high",
  truck: "lateral truck moving parallel to the subject",
  pedestal: "pedestal rise, the camera elevates to overlook the subject",
  orbit: "full 360-degree orbit around the subject",
  follow: "tracking follow shot locked on the subject, framing held stable",
  handheld: "handheld camera with subtle organic shake, documentary presence",
  steadicam: "steadicam glide, silky smooth long take",
  dollyzoom: "dolly zoom, the subject holds size while background space warps",
  whippan: "fast whip pan transition",
  crashzoom: "crash zoom snapping onto the subject in an instant",
  aerial: "aerial drone descent from high altitude down toward the subject",
  lowangle: "low-angle framing looking up, the subject towers",
  overshoulder: "over-the-shoulder framing",
  pov: "first-person POV framing",
  arc: "arc move circling the subject along a partial curve",
  slowpush: "extremely slow push-in ending on a close-up",
  static: "locked-off static frame, the action happens inside the composition",
};

/** bpy 相机轨迹关键帧摘要（Z-up 世界座标，Blender 原生朝向）。 */
export interface BpyCameraKeyframe {
  /** Blender 帧号。 */
  frame: number;
  /** 相机 world location（米，Z-up）。 */
  position?: [number, number, number];
  /** 相机 rotation_euler（度）。 */
  rotationEulerDeg?: [number, number, number];
}

/** 相机轨迹种子：L1 模板 id 或 bpy 轨迹摘要，任一在场即可翻译。 */
export interface CameraTrajectory {
  /** L1 运镜 id 清单（CAMERA_MOVES id，未知名忽略）。 */
  moves?: string[];
  /** bpy 相机 keyframe 摘要（≥2 帧才可推导运动方向）。 */
  keyframes?: BpyCameraKeyframe[];
  /** 焦距 mm（bpy camera.data.lens 或 L1 combo 数值）。 */
  focalLengthMm?: number;
  /** bpy 轨迹自由文本摘要（已是英文描述词时逐字保留）。 */
  summary?: string;
}

/** 用户「模糊镜头描述」侦测：形容词＋镜头名词的空话组合。
 *  只匹配这类短语才允许轨迹翻译词覆盖 camera 槽；用户点名具体运镜词
 * （dolly/pan/orbit/…，即 SLOT_PATTERNS.camera 的实义子集）= 明示，不干预。 */
const VAGUE_CAMERA_PHRASE =
  /\b(?:dynamic|dramatic|intense|cool|smooth|epic|nice)\s+(?:shot|camera|angle|move|movement|framing|work)\b/i;

/** bpy keyframe 路径 → 运动方向描述词（起末帧差分，确定性规则）。
 *  距离阈 15%、横移/升降阈 0.2m、旋转阈 30°/180°——与 seed-mapping §1.2
 *  的语义分档（push/pull、truck/pedestal、pan/orbit）同构。 */
function describeKeyframePath(kfs: BpyCameraKeyframe[]): string | null {
  const first = kfs[0];
  const last = kfs[kfs.length - 1];
  if (!first.position || !last.position) return null;
  const [x0, y0, z0] = first.position;
  const [x1, y1, z1] = last.position;
  const parts: string[] = [];
  const d0 = Math.hypot(x0, y0, z0);
  const d1 = Math.hypot(x1, y1, z1);
  if (d0 > 0 && d1 / d0 <= 0.85) parts.push("pushing in toward the subject");
  else if (d0 > 0 && d1 / d0 >= 1.15) parts.push("pulling back from the subject");
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const dz = Math.abs(z1 - z0);
  const lateral = Math.max(dx, dy);
  if (dz > 0.2 && dz >= lateral) {
    parts.push(z1 > z0 ? "rising vertically upward" : "descending vertically downward");
  } else if (lateral > 0.2) {
    parts.push("trucking laterally past the subject");
  }
  if (first.rotationEulerDeg && last.rotationEulerDeg) {
    const dRotZ = last.rotationEulerDeg[2] - first.rotationEulerDeg[2];
    const dRotX = Math.abs(last.rotationEulerDeg[0] - first.rotationEulerDeg[0]);
    if (Math.abs(dRotZ) >= 180) parts.push("orbiting around the subject");
    else if (Math.abs(dRotZ) >= 30) {
      parts.push(dRotZ > 0 ? "panning right across the scene" : "panning left across the scene");
    } else if (dRotX >= 20) parts.push("tilting vertically");
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/** 轨迹 → 完整 Camera 槽描述词（含 "Camera: " 前缀，形状对齐
 *  invisible-prompt-director 的 SLOT_PATTERNS.camera 语汇面）。无可翻译内容回空串。 */
export function describeCameraTrajectory(trajectory: CameraTrajectory): string {
  const phrases: string[] = [];
  for (const id of trajectory.moves ?? []) {
    const phrase = CAMERA_MOVE_TO_PROMPT[id.trim().toLowerCase()];
    if (phrase) phrases.push(phrase);
  }
  const path = trajectory.keyframes && trajectory.keyframes.length >= 2 ? describeKeyframePath(trajectory.keyframes) : null;
  if (path) phrases.push(path);
  const summary = trajectory.summary?.trim();
  if (summary) phrases.push(summary);
  if (phrases.length === 0) return "";
  const focal = trajectory.focalLengthMm && trajectory.focalLengthMm > 0 ? ` (${Math.round(trajectory.focalLengthMm)}mm lens)` : "";
  return `Camera: ${phrases.join(", then ")}${focal}, a single deliberate camera move, ending framed on the subject.`;
}

export interface SceneCameraRule {
  /** 注入/覆盖六槽 Camera 槽的描述词。 */
  directive: string;
}

/**
 * sceneCard 感知规则（最小干预）：
 * - 用户 prompt 无 camera 槽 → 轨迹翻译词注入 Camera 槽（取代通用中性指令）。
 * - camera 槽在场且只出现模糊镜头短语（VAGUE_CAMERA_PHRASE）→ 轨迹翻译词覆盖。
 * - camera 槽在场且用户点名具体运镜 → 回 null（用户明示为准，零干预）。
 * 只影响 camera 槽；其余五槽与品质锁不动。
 */
export function resolveSceneCameraRule(
  trajectory: CameraTrajectory,
  rawUserPrompt: string,
  cameraPresent: boolean,
): SceneCameraRule | null {
  const directive = describeCameraTrajectory(trajectory);
  if (!directive) return null;
  if (!cameraPresent) return { directive };
  return VAGUE_CAMERA_PHRASE.test(rawUserPrompt) ? { directive } : null;
}
