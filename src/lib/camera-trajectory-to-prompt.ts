/**
 * Camera trajectory → 六槽公式 Camera 槽描述詞翻譯層。
 *
 * 把 3D 場景卡（scene_3d 節點）附帶的機位/運動種子——L1 director-engine 運鏡 id
 * 或 bpy 相機軌跡關鍵幀摘要——翻譯成 Seedance 六槽公式 Camera 槽的精確英文描述詞。
 * 反向映射表 = `skills/blender-director/seed-mapping.md` §1.2（21 運鏡對照）對
 * `src/lib/director-engine/cameraPresets.ts` CAMERA_MOVES（現場真源，20 個 id）的
 * 反向：id → prompt 語義（seed-mapping 正向是 id→bpy keyframe，此處反向 id→prompt）。
 *
 * 本檔為純函數層，不 import invisible-prompt-director（避免環）；注入規則本體在
 * invisible-prompt-director.directVideoPrompt 的 cameraRule 接線（≤10 行）。
 */

/** L1 運鏡 id（cameraPresets.ts CAMERA_MOVES）→ 六槽 Camera 槽精確描述詞。
 *  語義對齊 seed-mapping.md §1.2 每行的 bpy 落地方案（推近=location 沿視線、
 *  pan=rotation_euler[2]、orbit=父級空物體 0→360°、dollyzoom=lens 反向補償）。 */
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

/** bpy 相機軌跡關鍵幀摘要（Z-up 世界座標，Blender 原生朝向）。 */
export interface BpyCameraKeyframe {
  /** Blender 幀號。 */
  frame: number;
  /** 相機 world location（米，Z-up）。 */
  position?: [number, number, number];
  /** 相機 rotation_euler（度）。 */
  rotationEulerDeg?: [number, number, number];
}

/** 相機軌跡種子：L1 模板 id 或 bpy 軌跡摘要，任一在場即可翻譯。 */
export interface CameraTrajectory {
  /** L1 運鏡 id 清單（CAMERA_MOVES id，未知名忽略）。 */
  moves?: string[];
  /** bpy 相機 keyframe 摘要（≥2 幀才可推導運動方向）。 */
  keyframes?: BpyCameraKeyframe[];
  /** 焦距 mm（bpy camera.data.lens 或 L1 combo 數值）。 */
  focalLengthMm?: number;
  /** bpy 軌跡自由文本摘要（已是英文描述詞時逐字保留）。 */
  summary?: string;
}

/** 用戶「模糊鏡頭描述」偵測：形容詞＋鏡頭名詞的空話組合。
 *  只匹配這類短語才允許軌跡翻譯詞覆蓋 camera 槽；用戶點名具體運鏡詞
 * （dolly/pan/orbit/…，即 SLOT_PATTERNS.camera 的實義子集）= 明示，不干預。 */
const VAGUE_CAMERA_PHRASE =
  /\b(?:dynamic|dramatic|intense|cool|smooth|epic|nice)\s+(?:shot|camera|angle|move|movement|framing|work)\b/i;

/** bpy keyframe 路徑 → 運動方向描述詞（起末幀差分，確定性規則）。
 *  距離閾 15%、橫移/升降閾 0.2m、旋轉閾 30°/180°——與 seed-mapping §1.2
 *  的語義分檔（push/pull、truck/pedestal、pan/orbit）同構。 */
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

/** 軌跡 → 完整 Camera 槽描述詞（含 "Camera: " 前綴，形狀對齊
 *  invisible-prompt-director 的 SLOT_PATTERNS.camera 語彙面）。無可翻譯內容回空串。 */
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
  /** 注入/覆蓋六槽 Camera 槽的描述詞。 */
  directive: string;
}

/**
 * sceneCard 感知規則（最小干預）：
 * - 用戶 prompt 無 camera 槽 → 軌跡翻譯詞注入 Camera 槽（取代通用中性指令）。
 * - camera 槽在場且只出現模糊鏡頭短語（VAGUE_CAMERA_PHRASE）→ 軌跡翻譯詞覆蓋。
 * - camera 槽在場且用戶點名具體運鏡 → 回 null（用戶明示為準，零干預）。
 * 只影響 camera 槽；其餘五槽與品質鎖不動。
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
