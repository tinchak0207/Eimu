// B1 成员点数配额（REQ-B1）测试：映射层 + 分配/回收 + 可视面 + 端到端口径（user 层模型）。
//
// 全部走注入的假 new-api（users.quota：主帐帐号 + 成员帐号）与假控制面 SQL：
// 断言的是「本地只做映射与分配、数字真源全在 new-api」、「分配 = 主帐 → 成员的
// 转移（总额守恒）」以及分配/回收的幂等与不超卖。
//
// user 层模型（09-23 重切）：成员 = new-api **另一个 user**，配额桶 = 该 user 的
// users.quota（token 子额度桶模型已被只读探针硬否定）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import type { GenerationSql } from "./database.ts";
import {
  allocateMemberQuota,
  findMemberByUserId,
  listTeamMembers,
  readMemberQuota,
  readTeamQuotaView,
  resolveMemberBinding,
  upsertTeamMember,
  type TeamLock,
} from "./member-quota.ts";

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

const COIN = QUOTA_PER_COIN;

// ── 假 new-api：users.quota（主帐帐号 + 成员帐号） ────────────────────────

interface FakeUserState {
  quota: number;
  used: number;
}

function fakeNewApi(seed: {
  users: Record<number, { quota: number; used?: number }>;
  failAdjust?: (userId: number, delta: number) => boolean;
}) {
  const users = new Map<number, FakeUserState>();
  for (const [id, state] of Object.entries(seed.users)) {
    users.set(Number(id), { quota: state.quota, used: state.used ?? 0 });
  }
  /** 每次上游额度调整的逐笔记录（正 = 加，负 = 扣）。 */
  const adjustments: { userId: number; delta: number }[] = [];
  const failedAdjustments: { userId: number; delta: number }[] = [];

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
      failedAdjustments.push({ userId, delta });
      throw new Error(`upstream rejected adjust of ${delta} on user ${userId}`);
    }
    current.quota += delta;
    adjustments.push({ userId, delta });
  }) as unknown as typeof import("@/lib/gateway-admin").adjustGatewayUserQuotaExact;

  /** new-api 内核的一笔消耗：成员花的是自己 user 的 quota（user 层由内核执法）。 */
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

  return {
    users,
    adjustments,
    failedAdjustments,
    deps: { fetchUser, adjustUserQuota },
    consume,
    quotaOf,
  };
}

// ── 假控制面 SQL：team_member_quota + biz_api_key ────────────────────────

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

/** FIFO 互斥锁：替代 Postgres 事务级 advisory lock 的测试实现。 */
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

function memberRow(
  overrides: Partial<FakeMemberRow> & { member_key_id: string; member_user_id: number },
): FakeMemberRow {
  return {
    id: `member-${overrides.member_key_id}`,
    team_user_id: 117,
    display_name: "",
    enabled: true,
    created_at: 0,
    ...overrides,
  };
}

/** 去掉注释后的代码/DDL：负向断言只针对「活的」代码，不被历史注释带跑。 */
function stripped(relPath: string): string {
  return readFileSync(join(process.cwd(), relPath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*(--|\/\/).*$/gm, "");
}

// ── 降级 ────────────────────────────────────────────────────────────────

test("控制面未配置时映射层降级为 null/[]/false，不炸 C 端部署", async () => {
  await withEnv({ GENERATION_DATABASE_URL: undefined, GENERATION_CONTROL_PLANE_ENABLED: undefined }, async () => {
    assert.equal(await findMemberByUserId(900), null);
    assert.deepEqual(await listTeamMembers(117), []);
    assert.equal(
      await upsertTeamMember({ id: "m1", teamUserId: 117, memberUserId: 900, memberKeyId: "key-a" }),
      false,
    );
    assert.equal(await resolveMemberBinding("key-a"), null);
    const allocation = await allocateMemberQuota({ teamUserId: 117, memberKeyId: "key-a", targetGranted: COIN });
    assert.equal(allocation.ok, false);
    assert.equal(allocation.ok === false ? allocation.status : 0, 503);
  });
});

// ── 映射层（归属） ───────────────────────────────────────────────────────

test("归属链：成员 key 的 user_id 就是成员 new-api user（007 免新表）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const { sql, queries } = fakeControlPlane({
      keys: [{ id: "key-a", label: "成员A", user_id: 900 }],
    });
    const binding = await resolveMemberBinding("key-a", sql);
    assert.deepEqual(binding, { memberKeyId: "key-a", userId: 900, label: "成员A" });
    assert.ok(queries[0].includes("FROM biz_api_key"));
    // user 层模型不需要 token 映射（012 只管 token 层闸门，不在此路径）。
    assert.ok(!queries[0].includes("biz_key_newapi_token"), "成员归属不得再依赖 token 映射");
  });
});

