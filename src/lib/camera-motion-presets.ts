/**
 * 运镜预设库（Camera Motion Presets）— 23 条互斥运镜 / 检索契约 / 工具绑定。
 *
 * 定位（与邻居的边界，禁造第二份轮子）：
 * - `lens-language-library.ts`（142 条 / 12 类）是**镜头语言词典**：分组词条、无
 *   toolId 绑定、无互斥切分，消费契约是「选词后拼片段」（composeLensFragment）。
 *   本档不是它的子集也不是替代品：这里每条是**一颗可选的运镜预设**（唯一 key +
 *   简体短标签 + 可执行运镜指令 + harness 工具 + 检索 tags），给导演台/Agent 当
 *   picker 与工具建议用；两者共存，互不引用（避免两种消费契约混成一团）。
 * - `camera-trajectory-to-prompt.ts` 是**轨迹 → 六槽 Camera 槽**翻译层，输入是
 *   moves/keyframes 座标，不是具名预设。本档**不重写**该翻译：最终组装一律走
 *   `describeCameraTrajectory()`（`cameraMotionPrompt` 内唯一呼叫的组装函式），
 *   本档也没有复制 `CAMERA_MOVE_TO_PROMPT` 任何一条字串（测试有防撞断言）。
 * - `director-engine/cameraPresets.ts` 的 CAMERA_MOVES 是 3D 导演台内部运镜 id
 *   （20 个），无中文标签/提示词/检索面；本档是对外的预设目录，语义可对齐、
 *   资料不复制。
 *
 * 文案来源：全部自写（无竞品字串、无具体作品镜头描述）。纯资料 + 纯函式，无 I/O。
 */

import { describeCameraTrajectory } from "./camera-trajectory-to-prompt";

/** 单条运镜预设。 */
export interface CameraMotionPreset {
  /** 全库唯一 id：kebab-case + `cm-` 前缀。 */
  readonly key: string;
  /** 简体中文短名（选择器主标题）。 */
  readonly name: string;
  /** 胶囊标签，≤4 字（含中文/表情符号按码位计）。 */
  readonly tagLabel: string;
  /**
   * 自写的可执行运镜指令（英文），描述「相机怎么动」，不含具体场景/人物，
   * 可被上游直接用；`cameraMotionPrompt()` 会把它交给既有翻译层组装。
   */
  readonly prompt: string;
  /** 建议在 harness 上落地此运镜的 toolId，必须 ∈ HARNESS_TOOL_ID_LIST。 */
  readonly toolId: string;
  /** 检索词（3-6 个）：中文同义词 + 少量英文术语。 */
  readonly tags: readonly string[];
}

/**
 * 23 条互斥运镜预设。互斥判准：任意两条的运动自由度（机位位移 / 光轴旋转 /
 * 焦距 / 焦点 / 时间）组合不同，且 tagLabel 两两不同（测试有断言）。
 */
