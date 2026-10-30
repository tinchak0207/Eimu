// steer-core.test.ts —— REQ-D2 steer 语义的具名回归测试（纯逻辑，无网关依赖）。
//
// 四组具名断言对应验收清单：
//   ① steer 入队顺序   ② 超限拒绝   ③ 停止优先于 steer   ④ 无 steer 时行为等价
// 跑法（必带超时，见记忆 2026-09-23-test-suite-hang-blender-e2e）：
//   timeout 240 npx tsx --test deploy-staging/gateway/steer-core.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  STEER_MAX_QUEUE,
  STEER_MAX_CHARS,
  STEER_QUEUE_TTL_MS,
  abortIsUserStop,
  enqueueSteer,
  gateSteerAcceptance,
  isValidSteerId,
  normalizeSteerText,
  planSteerFlush,
  steerBatchText,
  steerFrameIds,
  type PendingSteer,
} from "./steer-core.ts";

const NOW = 1_760_000_000_000;

/** 依序入队一串文本，回传最终队列（模拟 gateway state.pendingSteers 的 append）。 */
function enqueueAll(texts: string[]): { queue: PendingSteer[]; results: ReturnType<typeof enqueueSteer>[] } {
  let queue: PendingSteer[] = [];
  const results: ReturnType<typeof enqueueSteer>[] = [];
  texts.forEach((text, i) => {
    const outcome = enqueueSteer(queue, text, { now: NOW + i, id: `steer-${i}` });
    results.push(outcome);
    if (outcome.kind === "accepted" && !outcome.deduped) queue = [...queue, outcome.steer];
  });
  return { queue, results };
}

test("steer 入队顺序：同一回合连发三条，FIFO 保序且 position 递增", () => {
  const { queue, results } = enqueueAll(["先改成冷色调", "再把节奏放慢一点", "结尾补一个品牌镜头"]);

  assert.equal(queue.length, 3, "三条都该在队列里");
  assert.deepEqual(
    queue.map((s) => s.text),
    ["先改成冷色调", "再把节奏放慢一点", "结尾补一个品牌镜头"],
    "队列顺序必须等于发送顺序（先到先得）",
  );
  assert.deepEqual(
    results.map((r) => (r.kind === "accepted" ? r.position : -1)),
    [1, 2, 3],
    "position 是入队后的 1-based 位置，逐条递增",
  );

  // 投递批次逐条保序：模型看到的指引顺序 = 用户发送顺序。
  const batch = steerBatchText(queue);
  const idxCold = batch.indexOf("先改成冷色调");
  const idxSlow = batch.indexOf("再把节奏放慢一点");
  const idxBrand = batch.indexOf("结尾补一个品牌镜头");
  assert.ok(idxCold >= 0 && idxSlow > idxCold && idxBrand > idxSlow, "批次文本必须保序");
  assert.match(batch, /【回合中追加指引】/, "批次文本必须交代来历，模型才不会重新开场");

  // 去重只认队列里已有的同一句：第 4 条（在回收的队列上）不会挤掉前 3 条。
  const dup = enqueueSteer(queue, "  先改成冷色调  ", { now: NOW + 9, id: "steer-dup" });
  assert.equal(dup.kind, "accepted", "重复文本按既有那条处理，不报错");
  assert.equal(dup.deduped, true, "同一句话重发＝命中队列既有条目");
  assert.equal(dup.position, 1, "指回既有条目的位置，不新增、不改顺序");
});

test("超限拒绝：第 4 条排不进队列，诚实回 queue_full 而不是静默丢", () => {
  assert.equal(STEER_MAX_QUEUE, 3, "上限是合约值（前端提示与这里同源）");
  const { queue, results } = enqueueAll(["一", "二", "三", "四"]);

  assert.equal(queue.length, STEER_MAX_QUEUE, "队列不得超过上限");
  const last = results[3];
  assert.equal(last.kind, "rejected", "超限的那条必须被拒绝");
  assert.equal(last.kind === "rejected" ? last.reason : "", "queue_full");
  assert.deepEqual(
    queue.map((s) => s.text),
    ["一", "二", "三"],
    "被拒绝的那条不得挤掉已在队列里的三条",
  );

  // 空文本／超长文本同样是诚实拒绝，不是塞一条空指引进去。
  assert.deepEqual(enqueueSteer(queue, "   \n  ", { now: NOW, id: "x" }), { kind: "rejected", reason: "empty" });
  const tooLong = "a".repeat(STEER_MAX_CHARS + 1);
  assert.deepEqual(enqueueSteer([], tooLong, { now: NOW, id: "x" }), { kind: "rejected", reason: "too_long" });
});

