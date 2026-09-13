/**
 * Expert 註冊表（MOE 改革波 0-A 地基，2026-09-08）。
 *
 * 設計真源：docs/expert-constitution-draft.md 卷三「波 0 落地映射」——
 * 本檔承擔「能力斷路」落點：域工具白名單 + task-type 映射 + 交付物契約聲明，
 * 後續波 1 由 gateway 攔截（本片只做註冊表地基，不接 gateway）。
 *
 * 輪子血緣（禁自造輪子鐵律）：
 *   - proto-Expert = src/lib/blender-director-persona.ts：director3d 行的
 *     身份/工具白名單/配方庫路徑/回覆 token 帽全部 import 該檔常量，禁止複製值。
 *   - 交付物契約欄 = src/lib/blender-delegate.ts 的 BLENDER_DELIVERABLES
 *     （import，勿手抄）。
 *   - 結構範式 = src/lib/harness-tool-registry.ts（常量導出 + 測試守衛）。
 *
 * 野獸模式：BEAST_MODE_SETTINGS_KEY 默認 OFF（readBeastMode 缺欄位/非布林
 * 一律 false = 現狀零變化）；ON 才允許下游按 routeExpert 啟用 Expert 路由。
 * Wave2 收口（2026-09-08）：註冊表七行全部啟用（無 provisioned 佔位行），
 * routeExpert 的佔位排除分支保留為防回歸門禁。
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

// ─────────────────────────────────────────── 野獸模式 toggle

/** 設定鍵（settings 記錄中的欄位名；缺欄位 = OFF = 現狀零遷移）。 */
export const BEAST_MODE_SETTINGS_KEY = "beast_mode" as const;

/**
 * 讀取野獸模式開關：settings 記錄中 beast_mode 欄位為布林 true 才返回 true。
 * 缺欄位 / 非布林 / settings 本身非物件 = false（默認 OFF，零遷移）。
 */
export function readBeastMode(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  return (settings as Record<string, unknown>)[BEAST_MODE_SETTINGS_KEY] === true;
}

// ─────────────────────────────────────────── Expert 定義

/** 單個 Expert 的註冊表行（能力斷路 / 路由 / 交付閘三件套的聲明面）。 */
export interface ExpertDef {
  /** 註冊表鍵與 id 一致（gateway bindings / 日誌統一用此 id）。 */
  id: string;
  /** 展示名（簡體文案，記憶 agent-gateway-copy-rules）。 */
  label: string;
  /** 一句話定位（設定頁/選單/派遣 spec 用）。 */
  description: string;
  /** 域工具白名單（能力斷路依據：域外工具不存在於該 Expert 的工具表）。 */
  toolIds: readonly string[];
  /** must-load 配方庫路徑（進 Expert 即載，不是「高興才查」）。 */
  skillPaths: readonly string[];
  /** 路由鍵（routeExpert 按精確/前綴匹配）。 */
  taskTypes: readonly string[];
  /** 交付物契約（缺欄位/缺 QC 簽名 = 組裝閘門不過 = 視為未交付）。 */
  deliverableContract: {
    requiredFields: readonly string[];
    qcSignatureRequired: boolean;
  };
  /** 回覆 token 帽（隔離鐵律：過程不出 subagent，摘要限長）。 */
  replyTokenCap: number;
  /** true = 佔位未啟用（野獸模式 ON 時也不可路由，routeExpert 不返回）。 */
  provisioned?: boolean;
}

// ─────────────────────────────────────────── 註冊表

/**
 * Expert 註冊表（鍵 = ExpertDef.id；首行 director3d 為 proto-Expert 輪子行，
 * 全部契約值 import 自 blender-director-persona / blender-delegate，零複製）。
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
  // 五行全部按 director3d/music 先例 import 各 persona/delegate 常量（零複製），
  // 刪 provisioned 正式啟用（野獸模式 ON 時 routeExpert 可按 taskTypes 命中）。
  "video-director": {
    id: "video-director",
    label: VIDEO_DIRECTOR_PERSONA_LABEL,
    description: VIDEO_DIRECTOR_PERSONA_DESCRIPTION,
    // 域工具白名單 = persona 常量（video_quote/video_upload/last_frame_video_chain
    // + 報價對偶 image_quote，全在 harness 真源）。
    // video_gen 無現成 harness 工具：generation 通路待接線（缺口如實保留）。
    toolIds: VIDEO_DIRECTOR_PERSONA_TOOL_IDS,
    // skills/ 無視頻導演域配方庫 → persona 常量置空（skill 待補）。
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
    // skills/ 無剪輯域配方庫 → persona 常量置空（skill 待補）。
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
    // skills/ 無編劇域配方庫 → persona 常量置空（skill 待補）。
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
    // skills/motion-design/ 無域根 SKILL.md → 指域目錄（2026-09-07 配方庫索引先例）。
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
};

// ─────────────────────────────────────────── 路由與能力斷路

/** 前綴匹配的邊界符：防止「3dx」誤命中「3d」、「musical」誤命中「music」。 */
const TASK_TYPE_PREFIX_BOUNDARIES = new Set(["-", "_", ".", "/", ":"]);

/**
 * 按 taskType 路由 Expert：精確匹配優先、其次邊界前綴匹配
 * （如 "blender_render" 命中 "blender"）。provisioned 行一律跳過不返回；
 * 無命中返回 null（= 留在 Orchestrator 本體，零變化）。
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
 * 能力斷路判定：Expert 是否持有某工具（域外工具不存在於其工具表）。
 * 未註冊的 expertId 一律 false。註冊但 provisioned 的行不在此攔
 * （佔位不可路由是 routeExpert 的門禁職責，本函數只判工具白名單）。
 */
export function assertExpertToolAccess(expertId: string, toolId: string): boolean {
  const expert = EXPERT_REGISTRY[expertId];
  if (!expert) return false;
  return expert.toolIds.includes(toolId);
}
