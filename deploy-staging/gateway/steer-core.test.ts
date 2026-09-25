// steer-core.test.ts —— REQ-D2 steer 語義的具名回歸測試（純邏輯，無網關依賴）。
//
// 四組具名斷言對應驗收清單：
//   ① steer 入隊順序   ② 超限拒絕   ③ 停止優先於 steer   ④ 無 steer 時行為等價
// 跑法（必帶超時，見記憶 2026-09-23-test-suite-hang-blender-e2e）：
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

/** 依序入隊一串文本，回傳最終隊列（模擬 gateway state.pendingSteers 的 append）。 */
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

test("steer 入隊順序：同一回合連發三條，FIFO 保序且 position 遞增", () => {
  const { queue, results } = enqueueAll(["先改成冷色调", "再把节奏放慢一点", "结尾补一个品牌镜头"]);

  assert.equal(queue.length, 3, "三條都該在隊列裡");
  assert.deepEqual(
    queue.map((s) => s.text),
    ["先改成冷色调", "再把节奏放慢一点", "结尾补一个品牌镜头"],
    "隊列順序必須等於發送順序（先到先得）",
  );
  assert.deepEqual(
    results.map((r) => (r.kind === "accepted" ? r.position : -1)),
    [1, 2, 3],
    "position 是入隊後的 1-based 位置，逐條遞增",
  );

  // 投遞批次逐條保序：模型看到的指引順序 = 用戶發送順序。
  const batch = steerBatchText(queue);
  const idxCold = batch.indexOf("先改成冷色调");
  const idxSlow = batch.indexOf("再把节奏放慢一点");
  const idxBrand = batch.indexOf("结尾补一个品牌镜头");
  assert.ok(idxCold >= 0 && idxSlow > idxCold && idxBrand > idxSlow, "批次文本必須保序");
  assert.match(batch, /【回合中追加指引】/, "批次文本必須交代來歷，模型才不會重新開場");

  // 去重只認隊列裡已有的同一句：第 4 條（在回收的隊列上）不會擠掉前 3 條。
  const dup = enqueueSteer(queue, "  先改成冷色调  ", { now: NOW + 9, id: "steer-dup" });
  assert.equal(dup.kind, "accepted", "重複文本按既有那條處理，不報錯");
  assert.equal(dup.deduped, true, "同一句話重發＝命中隊列既有條目");
  assert.equal(dup.position, 1, "指回既有條目的位置，不新增、不改順序");
});

test("超限拒絕：第 4 條排不進隊列，誠實回 queue_full 而不是靜默丟", () => {
  assert.equal(STEER_MAX_QUEUE, 3, "上限是合約值（前端提示與這裡同源）");
  const { queue, results } = enqueueAll(["一", "二", "三", "四"]);

  assert.equal(queue.length, STEER_MAX_QUEUE, "隊列不得超過上限");
  const last = results[3];
  assert.equal(last.kind, "rejected", "超限的那條必須被拒絕");
  assert.equal(last.kind === "rejected" ? last.reason : "", "queue_full");
  assert.deepEqual(
    queue.map((s) => s.text),
    ["一", "二", "三"],
    "被拒絕的那條不得擠掉已在隊列裡的三條",
  );

  // 空文本／超長文本同樣是誠實拒絕，不是塞一條空指引進去。
  assert.deepEqual(enqueueSteer(queue, "   \n  ", { now: NOW, id: "x" }), { kind: "rejected", reason: "empty" });
  const tooLong = "a".repeat(STEER_MAX_CHARS + 1);
  assert.deepEqual(enqueueSteer([], tooLong, { now: NOW, id: "x" }), { kind: "rejected", reason: "too_long" });
});

test("停止優先於 steer：回合被中止 → 隊列全數作廢，一條都不投遞", () => {
  const { queue } = enqueueAll(["先改成冷色调", "再把节奏放慢一点"]);
  assert.equal(queue.length, 2, "前置：隊列裡確有兩條待投");

  const aborted = planSteerFlush(queue, { turnAborted: true });
  assert.equal(aborted.batch, null, "用戶按了停止：不得再投遞任何 steer");
  assert.deepEqual(
    aborted.dropped.map((d) => d.id),
    queue.map((s) => s.id),
    "每一條都要進 dropped（UI 明示已作廢），不是靜默消失",
  );
  assert.ok(aborted.dropped.every((d) => d.reason === "aborted"));

  // 對照組：未中止才投遞，且投遞內容與隊列一致。
  const normal = planSteerFlush(queue, { turnAborted: false });
  assert.deepEqual(normal.dropped, []);
  assert.deepEqual(normal.batch?.ids, queue.map((s) => s.id));
  assert.match(normal.batch?.text ?? "", /先改成冷色调[\s\S]*再把节奏放慢一点/);
});