test("停止优先于 steer：回合被中止 → 队列全数作废，一条都不投递", () => {
  const { queue } = enqueueAll(["先改成冷色调", "再把节奏放慢一点"]);
  assert.equal(queue.length, 2, "前置：队列里确有两条待投");

  const aborted = planSteerFlush(queue, { turnAborted: true });
  assert.equal(aborted.batch, null, "用户按了停止：不得再投递任何 steer");
  assert.deepEqual(
    aborted.dropped.map((d) => d.id),
    queue.map((s) => s.id),
    "每一条都要进 dropped（UI 明示已作废），不是静默消失",
  );
  assert.ok(aborted.dropped.every((d) => d.reason === "aborted"));

  // 对照组：未中止才投递，且投递内容与队列一致。
  const normal = planSteerFlush(queue, { turnAborted: false });
  assert.deepEqual(normal.dropped, []);
  assert.deepEqual(normal.batch?.ids, queue.map((s) => s.id));
  assert.match(normal.batch?.text ?? "", /先改成冷色调[\s\S]*再把节奏放慢一点/);
});

test("无 steer 时行为逐位等价：空队列零决策、零帧、零投递（回归保护）", () => {
  const none = planSteerFlush([], { turnAborted: false });
  assert.equal(none.batch, null, "没有 steer 的回合收尾不得多出任何投递");
  assert.deepEqual(none.dropped, [], "没有 steer 就没有可上报的状态帧");
  // 中止轮的空队列同样是全零（既有 abort 路径行为逐位不变）。
  assert.deepEqual(planSteerFlush([], { turnAborted: true }), { batch: null, dropped: [] });
  assert.equal(steerBatchText([]), "", "空批次文本是空字串，不是带标题的空壳");
});

test("文本归一化与 id 值域：去重键稳定、非法 id 不进队列", () => {
  assert.equal(normalizeSteerText("  先   改成\n冷色调  "), "先 改成 冷色调");
  assert.equal(normalizeSteerText(null), "");

  assert.equal(isValidSteerId("steer-m1abcd-1"), true);
  assert.equal(isValidSteerId("steer/../../etc"), false);
  assert.equal(isValidSteerId(""), false);
  assert.equal(isValidSteerId(42), false);
  // D-7b 的前提：id 值域**含底线**——所以持久层的别名查询不得用 LIKE 通配比对。
  assert.equal(isValidSteerId("steer-p_q"), true, "底线是合法 id 字元（LIKE 下却是单字元通配符）");
});

// ─────────────── F-D2（2026-09-23）对抗性验收缺陷的具名回归 ───────────────

test("D2-1a 停止优先闸：没回合在跑、或回合已中止（abort→idle 窗口）都不受理 steer", () => {
  assert.deepEqual(gateSteerAcceptance({ turnInFlight: false, turnAborted: false }), {
    kind: "reject",
    reason: "no_active_turn",
  });
  // 实锤窗口：abort 已落地但 idle 帧还没到——lastTurnActiveAt 仍是旧值（turnInFlight 真），
  // 旧实作只看这一个开关就放行，会把用户指引当「答覆」POST 进已中止回合。
  assert.deepEqual(gateSteerAcceptance({ turnInFlight: true, turnAborted: true }), {
    kind: "reject",
    reason: "turn_aborted",
  });
  // 对照组：正常在途回合才放行。
  assert.deepEqual(gateSteerAcceptance({ turnInFlight: true, turnAborted: false }), { kind: "accept" });
});

test("D-6 系统中止窗口照常受理、只有用户停止才拒（不得回「已中止、不会生效」的假话）", () => {
  // ① 用户停止窗口：一律拒（D2-1a 的保护不得被本次放宽）。
  assert.deepEqual(gateSteerAcceptance({ turnInFlight: true, turnAborted: true, turnAbortSource: "user" }), {
    kind: "reject",
    reason: "turn_aborted",
  });
  // ② 来源缺席（旧状态物件／volatile 被清）：保守按用户处置，仍拒。
  assert.deepEqual(gateSteerAcceptance({ turnInFlight: true, turnAborted: true }), {
    kind: "reject",
    reason: "turn_aborted",
  });
  // ③ 系统中止（空转断路器自行中止＋同轮续跑）：受理。排队指引本来就被刻意保留，
  //    旧版回「本轮已中止，引导不会再生效」是假话，还害前端 fallback 成普通送出。
  assert.deepEqual(
    gateSteerAcceptance({ turnInFlight: true, turnAborted: true, turnAbortSource: "system" }),
    { kind: "accept" },
    "系统中止窗口必须照常受理",
  );
  // ④ 受理之后语义闭环：这条指引照常排队、照常在收尾时投递（与 abortIsUserStop 同一判据）。
  const { queue } = enqueueAll(["先改成冷色调"]);
  assert.equal(abortIsUserStop(true, "system"), false, "系统中止不是用户停止");
  assert.deepEqual(planSteerFlush(queue, { turnAborted: abortIsUserStop(true, "system") }).batch?.ids, ["steer-0"]);
});

