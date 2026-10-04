/**
 * Expert 注册表（MOE 改革波 0-A 地基，2026-09-08）。
 *
 * 设计真源：docs/expert-constitution-draft.md 卷三「波 0 落地映射」——
 * 本档承担「能力断路」落点：域工具白名单 + task-type 映射 + 交付物契约声明，
 * 后续波 1 由 gateway 拦截（本片只做注册表地基，不接 gateway）。
 *
 * 轮子血缘（禁自造轮子铁律）：
 *   - proto-Expert = src/lib/blender-director-persona.ts：director3d 行的
 *     身份/工具白名单/配方库路径/回覆 token 帽全部 import 该档常量，禁止复制值。
 *   - 交付物契约栏 = src/lib/blender-delegate.ts 的 BLENDER_DELIVERABLES
 *     （import，勿手抄）。
 *   - 结构范式 = src/lib/harness-tool-registry.ts（常量导出 + 测试守卫）。
 *
 * 野兽模式：BEAST_MODE_SETTINGS_KEY 默认 OFF（readBeastMode 缺栏位/非布林
 * 一律 false = 现状零变化）；ON 才允许下游按 routeExpert 启用 Expert 路由。
 * Wave2 收口（2026-09-08）：注册表七行全部启用；09-15 critic 行翻正启用
 * （部署片删 provisioned，同兄弟行不设该键），注册表八行全激活、无占位行，
 * routeExpert 的占位排除分支保留为防回归门禁。
 */

