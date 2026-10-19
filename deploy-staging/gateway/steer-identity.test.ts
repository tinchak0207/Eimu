// steer-identity.test.ts —— REQ-D2b（steer 持久命令身份＋uncertain 态＋tombstone）的
// 纯核心具名测试。这里的每一条都是**真实行为断言**（真函数、真输入→真输出）；
// 唯一的外部 oracle 是 GNU coreutils 的 sha256sum（独立于本档的 JS 实作，防同源断言）。
//
// 持久层（bun:sqlite）与真实 HTTP 受理端在 steer-ledger-db.test.ts（bun 直跑，
// tsx 载不动 bun:sqlite），本档只钉语义。
//
// 跑法（必带超时）：
//   timeout 240 npx tsx --test deploy-staging/gateway/steer-identity.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  STEER_COMMAND_STATES,
  STEER_STATE_TRANSITIONS,
  STEER_TERMINAL_STATES,
  canonicalSteerPayload,
  createSteerLedger,
  freezeSteerPayload,
  isLegalSteerTransition,
  isSteerTerminalState,
  planSteerBegin,
  steerWireStatus,
  type SteerCommand,
  type SteerLedgerStore,
} from "./steer-identity.ts";

const NOW = 1_760_000_000_000;

/** 记忆体替身 store（介面与 persistence.steerCommandStore 逐字同形）。 */
function memStore(): SteerLedgerStore & { rows: Map<string, SteerCommand> } {
  const rows = new Map<string, SteerCommand>();
  return {
    rows,
    read(steerId) {
      const direct = rows.get(steerId);
      if (direct) return direct;
      // 别名命中（生产侧由 SQL 的 alias_ids LIKE 完成，语义相同）。
      for (const row of rows.values()) if (row.aliasIds.includes(steerId)) return row;
      return null;
    },
    readBySession(sessionId) {
      return [...rows.values()].filter((r) => r.sessionId === sessionId);
    },
    write(command) {
      rows.set(command.steerId, { ...command });
    },
  };
}

function beginInput(over: Partial<Parameters<ReturnType<typeof createSteerLedger>["begin"]>[0]> = {}) {
  return {
    steerId: "steer-aaa-1",
    sessionId: "ses_1",
    ownerKey: "sk-test",
    content: "先改成冷色调",
    opencodeSessionId: "oc_1",
    turnGen: 3,
    now: NOW,
    ...over,
  };
}

// ─────────────── ① 状态机：六态（上屏）／七态（持久）流转合法、终态冻结 ───────────────

test("状态机流转表：queued→dispatched→applied/injected/failed/uncertain/aborted 合法，终态零出边", () => {
  // 值域本身是契约（前端 AGENT_STEER_STATUSES 与上屏状态逐字对齐）。
  assert.deepEqual(
    [...STEER_COMMAND_STATES],
    ["queued", "dispatched", "applied", "injected", "failed", "uncertain", "aborted"],
  );
  assert.deepEqual([...STEER_TERMINAL_STATES], ["applied", "injected", "failed", "uncertain", "aborted"]);

  // 主线：queued → dispatched → 五个终态（applied/injected/failed/uncertain/aborted）。
  assert.equal(isLegalSteerTransition("queued", "dispatched"), true);
  for (const t of ["applied", "injected", "failed", "uncertain", "aborted"] as const) {
    assert.equal(isLegalSteerTransition("dispatched", t), true, `dispatched → ${t} 必须合法`);
  }
  // 未投递就能落终态（停止优先／逾时／重启前未投递）：queued → failed/aborted/uncertain。
  for (const t of ["failed", "aborted", "uncertain"] as const) {
    assert.equal(isLegalSteerTransition("queued", t), true, `queued → ${t} 必须合法`);
  }
  // 终态零出边＝冻结（含 uncertain 不得被迟到帧改写）。
  for (const from of STEER_TERMINAL_STATES) {
    assert.deepEqual([...STEER_STATE_TRANSITIONS[from]], [], `${from} 是终态，不得有出边`);
    for (const to of STEER_COMMAND_STATES) {
      assert.equal(isLegalSteerTransition(from, to), false, `${from} → ${to} 必须非法`);
    }
  }
  // 不得跳过 dispatched 直接自称已投递成功语义之外的乱跳。
  assert.equal(isLegalSteerTransition("queued", "queued"), false, "同态不是合法流转（ledger 另有幂等分支）");
  assert.equal(isLegalSteerTransition("dispatched", "dispatched"), false);

  // 上屏映射：dispatched 是内部在途态，对使用者仍是「排队中」（尚未确认就不许说已生效）。
  assert.equal(steerWireStatus("queued"), "queued");
  assert.equal(steerWireStatus("dispatched"), "queued");
  assert.equal(steerWireStatus("applied"), "applied");
  assert.equal(steerWireStatus("injected"), "injected");
  assert.equal(steerWireStatus("failed"), "failed");
  assert.equal(steerWireStatus("uncertain"), "uncertain");
  assert.equal(steerWireStatus("aborted"), "aborted");
  assert.equal(isSteerTerminalState("uncertain"), true);
  assert.equal(isSteerTerminalState("dispatched"), false);
  assert.equal(isSteerTerminalState("garbage"), false);
});

