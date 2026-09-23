// steer-identity.test.ts —— REQ-D2b（steer 持久命令身份＋uncertain 態＋tombstone）的
// 純核心具名測試。這裡的每一條都是**真實行為斷言**（真函數、真輸入→真輸出）；
// 唯一的外部 oracle 是 GNU coreutils 的 sha256sum（獨立於本檔的 JS 實作，防同源斷言）。
//
// 持久層（bun:sqlite）與真實 HTTP 受理端在 steer-ledger-db.test.ts（bun 直跑，
// tsx 載不動 bun:sqlite），本檔只釘語義。
//
// 跑法（必帶超時）：
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

/** 記憶體替身 store（介面與 persistence.steerCommandStore 逐字同形）。 */
function memStore(): SteerLedgerStore & { rows: Map<string, SteerCommand> } {
  const rows = new Map<string, SteerCommand>();
  return {
    rows,
    read(steerId) {
      const direct = rows.get(steerId);
      if (direct) return direct;
      // 別名命中（生產側由 SQL 的 alias_ids LIKE 完成，語義相同）。
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

// ─────────────── ① 狀態機：六態（上屏）／七態（持久）流轉合法、終態凍結 ───────────────

test("狀態機流轉表：queued→dispatched→applied/injected/failed/uncertain/aborted 合法，終態零出邊", () => {
  // 值域本身是契約（前端 AGENT_STEER_STATUSES 與上屏狀態逐字對齊）。
  assert.deepEqual(
    [...STEER_COMMAND_STATES],
    ["queued", "dispatched", "applied", "injected", "failed", "uncertain", "aborted"],
  );
  assert.deepEqual([...STEER_TERMINAL_STATES], ["applied", "injected", "failed", "uncertain", "aborted"]);

  // 主線：queued → dispatched → 五個終態（applied/injected/failed/uncertain/aborted）。
  assert.equal(isLegalSteerTransition("queued", "dispatched"), true);
  for (const t of ["applied", "injected", "failed", "uncertain", "aborted"] as const) {
    assert.equal(isLegalSteerTransition("dispatched", t), true, `dispatched → ${t} 必須合法`);
  }
  // 未投遞就能落終態（停止優先／逾時／重啟前未投遞）：queued → failed/aborted/uncertain。
  for (const t of ["failed", "aborted", "uncertain"] as const) {
    assert.equal(isLegalSteerTransition("queued", t), true, `queued → ${t} 必須合法`);
  }
  // 終態零出邊＝凍結（含 uncertain 不得被遲到幀改寫）。
  for (const from of STEER_TERMINAL_STATES) {
    assert.deepEqual([...STEER_STATE_TRANSITIONS[from]], [], `${from} 是終態，不得有出邊`);
    for (const to of STEER_COMMAND_STATES) {
      assert.equal(isLegalSteerTransition(from, to), false, `${from} → ${to} 必須非法`);
    }
  }
  // 不得跳過 dispatched 直接自稱已投遞成功語義之外的亂跳。
  assert.equal(isLegalSteerTransition("queued", "queued"), false, "同態不是合法流轉（ledger 另有冪等分支）");
  assert.equal(isLegalSteerTransition("dispatched", "dispatched"), false);

  // 上屏映射：dispatched 是內部在途態，對使用者仍是「排隊中」（尚未確認就不許說已生效）。
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

// ─────────────── ② payload 凍結：內容 + turn/session 標識都進哈希 ───────────────

test("payload 凍結：hash 與獨立實作（sha256sum）逐字相等，且對內容/turn/session 敏感", () => {
  const frozen = freezeSteerPayload({
    steerId: "steer-aaa-1",
    sessionId: "ses_1",
    opencodeSessionId: "oc_1",
    turnGen: 3,
    content: "先改成冷色调",
  });
  // 獨立 oracle：GNU coreutils 的 sha256sum（不是本檔的 node:crypto 實作）。
  const external = execFileSync("sha256sum", { input: frozen.canonical, encoding: "utf8" }).split(/\s+/)[0];
  assert.equal(frozen.payloadHash, external, "payload hash 必須等於獨立工具對同一 canonical 字串的結果");
  assert.match(frozen.payloadHash, /^[0-9a-f]{64}$/);

  // 決定性：同輸入同哈希（重放比對才成立）。
  const again = freezeSteerPayload({
    steerId: "steer-aaa-1",
    sessionId: "ses_1",
    opencodeSessionId: "oc_1",
    turnGen: 3,
    content: "先改成冷色调",
  });
  assert.equal(again.payloadHash, frozen.payloadHash);

  // 敏感度：content / session / opencode session / turn 任一改變 → 不同哈希
  //（身份覆蓋「內容與關聯 turn/session 標識」＝同一 id 帶不同內容必被認出）。
  const variants = [
    { content: "把节奏放慢一点" },
    { sessionId: "ses_2" },
    { opencodeSessionId: "oc_2" },
    { turnGen: 4 },
  ];
  const base = { steerId: "steer-aaa-1", sessionId: "ses_1", opencodeSessionId: "oc_1", turnGen: 3, content: "先改成冷色调" };
  for (const patch of variants) {
    const h = freezeSteerPayload({ ...base, ...patch }).payloadHash;
    assert.notEqual(h, frozen.payloadHash, `改了 ${Object.keys(patch)[0]} 之後哈希必須變`);
  }
  // steerId 不進哈希（它是主鍵身份，不是 payload 的一部分）——同內容同 turn 必同哈希。
  assert.equal(
    freezeSteerPayload({ ...base, steerId: "steer-bbb-9" }).payloadHash,
    frozen.payloadHash,
  );
  // canonical 形態：鍵序固定（sha256sum 對照的前提），且不含時間（重試不得算出第二種哈希）。
  assert.equal(
    canonicalSteerPayload(base),
    '{"content":"先改成冷色调","session_id":"ses_1","opencode_session_id":"oc_1","turn_gen":3}',
  );
});

// ─────────────── ③ 受理判定：同 id 重放一律可辨識拒絕 ───────────────

test("受理判定：終態→replay_settled、在途→replay_in_flight、同 id 改內容→payload_mismatch、跨會話→id_conflict", () => {
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
  // 同 id 但在途 + 內容/hash 不同：拒絕（還會被投遞的指令不得被改寫）。
  assert.equal(
    planSteerBegin({ ...settled, state: "dispatched" }, { steerId: "s1", sessionId: "ses_1", payloadHash: "h2" })?.code,
    "steer_payload_mismatch",
  );
  // 已終態 + 內容/hash 不同：仍然回「已有結論」（終態判定優先於 payload 比對）——
  // 實錘：重啟後 turnGen 由 DB 恢復為 0，同一條指引的正常重放會漂移出不同 hash，
  // 若先比 payload 就會把「已結案」誤報成「內容不同」。
  assert.equal(planSteerBegin(settled, { steerId: "s1", sessionId: "ses_1", payloadHash: "h2" })?.code, "steer_replay_settled");
  // 同 id 屬別 session：拒絕。
  assert.equal(
    planSteerBegin(settled, { steerId: "s1", sessionId: "ses_2", payloadHash: "h1" })?.code,
    "steer_id_conflict",
  );
  // 全新 id：放行（null＝沒有既有記錄）。
  assert.equal(planSteerBegin(null, { steerId: "s9", sessionId: "ses_1", payloadHash: "h1" }), null);
});

// ─────────────── ④ ledger：投遞前落地、終態凍結、別名覆蓋、重啟落 uncertain ───────────────

test("ledger 受理：begin 立刻落地（投遞前），同 id 重放被拒且不覆寫既有記錄", () => {
  const store = memStore();
  const ledger = createSteerLedger(store);

  const first = ledger.begin(beginInput());
  assert.equal(first.kind, "accepted");
  assert.equal(first.kind === "accepted" ? first.command.state : "", "queued");
  assert.equal(store.rows.size, 1, "begin 必須立刻寫入持久層（投遞之前的身份落地）");
  const row = store.rows.get("steer-aaa-1")!;
  assert.equal(row.payloadHash, freezeSteerPayload({ steerId: "steer-aaa-1", sessionId: "ses_1", opencodeSessionId: "oc_1", turnGen: 3, content: "先改成冷色调" }).payloadHash);
  assert.equal(row.ownerKey, "sk-test");
  assert.equal(row.dispatchedAt, undefined, "還沒投遞：不得有 dispatchedAt");

  // 同 id 重放（同內容）：in_flight 拒絕（它還活著），不得長出第二條、不得覆寫。
  const replay = ledger.begin(beginInput({ now: NOW + 500 }));
  assert.equal(replay.kind, "rejected");
  assert.equal(replay.kind === "rejected" ? replay.code : "", "steer_replay_in_flight");
  assert.equal(store.rows.size, 1);
  assert.equal(store.rows.get("steer-aaa-1")!.at, NOW, "既有記錄不得被重放覆寫（at 不變）");

  // 同 id 改內容（重放帶了改寫過的正文）：payload_mismatch，仍不覆寫。
  const edited = ledger.begin(beginInput({ content: "完全不同的说法", now: NOW + 600 }));
  assert.equal(edited.kind === "rejected" ? edited.code : "", "steer_payload_mismatch");
  assert.equal(store.rows.get("steer-aaa-1")!.payloadHash, row.payloadHash);
});

test("ledger 生命週期：dispatched → applied 後終態凍結；uncertain 不得被遲到幀改寫", () => {
  const store = memStore();
  const ledger = createSteerLedger(store);
  ledger.begin(beginInput());

  assert.equal(ledger.markDispatched("steer-aaa-1", NOW + 10).kind, "settled");
  assert.equal(store.rows.get("steer-aaa-1")!.state, "dispatched");
  assert.equal(store.rows.get("steer-aaa-1")!.dispatchedAt, NOW + 10);
  // 重入 dispatch＝冪等成功（注入腿落回排隊腿時會再標一次），不得當成非法流轉。
  assert.equal(ledger.markDispatched("steer-aaa-1", NOW + 11).kind, "settled");
  assert.equal(store.rows.get("steer-aaa-1")!.dispatchedAt, NOW + 10, "第二次標記不得改寫既有時刻");

  const applied = ledger.settle("steer-aaa-1", "applied", NOW + 20);
  assert.equal(applied.kind, "settled");
  assert.equal(store.rows.get("steer-aaa-1")!.state, "applied");
  assert.equal(store.rows.get("steer-aaa-1")!.settledAt, NOW + 20);
  // 終態再改（遲到的 failed/injected 幀）→ 拒絕且不寫盤。
  const late = ledger.settle("steer-aaa-1", "failed", NOW + 30, "late_frame");
  assert.equal(late.kind, "refused");
  assert.equal(late.kind === "refused" ? late.reason : "", "terminal");
  assert.equal(store.rows.get("steer-aaa-1")!.state, "applied");
  assert.equal(store.rows.get("steer-aaa-1")!.settledAt, NOW + 20, "凍結後時刻也不得變");

  // 未知 id 不憑空造記錄。
  const ghost = ledger.settle("steer-nope", "applied", NOW);
  assert.equal(ghost.kind === "refused" ? ghost.reason : "", "unknown");
  assert.equal(store.rows.size, 1);

  // uncertain 專項：落 uncertain 之後任何遲到幀（applied/injected/queued）都動不了它。
  const store2 = memStore();
  const ledger2 = createSteerLedger(store2);
  ledger2.begin(beginInput({ steerId: "steer-u-1" }));
  ledger2.markDispatched("steer-u-1", NOW + 1);
  assert.equal(ledger2.settle("steer-u-1", "uncertain", NOW + 2, "restart_unconfirmed").kind, "settled");
  for (const late of ["applied", "injected", "failed", "aborted"] as const) {
    assert.equal(ledger2.settle("steer-u-1", late, NOW + 3).kind, "refused", `uncertain 不得被 ${late} 改寫`);
  }
  assert.equal(ledger2.markDispatched("steer-u-1", NOW + 4).kind, "refused");
  assert.equal(store2.rows.get("steer-u-1")!.state, "uncertain");
});

test("別名 id：同文去重的第二個 id 記進同一條記錄，其重放同樣被 tombstone 擋住", () => {
  const store = memStore();
  const ledger = createSteerLedger(store);
  ledger.begin(beginInput({ steerId: "steer-main", content: "先改成冷色调" }));
  ledger.addAlias("steer-main", "steer-alias");
  const row = store.rows.get("steer-main")!;
  assert.deepEqual(row.aliasIds, ["steer-alias"]);

  // 別名重放（同內容）：命中同一條記錄 → 在途拒絕；不得長出第二顆記錄。
  const replay = ledger.begin(beginInput({ steerId: "steer-alias", content: "先改成冷色调", now: NOW + 5 }));
  assert.equal(replay.kind === "rejected" ? replay.code : "", "steer_replay_in_flight");
  assert.equal(store.rows.size, 1);
  // 別名也查得到（生產側由 alias_ids LIKE 完成）。
  assert.equal(ledger.get("steer-alias")?.steerId, "steer-main");

  // 終態化之後：本體與別名兩條 id 的重放都是 settled（tombstone 覆蓋全 id）。
  ledger.markDispatched("steer-main", NOW + 6);
  ledger.settle("steer-main", "applied", NOW + 7);
  assert.equal(ledger.begin(beginInput({ steerId: "steer-main", content: "先改成冷色调" })).kind === "rejected" ? "ok" : "", "ok");
  assert.equal(ledger.begin(beginInput({ steerId: "steer-alias", content: "先改成冷色调" })).kind === "rejected" ? "ok" : "", "ok");
  assert.equal(ledger.get("steer-main")?.state, "applied");
});

test("重啟恢復：未終結一律落 uncertain（永不自動重發），已終態者紋絲不動", () => {
  const store = memStore();
  const ledger = createSteerLedger(store);
  // A：投遞後未確認（dispatched）——重啟恢復的主角。
  ledger.begin(beginInput({ steerId: "steer-A" }));
  ledger.markDispatched("steer-A", NOW + 1);
  // B：進程中斷於投遞前（仍 queued）。
  ledger.begin(beginInput({ steerId: "steer-B", content: "再把节奏放慢一点" }));
  // C：已有結論（applied 終態）——恢復掃描不得碰它。
  ledger.begin(beginInput({ steerId: "steer-C", content: "结尾补一个品牌镜头" }));
  ledger.markDispatched("steer-C", NOW + 2);
  ledger.settle("steer-C", "applied", NOW + 3);
  // D：別的會話——不得被本會話的恢復牽連。
  ledger.begin(beginInput({ steerId: "steer-D", sessionId: "ses_2" }));
  ledger.markDispatched("steer-D", NOW + 4);

  const flipped = ledger.recoverSession("ses_1", NOW + 100);
  assert.deepEqual(
    flipped.map((c) => c.steerId).sort(),
    ["steer-A", "steer-B"],
    "只有未終結的命令會被翻轉",
  );
  const byId = (id: string) => store.rows.get(id)!;
  assert.equal(byId("steer-A").state, "uncertain", "投遞後未確認 → uncertain（不是 applied/queued）");
  assert.equal(byId("steer-A").reason, "restart_unconfirmed");
  assert.equal(byId("steer-B").state, "uncertain", "投遞前中斷 → 同樣 uncertain（隊列 volatile，永不自動重發）");
  assert.equal(byId("steer-B").reason, "restart_never_dispatched");
  assert.equal(byId("steer-C").state, "applied", "已終態者不受恢復影響");
  assert.equal(byId("steer-D").state, "dispatched", "別的會話不被牽連");
  assert.equal(flipped.every((c) => c.settledAt === NOW + 100), true, "恢復即終態落地時刻");

  // 恢復是冪等的：第二次零動作（全部已終態）。
  assert.deepEqual(ledger.recoverSession("ses_1", NOW + 200), []);

  // 恢復後的重放（同一 id）被拒絕且是可辨識碼——這就是「不得被重送」的持久保證。
  const replayA = ledger.begin(beginInput({ steerId: "steer-A" }));
  assert.equal(replayA.kind === "rejected" ? replayA.code : "", "steer_replay_settled");
  assert.equal(byId("steer-A").state, "uncertain", "重放不得把 uncertain 改成 queued 再送一次");
});

test("零記錄＝零動作：空 store 的恢復不產生任何幀（無 steer 會話與改動前逐位等價）", () => {
  const ledger = createSteerLedger(memStore());
  assert.deepEqual(ledger.recoverSession("ses_none", NOW), []);
  assert.deepEqual(ledger.listBySession("ses_none"), []);
  assert.equal(ledger.get("steer-missing"), null);
});
