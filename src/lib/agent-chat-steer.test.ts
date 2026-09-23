// agent-chat-steer.test.ts —— REQ-D2（steer 回合中引导）前端语义回归。
//
// 与 gateway 侧 steer-core.test.ts 配对：那边钉队列代数（顺序/上限/停止优先），
// 这边钉「状态怎么落到用户气泡上」——徽章值域、终态不回退、找不到 id 不凭空造条目、
// 停止优先的本地改判、以及无 steer 时模型逐位等价。
// 跑法（必带超时）：timeout 240 npx tsx --test src/lib/agent-chat-steer.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_STEER_QUEUE_TTL_MS,
  AGENT_STEER_STATUSES,
  EMPTY_AGENT_CHAT_STATE,
  parseAgentSseEvent,
  type AgentChatState,
  type AgentUserTurnItem,
} from "./agent-chat-types";
import {
  appendUserTurn,
  applySteerRejection,
  applySteerStatus,
  expireQueuedSteers,
  markQueuedSteersAborted,
} from "./agent-chat-reducer";

/** 造一个「回合进行中 + 已乐观插入一条 steer」的 state。 */
function stateWithSteer(status: (typeof AGENT_STEER_STATUSES)[number] = "queued"): AgentChatState {
  return appendUserTurn(
    { ...EMPTY_AGENT_CHAT_STATE, turnActive: true },
    "先改成冷色调",
    undefined,
    { id: "steer-1", status },
  );
}

function steerItem(state: AgentChatState): AgentUserTurnItem {
  const item = state.items.find((i): i is AgentUserTurnItem => i.kind === "user");
  assert.ok(item, "必须有一条用户条目");
  return item;
}

test("steer 徽章：排隊中 → 已注入/已生效，状态逐帧落到同一条目上", () => {
  let state = stateWithSteer("queued");
  assert.equal(steerItem(state).steer?.status, "queued");
  assert.equal(steerItem(state).steer?.id, "steer-1");

  // 真注入：回合卡在 question 断点 → 本回合内生效（这是 D2 唯一「同回合生效」的形态）。
  const injected = applySteerStatus(state, "steer-1", "injected");
  assert.equal(steerItem(injected).steer?.status, "injected");
  assert.equal(injected.items.length, state.items.length, "状态更新不得新增条目");

  // 诚实排队 → 本回合收尾投递成功（下一回合生效）。
  state = stateWithSteer("queued");
  const applied = applySteerStatus(state, "steer-1", "applied");
  assert.equal(steerItem(applied).steer?.status, "applied");
});

test("steer 状态终态不回退：已生效后再来的 queued 帧不得打回「排队中」", () => {
  const applied = applySteerStatus(stateWithSteer("applied"), "steer-1", "queued");
  assert.equal(steerItem(applied).steer?.status, "applied", "终态（applied）不被迟到的 queued 帧回退");

  const aborted = applySteerStatus(stateWithSteer("aborted"), "steer-1", "injected");
  assert.equal(steerItem(aborted).steer?.status, "aborted", "已中止也不许被 injected 帧复活");
});

test("找不到 id / 不是 steer 条目：原样返回，不凭空造条目（无 steer 回归保护）", () => {
  // ① 普通用户消息（无 steer 徽章）遇到 steer.status 帧：状态原样返回。
  const plain = appendUserTurn({ ...EMPTY_AGENT_CHAT_STATE, turnActive: true }, "这是一条普通消息");
  assert.equal(steerItem(plain).steer, undefined, "不带 steer 的乐观插入不得长出 steer 字段");
  assert.equal(applySteerStatus(plain, "steer-1", "applied"), plain, "无匹配条目 = 同一个 reference（React 可 bail out）");

  // ② id 对不上（重连丢了乐观条目）：不新增、不改动。
  const state = stateWithSteer("queued");
  assert.equal(applySteerStatus(state, "steer-other", "applied"), state);
  assert.equal(applySteerStatus(state, "steer-other", "aborted"), state);
});

test("停止优先于 steer：按停止只改判排队中的，已注入/已生效的不动", () => {
  const mixed: AgentChatState = {
    ...EMPTY_AGENT_CHAT_STATE,
    turnActive: true,
    items: [
      appendUserTurn(EMPTY_AGENT_CHAT_STATE, "第一条", undefined, { id: "steer-a", status: "queued" }).items[0],
      appendUserTurn(
        { ...EMPTY_AGENT_CHAT_STATE, items: [] },
        "第二条",
        undefined,
        { id: "steer-b", status: "injected" },
      ).items[0],
      appendUserTurn(EMPTY_AGENT_CHAT_STATE, "第三条", undefined, { id: "steer-c", status: "applied" }).items[0],
    ],
  };

  const after = markQueuedSteersAborted(mixed);
  const byText = (t: string) =>
    after.items.find((i): i is AgentUserTurnItem => i.kind === "user" && i.text === t);
  assert.equal(byText("第一条")?.steer?.status, "aborted", "排队中的那条随停止作废（未生效）");
  assert.equal(byText("第二条")?.steer?.status, "injected", "已注入本回合的不受停止影响（它已经生效过了）");
  assert.equal(byText("第三条")?.steer?.status, "applied", "已生效的同样不动");

  // 没有排队中的 steer 时是同一个 reference（不触发多余渲染）。
  const noQueued = applySteerStatus(stateWithSteer("injected"), "steer-1", "injected");
  assert.equal(markQueuedSteersAborted(noQueued), noQueued);
});