// ─────────────── ② payload 冻结：内容 + turn/session 标识都进哈希 ───────────────

test("payload 冻结：hash 与独立实作（sha256sum）逐字相等，且对内容/turn/session 敏感", () => {
  const frozen = freezeSteerPayload({
    steerId: "steer-aaa-1",
    sessionId: "ses_1",
    opencodeSessionId: "oc_1",
    turnGen: 3,
    content: "先改成冷色调",
  });
  // 独立 oracle：GNU coreutils 的 sha256sum（不是本档的 node:crypto 实作）。
  const external = execFileSync("sha256sum", { input: frozen.canonical, encoding: "utf8" }).split(/\s+/)[0];
  assert.equal(frozen.payloadHash, external, "payload hash 必须等于独立工具对同一 canonical 字串的结果");
  assert.match(frozen.payloadHash, /^[0-9a-f]{64}$/);

  // 决定性：同输入同哈希（重放比对才成立）。
  const again = freezeSteerPayload({
    steerId: "steer-aaa-1",
    sessionId: "ses_1",
    opencodeSessionId: "oc_1",
    turnGen: 3,
    content: "先改成冷色调",
  });
  assert.equal(again.payloadHash, frozen.payloadHash);

  // 敏感度：content / session / opencode session / turn 任一改变 → 不同哈希
  //（身份覆盖「内容与关联 turn/session 标识」＝同一 id 带不同内容必被认出）。
  const variants = [
    { content: "把节奏放慢一点" },
    { sessionId: "ses_2" },
    { opencodeSessionId: "oc_2" },
    { turnGen: 4 },
  ];
  const base = { steerId: "steer-aaa-1", sessionId: "ses_1", opencodeSessionId: "oc_1", turnGen: 3, content: "先改成冷色调" };
  for (const patch of variants) {
    const h = freezeSteerPayload({ ...base, ...patch }).payloadHash;
    assert.notEqual(h, frozen.payloadHash, `改了 ${Object.keys(patch)[0]} 之后哈希必须变`);
  }
  // steerId 不进哈希（它是主键身份，不是 payload 的一部分）——同内容同 turn 必同哈希。
  assert.equal(
    freezeSteerPayload({ ...base, steerId: "steer-bbb-9" }).payloadHash,
    frozen.payloadHash,
  );
  // canonical 形态：键序固定（sha256sum 对照的前提），且不含时间（重试不得算出第二种哈希）。
  assert.equal(
    canonicalSteerPayload(base),
    '{"content":"先改成冷色调","session_id":"ses_1","opencode_session_id":"oc_1","turn_gen":3}',
  );
});

// ─────────────── ③ 受理判定：同 id 重放一律可辨识拒绝 ───────────────