test("無 steer 時行為逐位等價：空隊列零決策、零幀、零投遞（回歸保護）", () => {
  const none = planSteerFlush([], { turnAborted: false });
  assert.equal(none.batch, null, "沒有 steer 的回合收尾不得多出任何投遞");
  assert.deepEqual(none.dropped, [], "沒有 steer 就沒有可上報的狀態幀");
  // 中止輪的空隊列同樣是全零（既有 abort 路徑行為逐位不變）。
  assert.deepEqual(planSteerFlush([], { turnAborted: true }), { batch: null, dropped: [] });
  assert.equal(steerBatchText([]), "", "空批次文本是空字串，不是帶標題的空殼");
});

test("文本歸一化與 id 值域：去重鍵穩定、非法 id 不進隊列", () => {
  assert.equal(normalizeSteerText("  先   改成\n冷色调  "), "先 改成 冷色调");
  assert.equal(normalizeSteerText(null), "");

  assert.equal(isValidSteerId("steer-m1abcd-1"), true);
  assert.equal(isValidSteerId("steer/../../etc"), false);
  assert.equal(isValidSteerId(""), false);
  assert.equal(isValidSteerId(42), false);
  // D-7b 的前提：id 值域**含底線**——所以持久層的別名查詢不得用 LIKE 通配比對。
  assert.equal(isValidSteerId("steer-p_q"), true, "底線是合法 id 字元（LIKE 下卻是單字元通配符）");
});

// ─────────────── F-D2（2026-09-23）對抗性驗收缺陷的具名回歸 ───────────────

test("D2-1a 停止優先閘：沒回合在跑、或回合已中止（abort→idle 窗口）都不受理 steer", () => {
  assert.deepEqual(gateSteerAcceptance({ turnInFlight: false, turnAborted: false }), {
    kind: "reject",
    reason: "no_active_turn",
  });
  // 實錘窗口：abort 已落地但 idle 幀還沒到——lastTurnActiveAt 仍是舊值（turnInFlight 真），
  // 舊實作只看這一個開關就放行，會把用戶指引當「答覆」POST 進已中止回合。
  assert.deepEqual(gateSteerAcceptance({ turnInFlight: true, turnAborted: true }), {
    kind: "reject",
    reason: "turn_aborted",
  });
  // 對照組：正常在途回合才放行。
  assert.deepEqual(gateSteerAcceptance({ turnInFlight: true, turnAborted: false }), { kind: "accept" });
});

test("D-6 系統中止窗口照常受理、只有用戶停止才拒（不得回「已中止、不會生效」的假話）", () => {
  // ① 用戶停止窗口：一律拒（D2-1a 的保護不得被本次放寬）。
  assert.deepEqual(gateSteerAcceptance({ turnInFlight: true, turnAborted: true, turnAbortSource: "user" }), {
    kind: "reject",
    reason: "turn_aborted",
  });
  // ② 來源缺席（舊狀態物件／volatile 被清）：保守按用戶處置，仍拒。
  assert.deepEqual(gateSteerAcceptance({ turnInFlight: true, turnAborted: true }), {
    kind: "reject",
    reason: "turn_aborted",
  });
  // ③ 系統中止（空轉斷路器自行中止＋同輪續跑）：受理。排隊指引本來就被刻意保留，
  //    舊版回「本轮已中止，引导不会再生效」是假話，還害前端 fallback 成普通送出。
  assert.deepEqual(
    gateSteerAcceptance({ turnInFlight: true, turnAborted: true, turnAbortSource: "system" }),
    { kind: "accept" },
    "系統中止窗口必須照常受理",
  );
  // ④ 受理之後語義閉環：這條指引照常排队、照常在收尾時投遞（與 abortIsUserStop 同一判據）。
  const { queue } = enqueueAll(["先改成冷色调"]);
  assert.equal(abortIsUserStop(true, "system"), false, "系統中止不是用戶停止");
  assert.deepEqual(planSteerFlush(queue, { turnAborted: abortIsUserStop(true, "system") }).batch?.ids, ["steer-0"]);
});