test("映射层只存身份与意图：本地表没有点数栏位，成员身份按 user", () => {
  const source = readFileSync(join(process.cwd(), "db/migrations/019_team_member_quota.sql"), "utf8");
  const createTable = /CREATE TABLE IF NOT EXISTS team_member_quota \(([\s\S]*?)\n\);/.exec(source);
  assert.ok(createTable, "应能定位 team_member_quota 表定义");
  for (const forbidden of [/quota\s+integer/i, /remain/i, /allocated/i, /balance/i]) {
    assert.doesNotMatch(createTable[1], forbidden, "映射表不得存点数额度（影子帐本）");
  }
  assert.match(createTable[1], /member_user_id integer NOT NULL UNIQUE/);
  assert.match(createTable[1], /team_user_id integer NOT NULL/);
  // 反转后的不变量：成员必须是「另一个 user」（旧版要求等于 team_user_id）。
  assert.match(source, /必须\*\*不等于\*\* team_user_id/);
  assert.match(source, /同一个 user 的多把 biz key 共用同一桶/);
  // 活的 DDL 里不得再有 token 桶栏位（只留历史注释）。
  assert.doesNotMatch(stripped("db/migrations/019_team_member_quota.sql"), /member_token_id/);
});

test("分配/回收必须在团队级串行化下执行（advisory lock，非本地帐本）", () => {
  const source = stripped("src/lib/generation-core/member-quota.ts");
  assert.match(source, /sql\.begin\(async \(tx\)/, "分配必须在事务内完成");
  assert.match(source, /pg_advisory_xact_lock\(hashtext\(/, "同一主帐的分配必须串行化，防多成员并发超卖");
  // 死件：token 子额度桶那两支（已从 gateway-admin 删除）不得再出现在本刀档案。
  assert.doesNotMatch(source, /fetchGatewayToken|setGatewayTokenQuota|memberTokenId|biz_key_newapi_token/);
});

// ── 分配 / 回收（user 层转移） ──────────────────────────────────────────

test("分配：主划 500 币给成员 A —— 主帐扣 500、成员桶加 500（逐笔对称）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({ keys: [{ id: "key-a", label: "成员A", user_id: 900 }] });
    const api = fakeNewApi({ users: { 117: { quota: 1000 * COIN }, 900: { quota: 0 } } });

    const result = await allocateMemberQuota(
      { teamUserId: 117, memberKeyId: "key-a", targetGranted: 500 * COIN },
      { sql: cp.sql, withTeamLock: mutexLock(cp.sql), newMemberId: () => "member-1", ...api.deps },
    );

    assert.equal(result.ok, true);
    assert.equal(result.ok === true ? result.granted : 0, 500 * COIN);
    assert.equal(result.ok === true ? result.used : 0, 0);
    assert.equal(result.ok === true ? result.remaining : 0, 500 * COIN);
    assert.equal(result.ok === true ? result.transferred : 0, 500 * COIN);
    assert.equal(result.ok === true ? result.unchanged : true, false);
    // 配额桶在成员 user 自己身上（内核执法），主帐手上少掉同额。
    assert.equal(api.quotaOf(900), 500 * COIN);
    assert.equal(api.quotaOf(117), 500 * COIN);
    assert.deepEqual(api.adjustments, [
      { userId: 117, delta: -500 * COIN },
      { userId: 900, delta: 500 * COIN },
    ]);
    assert.equal(cp.members.length, 1, "首次分配登记归属");
    assert.equal(cp.members[0].member_user_id, 900);
    assert.equal(cp.members[0].member_key_id, "key-a");
  });
});