test("受理判定：终态→replay_settled、在途→replay_in_flight、同 id 改内容→payload_mismatch、跨会话→id_conflict", () => {
  const settled: SteerCommand = {
    steerId: "s1",
    sessionId: "ses_1",
    ownerKey: "sk",
    aliasIds: [],
    payloadHash: "h1",
    payload: "{}",
    state: "applied",
    at: NOW,
  };
  assert.deepEqual(planSteerBegin(settled, { steerId: "s1", sessionId: "ses_1", payloadHash: "h1" }), {
    kind: "rejected",
    code: "steer_replay_settled",
    httpStatus: 409,
    command: settled,
  });
  assert.deepEqual(planSteerBegin({ ...settled, state: "dispatched" }, { steerId: "s1", sessionId: "ses_1", payloadHash: "h1" }), {
    kind: "rejected",
    code: "steer_replay_in_flight",
    httpStatus: 409,
    command: { ...settled, state: "dispatched" },
  });
  assert.deepEqual(planSteerBegin({ ...settled, state: "uncertain" }, { steerId: "s1", sessionId: "ses_1", payloadHash: "h1" }), {
    kind: "rejected",
    code: "steer_replay_settled",
    httpStatus: 409,
    command: { ...settled, state: "uncertain" },
  });
  // 同 id 但在途 + 内容/hash 不同：拒绝（还会被投递的指令不得被改写）。
  assert.equal(
    planSteerBegin({ ...settled, state: "dispatched" }, { steerId: "s1", sessionId: "ses_1", payloadHash: "h2" })?.code,
    "steer_payload_mismatch",
  );
  // 已终态 + 内容/hash 不同：仍然回「已有结论」（终态判定优先于 payload 比对）——
  // 实锤：重启后 turnGen 由 DB 恢复为 0，同一条指引的正常重放会漂移出不同 hash，
  // 若先比 payload 就会把「已结案」误报成「内容不同」。
  assert.equal(planSteerBegin(settled, { steerId: "s1", sessionId: "ses_1", payloadHash: "h2" })?.code, "steer_replay_settled");
  // 同 id 属别 session：拒绝。
  assert.equal(
    planSteerBegin(settled, { steerId: "s1", sessionId: "ses_2", payloadHash: "h1" })?.code,
    "steer_id_conflict",
  );
  // 全新 id：放行（null＝没有既有记录）。
  assert.equal(planSteerBegin(null, { steerId: "s9", sessionId: "ses_1", payloadHash: "h1" }), null);
});

// ─────────────── ④ ledger：投递前落地、终态冻结、别名覆盖、重启落 uncertain ───────────────

test("ledger 受理：begin 立刻落地（投递前），同 id 重放被拒且不覆写既有记录", () => {
  const store = memStore();
  const ledger = createSteerLedger(store);

  const first = ledger.begin(beginInput());
  assert.equal(first.kind, "accepted");
  assert.equal(first.kind === "accepted" ? first.command.state : "", "queued");
  assert.equal(store.rows.size, 1, "begin 必须立刻写入持久层（投递之前的身份落地）");
  const row = store.rows.get("steer-aaa-1")!;
  assert.equal(row.payloadHash, freezeSteerPayload({ steerId: "steer-aaa-1", sessionId: "ses_1", opencodeSessionId: "oc_1", turnGen: 3, content: "先改成冷色调" }).payloadHash);
  assert.equal(row.ownerKey, "sk-test");
  assert.equal(row.dispatchedAt, undefined, "还没投递：不得有 dispatchedAt");

  // 同 id 重放（同内容）：in_flight 拒绝（它还活著），不得长出第二条、不得覆写。
  const replay = ledger.begin(beginInput({ now: NOW + 500 }));
  assert.equal(replay.kind, "rejected");
  assert.equal(replay.kind === "rejected" ? replay.code : "", "steer_replay_in_flight");
  assert.equal(store.rows.size, 1);
  assert.equal(store.rows.get("steer-aaa-1")!.at, NOW, "既有记录不得被重放覆写（at 不变）");

  // 同 id 改内容（重放带了改写过的正文）：payload_mismatch，仍不覆写。
  const edited = ledger.begin(beginInput({ content: "完全不同的说法", now: NOW + 600 }));
  assert.equal(edited.kind === "rejected" ? edited.code : "", "steer_payload_mismatch");
  assert.equal(store.rows.get("steer-aaa-1")!.payloadHash, row.payloadHash);
});