test("D2-1b 停止優先只認用戶停止：內部斷路器中止不丟用戶排隊指引", () => {
  assert.equal(abortIsUserStop(true, "user"), true, "用戶按停止 → 丟隊列（停止優先）");
  assert.equal(abortIsUserStop(true, "system"), false, "內部空轉斷路器中止 → 隊列保留");
  assert.equal(abortIsUserStop(false, undefined), false, "沒中止 → 照常投遞");
  // 來源缺席（舊狀態物件／volatile 被清）一律保守按用戶停止處置。
  assert.equal(abortIsUserStop(true, undefined), true, "來源不明時寧可作廢，不可把指引投進已叫停的輪");
  assert.equal(abortIsUserStop(undefined, "user"), false);

  // 行為對照：同一條隊列，用戶停止全數作廢；系統中止照樣拼批投遞。
  const { queue } = enqueueAll(["先改成冷色调"]);
  assert.equal(planSteerFlush(queue, { turnAborted: abortIsUserStop(true, "user") }).batch, null);
  const kept = planSteerFlush(queue, { turnAborted: abortIsUserStop(true, "system") });
  assert.deepEqual(kept.dropped, [], "系統中止不得丟用戶指引");
  assert.deepEqual(kept.batch?.ids, ["steer-0"], "系統中止後下一輪收尾照常投遞");
});

test("D2-4 dedupe 認 steer_id：同 id 重放不得長出第二顆（同文去重保留）", () => {
  const { queue } = enqueueAll(["先改成冷色调", "再把节奏放慢一点"]);
  // 同一條 steer（同 id）被重試／中繼重放：只回既有那條，不新增、不改順序。
  const replay = enqueueSteer(queue, "先改成冷色调", { now: NOW + 50, id: "steer-0" });
  assert.equal(replay.kind, "accepted");
  assert.equal(replay.deduped, true);
  assert.equal(replay.position, 1);
  assert.equal(replay.kind === "accepted" ? replay.steer.id : "", "steer-0");
  // 同 id 但文本不同（重放帶了改寫過的正文）：仍只認既有那條，不得覆蓋。
  const replayEdited = enqueueSteer(queue, "完全不同的说法", { now: NOW + 51, id: "steer-0" });
  assert.equal(replayEdited.deduped, true);
  assert.equal(replayEdited.kind === "accepted" ? replayEdited.steer.text : "", "先改成冷色调");
  // 別名 id 也認（同文去重時第二個 id 記進 aliases，之後的同 id 重放同樣命中）。
  const aliased: PendingSteer = { ...queue[0], aliases: ["steer-alias"] };
  const replayAlias = enqueueSteer([aliased], "先改成冷色调", { now: NOW + 52, id: "steer-alias" });
  assert.equal(replayAlias.deduped, true);
  assert.deepEqual(steerFrameIds(aliased), ["steer-0", "steer-alias"], "本體+別名都要收終態幀");
});

test("D2-3 deadline：排隊條目帶投遞截止，逾時不投遞並落 expired（前端據此翻終態）", () => {
  const { queue } = enqueueAll(["先改成冷色调"]);
  assert.equal(queue[0].deadline, NOW + STEER_QUEUE_TTL_MS, "入隊即定死 deadline");
  assert.equal(STEER_QUEUE_TTL_MS, 30 * 60 * 1000, "TTL 是合約值（前端鏡像常數必須同值）");

  // 逾期：不投遞、落 expired（呼叫端據此發 failed 終態幀，而不是永遠排队中）。
  const late = planSteerFlush(queue, { turnAborted: false, now: NOW + STEER_QUEUE_TTL_MS + 1 });
  assert.equal(late.batch, null, "逾時條目不得投遞");
  assert.deepEqual(late.dropped, [{ id: "steer-0", reason: "expired" }]);

  // 未逾期：照常投遞，一條都不丟。
  const inTime = planSteerFlush(queue, { turnAborted: false, now: NOW + STEER_QUEUE_TTL_MS - 1 });
  assert.deepEqual(inTime.dropped, []);
  assert.deepEqual(inTime.batch?.ids, ["steer-0"]);

  // 部分逾時：只丟逾時那條，其餘照投（誠實、不牽連）。
  const { queue: two } = enqueueAll(["早", "晚"]);
  const aged: PendingSteer[] = [
    { ...two[0], at: NOW - STEER_QUEUE_TTL_MS - 1, deadline: NOW - 1 },
    { ...two[1], at: NOW, deadline: NOW + STEER_QUEUE_TTL_MS },
  ];
  const mixed = planSteerFlush(aged, { turnAborted: false, now: NOW });
  assert.deepEqual(mixed.dropped, [{ id: "steer-0", reason: "expired" }]);
  assert.deepEqual(mixed.batch?.ids, ["steer-1"]);

  // 不給 now＝不判逾時（既有呼叫端行為逐位不變）。
  assert.deepEqual(planSteerFlush(queue, { turnAborted: false }).dropped, []);
});

