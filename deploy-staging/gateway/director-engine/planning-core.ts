/**
 * planning-core — 自 vendor agentPlanning.ts 拆出的純核（白名單④重命名移植）。
 * LLM 呼叫點切除，二期 quickChat 替換點；其餘逐行等價。
 *
 * 2026-09-03 暴君裁定白名單偏離：ACTION_KEYWORDS 加繁體變體，函數體不動。
 */
import { nanoid } from 'nanoid';
import type {
  DirectorActionId,
  DirectorActionClip,
  DirectorCameraMove,
  DirectorElement,
  DirectorPlan,
  DirectorSequenceShot,
  DirectorShotScale,
  Vec3,
} from './types';
import { createMotionKeyframes } from './motionTemplates';
import { cameraPatchFromTemplate } from './cameraTemplates';

interface RawAction {
  elementName?: string;
  action?: DirectorActionId;
  startSec?: number;
  durationSec?: number;
  moveX?: number;
  moveZ?: number;
}

interface RawShot {
  name?: string;
  primaryElementName?: string;
  durationSec?: number;
  cameraMove?: DirectorCameraMove;
  shotScale?: DirectorShotScale;
  cameraYawDeg?: number;
  cameraPitchDeg?: number;
  focalLengthMm?: number;
  actions?: RawAction[];
}

interface RawPlan { name?: string; summary?: string; shots?: RawShot[] }


/* ── 白名單切除：DirectorConsultMessage / DirectorAgentCommand——LLM 呼叫點切除，二期 quickChat 替換點 ── */
const CAMERA_MOVES = new Set<DirectorCameraMove>([
  'static', 'push', 'pull', 'truck-left', 'truck-right', 'crane-up', 'crane-down',
  'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'orbit', 'arc-left', 'arc-right',
  'follow', 'tracking', 'steadicam', 'handheld', 'handheld-intense', 'jib-up', 'jib-down',
  'zoom-in', 'zoom-out', 'dolly-zoom', 'whip-pan-left', 'whip-pan-right', 'roll-left', 'roll-right',
]);

const ACTIONS = new Set<DirectorActionId>([
  'stand', 'wait', 'walk', 'fast-walk', 'run', 'stop', 'sit', 'stand-up', 'turn',
  'look-back', 'crouch', 'kneel', 'lie-down', 'raise-hand', 'wave', 'point', 'pick-up',
  'put-down', 'push', 'pull', 'open-door', 'close-door', 'hug', 'face-to-face', 'pass-by',
  'follow', 'dodge', 'fall', 'get-up', 'enter-car', 'exit-car',
  'sew', 'read', 'write', 'speak', 'nod', 'shake-head', 'look-up', 'look-down', 'look-at', 'reach', 'hold',
  'idle-breathe', 'listen', 'hesitate', 'bow', 'cross-arms', 'hands-on-hips', 'clap', 'drink', 'phone',
  'hand-over', 'receive', 'step-back', 'step-forward', 'glance', 'inspect', 'knock',
]);

/* 2026-09-03 暴君裁定白名單偏離：ACTION_KEYWORDS 加繁體變體，函數體不動。
   逐詞對照 vendor 簡體原詞補同義繁寫（繁體緊跟原詞；同形詞如 展卷/步行/跪下 不重複），禁止發明新詞/新動作。 */