test("ledger 生命周期：dispatched → applied 后终态冻结；uncertain 不得被迟到帧改写", () => {
  const store = memStore();
  const ledger = createSteerLedger(store);
  ledger.begin(beginInput());

  assert.equal(ledger.markDispatched("steer-aaa-1", NOW + 10).kind, "settled");
  assert.equal(store.rows.get("steer-aaa-1")!.state, "dispatched");
  assert.equal(store.rows.get("steer-aaa-1")!.dispatchedAt, NOW + 10);
  // 重入 dispatch＝幂等成功（注入腿落回排队腿时会再标一次），不得当成非法流转。
  assert.equal(ledger.markDispatched("steer-aaa-1", NOW + 11).kind, "settled");
  assert.equal(store.rows.get("steer-aaa-1")!.dispatchedAt, NOW + 10, "第二次标记不得改写既有时刻");

  const applied = ledger.settle("steer-aaa-1", "applied", NOW + 20);
  assert.equal(applied.kind, "settled");
  assert.equal(store.rows.get("steer-aaa-1")!.state, "applied");
  assert.equal(store.rows.get("steer-aaa-1")!.settledAt, NOW + 20);
  // 终态再改（迟到的 failed/injected 帧）→ 拒绝且不写盘。
  const late = ledger.settle("steer-aaa-1", "failed", NOW + 30, "late_frame");
  assert.equal(late.kind, "refused");
  assert.equal(late.kind === "refused" ? late.reason : "", "terminal");
  assert.equal(store.rows.get("steer-aaa-1")!.state, "applied");
  assert.equal(store.rows.get("steer-aaa-1")!.settledAt, NOW + 20, "冻结后时刻也不得变");

  // 未知 id 不凭空造记录。
  const ghost = ledger.settle("steer-nope", "applied", NOW);
  assert.equal(ghost.kind === "refused" ? ghost.reason : "", "unknown");
  assert.equal(store.rows.size, 1);

  // uncertain 专项：落 uncertain 之后任何迟到帧（applied/injected/queued）都动不了它。
  const store2 = memStore();
  const ledger2 = createSteerLedger(store2);
  ledger2.begin(beginInput({ steerId: "steer-u-1" }));
  ledger2.markDispatched("steer-u-1", NOW + 1);
  assert.equal(ledger2.settle("steer-u-1", "uncertain", NOW + 2, "restart_unconfirmed").kind, "settled");
  for (const late of ["applied", "injected", "failed", "aborted"] as const) {
    assert.equal(ledger2.settle("steer-u-1", late, NOW + 3).kind, "refused", `uncertain 不得被 ${late} 改写`);
  }
  assert.equal(ledger2.markDispatched("steer-u-1", NOW + 4).kind, "refused");
  assert.equal(store2.rows.get("steer-u-1")!.state, "uncertain");
});

