/**
 * DirectorActionId → Kaykit Skeleton_* AnimationClip 名。
 * 资产：.asset-cache/kaykit-skeletons/.../Skeleton_{Warrior,Mage,Rogue,Minion}.glb（95 clips）。
 * 无专用 clip 的日常动作回落到 Idle / Walking / Running 等最近似项。
 */
import type { DirectorActionId } from './types';

export const ACTION_TO_KAYKIT_CLIP: Record<DirectorActionId, string> = {
  stand: 'Idle',
  wait: 'Idle',
  'idle-breathe': 'Idle_B',
  walk: 'Walking_A',
  'fast-walk': 'Walking_B',
  run: 'Running_A',
  stop: 'Idle',
  sit: 'Sit_Floor_Down',
  'stand-up': 'Sit_Floor_StandUp',
  turn: 'Idle',
  'look-back': 'Idle',
  crouch: 'Block',
  kneel: 'Sit_Floor_Pose',
  'lie-down': 'Lie_Down',
  'raise-hand': 'Cheer',
  wave: 'Cheer',
  point: 'Idle_Combat',
  'pick-up': 'PickUp',
  'put-down': 'PickUp',
  push: 'Interact',
  pull: 'Interact',
  'open-door': 'Interact',
  'close-door': 'Interact',
  hug: 'Idle',
  'face-to-face': 'Idle_Combat',
  'pass-by': 'Walking_A',
  follow: 'Walking_A',
  dodge: 'Dodge_Left',
  fall: 'Death_A',
  'get-up': 'Lie_StandUp',
  'enter-car': 'Walking_A',
  'exit-car': 'Walking_A',
  sew: 'Idle',
  read: 'Idle',
  write: 'Idle',
  speak: 'Idle_Combat',
  nod: 'Idle',
  'shake-head': 'Idle',
  'look-up': 'Idle',
  'look-down': 'Idle',
  'look-at': 'Idle_Combat',
  reach: 'Interact',
  hold: 'Idle_Combat',
  listen: 'Idle_Combat',
  hesitate: 'Idle_B',
  bow: 'Idle',
  'cross-arms': 'Idle',
  'hands-on-hips': 'Idle_Combat',
  clap: 'Cheer',
  drink: 'Use_Item',
  phone: 'Use_Item',
  'hand-over': 'Interact',
  receive: 'Interact',
  'step-back': 'Walking_Backwards',
  'step-forward': 'Walking_A',
  glance: 'Idle',
  inspect: 'Idle_Combat',
  knock: 'Interact',
  // 打斗追加（S1）
  slash: '1H_Melee_Attack_Slice_Horizontal',
  chop: '1H_Melee_Attack_Chop',
  stab: '1H_Melee_Attack_Stab',
  'jump-attack': '1H_Melee_Attack_Jump_Chop',
  'dodge-forward': 'Dodge_Forward',
  'hit-react': 'Hit_A',
  'idle-combat': 'Idle_Combat',
  'run-combat': 'Running_B',
  // S2 武侠金样补齐
  'slash-spin': '2H_Melee_Attack_Spin',
  'slash-diagonal': '1H_Melee_Attack_Slice_Diagonal',
  'slash-combo': 'Dualwield_Melee_Attack_Slice',
  jump: 'Jump_Full_Short',
  'flip-air': 'Jump_Full_Long',
  land: 'Jump_Land',
  roll: 'Dodge_Forward',
  dash: 'Dodge_Forward',
  charge: 'Idle_Combat',
  knockback: 'Hit_B',
  'slide-land': 'Dodge_Backward',
  'cast-summon': 'Spellcast_Summon',
  'cast-circle': 'Spellcast_Long',
  'cast-release': 'Spellcast_Shoot',
  'raise-sword': 'Spellcast_Raise',
  shout: 'Taunt',
  shockwave: 'Spellcast_Shoot',
  launch: 'Hit_B',
  'wipe-blood': 'Interact',
};


export function kaykitClipForAction(action: DirectorActionId, clipName?: string): string | null {
  if (clipName && clipName.trim()) return clipName.trim();
  return ACTION_TO_KAYKIT_CLIP[action] ?? null;
}

/** 适合 LoopRepeat 的动作（待机/走跑） */
const LOOPABLE_ACTIONS = new Set<DirectorActionId>([
  'stand', 'wait', 'idle-breathe', 'idle-combat',
  'walk', 'fast-walk', 'run', 'run-combat', 'follow',
]);

export function isKaykitLoopableAction(action: DirectorActionId): boolean {
  return LOOPABLE_ACTIONS.has(action) || Boolean(ACTION_TO_KAYKIT_CLIP[action] && (
    ACTION_TO_KAYKIT_CLIP[action].startsWith('Idle')
    || ACTION_TO_KAYKIT_CLIP[action].startsWith('Walking')
    || ACTION_TO_KAYKIT_CLIP[action].startsWith('Running')
  ));
}