const ACTION_KEYWORDS: Array<{ action: DirectorActionId; pattern: RegExp }> = [
  { action: 'sew', pattern: /走针|走針|落针|落針|缝制|縫製|缝纫|縫紉|刺绣|刺繡|针线|針線|针尖.*布料|針尖.*布料|穿刺布料|针穿|針穿|丝线绷紧|絲線繃緊/ },
  { action: 'read', pattern: /阅读|閱讀|展卷|看卷|竹简上读|竹簡上讀|读它们|讀它們|山海图.*(?:读|看)|山海圖.*(?:讀|看)/ },
  { action: 'write', pattern: /书写|書寫|写字|寫字|记录|記錄|落笔|落筆/ },
  { action: 'look-up', pattern: /抬眼|抬头|抬頭|仰头|仰頭/ },
  { action: 'look-down', pattern: /低头|低頭|垂眼|俯视|俯視/ },
  { action: 'look-at', pattern: /看向|注视|注視|凝视|凝視|望向|目光.*移|盯着|盯著/ },
  { action: 'look-back', pattern: /回头|回頭|回望/ },
  { action: 'turn', pattern: /转身|轉身|转向|轉向/ },
  { action: 'open-door', pattern: /开门|開門|推门而入|推門而入/ },
  { action: 'close-door', pattern: /关门|關門/ },
  { action: 'stand-up', pattern: /起身|站起/ },
  { action: 'stop', pattern: /停下|顿住|頓住|停顿|停頓|悬停|懸停|静止|靜止/ },
  { action: 'sit', pattern: /坐下|落座/ },
  { action: 'run', pattern: /跑|冲|衝|逃/ },
  { action: 'fast-walk', pattern: /快走|疾走/ },
  { action: 'walk', pattern: /走进|走進|走向|走到|进入|進入|离开|離開|步行/ },
  { action: 'reach', pattern: /伸手|探手|手伸向|靠近.*手/ },
  { action: 'point', pattern: /指向|指着|指著|手指.*滑动|手指.*滑動|划过|劃過/ },
  { action: 'pick-up', pattern: /拿起|拾起|捡起|撿起/ },
  { action: 'put-down', pattern: /放下|搁下|擱下/ },
  { action: 'hold', pattern: /握住|托住|捧着|捧著|拿着|拿著|握紧|握緊/ },
  { action: 'nod', pattern: /点头|點頭/ },
  { action: 'shake-head', pattern: /摇头|搖頭/ },
  { action: 'wave', pattern: /挥手|揮手|招手/ },
  { action: 'raise-hand', pattern: /举手|舉手|抬手/ },
  { action: 'hug', pattern: /拥抱|擁抱|抱住/ },
  { action: 'face-to-face', pattern: /对视|對視|面对面|面對面/ },
  { action: 'kneel', pattern: /跪下|跪地/ },
  { action: 'crouch', pattern: /蹲下|俯身/ },
  { action: 'fall', pattern: /跌倒|摔倒|倒地/ },
  { action: 'speak', pattern: /说[：{]|說[：{]|回答|开口|開口|台词|台詞|问道|問道/ },
];

const ACTION_PRIORITY: Partial<Record<DirectorActionId, number>> = {
  sew: 100, read: 100, write: 100, speak: 95,
  walk: 90, 'fast-walk': 90, run: 90, 'open-door': 90, 'close-door': 90,
  'pick-up': 85, 'put-down': 85, reach: 85, hold: 85, point: 85,
  'look-up': 70, 'look-down': 70, 'look-at': 70, 'look-back': 70,
};

const SHOT_SCALES = new Set<DirectorShotScale>(['extreme-wide', 'wide', 'medium', 'medium-close', 'close-up', 'extreme-close-up']);

function applyRawCamera(shot: DirectorSequenceShot, raw: RawShot, elements: DirectorElement[]): DirectorSequenceShot {
  if (!SHOT_SCALES.has(raw.shotScale as DirectorShotScale) && raw.cameraYawDeg === undefined && raw.cameraPitchDeg === undefined) return shot;
  const scale = SHOT_SCALES.has(raw.shotScale as DirectorShotScale) ? raw.shotScale! : shot.shotScale ?? 'medium';
  const settings = ({
    'extreme-wide': { distance: 12, focal: 24, targetY: 0.9 }, wide: { distance: 7.5, focal: 35, targetY: 0.95 },
    medium: { distance: 4.8, focal: 50, targetY: 1.05 }, 'medium-close': { distance: 3.3, focal: 65, targetY: 1.2 },
    'close-up': { distance: 2.05, focal: 85, targetY: 1.43 }, 'extreme-close-up': { distance: 1.25, focal: 105, targetY: 1.53 },
  } as const)[scale];
  const primary = elements.find((element) => element.kind === 'mannequin' && raw.primaryElementName && (element.name === raw.primaryElementName || raw.primaryElementName.includes(element.name) || element.name.includes(raw.primaryElementName)))
    ?? elements.find((element) => element.kind === 'mannequin');
  const primaryPosition = primary ? shot.elementStates[primary.id]?.position ?? primary.position : { x: 0, y: 0, z: 0 };
  const target = { x: primaryPosition.x, y: settings.targetY, z: primaryPosition.z };
  const yawDeg = Math.max(-180, Math.min(180, Number(raw.cameraYawDeg) || 0));
  const pitchDeg = Math.max(-45, Math.min(75, Number(raw.cameraPitchDeg) || 0));
  const yaw = yawDeg * Math.PI / 180;
  const pitch = pitchDeg * Math.PI / 180;
  const horizontal = settings.distance * Math.cos(pitch);
  const position = { x: target.x + Math.sin(yaw) * horizontal, y: Math.max(0.35, target.y + Math.sin(pitch) * settings.distance), z: target.z + Math.cos(yaw) * horizontal };
  const focal = Math.max(18, Math.min(135, Number(raw.focalLengthMm) || settings.focal));
  const fov = (2 * Math.atan(24 / (2 * focal)) * 180) / Math.PI;
  return { ...shot, position, target, fov, focalLengthMm: focal, shotScale: scale, primaryElementId: primary?.id, recognition: { version: 2, confidence: 0.7, cameraYawDeg: yawDeg, cameraPitchDeg: pitchDeg } };
}

function parseJson(text: string): { plans?: RawPlan[] } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(source) as { plans?: RawPlan[] };
}

function promptShotSections(prompt: string): string[] {
  const matches = [...prompt.matchAll(/(?:^|\n)(镜头[^\n]*)([\s\S]*?)(?=\n镜头|\n\{|$)/g)];
  return matches.map((match) => `${match[1]}\n${match[2]}`.trim());
}

function alignRawPlanToPrompt(rawPlan: RawPlan, prompt: string): RawPlan {
  const sections = promptShotSections(prompt);
  if (sections.length === 0) return rawPlan;
  return {
    ...rawPlan,
    shots: sections.map((section, index) => {
      const sourceDuration = Number(section.match(/^镜头[^\n]*?\s(\d+(?:\.\d+)?)s\b/i)?.[1]);
      const sourceScale: DirectorShotScale | undefined = /微距|极近|大特写/.test(section) ? 'extreme-close-up'
        : /特写/.test(section) ? 'close-up'
          : /中近景/.test(section) ? 'medium-close'
            : /近景/.test(section) ? 'close-up'
              : /中景/.test(section) ? 'medium'
                : /远景|大全景/.test(section) ? 'extreme-wide'
                  : /全景/.test(section) ? 'wide' : undefined;
      const sourceMove: DirectorCameraMove | undefined = /前推|推近|推进/.test(section) ? 'push'
        : /拉远|后拉|缓拉/.test(section) ? 'pull'
          : /环绕/.test(section) ? 'orbit'
            : /跟随|跟拍/.test(section) ? 'follow'
              : /手持|肩扛/.test(section) ? 'handheld'
                : /固定/.test(section) ? 'static' : undefined;
      return {
        ...(rawPlan.shots?.[index] ?? {}),
        name: section.match(/^(镜头\S+)/)?.[1] ?? rawPlan.shots?.[index]?.name,
        durationSec: Number.isFinite(sourceDuration) ? sourceDuration : rawPlan.shots?.[index]?.durationSec,
        shotScale: sourceScale ?? rawPlan.shots?.[index]?.shotScale,
        cameraMove: sourceMove ?? rawPlan.shots?.[index]?.cameraMove,
      };
    }),
  };
}

function inferSectionActions(section: string, elements: DirectorElement[]): RawAction[] {
  const people = elements.filter((element) => element.kind === 'mannequin');
  const clauses = section.split(/[。！？；，,、\n]|——/).map((item) => item.trim()).filter(Boolean);
  const inferred: RawAction[] = [];
  // The first named person is normally the shot subject. Later names may only
  // describe an eyeline target or a foreground occluder, so they must not take
  // over the subject unless that same clause gives them an action.
  let activePerson = people.find((person) => section.indexOf(person.name) >= 0);
  for (const clause of clauses) {
    const matched = ACTION_KEYWORDS
      .map((rule) => ({ rule, index: clause.search(rule.pattern) }))
      .filter((item) => item.index >= 0)
      .sort((left, right) => (ACTION_PRIORITY[right.rule.action] ?? 80) - (ACTION_PRIORITY[left.rule.action] ?? 80) || left.index - right.index)[0];
    const mentions = people.map((person) => ({ person, index: clause.indexOf(person.name) })).filter((item) => item.index >= 0).sort((left, right) => left.index - right.index);
    if (!matched) continue;
    const subjectsBeforeAction = mentions.filter((item) => item.index <= matched.index).sort((left, right) => right.index - left.index);
    const person = subjectsBeforeAction[0]?.person ?? activePerson ?? mentions[0]?.person;
    if (!person) continue;
    activePerson = person;
    if (inferred.some((action) => action.elementName === person.name && action.action === matched.rule.action)) continue;
    const moving = ['walk', 'fast-walk', 'run', 'follow', 'pass-by', 'dodge'].includes(matched.rule.action);
    inferred.push({ elementName: person.name, action: matched.rule.action, startSec: Math.min(0.15 + inferred.length * 0.85, 3), durationSec: moving ? 2.4 : 1.5, moveX: moving ? 1.8 : 0, moveZ: 0 });
  }
  return inferred.slice(0, 5);
}

export function inferPromptActionsByShot(prompt: string, elements: DirectorElement[], shotCount: number): RawAction[][] {
  const sections = promptShotSections(prompt);
  if (sections.length > 0) return Array.from({ length: shotCount }, (_, index) => inferSectionActions(sections[index] ?? '', elements));
  const flat = inferSectionActions(prompt, elements);
  return Array.from({ length: shotCount }, (_, index) => flat[index] ? [flat[index]] : []);
}

export function inferPromptActions(prompt: string, elements: DirectorElement[]): RawAction[] {
  const sections = promptShotSections(prompt);
  return inferPromptActionsByShot(prompt, elements, Math.max(1, sections.length)).flat();
}

function ensurePlanActions(rawPlan: RawPlan, prompt: string, elements: DirectorElement[]): RawPlan {
  const hintsByShot = inferPromptActionsByShot(prompt, elements, Math.max(1, rawPlan.shots?.length ?? 0));
  const needsMeaningfulAction = promptImpliesCharacterAction(prompt);
  const validPersonName = (name?: string) => Boolean(name && elements.some((element) => element.kind === 'mannequin' && (name === element.name || name.includes(element.name) || element.name.includes(name))));
  return {
    ...rawPlan,
    shots: (rawPlan.shots ?? []).map((shot, index) => {
      const validActions = (shot.actions ?? []).filter((action) => ACTIONS.has(action.action as DirectorActionId) && validPersonName(action.elementName) && (!needsMeaningfulAction || (action.action !== 'stand' && action.action !== 'wait')));
      const sourceActions = hintsByShot[index] ?? [];
      const sourceMatches = sourceActions.filter((expected) => validActions.some((actual) => actual.action === expected.action && actual.elementName && expected.elementName && (actual.elementName === expected.elementName || actual.elementName.includes(expected.elementName) || expected.elementName.includes(actual.elementName))));
      const sourceCoverage = sourceActions.length > 0 ? sourceMatches.length / sourceActions.length : 1;
      const actions = sourceActions.length > 0 && sourceCoverage < 0.6 ? sourceActions : validActions;
      return {
        ...shot,
        primaryElementName: sourceActions[0]?.elementName ?? shot.primaryElementName,
        actions: actions.map((action) => ({ ...action, durationSec: Math.min(action.durationSec ?? 1.8, Math.max(0.5, Number(shot.durationSec) || 2)) })),
      };
    }),
  };
}

export function promptImpliesCharacterAction(prompt: string): boolean {
  return ACTION_KEYWORDS.some((rule) => rule.pattern.test(prompt));
}

function buildPlans(rawPlans: RawPlan[], base: DirectorPlan, elements: DirectorElement[]): DirectorPlan[] {
  return rawPlans.slice(0, 3).map((rawPlan, planIndex) => {
    let cursor = 0;
    const currentPositions = new Map(elements.map((element) => [element.id, { ...element.position }]));
    const shots = base.shots.map((baseShot, shotIndex) => {
      const raw = rawPlan.shots?.[shotIndex] ?? {};
      const durationSec = Math.max(0.5, Number(raw.durationSec) || baseShot.durationSec);
      const cameraMove = CAMERA_MOVES.has(raw.cameraMove as DirectorCameraMove) ? raw.cameraMove! : baseShot.cameraMove;
      const shotStartPositions = new Map([...currentPositions].map(([id, position]) => [id, { ...position }]));
      const workingPositions = new Map([...currentPositions].map(([id, position]) => [id, { ...position }]));
      let actions = (raw.actions ?? []).flatMap((item) => {
        const rawName = item.elementName?.trim() ?? '';
        const element = (rawName ? elements.find((candidate) => candidate.kind === 'mannequin' && (candidate.name === rawName || rawName.includes(candidate.name) || candidate.name.includes(rawName))) : undefined)
          ?? (elements.filter((candidate) => candidate.kind === 'mannequin').length === 1 ? elements.find((candidate) => candidate.kind === 'mannequin') : undefined);
        if (!element || !ACTIONS.has(item.action as DirectorActionId)) return [];
        const state = baseShot.elementStates[element.id];
        const from = { ...(workingPositions.get(element.id) ?? state?.position ?? element.position) };
        const action: DirectorActionClip = {
          id: `act-${nanoid(7)}`,
          elementId: element.id,
          action: item.action!,
          startSec: Math.max(0, Math.min(durationSec - 0.1, Number(item.startSec) || 0)),
          durationSec: Math.max(0.2, Math.min(durationSec, Number(item.durationSec) || Math.min(2.5, durationSec))),
          from,
          to: { x: from.x + (Number(item.moveX) || 0), y: from.y, z: from.z + (Number(item.moveZ) || 0) },
          templateId: item.action!,
          source: 'agent' as const,
          intensity: 1,
          keyframes: [],
        };
        action.keyframes = createMotionKeyframes(action.action, action.durationSec, action.from, action.to, 'agent');
        workingPositions.set(element.id, { ...action.to });
        return [action];
      });
      for (const element of elements) {
        let actionCursor = 0;
        actions.filter((action) => action.elementId === element.id).sort((a, b) => a.startSec - b.startSec).forEach((action) => {
          action.startSec = Math.max(action.startSec, actionCursor);
          action.durationSec = Math.min(action.durationSec, Math.max(0, durationSec - action.startSec));
          actionCursor = action.startSec + action.durationSec;
        });
      }
      actions = actions.filter((action) => action.startSec < durationSec - 0.05 && action.durationSec >= 0.15);
      const elementStates = Object.fromEntries(Object.entries(baseShot.elementStates).map(([id, state]) => [id, { ...state, position: { ...(shotStartPositions.get(id) ?? state.position) } }]));
      let shot: DirectorSequenceShot = {
        ...structuredClone(baseShot),
        id: `shot-${nanoid(7)}`,
        name: raw.name?.trim() || baseShot.name,
        startSec: cursor,
        durationSec,
        cameraMove,
        actions,
        elementStates,
      };
      shot = applyRawCamera(shot, raw, elements);
      workingPositions.forEach((position, id) => currentPositions.set(id, { ...position }));
      shot = { ...shot, ...cameraPatchFromTemplate(shot, cameraMove) };
      cursor += durationSec;
      return shot;
    });
    return {
      id: `plan-${nanoid(7)}`,
      name: rawPlan.name?.trim() || ['克制观察', '压迫跟随', '运动调度'][planIndex],
      summary: rawPlan.summary?.trim() || `${cursor.toFixed(1)} 秒 · ${shots.length} 镜`,
      createdAt: Date.now(),
      shots,
    };
  });
}

function preserveLockedEdits(generated: DirectorPlan[], base: DirectorPlan): DirectorPlan[] {
  return generated.map((plan) => ({
    ...plan,
    shots: plan.shots.map((shot, index) => {
      const source = base.shots[index];
      if (!source) return shot;
      const lockedActions = source.actions.filter((action) => action.locked || action.keyframes?.some((keyframe) => keyframe.locked));
      const actions = [
        ...shot.actions.filter((candidate) => !lockedActions.some((locked) => locked.elementId === candidate.elementId && candidate.startSec < locked.startSec + locked.durationSec && locked.startSec < candidate.startSec + candidate.durationSec)),
        ...structuredClone(lockedActions),
      ].sort((a, b) => a.startSec - b.startSec);
      const lockedCamera = source.cameraKeyframes?.filter((keyframe) => keyframe.locked) ?? [];
      const cameraKeyframes = lockedCamera.length ? [
        ...(shot.cameraKeyframes ?? []).filter((candidate) => !lockedCamera.some((locked) => Math.abs(locked.timeSec - candidate.timeSec) < 0.04)),
        ...structuredClone(lockedCamera),
      ].sort((a, b) => a.timeSec - b.timeSec) : shot.cameraKeyframes;
      return { ...shot, actions, cameraKeyframes };
    }),
  }));
}

// 測試閘導出（spec 片1+2 測試要求直接呼叫 fallbackPlans；vendor 原為私有，除此之外逐行等價）
export function fallbackPlans(base: DirectorPlan, elements: DirectorElement[], prompt: string): DirectorPlan[] {
  const hintsByShot = inferPromptActionsByShot(prompt, elements, base.shots.length);
  const shotActions = (index: number) => (hintsByShot[index] ?? []).map((hint) => ({ ...hint, startSec: Math.max(0.1, hint.startSec ?? 0.1) }));
  const raw: RawPlan[] = [
    { name: '克制观察', summary: `稳定机位与轻微推近 · ${prompt || '当前任务'}`, shots: base.shots.map((_, index) => ({ cameraMove: index % 2 ? 'push' : 'static', actions: shotActions(index) })) },
    { name: '压迫跟随', summary: `近距离跟随与手持呼吸 · ${prompt || '当前任务'}`, shots: base.shots.map((_, index) => ({ cameraMove: index % 2 ? 'handheld' : 'follow', actions: shotActions(index) })) },
    { name: '运动调度', summary: `横移、环绕与空间走位 · ${prompt || '当前任务'}`, shots: base.shots.map((_, index) => ({ cameraMove: index % 2 ? 'orbit' : 'truck-right', actions: shotActions(index) })) },
  ];
  return raw.map((plan) => {
    const complete = ensurePlanActions(alignRawPlanToPrompt(plan, prompt), prompt, elements);
    return buildPlans([complete], adaptBaseForMotion(base, complete), elements)[0];
  });
}

function adaptBaseForMotion(base: DirectorPlan, rawPlan: RawPlan): DirectorPlan {
  const count = Math.max(1, Math.min(8, rawPlan.shots?.length || base.shots.length || 4));
  const total = Math.max(1, planDuration(base));
  const duration = total / count;
  let cursor = 0;
  const shots = Array.from({ length: count }, (_, index) => {
    const source = structuredClone(base.shots[index % Math.max(1, base.shots.length)] ?? base.shots[0]);
    const rawDuration = Math.max(0.5, Number(rawPlan.shots?.[index]?.durationSec) || duration);
    const shot = { ...source, id: `shot-${nanoid(7)}`, startSec: cursor, durationSec: rawDuration, actions: [] } as DirectorSequenceShot;
    cursor += rawDuration;
    return shot;
  });
  return { ...base, shots };
}



/* ── 白名單切除：generateDirectorMotionDraftProposals / generateDirectorPlanProposals——LLM 呼叫點切除，二期 quickChat 替換點 ── */
function planDuration(plan: DirectorPlan): number {
  return plan.shots.reduce((sum, shot) => sum + shot.durationSec, 0);
}

/* ── 白名單切除：consultDirectorPlan——LLM 呼叫點切除，二期 quickChat 替換點 ── */