test("steer.status 帧解析：值域白名单，缺 id 或状态不在值域整帧丢弃", () => {
  const ok = parseAgentSseEvent("steer.status", JSON.stringify({ steer_id: "steer-1", status: "queued", position: 2 }));
  assert.ok(ok, "合法帧要能解析");
  assert.deepEqual(ok?.data, { steer_id: "steer-1", status: "queued", position: 2 });

  assert.equal(
    parseAgentSseEvent("steer.status", JSON.stringify({ steer_id: "steer-1", status: "made_up" })),
    null,
    "认不得的状态整帧丢（不猜、不上屏）",
  );
  assert.equal(
    parseAgentSseEvent("steer.status", JSON.stringify({ status: "queued" })),
    null,
    "缺 steer_id 整帧丢",
  );
  // 值域与网關 steer-core.ts 逐字对齐：多一个/少一个都会在这里红。
  // uncertain 是 D2b（2026-09-23）新增的第六態（未確認·未重送）——同一條鐵律：
  // 兩邊值域必須逐字同步，否則網關送來的 uncertain 幀會被這裡整幀丟掉。
  assert.deepEqual([...AGENT_STEER_STATUSES], ["queued", "injected", "applied", "aborted", "failed", "uncertain"]);
});

// ─────────────── F-D2（2026-09-23）對抗性驗收缺陷的具名回歸 ───────────────

test("D2-5 injected 是终态：迟到的 queued 帧不得把「已注入本回合」打回「排队中」", () => {
  const injected = stateWithSteer("injected");
  assert.equal(
    steerItem(applySteerStatus(injected, "steer-1", "queued", 2)).steer?.status,
    "injected",
    "已注入＝已经在本回合生效过的事實，重连回放的 queued 帧不得回退",
  );
  // 同一 reference（终态冻结＝零改动，React 可 bail out）。
  assert.equal(applySteerStatus(injected, "steer-1", "injected"), injected);
  // 终态之间也不许互相覆盖：已中止不得被迟到的 injected 帧「复活」成已生效。
  assert.equal(
    steerItem(applySteerStatus(stateWithSteer("aborted"), "steer-1", "injected")).steer?.status,
    "aborted",
  );
  assert.equal(
    steerItem(applySteerStatus(stateWithSteer("failed"), "steer-1", "applied")).steer?.status,
    "failed",
  );
});

test("D2-3 排队逾时清扫：TTL 内不动，逾时翻「未能送达（未生效）」，且不留无锚点的永动机徽章", () => {
  const TTL = AGENT_STEER_QUEUE_TTL_MS;
  assert.equal(TTL, 30 * 60 * 1000, "TTL 是合約值，必须与网關 steer-core.STEER_QUEUE_TTL_MS 等值（见 UI 测试的镜像锁）");

  // ① 入队即打锚点（本地 ack 带 queuedAt）：未逾时不动。
  const fresh = applySteerStatus(stateWithSteer("queued"), "steer-1", "queued", 1, 1_000);
  assert.equal(steerItem(fresh).steer?.queuedAt, 1_000, "queued 落账时记下本端入队时刻");
  assert.equal(expireQueuedSteers(fresh, { now: 1_000 + TTL - 1, ttlMs: TTL }), fresh, "未逾时＝同一 reference");

  // ② 逾时：翻 failed（终态），徽章文案随之变「引导未能送达（未生效）」——不再排队中。
  const expired = expireQueuedSteers(fresh, { now: 1_000 + TTL, ttlMs: TTL });
  assert.equal(steerItem(expired).steer?.status, "failed", "逾时不得留在「排队中」");
  assert.equal(expired.items.length, fresh.items.length, "只改状态，不新增/删除条目");
  // ③ 翻完之后不再被任何帧（含迟到的 applied）改回来——它已经是终态。
  assert.equal(steerItem(applySteerStatus(expired, "steer-1", "applied")).steer?.status, "failed");

  // ④ 存档还原场景（网關重启后 pendingSteers 消失，永远不会有终态帧）：
  //    以存档时刻为兜底锚点——存档已 40 分钟前的「排队中」必须当场落 failed。
  const restored = appendUserTurn(
    { ...EMPTY_AGENT_CHAT_STATE, turnActive: false },
    "先改成冷色调",
    undefined,
    { id: "steer-1", status: "queued" },
  );
  const stale = expireQueuedSteers(restored, { now: 40 * 60 * 1000, ttlMs: TTL, baselineAt: 0 });
  assert.equal(steerItem(stale).steer?.status, "failed", "逾时的存档徽章不得原样复活成「排队中」");

  // ⑤ 存档很新（刚刷新页面）：先保留排队中，但把锚点写回条目，下一趟才判得动
  //    （绝不留「无锚点 = 永远排队中」的永动机）。
  const freshRestore = expireQueuedSteers(restored, { now: 5_000, ttlMs: TTL, baselineAt: 4_000 });
  assert.equal(steerItem(freshRestore).steer?.status, "queued", "时窗内允许它还是排队中（网關那边可能真的还握着）");
  assert.equal(steerItem(freshRestore).steer?.queuedAt, 4_000, "锚点必须写回，否则下一趟判不动＝永久排队中");
  assert.equal(
    steerItem(expireQueuedSteers(freshRestore, { now: 4_000 + TTL, ttlMs: TTL })).steer?.status,
    "failed",
    "锚点落地后，逾时照样收口",
  );

  // ⑥ 无基准（既无 queuedAt 也无 baselineAt）＝不动它，也不凭空猜。
  assert.equal(expireQueuedSteers(restored, { now: 10 ** 12, ttlMs: TTL }), restored);
});

