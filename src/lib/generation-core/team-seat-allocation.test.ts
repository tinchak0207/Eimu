// 席位 ↔ 配額分配（刀 3）真行為斷言測試：四條不變量逐字斷言。
//
// 假件沿用 member-quota.test.ts 的形狀：假 new-api（users.quota 帳號桶）＋假控制面
// SQL（team_member_quota / biz_api_key）。真行為 = 上游額度調整逐筆記錄。

import assert from "node:assert/strict";
import test from "node:test";

import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import type { GenerationSql } from "./database.ts";
import type { TeamLock } from "./member-quota.ts";
import { applySeatAllocation } from "./team-seat-allocation.ts";

const COIN = QUOTA_PER_COIN;
const CONTROL_PLANE_ENV = {
  GENERATION_DATABASE_URL: "postgres://fake:fake@127.0.0.1:1/fake",
  GENERATION_CONTROL_PLANE_ENABLED: "true",
};

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> | void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

// ── 假 new-api：users.quota ──────────────────────────────────────────────

function fakeNewApi(seed: {
  users: Record<number, { quota: number; used?: number }>;
  failAdjust?: (userId: number, delta: number) => boolean;
}) {
  const users = new Map<number, { quota: number; used: number }>();
  for (const [id, state] of Object.entries(seed.users)) {
    users.set(Number(id), { quota: state.quota, used: state.used ?? 0 });
  }
  const adjustments: { userId: number; delta: number }[] = [];

  const fetchUser = (async (userId: number) => {
    const current = users.get(userId);
    if (!current) return null;
    return { id: userId, username: `user-${userId}`, quota: current.quota, used_quota: current.used };
  }) as unknown as typeof import("@/lib/gateway-admin").fetchGatewayUser;

  const adjustUserQuota = (async (userId: number, deltaQuota: number) => {
    if (!Number.isFinite(deltaQuota) || deltaQuota === 0) return;
    const delta = Math.round(deltaQuota);
    const current = users.get(userId);
    if (!current) throw new Error(`no user ${userId}`);
    if (seed.failAdjust?.(userId, delta)) {
      throw new Error(`upstream rejected adjust of ${delta} on user ${userId}`);
    }
    current.quota += delta;
    adjustments.push({ userId, delta });
  }) as unknown as typeof import("@/lib/gateway-admin").adjustGatewayUserQuotaExact;

  function consume(userId: number, quota: number): void {
    const current = users.get(userId);
    if (!current) throw new Error(`no user ${userId}`);
    current.quota -= quota;
    current.used += quota;
  }

  function quotaOf(userId: number): number {
    const current = users.get(userId);
    if (!current) throw new Error(`no user ${userId}`);
    return current.quota;
  }

  return { adjustments, deps: { fetchUser, adjustUserQuota }, consume, quotaOf };
}

// ── 假控制面 SQL：biz_api_key + team_member_quota ─────────────────────────

interface FakeMemberRow {
  id: string;
  team_user_id: number;
  member_user_id: number;
  member_key_id: string;
  display_name: string | null;
  enabled: boolean;
  created_at: number;
}

function fakeControlPlane(seed: {
  keys: { id: string; label: string; user_id: number }[];
  members?: FakeMemberRow[];
}) {
  const members: FakeMemberRow[] = [...(seed.members ?? [])];
  const queries: string[] = [];
  let seq = members.length;

  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ? ");
    queries.push(query);
    if (query.includes("FROM team_member_quota")) {
      if (query.includes("WHERE member_user_id")) {
        return members.filter((m) => m.member_user_id === Number(values[0])).slice(0, 1);
      }
      if (query.includes("WHERE team_user_id")) {
        return members
          .filter((m) => m.team_user_id === Number(values[0]))
          .sort((a, b) => a.created_at - b.created_at);
      }
      return [];
    }
    if (query.includes("FROM biz_api_key")) {
      const key = seed.keys.find((candidate) => candidate.id === values[0]);
      if (!key) return [];
      return [{ id: key.id, label: key.label, user_id: key.user_id }];
    }
    if (query.includes("INSERT INTO team_member_quota")) {
      const [id, teamUserId, memberUserId, memberKeyId, displayName, enabled] = values as [
        string,
        number,
        number,
        string,
        string,
        boolean,
      ];
      const existing = members.find((m) => m.member_user_id === Number(memberUserId));
      if (existing) {
        existing.team_user_id = Number(teamUserId);
        existing.display_name = displayName;
        existing.enabled = enabled;
      } else {
        members.push({
          id,
          team_user_id: Number(teamUserId),
          member_user_id: Number(memberUserId),
          member_key_id: memberKeyId,
          display_name: displayName,
          enabled,
          created_at: seq++,
        });
      }
      return [];
    }
    return [];
  }) as unknown as GenerationSql;

  return { sql: tagged, members, queries };
}