export const CAMERA_MOTION_PRESETS: readonly CameraMotionPreset[] = [
  {
    key: "cm-fixed",
    name: "固定镜头",
    tagLabel: "固定",
    prompt:
      "tripod-locked frame: the camera never moves and the framing is identical from first frame to last, every bit of motion belongs to the subject and the environment",
    toolId: "director_set_camera_keyframe",
    tags: ["固定机位", "锁机位", "静止", "不动", "static"],
  },
  {
    key: "cm-dolly-in",
    name: "推轨",
    tagLabel: "推轨",
    prompt:
      "steady dolly-in along a straight track: the camera glides toward the subject, foreground elements sweep past the lens and the frame tightens step by step",
    toolId: "director_set_camera_keyframe",
    tags: ["推镜", "推进", "前进", "拉近", "dolly"],
  },
  {
    key: "cm-dolly-out",
    name: "拉远",
    tagLabel: "拉远",
    prompt:
      "smooth dolly-out pulling straight back from the subject, the frame opening wider and wider until the subject sits small inside the surrounding space",
    toolId: "director_set_camera_keyframe",
    tags: ["拉镜", "后退", "退出", "交代环境", "dolly"],
  },
  {
    key: "cm-truck",
    name: "横移",
    tagLabel: "横移",
    prompt:
      "lateral truck sliding sideways past the subject at a fixed distance, the camera never rotates and background layers parallax across the frame one after another",
    toolId: "director_set_camera_keyframe",
    tags: ["平移", "侧移", "轨道", "平行移动", "truck"],
  },
  {
    key: "cm-follow",
    name: "跟拍",
    tagLabel: "跟拍",
    prompt:
      "tracking follow shot locked onto the subject from behind, the camera matches its pace and keeps the same framing distance without ever losing the back of the head",
    toolId: "director_set_camera_keyframe",
    tags: ["跟随", "追踪", "追拍", "背影", "follow"],
  },
  {
    key: "cm-orbit",
    name: "环绕",
    tagLabel: "环绕",
    prompt:
      "smooth arc orbit circling the subject at a constant radius, the background rotating continuously behind while the subject stays centred in frame",
    toolId: "director_set_camera_keyframe",
    tags: ["绕拍", "弧线", "转圈", "orbit"],
  },
  {
    key: "cm-pedestal",
    name: "升降",
    tagLabel: "升降",
    prompt:
      "vertical pedestal move rising straight up at an even speed while the lens stays level on the subject, the eye line holding all the way to the top",
    toolId: "director_set_camera_keyframe",
    tags: ["上下", "垂直", "升起", "落降", "pedestal"],
  },
  {
    key: "cm-handheld",
    name: "手持",
    tagLabel: "手持",
    prompt:
      "handheld camera with live micro-shake and constant small corrections, documentary energy, the operator breathes with the subject instead of smoothing it out",
    toolId: "director_set_camera_keyframe",
    tags: ["抖动", "纪录感", "呼吸感", "近距离", "handheld"],
  },
  {
    key: "cm-crane",
    name: "摇臂",
    tagLabel: "摇臂",
    prompt:
      "sweeping crane move: the arm carries the camera up and over the scene in one continuous lift, ending on a high wide overview of the whole space",
    toolId: "director_set_camera_keyframe",
    tags: ["吊臂", "升降臂", "大范围", "俯视收尾", "crane"],
  },
  {
    key: "cm-aerial-dive",
    name: "俯冲",
    tagLabel: "俯冲",
    prompt:
      "aerial dive: the camera drops fast from high altitude straight toward the subject, the ground rushing up until the subject fills the frame",
    toolId: "director_set_camera_keyframe",
    tags: ["无人机", "高空滑落", "俯冲下降", "航拍", "aerial"],
  },
  {
    key: "cm-tilt-up",
    name: "仰拍抬升",
    tagLabel: "仰拍",
    prompt:
      "low tilt-and-rise: starting close and low on the subject, the camera tilts upward while easing back, letting the subject tower against the sky",
    toolId: "director_set_camera_keyframe",
    tags: ["仰角", "抬镜", "由低到高", "威压感", "tilt"],
  },
  {
    key: "cm-zoom-in",
    name: "变焦推近",
    tagLabel: "变焦",
    prompt:
      "optical zoom-in on a long lens: the field of view narrows and the background compresses flat while the camera body itself never moves an inch",
    toolId: "director_set_camera_keyframe",
    tags: ["推镜头", "长焦", "压空间", "zoom"],
  },
  {
    key: "cm-dolly-zoom",
    name: "希区柯克变焦",
    tagLabel: "眩晕变焦",
    prompt:
      "dolly zoom: the camera tracks backward while the lens zooms in at a matched rate, so the subject holds its size in frame while background perspective stretches violently",
    toolId: "director_set_camera_keyframe",
    tags: ["眩晕", "推拉变焦", "透视变形", "dolly zoom"],
  },
  {
    key: "cm-one-take",
    name: "一镜到底",
    tagLabel: "一镜到底",
    prompt:
      "single unbroken take with no cuts: the camera keeps travelling through the space in one continuous line, following the action from room to room until the final frame",
    toolId: "director_transport",
    tags: ["长镜头", "不剪辑", "连续", "穿行"],
  },
  {
    key: "cm-pov",
    name: "第一人称",
    tagLabel: "第一人称",
    prompt:
      "first-person POV: the lens sits at the character's eye height, hands or a held object entering the bottom of frame, head movement natural and unpolished",
    toolId: "director_set_camera_keyframe",
    tags: ["主观视角", "代入", "眼睛高度", "pov"],
  },
  {
    key: "cm-over-shoulder",
    name: "越肩",
    tagLabel: "越肩",
    prompt:
      "over-the-shoulder framing: the camera sits behind the foreground figure's shoulder, the shoulder soft in the lower frame, the opposite subject held sharp beyond",
    toolId: "director_set_camera_keyframe",
    tags: ["对话", "关系镜头", "前景肩背", "双人"],
  },
  {
    key: "cm-low-ground",
    name: "低角度贴地",
    tagLabel: "贴地",
    prompt:
      "ground-level low angle: the camera skims just above the floor and pushes forward, the subject looming huge overhead against the ceiling or the sky",
    toolId: "director_set_camera_keyframe",
    tags: ["贴地机位", "虫视", "低机位", "压迫感", "low angle"],
  },
  {
    key: "cm-aerial-top-down",
    name: "航拍俯视",
    tagLabel: "航拍",
    prompt:
      "top-down aerial hover: the camera looks straight down from a drone, the ground reads as a flat plane and the subject crosses the frame as a graphic shape",
    toolId: "director_set_camera_keyframe",
    tags: ["无人机", "正俯视", "上帝视角", "平面构图"],
  },
  {
    key: "cm-spiral-rise",
    name: "螺旋上升",
    tagLabel: "螺旋",
    prompt:
      "spiral ascent: the camera circles the subject while steadily climbing, tightening the radius near the top so the whole move reads as an upward helix",
    toolId: "director_set_camera_keyframe",
    tags: ["盘旋", "边转边升", "螺旋", "上升"],
  },
  {
    key: "cm-whip-pan",
    name: "甩镜",
    tagLabel: "甩镜",
    prompt:
      "fast whip pan: the camera snaps sideways in a fraction of a second, motion blur smears the whole transition, then the frame lands hard on the next subject",
    toolId: "director_set_camera_keyframe",
    tags: ["快摇", "转场", "动态模糊", "急甩", "whip pan"],
  },
  {
    key: "cm-timelapse",
    name: "延时",
    tagLabel: "延时",
    prompt:
      "locked-off timelapse: the camera holds still while hours of change compress into seconds, clouds light and crowds streaming across a fixed frame",
    toolId: "director_transport",
    tags: ["延时间隔", "时间压缩", "固定机位", "变化"],
  },
  {
    key: "cm-steadicam-walk",
    name: "稳定器走动",
    tagLabel: "稳定器",
    prompt:
      "gimbal walk: the operator advances at walking pace behind the subject, the horizon stays perfectly level and the move reads as weightless floating",
    toolId: "director_set_camera_keyframe",
    tags: ["稳定器", "云台", "匀速前行", "平滑"],
  },
  {
    key: "cm-rack-focus",
    name: "跟焦转焦",
    tagLabel: "跟焦",
    prompt:
      "rack focus pull: focus travels from the near object to the subject far away, or the reverse, the shift smooth decisive and timed to the beat of the action",
    toolId: "director_set_camera_keyframe",
    tags: ["移焦", "变焦点", "虚实转换", "focus pull"],
  },
];

