/**
 * S2 金样结构校验。仓库根执行：
 *   npx tsx docs/evidence/previs-harness-20261022/s2-golden/validate-golden.mts
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const planPath = resolve(root, 'docs/evidence/previs-harness-20261022/s2-golden/wuxia-cherry-plan.json');
const docPath = resolve(root, 'docs/evidence/previs-harness-20261022/s2-golden/wuxia-cherry-doc.json');

// 用 pathToFileURL + 仓库内相对入口（tsx 对「从 package 根相对 import」才暴露 named export）
const catUrl = pathToFileURL(resolve(root, 'src/lib/director-engine/actionClipCatalog.ts')).href;
const planUrl = pathToFileURL(resolve(root, 'src/lib/director-engine/planning-core.ts')).href;

// 通过子进程绕过 absolute-fileURL 的 CJS interop：改写为 cwd 相对 runner
import { spawnSync } from 'node:child_process';
const runner = `
import { readFileSync } from 'node:fs';
import { CLOSED_ACTIONS, CLOSED_CAMERA_MOVES, normalizeActionId, normalizeCameraMove } from './src/lib/director-engine/actionClipCatalog.ts';
import { compileReferenceWuxiaPlan } from './src/lib/director-engine/planning-core.ts';

const planPath = ${JSON.stringify(planPath)};
const docPath = ${JSON.stringify(docPath)};
const CAMERA_SET = new Set(CLOSED_CAMERA_MOVES);
const ACTION_SET = new Set(CLOSED_ACTIONS);
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const plan = compileReferenceWuxiaPlan(planPath);
assert(plan.id && plan.name && Array.isArray(plan.shots), 'plan meta');
assert(plan.shots.length >= 10 && plan.shots.length <= 22, 'A2 shotCount ' + plan.shots.length);

let cursor = 0;
const moves = new Set();
const scales = new Set();
let slowSec = 0;
let attackCount = 0;
const attackIds = new Set(['slash','chop','stab','jump-attack','slash-spin','slash-diagonal','slash-combo','dash','run-combat','shockwave','launch']);

for (const shot of plan.shots) {
  assert(typeof shot.startSec === 'number' && typeof shot.durationSec === 'number', shot.id + ' time');
  assert(shot.durationSec >= 0.4, shot.id + ' too short');
  assert(shot.cameraEnd?.position && shot.cameraEnd?.target, shot.id + ' cameraEnd');
  assert(CAMERA_SET.has(shot.cameraMove), shot.id + ' cameraMove ' + shot.cameraMove);
  assert(shot.elementStates && typeof shot.elementStates === 'object', shot.id + ' elementStates');
  assert(Array.isArray(shot.actions), shot.id + ' actions');
  for (const a of shot.actions) {
    assert(ACTION_SET.has(a.action), shot.id + ' action ' + a.action);
    assert(a.elementId && a.from && a.to, shot.id + '/' + a.id + ' clip fields');
    if (attackIds.has(a.action)) attackCount += 1;
  }
  moves.add(shot.cameraMove);
  if (shot.shotScale) scales.add(shot.shotScale);
  if (typeof shot.timeScale === 'number' && shot.timeScale < 1) slowSec += shot.durationSec;
  cursor = Math.max(cursor, shot.startSec + shot.durationSec);
}

const total = cursor;
assert(total >= 26 && total <= 34, 'A1 total ' + total);
const avg = total / plan.shots.length;
assert(avg >= 1.3 && avg <= 3.0, 'A3 avg ' + avg);
const longest = Math.max(...plan.shots.map((s) => s.durationSec));
assert(longest >= 2.5 && longest <= 5.0, 'A4 longest ' + longest);
assert(moves.size >= 4 && moves.size <= 7, 'A5 moves ' + moves.size + ' ' + [...moves]);
assert(scales.size >= 4 && scales.size <= 6, 'A6 scales ' + scales.size);
assert(scales.has('close-up'), 'A6 need close-up');
assert([...scales].some((s) => s === 'wide' || s === 'extreme-wide'), 'A6 need wide');
const slowRatio = slowSec / total;
assert(slowSec >= 0.8 && slowRatio >= 0.05 && slowRatio <= 0.2, 'A7 slow ' + slowSec + 's ' + slowRatio);
assert(attackCount >= 12 && attackCount <= 30, 'A8 attacks ' + attackCount);
assert(normalizeActionId('横斩') === 'slash', 'alias slash');
assert(ACTION_SET.has(normalizeActionId('slahs')), 'levenshtein');
assert(CAMERA_SET.has(normalizeCameraMove('track_follow')), 'cam alias');
const doc = JSON.parse(readFileSync(docPath, 'utf8'));
assert(doc.version === 2 && doc.plans?.[0]?.id === plan.id, 'doc wraps plan');
assert(doc.elements?.some((e) => e.id === 'hero'), 'doc hero');
console.log(JSON.stringify({
  ok: true, planPath, shotCount: plan.shots.length, totalSec: total,
  moves: [...moves], scales: [...scales], slowSec, attackCount,
  closedActions: CLOSED_ACTIONS.length, closedCameras: CLOSED_CAMERA_MOVES.length,
}, null, 2));
`;

const r = spawnSync('npx', ['tsx', '-e', runner], { cwd: root, encoding: 'utf8', env: process.env });
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(r.status ?? 1);
}
process.stdout.write(r.stdout);