function mutexLock(handle: GenerationSql): TeamLock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(_teamUserId: number, fn: (tx: GenerationSql) => Promise<T>): Promise<T> => {
    const run = tail.then(() => fn(handle));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** 成員 A（user 900，key-a）已在團隊 117 名冊。 */
function harness(options: { failAdjust?: (userId: number, delta: number) => boolean } = {}) {
  const cp = fakeControlPlane({
    keys: [{ id: "key-a", label: "成员A", user_id: 900 }],
    members: [
      {
        id: "member-key-a",
        team_user_id: 117,
        member_user_id: 900,
        member_key_id: "key-a",
        display_name: "成员A",
        enabled: true,
        created_at: 0,
      },
    ],
  });
  const api = fakeNewApi({ users: { 117: { quota: 1000 * COIN }, 900: { quota: 0 } }, ...options });
  return {
    cp,
    api,
    deps: { sql: cp.sql, withTeamLock: mutexLock(cp.sql), newMemberId: () => "member-new", ...api.deps },
  };
}

// ── 不變量 ①：分配 = 轉移 ＋ 總額守恆 ──────────────────────────────────

test("不變量①：席位数 × 每席位幣數 = 目標額度；主帳扣 Δ、成員加 Δ，全團隊總額守恆", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { api, deps } = harness();
    const before = api.quotaOf(117) + api.quotaOf(900);

    const result = await applySeatAllocation(
      { teamUserId: 117, memberUserId: 900, seats: 5, perSeatCoins: 40 },
      deps,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.memberKeyId, "key-a");
    assert.equal(result.targetCoins, 200, "5 席 × 40 币 = 200 币");
    assert.equal(result.targetQuota, 200 * COIN);
    assert.equal(result.granted, 200 * COIN);
    assert.equal(result.remaining, 200 * COIN);
    assert.equal(result.transferred, 200 * COIN);
    assert.equal(result.unchanged, false);

    // 兩條腿逐筆對稱：只有 allocateMemberQuota 這一條通路在動上游額度。
    assert.deepEqual(api.adjustments, [
      { userId: 117, delta: -200 * COIN },
      { userId: 900, delta: 200 * COIN },
    ]);
    assert.equal(api.quotaOf(117), 800 * COIN, "主帳扣掉本次劃出");
    assert.equal(api.quotaOf(900), 200 * COIN, "成員桶加上同額");
    assert.equal(api.quotaOf(117) + api.quotaOf(900), before, "總額守恆：沒有印錢也沒有蒸發");
  });
});

test("不變量①：成員消耗後分配仍守恆（主帳 + Σ成員桶 + Σ已用 = 常數）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { api, deps } = harness();
    const total = api.quotaOf(117);

    const first = await applySeatAllocation(
      { teamUserId: 117, memberUserId: 900, seats: 2, perSeatCoins: 100 },
      deps,
    );
    assert.equal(first.ok, true);
    api.consume(900, 50 * COIN); // 成員用掉 50 币（內核扣費）

    const second = await applySeatAllocation(
      { teamUserId: 117, memberUserId: 900, seats: 3, perSeatCoins: 100 },
      deps,
    );
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.transferred, 100 * COIN, "從 200 币加到 300 币，只補 100 币差額");
    assert.equal(api.quotaOf(117) + api.quotaOf(900) + 50 * COIN, total);
  });
});

