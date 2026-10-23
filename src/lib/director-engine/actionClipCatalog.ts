/**
 * FilmAgent 式闭集词表：LLM/agent 只从枚举选 action / cameraMove；
 * 名单外 → Levenshtein 最近邻纠偏（return_most_similar 形态，自写 ≤40 行）。
 * Kaykit clip 映射复用 S1 clipMap，勿平行第二份。
 */
import type { DirectorActionId, DirectorCameraMove } from './types';
import { ACTION_TO_KAYKIT_CLIP, kaykitClipForAction } from './clipMap';
import { CAMERA_TEMPLATES } from './cameraTemplates';
import { MOTION_TEMPLATES } from './motionTemplates';

export { ACTION_TO_KAYKIT_CLIP, kaykitClipForAction };

/** 闭集动作 id（与 MOTION_TEMPLATES / DirectorActionId 对齐） */
export const CLOSED_ACTIONS: readonly DirectorActionId[] = MOTION_TEMPLATES.map((t) => t.id);

/** 闭集运镜（24 枚举，与 CAMERA_TEMPLATES 对齐） */
export const CLOSED_CAMERA_MOVES: readonly DirectorCameraMove[] = CAMERA_TEMPLATES.map((t) => t.id);

const ACTION_SET = new Set<string>(CLOSED_ACTIONS);
const CAMERA_SET = new Set<string>(CLOSED_CAMERA_MOVES);

/** 中文/别名 → 闭集 id（金样与 agent 口语） */
const ACTION_ALIASES: Record<string, DirectorActionId> = {
  冲刺: 'run-combat', 奔跑: 'run', 横斩: 'slash', 劈砍: 'chop', 斜劈: 'slash-diagonal',
  突刺: 'stab', 连斩: 'slash-combo', 回旋斩: 'slash-spin', 冲刺斩: 'run-combat',
  弧斩: 'slash-diagonal', 跳斩: 'jump-attack', 腾跃: 'jump', 空中翻身: 'flip-air',
  落地: 'land', 翻滚: 'roll', 闪避: 'dodge', 前闪: 'dodge-forward', 突进: 'dash',
  蓄力: 'charge', 命中反应: 'hit-react', 受击: 'hit-react', 击退: 'knockback',
  落地滑行: 'slide-land', 召唤: 'cast-summon', 结阵: 'cast-circle', 释放: 'cast-release',
  举剑: 'raise-sword', 喊招: 'shout', 冲击波: 'shockwave', 击飞: 'launch',
  擦血: 'wipe-blood', 蹲伏: 'crouch', 起身: 'stand-up', 转身: 'turn', 站立: 'stand',
  表情: 'look-at', 战斗待机: 'idle-combat',
};

const CAMERA_ALIASES: Record<string, DirectorCameraMove> = {
  track_follow: 'follow', 'handheld_shake+truck': 'handheld-intense',
  crane_up_follow: 'crane-up', 'crane_up(top_down)': 'crane-up',
  truck_lateral_follow: 'tracking', 'low_static→push': 'push',
  handheld_follow: 'handheld', slow_push: 'push', push_in: 'push',
  'handheld_follow+pull_out': 'pull', 'push_in+tilt_up': 'tilt-up',
  'tilt_up(上摇)': 'tilt-up', tilt_up: 'tilt-up', 'static→dolly_back': 'pull',
  orbit: 'orbit', follow: 'follow', push: 'push', pull: 'pull',
  handheld: 'handheld', tracking: 'tracking', static: 'static',
};

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

function mostSimilar(raw: string, closed: readonly string[]): string {
  const needle = raw.trim().toLowerCase().replace(/_/g, '-');
  let best = closed[0];
  let bestDist = Infinity;
  for (const id of closed) {
    const d = levenshtein(needle, id.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

/** FilmAgent return_most_similar：闭集内直返；别名表；否则最近邻 */
export function normalizeActionId(raw: string): DirectorActionId {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'stand';
  if (ACTION_SET.has(trimmed)) return trimmed as DirectorActionId;
  const lower = trimmed.toLowerCase().replace(/_/g, '-');
  if (ACTION_SET.has(lower)) return lower as DirectorActionId;
  if (trimmed in ACTION_ALIASES) return ACTION_ALIASES[trimmed];
  if (lower in ACTION_ALIASES) return ACTION_ALIASES[lower];
  return mostSimilar(lower, CLOSED_ACTIONS) as DirectorActionId;
}

export function normalizeCameraMove(raw: string): DirectorCameraMove {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'static';
  if (CAMERA_SET.has(trimmed)) return trimmed as DirectorCameraMove;
  const lower = trimmed.toLowerCase().replace(/_/g, '-');
  if (CAMERA_SET.has(lower)) return lower as DirectorCameraMove;
  if (trimmed in CAMERA_ALIASES) return CAMERA_ALIASES[trimmed];
  if (lower in CAMERA_ALIASES) return CAMERA_ALIASES[lower];
  // 复合串：取首个可匹配片段
  for (const [alias, id] of Object.entries(CAMERA_ALIASES)) {
    if (trimmed.includes(alias) || lower.includes(alias.replace(/_/g, '-'))) return id;
  }
  return mostSimilar(lower, CLOSED_CAMERA_MOVES) as DirectorCameraMove;
}

/** 纠偏前：不在闭集且无别名的原始串（FilmAgent find_unknown_actions） */
export function findUnknownActions(ids: string[]): string[] {
  return ids.filter((id) => {
    const trimmed = (id ?? '').trim();
    if (!trimmed) return false;
    if (ACTION_SET.has(trimmed) || ACTION_SET.has(trimmed.toLowerCase().replace(/_/g, '-'))) return false;
    if (trimmed in ACTION_ALIASES || trimmed.toLowerCase() in ACTION_ALIASES) return false;
    return true;
  });
}

export function findUnknownCameraMoves(ids: string[]): string[] {
  return ids.filter((id) => {
    const trimmed = (id ?? '').trim();
    if (!trimmed) return false;
    if (CAMERA_SET.has(trimmed) || CAMERA_SET.has(trimmed.toLowerCase().replace(/_/g, '-'))) return false;
    if (trimmed in CAMERA_ALIASES || trimmed.toLowerCase() in CAMERA_ALIASES) return false;
    return true;
  });
}