test("D2-1b 停止优先只认用户停止：内部断路器中止不丢用户排队指引", () => {
  assert.equal(abortIsUserStop(true, "user"), true, "用户按停止 → 丢队列（停止优先）");
  assert.equal(abortIsUserStop(true, "system"), false, "内部空转断路器中止 → 队列保留");
  assert.equal(abortIsUserStop(false, undefined), false, "没中止 → 照常投递");
  // 来源缺席（旧状态物件／volatile 被清）一律保守按用户停止处置。
  assert.equal(abortIsUserStop(true, undefined), true, "来源不明时宁可作废，不可把指引投进已叫停的轮");
  assert.equal(abortIsUserStop(undefined, "user"), false);

  // 行为对照：同一条队列，用户停止全数作废；系统中止照样拼批投递。
  const { queue } = enqueueAll(["先改成冷色调"]);
  assert.equal(planSteerFlush(queue, { turnAborted: abortIsUserStop(true, "user") }).batch, null);
  const kept = planSteerFlush(queue, { turnAborted: abortIsUserStop(true, "system") });
  assert.deepEqual(kept.dropped, [], "系统中止不得丢用户指引");
  assert.deepEqual(kept.batch?.ids, ["steer-0"], "系统中止后下一轮收尾照常投递");
});

test("D2-4 dedupe 认 steer_id：同 id 重放不得长出第二颗（同文去重保留）", () => {
  const { queue } = enqueueAll(["先改成冷色调", "再把节奏放慢一点"]);
  // 同一条 steer（同 id）被重试／中继重放：只回既有那条，不新增、不改顺序。
  const replay = enqueueSteer(queue, "先改成冷色调", { now: NOW + 50, id: "steer-0" });
  assert.equal(replay.kind, "accepted");
  assert.equal(replay.deduped, true);
  assert.equal(replay.position, 1);
  assert.equal(replay.kind === "accepted" ? replay.steer.id : "", "steer-0");
  // 同 id 但文本不同（重放带了改写过的正文）：仍只认既有那条，不得覆盖。
  const replayEdited = enqueueSteer(queue, "完全不同的说法", { now: NOW + 51, id: "steer-0" });
  assert.equal(replayEdited.deduped, true);
  assert.equal(replayEdited.kind === "accepted" ? replayEdited.steer.text : "", "先改成冷色调");
  // 别名 id 也认（同文去重时第二个 id 记进 aliases，之后的同 id 重放同样命中）。
  const aliased: PendingSteer = { ...queue[0], aliases: ["steer-alias"] };
  const replayAlias = enqueueSteer([aliased], "先改成冷色调", { now: NOW + 52, id: "steer-alias" });
  assert.equal(replayAlias.deduped, true);
  assert.deepEqual(steerFrameIds(aliased), ["steer-0", "steer-alias"], "本体+别名都要收终态帧");
});

