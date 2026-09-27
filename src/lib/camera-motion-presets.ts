/**
 * 運鏡預設庫（Camera Motion Presets）— 23 條互斥運鏡 / 檢索契約 / 工具綁定。
 *
 * 定位（與鄰居的邊界，禁造第二份輪子）：
 * - `lens-language-library.ts`（142 條 / 12 類）是**鏡頭語言詞典**：分組詞條、無
 *   toolId 綁定、無互斥切分，消費契約是「選詞後拼片段」（composeLensFragment）。
 *   本檔不是它的子集也不是替代品：這裡每條是**一顆可選的運鏡預設**（唯一 key +
 *   簡體短標籤 + 可執行運鏡指令 + harness 工具 + 檢索 tags），給導演台/Agent 當
 *   picker 與工具建議用；兩者共存，互不引用（避免兩種消費契約混成一團）。
 * - `camera-trajectory-to-prompt.ts` 是**軌跡 → 六槽 Camera 槽**翻譯層，輸入是
 *   moves/keyframes 座標，不是具名預設。本檔**不重寫**該翻譯：最終組裝一律走
 *   `describeCameraTrajectory()`（`cameraMotionPrompt` 內唯一呼叫的組裝函式），
 *   本檔也沒有複製 `CAMERA_MOVE_TO_PROMPT` 任何一條字串（測試有防撞斷言）。
 * - `director-engine/cameraPresets.ts` 的 CAMERA_MOVES 是 3D 導演台內部運鏡 id
 *   （20 個），無中文標籤/提示詞/檢索面；本檔是對外的預設目錄，語義可對齊、
 *   資料不複製。
 *
 * 文案來源：全部自寫（無競品字串、無具體作品鏡頭描述）。純資料 + 純函式，無 I/O。
 */

import { describeCameraTrajectory } from "./camera-trajectory-to-prompt";

/** 單條運鏡預設。 */
export interface CameraMotionPreset {
  /** 全庫唯一 id：kebab-case + `cm-` 前綴。 */
  readonly key: string;
  /** 簡體中文短名（選擇器主標題）。 */
  readonly name: string;
  /** 膠囊標籤，≤4 字（含中文/表情符號按碼位計）。 */
  readonly tagLabel: string;
  /**
   * 自寫的可執行運鏡指令（英文），描述「相機怎麼動」，不含具體場景/人物，
   * 可被上游直接用；`cameraMotionPrompt()` 會把它交給既有翻譯層組裝。
   */
  readonly prompt: string;
  /** 建議在 harness 上落地此運鏡的 toolId，必須 ∈ HARNESS_TOOL_ID_LIST。 */
  readonly toolId: string;
  /** 檢索詞（3-6 個）：中文同義詞 + 少量英文術語。 */
  readonly tags: readonly string[];
}

/**
 * 23 條互斥運鏡預設。互斥判準：任意兩條的運動自由度（機位位移 / 光軸旋轉 /
 * 焦距 / 焦點 / 時間）組合不同，且 tagLabel 兩兩不同（測試有斷言）。
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

/** 檢索用文字堆：key / name / tagLabel / prompt / tags 聯集（小寫）。 */
function haystack(preset: CameraMotionPreset): string {
  return [preset.key, preset.name, preset.tagLabel, preset.prompt, ...preset.tags].join(" \u0001 ").toLowerCase();
}

/**
 * 列舉/檢索運鏡預設（純函式，零 I/O）。
 * - `query`：子字串命中 key/name/tagLabel/prompt/tags（不分大小寫、去首尾空白）；空 = 不篩。
 * - `tag`：精確命中 tags 其中一個（不分大小寫）；空 = 不篩。
 * - 無參數＝全庫（逐位元等於 `CAMERA_MOTION_PRESETS`，順序保留）。
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

/** 全庫 tags 去重排序（API facet 用；與篩選結果無關）。 */
export function listCameraMotionPresetTags(): readonly string[] {
  const seen = new Set<string>();
  for (const preset of CAMERA_MOTION_PRESETS) {
    for (const tag of preset.tags) seen.add(tag);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

/** 依 key 取單條（未知 key 回 `null`，不拋、不猜同義詞）。 */
export function getCameraMotionPreset(key: string): CameraMotionPreset | null {
  if (typeof key !== "string") return null;
  const normalized = key.trim().toLowerCase();
  if (!normalized) return null;
  return CAMERA_MOTION_PRESETS.find((preset) => preset.key === normalized) ?? null;
}

/**
 * 預設 + 鏡頭情境 → 最終提示詞。
 *
 * 組裝**一律**交給 `camera-trajectory-to-prompt.describeCameraTrajectory()`（本檔
 * 不另寫一套運鏡/軌跡措辭邏輯）：把 preset.prompt 當「軌跡自由文本摘要」餵入，
 * 情境非空時以 `, <情境>` 接在摘要後段——故有/無情境的輸出**差異只落在情境段**。
 * - 未知 key → `null`。
 * - 情境缺省/空字串/純空白 → 逐位元等價退化（不注入空段、不加多餘分隔符）。
 */
export function cameraMotionPrompt(key: string, shotContext?: string): string | null {
  const preset = getCameraMotionPreset(key);
  if (!preset) return null;
  const context = typeof shotContext === "string" ? shotContext.trim() : "";
  return describeCameraTrajectory({ summary: context ? `${preset.prompt}, ${context}` : preset.prompt });
}