test("别名 id：同文去重的第二个 id 记进同一条记录，其重放同样被 tombstone 挡住", () => {
  const store = memStore();
  const ledger = createSteerLedger(store);
  ledger.begin(beginInput({ steerId: "steer-main", content: "先改成冷色调" }));
  ledger.addAlias("steer-main", "steer-alias");
  const row = store.rows.get("steer-main")!;
  assert.deepEqual(row.aliasIds, ["steer-alias"]);

  // 别名重放（同内容）：命中同一条记录 → 在途拒绝；不得长出第二颗记录。
  const replay = ledger.begin(beginInput({ steerId: "steer-alias", content: "先改成冷色调", now: NOW + 5 }));
  assert.equal(replay.kind === "rejected" ? replay.code : "", "steer_replay_in_flight");
  assert.equal(store.rows.size, 1);
  // 别名也查得到（生产侧由 alias_ids LIKE 完成）。
  assert.equal(ledger.get("steer-alias")?.steerId, "steer-main");

  // 终态化之后：本体与别名两条 id 的重放都是 settled（tombstone 覆盖全 id）。
  ledger.markDispatched("steer-main", NOW + 6);
  ledger.settle("steer-main", "applied", NOW + 7);
  assert.equal(ledger.begin(beginInput({ steerId: "steer-main", content: "先改成冷色调" })).kind === "rejected" ? "ok" : "", "ok");
  assert.equal(ledger.begin(beginInput({ steerId: "steer-alias", content: "先改成冷色调" })).kind === "rejected" ? "ok" : "", "ok");
  assert.equal(ledger.get("steer-main")?.state, "applied");
});

test("重启恢复：未终结一律落 uncertain（永不自动重发），已终态者纹丝不动", () => {
  const store = memStore();
  const ledger = createSteerLedger(store);
  // A：投递后未确认（dispatched）——重启恢复的主角。
  ledger.begin(beginInput({ steerId: "steer-A" }));
  ledger.markDispatched("steer-A", NOW + 1);
  // B：进程中断于投递前（仍 queued）。
  ledger.begin(beginInput({ steerId: "steer-B", content: "再把节奏放慢一点" }));
  // C：已有结论（applied 终态）——恢复扫描不得碰它。
  ledger.begin(beginInput({ steerId: "steer-C", content: "结尾补一个品牌镜头" }));
  ledger.markDispatched("steer-C", NOW + 2);
  ledger.settle("steer-C", "applied", NOW + 3);
  // D：别的会话——不得被本会话的恢复牵连。
  ledger.begin(beginInput({ steerId: "steer-D", sessionId: "ses_2" }));
  ledger.markDispatched("steer-D", NOW + 4);

  const flipped = ledger.recoverSession("ses_1", NOW + 100);
  assert.deepEqual(
    flipped.map((c) => c.steerId).sort(),
    ["steer-A", "steer-B"],
    "只有未终结的命令会被翻转",
  );
  const byId = (id: string) => store.rows.get(id)!;
  assert.equal(byId("steer-A").state, "uncertain", "投递后未确认 → uncertain（不是 applied/queued）");
  assert.equal(byId("steer-A").reason, "restart_unconfirmed");
  assert.equal(byId("steer-B").state, "uncertain", "投递前中断 → 同样 uncertain（队列 volatile，永不自动重发）");
  assert.equal(byId("steer-B").reason, "restart_never_dispatched");
  assert.equal(byId("steer-C").state, "applied", "已终态者不受恢复影响");
  assert.equal(byId("steer-D").state, "dispatched", "别的会话不被牵连");
  assert.equal(flipped.every((c) => c.settledAt === NOW + 100), true, "恢复即终态落地时刻");

  // 恢复是幂等的：第二次零动作（全部已终态）。
  assert.deepEqual(ledger.recoverSession("ses_1", NOW + 200), []);

  // 恢复后的重放（同一 id）被拒绝且是可辨识码——这就是「不得被重送」的持久保证。
  const replayA = ledger.begin(beginInput({ steerId: "steer-A" }));
  assert.equal(replayA.kind === "rejected" ? replayA.code : "", "steer_replay_settled");
  assert.equal(byId("steer-A").state, "uncertain", "重放不得把 uncertain 改成 queued 再送一次");
});

test("零记录＝零动作：空 store 的恢复不产生任何帧（无 steer 会话与改动前逐位等价）", () => {
  const ledger = createSteerLedger(memStore());
  assert.deepEqual(ledger.recoverSession("ses_none", NOW), []);
  assert.deepEqual(ledger.listBySession("ses_none"), []);
  assert.equal(ledger.get("steer-missing"), null);
});