test("分配幂等：目标值不变时是 no-op，不再写上游、不重复登记", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      keys: [{ id: "key-a", label: "成员A", user_id: 900 }],
      members: [memberRow({ member_key_id: "key-a", member_user_id: 900, display_name: "成员A" })],
    });
    const api = fakeNewApi({ users: { 117: { quota: 500 * COIN }, 900: { quota: 500 * COIN } } });
    const deps = { sql: cp.sql, withTeamLock: mutexLock(cp.sql), newMemberId: () => "member-1", ...api.deps };

    const first = await allocateMemberQuota({ teamUserId: 117, memberKeyId: "key-a", targetGranted: 500 * COIN }, deps);
    assert.equal(first.ok, true);
    assert.equal(first.ok === true ? first.unchanged : false, true, "同目标值 = 幂等 no-op");
    assert.equal(first.ok === true ? first.transferred : 1, 0);

    const second = await allocateMemberQuota({ teamUserId: 117, memberKeyId: "key-a", targetGranted: 500 * COIN }, deps);
    assert.equal(second.ok === true ? second.unchanged : false, true);
    assert.equal(api.adjustments.length, 0, "no-op 不得写上游");
    assert.equal(api.quotaOf(117), 500 * COIN);
    assert.equal(api.quotaOf(900), 500 * COIN);
    assert.equal(cp.members.length, 1);
  });
});

test("回收：目标低于现值时差额从成员桶收回主帐（同一操作，重放幂等）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      keys: [{ id: "key-a", label: "成员A", user_id: 900 }],
      members: [memberRow({ member_key_id: "key-a", member_user_id: 900 })],
    });
    const api = fakeNewApi({ users: { 117: { quota: 500 * COIN }, 900: { quota: 500 * COIN } } });
    const deps = { sql: cp.sql, withTeamLock: mutexLock(cp.sql), ...api.deps };

    const reclaimed = await allocateMemberQuota({ teamUserId: 117, memberKeyId: "key-a", targetGranted: 200 * COIN }, deps);
    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.ok === true ? reclaimed.granted : 0, 200 * COIN);
    assert.equal(reclaimed.ok === true ? reclaimed.remaining : 0, 200 * COIN);
    assert.equal(reclaimed.ok === true ? reclaimed.transferred : 0, -300 * COIN);
    assert.equal(api.quotaOf(900), 200 * COIN);
    assert.equal(api.quotaOf(117), 800 * COIN, "回收的钱回到主帐手上");

    // 重放同一回收请求 = 幂等（不再写上游）
    const replay = await allocateMemberQuota({ teamUserId: 117, memberKeyId: "key-a", targetGranted: 200 * COIN }, deps);
    assert.equal(replay.ok === true ? replay.unchanged : false, true);
    assert.equal(api.adjustments.length, 2);
    assert.equal(api.quotaOf(900), 200 * COIN);
  });
});

test("已消耗部分不可回收：目标低于已用被拒，且不动上游", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      keys: [{ id: "key-a", label: "成员A", user_id: 900 }],
      members: [memberRow({ member_key_id: "key-a", member_user_id: 900 })],
    });
    const api = fakeNewApi({
      users: { 117: { quota: 500 * COIN }, 900: { quota: 300 * COIN, used: 200 * COIN } },
    });

    const result = await allocateMemberQuota(
      { teamUserId: 117, memberKeyId: "key-a", targetGranted: 150 * COIN },
      { sql: cp.sql, withTeamLock: mutexLock(cp.sql), ...api.deps },
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.status : 0, 409);
    assert.equal(result.ok === false ? result.code : "", "target_below_used");
    assert.match(result.ok === false ? result.message : "", /已消耗 200 币/);
    assert.equal(api.adjustments.length, 0);
    assert.equal(api.quotaOf(900), 300 * COIN);
  });
});