// ── 不變量 ②：重放同請求不重複扣 ────────────────────────────────────────

test("不變量②：同請求重放是冪等 no-op（不再寫上游、不重複扣主帳）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { api, deps } = harness();
    const request = { teamUserId: 117, memberUserId: 900, seats: 4, perSeatCoins: 25 };

    const first = await applySeatAllocation(request, deps);
    assert.equal(first.ok === true ? first.unchanged : true, false);
    const afterFirst = api.adjustments.length;
    const master = api.quotaOf(117);

    const replay = await applySeatAllocation(request, deps);
    assert.equal(replay.ok, true);
    assert.equal(replay.ok === true ? replay.unchanged : false, true, "同目标值 = 幂等 no-op");
    assert.equal(replay.ok === true ? replay.transferred : 1, 0, "重放不得再转一次");
    assert.equal(api.adjustments.length, afterFirst, "重放不得产生新的上游调整");
    assert.equal(api.quotaOf(117), master, "重放不得重复扣主帐");
    assert.equal(api.quotaOf(900), 100 * COIN);
  });
});

test("不變量②：降低席位數 = 回收差額（同一操作的反向冪等）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { api, deps } = harness();
    await applySeatAllocation({ teamUserId: 117, memberUserId: 900, seats: 5, perSeatCoins: 40 }, deps);

    const shrink = await applySeatAllocation(
      { teamUserId: 117, memberUserId: 900, seats: 2, perSeatCoins: 40 },
      deps,
    );
    assert.equal(shrink.ok, true);
    assert.equal(shrink.ok === true ? shrink.transferred : 0, -120 * COIN, "80 币目标 → 从成员桶收回 120 币");
    assert.deepEqual(api.adjustments.slice(-2), [
      { userId: 900, delta: -120 * COIN },
      { userId: 117, delta: 120 * COIN },
    ]);
    assert.equal(api.quotaOf(117) + api.quotaOf(900), 1000 * COIN);
  });
});

// ── 不變量 ③：目標不得低於已消耗 ────────────────────────────────────────

test("不變量③：席位目標低於該成員已消耗 → 409 target_below_used，且不動上游", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { api, deps } = harness();
    // 成員桶已有 300 币，其中已消耗 150 币。
    await applySeatAllocation({ teamUserId: 117, memberUserId: 900, seats: 3, perSeatCoins: 100 }, deps);
    api.consume(900, 150 * COIN);
    const adjustmentsBefore = api.adjustments.length;

    // 目標 = 1 席 × 100 币 = 100 币 < 已消耗 150 币。
    const result = await applySeatAllocation(
      { teamUserId: 117, memberUserId: 900, seats: 1, perSeatCoins: 100 },
      deps,
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.status : 0, 409);
    assert.equal(result.ok === false ? result.code : "", "target_below_used");
    assert.equal(api.adjustments.length, adjustmentsBefore, "被拒时不得动上游");
    assert.equal(api.quotaOf(900), 150 * COIN, "成员桶剩余不变（已消耗部分不可回收）");
  });
});

test("不變量③：主帳手上餘額不足 → 402 insufficient_team_quota（不超賣）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { api, deps } = harness();
    const result = await applySeatAllocation(
      { teamUserId: 117, memberUserId: 900, seats: 50, perSeatCoins: 40 },
      deps,
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.status : 0, 402);
    assert.equal(result.ok === false ? result.code : "", "insufficient_team_quota");
    assert.equal(api.adjustments.length, 0);
    assert.equal(api.quotaOf(117), 1000 * COIN);
  });
});

// ── 不變量 ④：失敗回滾不留半邊 ──────────────────────────────────────────