// ─────────────── F-D2b（2026-09-23）：第六态 uncertain 与重放拒绝的徽章纠正 ───────────────

test("D2b 第六态 uncertain：真帧能上屏，且迟到的 queued/applied 不得改写它", () => {
  assert.ok(
    (AGENT_STEER_STATUSES as readonly string[]).includes("uncertain"),
    "值域必须含 uncertain（否则网關的帧会被整帧丢弃，徽章永远停在旧状态）",
  );

  // 真帧解析（网關 steer.status 帧的形状），值域不一致会在这里整帧被丢。
  const parsed = parseAgentSseEvent(
    "steer.status",
    JSON.stringify({ steer_id: "steer-1", status: "uncertain", reason: "restart_unconfirmed", event_id: 9 }),
  );
  assert.ok(parsed && parsed.name === "steer.status", "uncertain 帧必须能解析出事件");
  assert.equal(parsed.data.steer_id, "steer-1");
  assert.equal(parsed.data.status, "uncertain");
  assert.equal(parsed.data.reason, "restart_unconfirmed");

  // 落地：排队中 → 未确认（网關重啟后永不自动重发）。
  let state = applySteerStatus(stateWithSteer("queued"), "steer-1", "uncertain");
  assert.equal(steerItem(state).steer?.status, "uncertain");
  // 迟到的 applied（模型其实收到了？不知道——所以不许改写）与迟到的 queued 都动不了它。
  state = applySteerStatus(state, "steer-1", "applied");
  assert.equal(steerItem(state).steer?.status, "uncertain", "uncertain 是终态：迟到的 applied 不得改写");
  state = applySteerStatus(state, "steer-1", "queued");
  assert.equal(steerItem(state).steer?.status, "uncertain", "uncertain 不得被打回排队中");
  // uncertain 也不会被 TTL 清扫动（它已不是 queued），更不会被停止改判复活。
  assert.equal(expireQueuedSteers(state, { now: 10 ** 12, ttlMs: AGENT_STEER_QUEUE_TTL_MS }).items.length, state.items.length);
  assert.equal(steerItem(markQueuedSteersAborted(state)).steer?.status, "uncertain");
});

test("D2b 重放被拒的徽章纠正：本地占位 failed 可被网關事实纠正，网关终态不得被覆盖", () => {
  // hook 的 catch 先按「未能送达」占位（本地猜测），随后用网關带回的真实状态纠正。
  const failed = applySteerStatus(stateWithSteer("queued"), "steer-1", "failed");
  assert.equal(steerItem(failed).steer?.status, "failed");

  const corrected = applySteerRejection(failed, "steer-1", "uncertain");
  assert.equal(steerItem(corrected).steer?.status, "uncertain", "重放被拒时徽章必须说「未确认·未重送」而不是猜「未能送达」");
  assert.equal(corrected.items.length, failed.items.length, "纠正不得新增/删除条目");

  // 纠正目标不含 queued（那会回到等不到终态的排队中）。
  assert.equal(steerItem(applySteerRejection(failed, "steer-1", "queued")).steer?.status, "failed");

  // 已是网關-authored 终态：一概不动（终态冻结）。
  const uncertain = applySteerStatus(stateWithSteer("queued"), "steer-1", "uncertain");
  assert.equal(steerItem(applySteerRejection(uncertain, "steer-1", "applied")).steer?.status, "uncertain");
  const applied = applySteerStatus(stateWithSteer("queued"), "steer-1", "applied");
  assert.equal(steerItem(applySteerRejection(applied, "steer-1", "aborted")).steer?.status, "applied");

  // 找不到 id：不凭空造条目、也不报错。
  assert.equal(steerItem(applySteerRejection(failed, "steer-nope", "uncertain")).steer?.status, "failed");
  // 排队锚点保留（queuedAt 不该被纠正抹掉）。
  assert.equal(steerItem(corrected).steer?.queuedAt, steerItem(failed).steer?.queuedAt);
});