test("主帐不足时拒绝新分配，错误可执行（可分配余额 + 充值/回收指引）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      keys: [
        { id: "key-a", label: "成员A", user_id: 900 },
        { id: "key-b", label: "成员B", user_id: 901 },
      ],
      members: [memberRow({ member_key_id: "key-a", member_user_id: 900 })],
    });
    // 主帐手上只剩 300 币（成员 A 那 500 已经划出去了），成员 B 要 500 → 差额超额。
    const api = fakeNewApi({
      users: { 117: { quota: 300 * COIN }, 900: { quota: 400 * COIN, used: 100 * COIN }, 901: { quota: 0 } },
    });

    const result = await allocateMemberQuota(
      { teamUserId: 117, memberKeyId: "key-b", targetGranted: 500 * COIN },
      { sql: cp.sql, withTeamLock: mutexLock(cp.sql), ...api.deps },
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.status : 0, 402);
    assert.equal(result.ok === false ? result.code : "", "insufficient_team_quota");
    const message = result.ok === false ? result.message : "";
    assert.match(message, /主账号额度不足/);
    assert.match(message, /可分配余额 300 币/, "可执行错误必须给出可分配余额");
    assert.match(message, /充值|回收/, "必须给出可执行动作");
    assert.equal(api.adjustments.length, 0, "主帐不足不得写成员额度");
    assert.equal(cp.members.length, 1, "被拒的分配不得登记归属");
  });
});

test("跨团队分配被拒：成员 user 已归属别家团队主帐", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      keys: [{ id: "key-x", label: "别家成员", user_id: 900 }],
      members: [memberRow({ team_user_id: 555, member_key_id: "key-x", member_user_id: 900 })],
    });
    const api = fakeNewApi({ users: { 117: { quota: 1000 * COIN }, 900: { quota: 0 }, 555: { quota: 0 } } });

    const result = await allocateMemberQuota(
      { teamUserId: 117, memberKeyId: "key-x", targetGranted: 10 * COIN },
      { sql: cp.sql, withTeamLock: mutexLock(cp.sql), ...api.deps },
    );

    assert.equal(result.ok === false ? result.status : 0, 403);
    assert.equal(result.ok === false ? result.code : "", "team_mismatch");
    assert.equal(result.ok === false ? (result.message.includes("555") ? 555 : 0) : 0, 555);
    assert.equal(api.adjustments.length, 0);
  });
});

test("主帐自己的 key 不能当成员（自己给自己划额度）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({ keys: [{ id: "key-master", label: "主帐key", user_id: 117 }] });
    const api = fakeNewApi({ users: { 117: { quota: 1000 * COIN } } });

    const result = await allocateMemberQuota(
      { teamUserId: 117, memberKeyId: "key-master", targetGranted: 500 * COIN },
      { sql: cp.sql, withTeamLock: mutexLock(cp.sql), ...api.deps },
    );

    assert.equal(result.ok === false ? result.status : 0, 403);
    assert.equal(result.ok === false ? result.code : "", "team_mismatch");
    assert.equal(api.adjustments.length, 0);
  });
});

test("同一 user 的多把 key 共用同一桶：不重复记帐、不重复登记", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      keys: [
        { id: "key-a", label: "成员A", user_id: 900 },
        { id: "key-a2", label: "成员A-备用", user_id: 900 },
      ],
    });
    const api = fakeNewApi({ users: { 117: { quota: 1000 * COIN }, 900: { quota: 0 } } });
    const deps = { sql: cp.sql, withTeamLock: mutexLock(cp.sql), newMemberId: () => "member-1", ...api.deps };

    await allocateMemberQuota({ teamUserId: 117, memberKeyId: "key-a", targetGranted: 500 * COIN }, deps);
    // 换一把 key 要求同一个目标值：同一个桶 ⇒ 幂等 no-op，主帐不再被扣。
    const viaSecondKey = await allocateMemberQuota(
      { teamUserId: 117, memberKeyId: "key-a2", targetGranted: 500 * COIN },
      deps,
    );
    assert.equal(viaSecondKey.ok === true ? viaSecondKey.unchanged : false, true);
    assert.equal(api.quotaOf(117), 500 * COIN);

    // 目标提高时只补差额（不是再划一次全额）。
    const raised = await allocateMemberQuota(
      { teamUserId: 117, memberKeyId: "key-a2", targetGranted: 600 * COIN },
      deps,
    );
    assert.equal(raised.ok === true ? raised.transferred : 0, 100 * COIN);
    assert.equal(api.quotaOf(117), 400 * COIN);
    assert.equal(api.quotaOf(900), 600 * COIN);
    assert.equal(cp.members.length, 1, "一个 user 一条归属记录");
    const registered = await findMemberByUserId(900, cp.sql);
    assert.equal(registered?.memberUserId, 900);
    assert.equal(registered?.teamUserId, 117);
  });
});