/** 检索用文字堆：key / name / tagLabel / prompt / tags 联集（小写）。 */
function haystack(preset: CameraMotionPreset): string {
  return [preset.key, preset.name, preset.tagLabel, preset.prompt, ...preset.tags].join(" \u0001 ").toLowerCase();
}

/**
 * 列举/检索运镜预设（纯函式，零 I/O）。
 * - `query`：子字串命中 key/name/tagLabel/prompt/tags（不分大小写、去首尾空白）；空 = 不筛。
 * - `tag`：精确命中 tags 其中一个（不分大小写）；空 = 不筛。
 * - 无参数＝全库（逐位元等于 `CAMERA_MOTION_PRESETS`，顺序保留）。
 */
export function listCameraMotionPresets(
  opts: { query?: string; tag?: string } = {},
): readonly CameraMotionPreset[] {
  const query = typeof opts.query === "string" ? opts.query.trim().toLowerCase() : "";
  const tag = typeof opts.tag === "string" ? opts.tag.trim().toLowerCase() : "";
  if (!query && !tag) return CAMERA_MOTION_PRESETS;
  return CAMERA_MOTION_PRESETS.filter((preset) => {
    if (tag && !preset.tags.some((t) => t.toLowerCase() === tag)) return false;
    if (!query) return true;
    return haystack(preset).includes(query);
  });
}

/** 全库 tags 去重排序（API facet 用；与筛选结果无关）。 */
export function listCameraMotionPresetTags(): readonly string[] {
  const seen = new Set<string>();
  for (const preset of CAMERA_MOTION_PRESETS) {
    for (const tag of preset.tags) seen.add(tag);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

/** 依 key 取单条（未知 key 回 `null`，不抛、不猜同义词）。 */
export function getCameraMotionPreset(key: string): CameraMotionPreset | null {
  if (typeof key !== "string") return null;
  const normalized = key.trim().toLowerCase();
  if (!normalized) return null;
  return CAMERA_MOTION_PRESETS.find((preset) => preset.key === normalized) ?? null;
}

/**
 * 预设 + 镜头情境 → 最终提示词。
 *
 * 组装**一律**交给 `camera-trajectory-to-prompt.describeCameraTrajectory()`（本档
 * 不另写一套运镜/轨迹措辞逻辑）：把 preset.prompt 当「轨迹自由文本摘要」喂入，
 * 情境非空时以 `, <情境>` 接在摘要后段——故有/无情境的输出**差异只落在情境段**。
 * - 未知 key → `null`。
 * - 情境缺省/空字串/纯空白 → 逐位元等价退化（不注入空段、不加多余分隔符）。
 */
export function cameraMotionPrompt(key: string, shotContext?: string): string | null {
  const preset = getCameraMotionPreset(key);
  if (!preset) return null;
  const context = typeof shotContext === "string" ? shotContext.trim() : "";
  return describeCameraTrajectory({ summary: context ? `${preset.prompt}, ${context}` : preset.prompt });
}