test("不變量④：成員那條腿失敗即回滾 —— 主帳回到原值、成員桶為 0，不憑空印額度", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { api, deps } = harness({ failAdjust: (userId, delta) => userId === 900 && delta > 0 });

    const result = await applySeatAllocation(
      { teamUserId: 117, memberUserId: 900, seats: 5, perSeatCoins: 40 },
      deps,
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.status : 0, 503);
    assert.equal(result.ok === false ? result.code : "", "member_quota_unavailable");
    assert.equal(api.quotaOf(117), 1000 * COIN, "主帳必须被回滚到原值");
    assert.equal(api.quotaOf(900), 0, "成员桶不得留下半邊");
    assert.deepEqual(api.adjustments, [
      { userId: 117, delta: -200 * COIN },
      { userId: 117, delta: 200 * COIN },
    ], "先扣後加：第二條腿失敗 → 第一條腿被回滾");
  });
});

// ── 邊界與歸屬校驗 ──────────────────────────────────────────────────────

test("邊界：席位/每席位幣數/團隊非法各自被拒，且不動上游", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { api, deps } = harness();
    const cases: { input: Parameters<typeof applySeatAllocation>[0]; status: number; code: string }[] = [
      { input: { teamUserId: 117, memberUserId: 900, seats: 0, perSeatCoins: 40 }, status: 400, code: "invalid_seats" },
      { input: { teamUserId: 117, memberUserId: 900, seats: 1.5, perSeatCoins: 40 }, status: 400, code: "invalid_seats" },
      { input: { teamUserId: 117, memberUserId: 900, seats: -2, perSeatCoins: 40 }, status: 400, code: "invalid_seats" },
      { input: { teamUserId: 117, memberUserId: 900, seats: 5, perSeatCoins: 0 }, status: 400, code: "invalid_per_seat_coins" },
      { input: { teamUserId: 117, memberUserId: 900, seats: 5, perSeatCoins: -1 }, status: 400, code: "invalid_per_seat_coins" },
      { input: { teamUserId: 0, memberUserId: 900, seats: 5, perSeatCoins: 40 }, status: 503, code: "invalid_team" },
      { input: { teamUserId: 117, memberUserId: 117, seats: 5, perSeatCoins: 40 }, status: 403, code: "team_mismatch" },
    ];
    for (const item of cases) {
      const result = await applySeatAllocation(item.input, deps);
      assert.equal(result.ok, false, JSON.stringify(item.input));
      assert.equal(result.ok === false ? result.status : 0, item.status, JSON.stringify(item.input));
      assert.equal(result.ok === false ? result.code : "", item.code, JSON.stringify(item.input));
    }
    assert.equal(api.adjustments.length, 0);
  });
});

test("歸屬校驗：未入名冊的成員 → 404；歸屬別家團隊的成員 → 403，皆不動上游", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { api, deps } = harness();
    const unknown = await applySeatAllocation(
      { teamUserId: 117, memberUserId: 901, seats: 1, perSeatCoins: 10 },
      deps,
    );
    assert.equal(unknown.ok === false ? unknown.status : 0, 404);
    assert.equal(unknown.ok === false ? unknown.code : "", "member_not_registered");

    const foreign = await applySeatAllocation(
      { teamUserId: 999, memberUserId: 900, seats: 1, perSeatCoins: 10 },
      deps,
    );
    assert.equal(foreign.ok === false ? foreign.status : 0, 403);
    assert.equal(foreign.ok === false ? foreign.code : "", "team_mismatch");
    assert.equal(api.adjustments.length, 0);
  });
});

test("唯一通路：控制面未配置時 fail-closed（503），不落任何本地點數", async () => {
  await withEnv(
    { GENERATION_DATABASE_URL: undefined, GENERATION_CONTROL_PLANE_ENABLED: undefined },
    async () => {
      const result = await applySeatAllocation(
        { teamUserId: 117, memberUserId: 900, seats: 5, perSeatCoins: 40 },
        {},
      );
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.status : 0, 503);
      assert.equal(result.ok === false ? result.code : "", "allocation_unavailable");
    },
  );
});