// ─────── D2-1a/D2-1b 接線鎖（網關模組 import 即載入 bun:sqlite，tsx 下載不動，
//          只能用「讀原始碼」的方式釘住接線——缺陷就在接線上，不在代數上）───────
function readGateway(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

test("D2-1a 接線鎖：受理閘同時看 turnInFlight 與 turnAborted，且閘在注入腿之前", () => {
  const gw = readGateway("./steer-gw.ts");
  assert.match(gw, /gateSteerAcceptance\(\{/, "受理端必須走純核心的閘（不是單憑 turnInFlight）");
  assert.match(gw, /turnAborted: state\.turnAborted === true/, "閘必須看 abort 狀態");
  assert.match(gw, /turnInFlight: turnInFlight\(state\)/);
  // D-6 接線：閘必須拿到中止來源（否則系統中止窗口會被當成用戶停止誤拒）；真值驗收見
  // steer-ledger-db.test.ts 的 ⑧（真 Request/Response）。
  assert.match(gw, /turnAbortSource: state\.turnAbortSource/, "閘必須帶上中止來源（D-6）");
  assert.match(gw, /const injectEligible = state\.turnAborted !== true && state\.pendingQuestions\.size > 0/, "中止輪不得走注入腿（任何來源）");
  const gateAt = gw.indexOf("gateSteerAcceptance({");
  const injectAt = gw.indexOf("const injectEligible =");
  assert.ok(gateAt > -1 && injectAt > gateAt, "閘必須排在注入腿之前——否則 abort 後仍會把指引當答覆 POST 進已中止回合");
  // 409 的兩種來歷都要誠實回報（前端據 code/status 落回正常送出）。
  assert.match(gw, /gate\.reason === "turn_aborted"/);
});

test("D2-1b 接線鎖：只有用戶停止設 source=user 並丟隊列；內部斷路器設 source=system 且不丟", () => {
  const abortPath = readGateway("./session-read.ts");
  const breaker = readGateway("./events-translate.ts");
  const gw = readGateway("./steer-gw.ts");

  // 用戶停止：標來源 + 丟隊列（順序：先標來源，再丟）。
  const srcUserAt = abortPath.indexOf('state.turnAbortSource = "user"');
  const dropAt = abortPath.indexOf('dropPendingSteers(state, "aborted")');
  assert.ok(srcUserAt > -1, "用戶中止必須標明來源＝user");
  assert.ok(dropAt > srcUserAt, "丟隊列必須在標來源之後（否則語義來源不明）");

  // 內部斷路器：設 turnAborted 的同時標 system，且**不得**呼叫 dropPendingSteers。
  const breakerFnAt = breaker.indexOf("export function triggerIdleStepBreaker(");
  assert.ok(breakerFnAt > -1);
  const breakerBody = breaker.slice(breakerFnAt, breaker.indexOf("export function", breakerFnAt + 10));
  assert.match(breakerBody, /state\.turnAborted = true/);
  assert.match(breakerBody, /state\.turnAbortSource = "system"/, "內部中止必須標 system，否則會誤丟用戶指引");
  assert.doesNotMatch(breakerBody, /dropPendingSteers/, "內部斷路器不得丟用戶的排隊指引（D2-1b 實錘）");

  // flush 端以 abortIsUserStop 判定，不是裸看的 turnAborted。
  assert.match(gw, /abortIsUserStop\(state\.turnAborted, state\.turnAbortSource\)/);
});