import {
  DIRECTOR_PERSONA_LABEL,
  DIRECTOR_PERSONA_DESCRIPTION,
  DIRECTOR_PERSONA_TOOL_IDS,
  DIRECTOR_PERSONA_SKILL_PATH,
  DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./blender-director-persona";
import {
  MUSIC_DIRECTOR_PERSONA_LABEL,
  MUSIC_DIRECTOR_PERSONA_DESCRIPTION,
  MUSIC_DIRECTOR_PERSONA_TOOL_IDS,
  MUSIC_DIRECTOR_PERSONA_SKILL_PATH,
  MUSIC_DIRECTOR_PERSONA_SKILL_FILES_PATH,
  MUSIC_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./music-director-persona";
import { BLENDER_DELIVERABLES } from "./blender-delegate";
import { MUSIC_DELIVERABLES } from "./music-delegate";
import {
  VIDEO_DIRECTOR_PERSONA_LABEL,
  VIDEO_DIRECTOR_PERSONA_DESCRIPTION,
  VIDEO_DIRECTOR_PERSONA_TOOL_IDS,
  VIDEO_DIRECTOR_PERSONA_SKILL_PATHS,
  VIDEO_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./video-director-persona";
import { VIDEO_DELIVERABLES } from "./video-delegate";
import {
  EDITOR_PERSONA_LABEL,
  EDITOR_PERSONA_DESCRIPTION,
  EDITOR_PERSONA_TOOL_IDS,
  EDITOR_PERSONA_SKILL_PATHS,
  EDITOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./editor-persona";
import { EDITOR_DELIVERABLES } from "./editor-delegate";
import {
  SCREENWRITER_PERSONA_LABEL,
  SCREENWRITER_PERSONA_DESCRIPTION,
  SCREENWRITER_PERSONA_TOOL_IDS,
  SCREENWRITER_PERSONA_SKILL_PATHS,
  SCREENWRITER_REPLY_SUMMARY_TOKEN_CAP,
} from "./screenwriter-persona";
import { SCREENWRITER_DELIVERABLES } from "./screenwriter-delegate";
import {
  MOTION_DIRECTOR_PERSONA_LABEL,
  MOTION_DIRECTOR_PERSONA_DESCRIPTION,
  MOTION_DIRECTOR_PERSONA_TOOL_IDS,
  MOTION_DIRECTOR_PERSONA_SKILL_PATHS,
  MOTION_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./motion-director-persona";
import { MOTION_DELIVERABLES } from "./motion-delegate";
import {
  WEB3D_DIRECTOR_PERSONA_LABEL,
  WEB3D_DIRECTOR_PERSONA_DESCRIPTION,
  WEB3D_DIRECTOR_PERSONA_TOOL_IDS,
  WEB3D_DIRECTOR_PERSONA_SKILL_PATHS,
  WEB3D_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./web3d-director-persona";
import { WEB3D_DELIVERABLES } from "./web3d-delegate";
import {
  CRITIC_PERSONA_LABEL,
  CRITIC_PERSONA_DESCRIPTION,
  CRITIC_PERSONA_TOOL_IDS,
  CRITIC_PERSONA_SKILL_PATHS,
  CRITIC_REPLY_SUMMARY_TOKEN_CAP,
} from "./critic-persona";
import { CRITIC_DELIVERABLES } from "./critic-delegate";

// ─────────────────────────────────────────── 野兽模式 toggle

/** 设定键（settings 记录中的栏位名；缺栏位 = OFF = 现状零迁移）。 */
export const BEAST_MODE_SETTINGS_KEY = "beast_mode" as const;

/**
 * 读取野兽模式开关：settings 记录中 beast_mode 栏位为布林 true 才返回 true。
 * 缺栏位 / 非布林 / settings 本身非物件 = false（默认 OFF，零迁移）。
 */
export function readBeastMode(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  return (settings as Record<string, unknown>)[BEAST_MODE_SETTINGS_KEY] === true;
}

// ─────────────────────────────────────────── Expert 定义

/** 单个 Expert 的注册表行（能力断路 / 路由 / 交付闸三件套的声明面）。 */
export interface ExpertDef {
  /** 注册表键与 id 一致（gateway bindings / 日志统一用此 id）。 */
  id: string;
  /** 展示名（简体文案，记忆 agent-gateway-copy-rules）。 */
  label: string;
  /** 一句话定位（设定页/选单/派遣 spec 用）。 */
  description: string;
  /** 域工具白名单（能力断路依据：域外工具不存在于该 Expert 的工具表）。 */
  toolIds: readonly string[];
  /** must-load 配方库路径（进 Expert 即载，不是「高兴才查」）。 */
  skillPaths: readonly string[];
  /** 路由键（routeExpert 按精确/前缀匹配）。 */
  taskTypes: readonly string[];
  /** 交付物契约（缺栏位/缺 QC 签名 = 组装闸门不过 = 视为未交付）。 */
  deliverableContract: {
    requiredFields: readonly string[];
    qcSignatureRequired: boolean;
  };
  /** 回覆 token 帽（隔离铁律：过程不出 subagent，摘要限长）。 */
  replyTokenCap: number;
  /** true = 占位未启用（野兽模式 ON 时也不可路由，routeExpert 不返回）。 */
  provisioned?: boolean;
}

// ─────────────────────────────────────────── 注册表

/**
 * Expert 注册表（键 = ExpertDef.id；首行 director3d 为 proto-Expert 轮子行，
 * 全部契约值 import 自 blender-director-persona / blender-delegate，零复制）。
 */
export const EXPERT_REGISTRY: Readonly<Record<string, ExpertDef>> = {
  director3d: {
    id: "director3d",
    label: DIRECTOR_PERSONA_LABEL,
    description: DIRECTOR_PERSONA_DESCRIPTION,
    toolIds: DIRECTOR_PERSONA_TOOL_IDS,
    skillPaths: [DIRECTOR_PERSONA_SKILL_PATH],
    taskTypes: ["3d", "blender", "scene_3d"],
    deliverableContract: {
      requiredFields: BLENDER_DELIVERABLES,
      qcSignatureRequired: true,
    },
    replyTokenCap: DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
  },
  music: {
    id: "music",
    label: MUSIC_DIRECTOR_PERSONA_LABEL,
    description: MUSIC_DIRECTOR_PERSONA_DESCRIPTION,
    toolIds: MUSIC_DIRECTOR_PERSONA_TOOL_IDS,
    skillPaths: [MUSIC_DIRECTOR_PERSONA_SKILL_PATH, MUSIC_DIRECTOR_PERSONA_SKILL_FILES_PATH],
    taskTypes: ["music", "song", "bgm", "mv_theme", "theme_song"],
    deliverableContract: {
      requiredFields: MUSIC_DELIVERABLES,
      qcSignatureRequired: true,
    },
    replyTokenCap: MUSIC_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
  },

  // ─────────────────────────────────────── Wave2 收口翻正式（2026-09-08）
  //
  // 五行全部按 director3d/music 先例 import 各 persona/delegate 常量（零复制），
  // 删 provisioned 正式启用（野兽模式 ON 时 routeExpert 可按 taskTypes 命中）。
  "video-director": {
    id: "video-director",
    label: VIDEO_DIRECTOR_PERSONA_LABEL,
    description: VIDEO_DIRECTOR_PERSONA_DESCRIPTION,
    // 域工具白名单 = persona 常量（video_quote/video_upload/last_frame_video_chain
    // + 报价对偶 image_quote，全在 harness 真源）。
    // video_gen 无现成 harness 工具：generation 通路待接线（缺口如实保留）。
    toolIds: VIDEO_DIRECTOR_PERSONA_TOOL_IDS,
    // skills/ 无视频导演域配方库 → persona 常量置空（skill 待补）。
    skillPaths: VIDEO_DIRECTOR_PERSONA_SKILL_PATHS,
    taskTypes: ["video", "video_gen", "shot_video", "film_clip"],
    deliverableContract: {
      requiredFields: VIDEO_DELIVERABLES,
      qcSignatureRequired: true,
    },
    replyTokenCap: VIDEO_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
  },
  "editor": {
    id: "editor",
    label: EDITOR_PERSONA_LABEL,
    description: EDITOR_PERSONA_DESCRIPTION,
    toolIds: EDITOR_PERSONA_TOOL_IDS,
    // skills/ 无剪辑域配方库 → persona 常量置空（skill 待补）。
    skillPaths: EDITOR_PERSONA_SKILL_PATHS,
    taskTypes: ["editing", "timeline", "cut", "film_assembly"],
    deliverableContract: {
      requiredFields: EDITOR_DELIVERABLES,
      qcSignatureRequired: true,
    },
    replyTokenCap: EDITOR_REPLY_SUMMARY_TOKEN_CAP,
  },
  "screenwriter": {
    id: "screenwriter",
    label: SCREENWRITER_PERSONA_LABEL,
    description: SCREENWRITER_PERSONA_DESCRIPTION,
    toolIds: SCREENWRITER_PERSONA_TOOL_IDS,
    // skills/ 无编剧域配方库 → persona 常量置空（skill 待补）。
    skillPaths: SCREENWRITER_PERSONA_SKILL_PATHS,
    taskTypes: ["screenplay", "storyboard", "script", "story_beats"],
    deliverableContract: {
      requiredFields: SCREENWRITER_DELIVERABLES,
      qcSignatureRequired: true,
    },
    replyTokenCap: SCREENWRITER_REPLY_SUMMARY_TOKEN_CAP,
  },
  "motion-director": {
    id: "motion-director",
    label: MOTION_DIRECTOR_PERSONA_LABEL,
    description: MOTION_DIRECTOR_PERSONA_DESCRIPTION,
    toolIds: MOTION_DIRECTOR_PERSONA_TOOL_IDS,
    // skills/motion-design/ 无域根 SKILL.md → 指域目录（2026-09-07 配方库索引先例）。
    skillPaths: MOTION_DIRECTOR_PERSONA_SKILL_PATHS,
    taskTypes: ["motion", "motion_design", "animation"],
    deliverableContract: {
      requiredFields: MOTION_DELIVERABLES,
      qcSignatureRequired: true,
    },
    replyTokenCap: MOTION_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
  },
  "web3d-director": {
    id: "web3d-director",
    label: WEB3D_DIRECTOR_PERSONA_LABEL,
    description: WEB3D_DIRECTOR_PERSONA_DESCRIPTION,
    toolIds: WEB3D_DIRECTOR_PERSONA_TOOL_IDS,
    skillPaths: WEB3D_DIRECTOR_PERSONA_SKILL_PATHS,
    taskTypes: ["web3d", "three_js", "interactive_3d"],
    deliverableContract: {
      requiredFields: WEB3D_DELIVERABLES,
      qcSignatureRequired: true,
    },
    replyTokenCap: WEB3D_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
  },

  // ─────────────────────────────────────── 09-15 评测补课片 → 翻正：critic 激活行
  //
  // 独立审核 Expert（质量闸）：裁定背景 = 评测实案 Orchestrator 自产自验
  // 0 次 QC / 0 次驳回（REPORT 见 eval-2026-op-theme/）。原 provisioned: true
  // 占位（routeExpert 跳过、digest 标「未启用」挡死路由）已于 09-15 翻正部署片
  // 删除该键，与七个可路由兄弟行逐栏同构（不设 provisioned = 激活可路由）。契约四栏
  // critic-delegate 常量（09-15 翻正接线片换挂）：CRITIC_DELIVERABLES 为该清单
  // 唯一真源，registry 行 / persona re-export / contracts 产物三处引用同一数组，
  // 零手抄第二份（同 director3d…web3d 各行 import 各 delegate 常量先例）。
  critic: {
    id: "critic",
    label: CRITIC_PERSONA_LABEL,
    description: CRITIC_PERSONA_DESCRIPTION,
    // 能力断路：只给 search_web web 查证，不给任何生成工具（persona 常量真源）。
    toolIds: CRITIC_PERSONA_TOOL_IDS,
    // skills/ 无审核域配方库 → persona 常量置空（skill 待补，照实现「未配置」惯例）。
    skillPaths: CRITIC_PERSONA_SKILL_PATHS,
    taskTypes: ["review", "audit", "critique", "quality_gate"],
    deliverableContract: {
      requiredFields: CRITIC_DELIVERABLES,
      qcSignatureRequired: true,
    },
    replyTokenCap: CRITIC_REPLY_SUMMARY_TOKEN_CAP,
  },
};

// ─────────────────────────────────────────── 路由与能力断路

/** 前缀匹配的边界符：防止「3dx」误命中「3d」、「musical」误命中「music」。 */
const TASK_TYPE_PREFIX_BOUNDARIES = new Set(["-", "_", ".", "/", ":"]);

/**
 * 按 taskType 路由 Expert：精确匹配优先、其次边界前缀匹配
 * （如 "blender_render" 命中 "blender"）。provisioned 行一律跳过不返回；
 * 无命中返回 null（= 留在 Orchestrator 本体，零变化）。
 */
export function routeExpert(taskType: string): ExpertDef | null {
  const requested = taskType.trim();
  if (!requested) return null;
  for (const expert of Object.values(EXPERT_REGISTRY)) {
    if (expert.provisioned) continue;
    for (const entry of expert.taskTypes) {
      if (requested === entry) return expert;
      if (
        requested.startsWith(entry) &&
        TASK_TYPE_PREFIX_BOUNDARIES.has(requested.charAt(entry.length))
      ) {
        return expert;
      }
    }
  }
  return null;
}

/**
 * 能力断路判定：Expert 是否持有某工具（域外工具不存在于其工具表）。
 * 未注册的 expertId 一律 false。注册但 provisioned 的行不在此拦
 * （占位不可路由是 routeExpert 的门禁职责，本函数只判工具白名单）。
 */
export function assertExpertToolAccess(expertId: string, toolId: string): boolean {
  const expert = EXPERT_REGISTRY[expertId];
  if (!expert) return false;
  return expert.toolIds.includes(toolId);
}