test("上游写入失败即回滚（先扣后加）：主帐不被扣走，也不凭空印额度", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({ keys: [{ id: "key-a", label: "成员A", user_id: 900 }] });
    const api = fakeNewApi({
      users: { 117: { quota: 1000 * COIN }, 900: { quota: 0 } },
      // 成员那条腿（加额度）失败 → 主帐那条腿必须回滚。
      failAdjust: (userId, delta) => userId === 900 && delta > 0,
    });

    const result = await allocateMemberQuota(
      { teamUserId: 117, memberKeyId: "key-a", targetGranted: 500 * COIN },
      { sql: cp.sql, withTeamLock: mutexLock(cp.sql), ...api.deps },
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.status : 0, 503);
    assert.equal(api.quotaOf(117), 1000 * COIN, "主帐必须被回滚到原值");
    assert.equal(api.quotaOf(900), 0);
    assert.deepEqual(api.adjustments, [
      { userId: 117, delta: -500 * COIN },
      { userId: 117, delta: 500 * COIN },
    ]);
    assert.equal(cp.members.length, 0, "失败的分配不得登记归属");
  });
});

// ── 并发 ────────────────────────────────────────────────────────────────

test("多成员并发不超卖：团队锁把分配串行化，划出的钱不超过主帐手上余额", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const memberKeys = ["key-a", "key-b", "key-c", "key-d", "key-e"];
    const cp = fakeControlPlane({
      keys: memberKeys.map((id, index) => ({ id, label: `成员${index}`, user_id: 900 + index })),
    });
    const users: Record<number, { quota: number }> = { 117: { quota: 1000 * COIN } };
    memberKeys.forEach((_, index) => {
      users[900 + index] = { quota: 0 };
    });
    const api = fakeNewApi({ users });
    const deps = { sql: cp.sql, withTeamLock: mutexLock(cp.sql), ...api.deps };

    // 5 个成员同时各要 400 币（合计 2000 > 主帐 1000）——串行化后只应放行 2 个。
    const results = await Promise.all(
      memberKeys.map((memberKeyId, index) =>
        allocateMemberQuota(
          { teamUserId: 117, memberKeyId, targetGranted: 400 * COIN },
          { ...deps, newMemberId: () => `member-${index}` },
        ),
      ),
    );

    assert.equal(results.filter((result) => result.ok).length, 2, "只有 2 个成员能在主帐兜底内拿到 400 币");
    const granted = cp.members.reduce((sum, row) => sum + api.quotaOf(row.member_user_id), 0);
    assert.equal(granted, 800 * COIN);
    // 守恒：主帐手上 + Σ成员桶 = 原额（没有超卖、没有印钱）。
    assert.equal(api.quotaOf(117) + granted, 1000 * COIN);
    const rejected = results.filter((result) => !result.ok);
    assert.equal(rejected.length, 3);
    for (const result of rejected) {
      assert.equal(result.ok === false ? result.status : 0, 402);
      assert.equal(result.ok === false ? result.code : "", "insufficient_team_quota");
    }
  });
});

// ── 可视面 ──────────────────────────────────────────────────────────────

test("可视面：主帐剩余／已分配／未分配／团队总额／成员各自额度与消耗（即时读 new-api）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      keys: [{ id: "key-a", label: "成员A", user_id: 900 }],
      members: [
        memberRow({ member_key_id: "key-a", member_user_id: 900, display_name: "成员A" }),
        memberRow({ member_key_id: "key-gone", member_user_id: 999, display_name: "幽灵成员", created_at: 1 }),
      ],
    });
    const api = fakeNewApi({
      users: { 117: { quota: 700 * COIN }, 900: { quota: 300 * COIN, used: 200 * COIN } },
    });

    const view = await readTeamQuotaView({ teamUserId: 117 }, { sql: cp.sql, ...api.deps });
    assert.ok(view);
    assert.equal(view.master.coins, 700);
    assert.equal(view.allocated, 500 * COIN);
    assert.equal(view.allocatedCoins, 500);
    assert.equal(view.usedCoins, 200);
    assert.equal(view.unallocated, 700 * COIN, "转移模型：可再分配 = 主帐手上余额");
    assert.equal(view.team.remaining, 1000 * COIN, "团队未消耗总额 = 主帐 + Σ成员桶");
    assert.equal(view.team.coins, 1000);
    assert.equal(view.members[0].coins.granted, 500);
    assert.equal(view.members[0].coins.used, 200);
    assert.equal(view.members[0].coins.remaining, 300);
    assert.equal(view.members[0].memberUserId, 900);
    assert.equal(view.members[0].unavailable, false);
    // 读不到上游的成员画成诚实第三态，不冒充足额。
    assert.equal(view.members[1].unavailable, true);
    assert.equal(view.members[1].coins.remaining, 0);
  });
});