test("D2-3 deadline：排队条目带投递截止，逾时不投递并落 expired（前端据此翻终态）", () => {
  const { queue } = enqueueAll(["先改成冷色调"]);
  assert.equal(queue[0].deadline, NOW + STEER_QUEUE_TTL_MS, "入队即定死 deadline");
  assert.equal(STEER_QUEUE_TTL_MS, 30 * 60 * 1000, "TTL 是合约值（前端镜像常数必须同值）");

  // 逾期：不投递、落 expired（呼叫端据此发 failed 终态帧，而不是永远排队中）。
  const late = planSteerFlush(queue, { turnAborted: false, now: NOW + STEER_QUEUE_TTL_MS + 1 });
  assert.equal(late.batch, null, "逾时条目不得投递");
  assert.deepEqual(late.dropped, [{ id: "steer-0", reason: "expired" }]);

  // 未逾期：照常投递，一条都不丢。
  const inTime = planSteerFlush(queue, { turnAborted: false, now: NOW + STEER_QUEUE_TTL_MS - 1 });
  assert.deepEqual(inTime.dropped, []);
  assert.deepEqual(inTime.batch?.ids, ["steer-0"]);

  // 部分逾时：只丢逾时那条，其余照投（诚实、不牵连）。
  const { queue: two } = enqueueAll(["早", "晚"]);
  const aged: PendingSteer[] = [
    { ...two[0], at: NOW - STEER_QUEUE_TTL_MS - 1, deadline: NOW - 1 },
    { ...two[1], at: NOW, deadline: NOW + STEER_QUEUE_TTL_MS },
  ];
  const mixed = planSteerFlush(aged, { turnAborted: false, now: NOW });
  assert.deepEqual(mixed.dropped, [{ id: "steer-0", reason: "expired" }]);
  assert.deepEqual(mixed.batch?.ids, ["steer-1"]);

  // 不给 now＝不判逾时（既有呼叫端行为逐位不变）。
  assert.deepEqual(planSteerFlush(queue, { turnAborted: false }).dropped, []);
});

// ─────── D2-1a/D2-1b 接线锁（网关模组 import 即载入 bun:sqlite，tsx 下载不动，
//          只能用「读原始码」的方式钉住接线——缺陷就在接线上，不在代数上）───────
function readGateway(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

test("D2-1a 接线锁：受理闸同时看 turnInFlight 与 turnAborted，且闸在注入腿之前", () => {
  const gw = readGateway("./steer-gw.ts");
  assert.match(gw, /gateSteerAcceptance\(\{/, "受理端必须走纯核心的闸（不是单凭 turnInFlight）");
  assert.match(gw, /turnAborted: state\.turnAborted === true/, "闸必须看 abort 状态");
  assert.match(gw, /turnInFlight: turnInFlight\(state\)/);
  // D-6 接线：闸必须拿到中止来源（否则系统中止窗口会被当成用户停止误拒）；真值验收见
  // steer-ledger-db.test.ts 的 ⑧（真 Request/Response）。
  assert.match(gw, /turnAbortSource: state\.turnAbortSource/, "闸必须带上中止来源（D-6）");
  assert.match(gw, /const injectEligible = state\.turnAborted !== true && state\.pendingQuestions\.size > 0/, "中止轮不得走注入腿（任何来源）");
  const gateAt = gw.indexOf("gateSteerAcceptance({");
  const injectAt = gw.indexOf("const injectEligible =");
  assert.ok(gateAt > -1 && injectAt > gateAt, "闸必须排在注入腿之前——否则 abort 后仍会把指引当答覆 POST 进已中止回合");
  // 409 的两种来历都要诚实回报（前端据 code/status 落回正常送出）。
  assert.match(gw, /gate\.reason === "turn_aborted"/);
});

test("D2-1b 接线锁：只有用户停止设 source=user 并丢队列；内部断路器设 source=system 且不丢", () => {
  const abortPath = readGateway("./session-read.ts");
  const breaker = readGateway("./events-translate.ts");
  const gw = readGateway("./steer-gw.ts");

  // 用户停止：标来源 + 丢队列（顺序：先标来源，再丢）。
  const srcUserAt = abortPath.indexOf('state.turnAbortSource = "user"');
  const dropAt = abortPath.indexOf('dropPendingSteers(state, "aborted")');
  assert.ok(srcUserAt > -1, "用户中止必须标明来源＝user");
  assert.ok(dropAt > srcUserAt, "丢队列必须在标来源之后（否则语义来源不明）");

  // 内部断路器：设 turnAborted 的同时标 system，且**不得**呼叫 dropPendingSteers。
  const breakerFnAt = breaker.indexOf("export function triggerIdleStepBreaker(");
  assert.ok(breakerFnAt > -1);
  const breakerBody = breaker.slice(breakerFnAt, breaker.indexOf("export function", breakerFnAt + 10));
  assert.match(breakerBody, /state\.turnAborted = true/);
  assert.match(breakerBody, /state\.turnAbortSource = "system"/, "内部中止必须标 system，否则会误丢用户指引");
  assert.doesNotMatch(breakerBody, /dropPendingSteers/, "内部断路器不得丢用户的排队指引（D2-1b 实锤）");

  // flush 端以 abortIsUserStop 判定，不是裸看的 turnAborted。
  assert.match(gw, /abortIsUserStop\(state\.turnAborted, state\.turnAbortSource\)/);
});