test("主帐读不到时可视面返回 null（端点回 503，不画假数字）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({ keys: [] });
    const view = await readTeamQuotaView(
      { teamUserId: 117 },
      {
        sql: cp.sql,
        fetchUser: (async () => {
          throw new Error("new-api down");
        }) as unknown as typeof import("@/lib/gateway-admin").fetchGatewayUser,
      },
    );
    assert.equal(view, null);
  });
});

test("成员额度读不到时 readMemberQuota 回 null（预检据此 fail-closed）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const missing = await readMemberQuota(999, {
      fetchUser: (async () => null) as unknown as typeof import("@/lib/gateway-admin").fetchGatewayUser,
    });
    assert.equal(missing, null);
    const broken = await readMemberQuota(999, {
      fetchUser: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof import("@/lib/gateway-admin").fetchGatewayUser,
    });
    assert.equal(broken, null);
    assert.equal(await readMemberQuota(0), null, "user_id=0 是无从计费通道，不发请求");
  });
});

// ── 端到端口径（验收项） ─────────────────────────────────────────────────

test("端到端：主划 500 给成员 A → 成员扣费／主帐扣减／余额显示三处逐笔一致", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({ keys: [{ id: "key-a", label: "成员A", user_id: 900 }] });
    const api = fakeNewApi({ users: { 117: { quota: 1000 * COIN }, 900: { quota: 0 } } });
    const deps = { sql: cp.sql, withTeamLock: mutexLock(cp.sql), newMemberId: () => "member-1", ...api.deps };

    // ① 主划 500 币给成员 A：主帐扣 500、成员桶加 500（逐笔对称，总额不变）。
    const masterBefore = api.quotaOf(117);
    const allocated = await allocateMemberQuota({ teamUserId: 117, memberKeyId: "key-a", targetGranted: 500 * COIN }, deps);
    assert.equal(allocated.ok, true);
    const masterDebit = masterBefore - api.quotaOf(117);
    assert.equal(masterDebit, 500 * COIN, "主帐扣减");
    assert.equal(api.quotaOf(900), 500 * COIN, "成员得到同额（逐笔吻合）");
    assert.equal(masterDebit, allocated.ok === true ? allocated.granted : 0);

    // ② 成员 A 消耗 120 币：new-api 内核扣成员 user 自己的 quota（成员扣费）。
    api.consume(900, 120 * COIN);

    // ③ 三处对帐：成员扣费 / 主帐扣减 / 显示逐笔一致，且团队总额守恒。
    const view = await readTeamQuotaView({ teamUserId: 117 }, { sql: cp.sql, ...api.deps });
    assert.ok(view);
    assert.equal(view.members[0].used, 120 * COIN, "成员扣费 = 本次消耗");
    assert.equal(view.members[0].coins.remaining, 380, "成员余额显示 = 500 − 120");
    assert.equal(view.master.coins, 500, "主帐余额显示 = 1000 − 500（分配时已转出）");
    assert.equal(view.team.coins, 880, "团队总额显示 = 主帐 500 + 成员 380 = 1000 − 120");
    assert.equal(view.members[0].coins.granted - view.members[0].coins.used, view.members[0].coins.remaining);
    assert.equal(view.allocatedCoins, 500, "已分配上限不因消耗漂移（quota + used 恒等于授予值）");
    assert.equal(view.usedCoins, 120);
  });
});
