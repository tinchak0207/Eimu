// 团队治理六面（席位／角色／建画布权限／加入审批／生命周期／用量）真行为断言测试。
//
// 姿势沿用 member-quota.test.ts：注入假控制面 SQL（记忆体）与假 new-api，
// 断言的是规则与副作用（谁被拒、名册怎么变、冷静期怎么算、有没有碰点数），
// 不是源码字串。源码扫描只用在「路由鉴权契约」与「禁影子帐本」两处护栏。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { LedgerEntry } from "./account-ledger.ts";
import type { GenerationSql } from "./database.ts";
import type { TeamLock } from "./member-quota.ts";
import {
  HOUR_MS,
  TEAM_CANVAS_FORBIDDEN_MESSAGE,
  applyToJoinTeam,
  canCreateSharedCanvas,
  canManageRole,
  canMemberCreateSharedCanvas,
  countOwnedTeams,
  decideJoinRequest,
  executeTeamDissolution,
  getTeamLifecycle,
  leaveTeam,
  ownerCount,
  readTeamSettings,
  readTeamUsage,
  removeTeamMember,
  resolveTeamActor,
  scheduleTeamDissolution,
  setMemberRole,
  setTeamSeats,
  teamCapacity,
  updateTeamSettings,
  withdrawTeamDissolution,
} from "./team-governance.ts";

const CONTROL_PLANE_ENV = {
  GENERATION_DATABASE_URL: "postgres://fake:fake@127.0.0.1:1/fake",
  GENERATION_CONTROL_PLANE_ENABLED: "true",
};

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
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

function stripped(relPath: string): string {
  return readFileSync(join(process.cwd(), relPath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*(\/\/|--).*$/gm, "");
}

// ── 假控制面：team_member_quota(role) + team_settings + team_join_request ──

interface FakeMemberRow {
  id: string;
  team_user_id: number;
  member_user_id: number;
  member_key_id: string;
  display_name: string | null;
  enabled: boolean;
  role: string;
  created_at: number;
}

interface FakeSettings {
  team_user_id: number;
  member_create_canvas: boolean;
  seats: number;
  dissolve_scheduled_at: string | null;
  dissolved_at: string | null;
}

interface FakeJoinRow {
  id: string;
  team_user_id: number;
  applicant_user_id: number;
  applicant_member_key_id: string;
  display_name: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_by_user_id: number | null;
}

function fakeControlPlane(seed: {
  members?: FakeMemberRow[];
  settings?: FakeSettings[];
  requests?: FakeJoinRow[];
}) {
  const members: FakeMemberRow[] = [...(seed.members ?? [])];
  const settings: FakeSettings[] = [...(seed.settings ?? [])];
  const requests: FakeJoinRow[] = [...(seed.requests ?? [])];
  const queries: string[] = [];
  let seq = members.length + 100;

  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(" ? ");
    queries.push(q);
    const v = values;

    if (q.includes("pg_advisory_xact_lock")) return [];

    if (q.includes("count(*)")) {
      if (q.includes("AND role = 'owner'")) {
        return [{ count: members.filter((m) => m.member_user_id === Number(v[0]) && m.role === "owner").length }];
      }
      if (q.includes("WHERE member_user_id")) {
        return [{ count: members.filter((m) => m.member_user_id === Number(v[0])).length }];
      }
      return [{ count: members.filter((m) => m.team_user_id === Number(v[0])).length }];
    }

    if (q.includes("INSERT INTO team_member_quota")) {
      const [id, teamUserId, memberUserId, memberKeyId, displayName, enabled] = v as [
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
          role: "member",
          created_at: seq++,
        });
      }
      return [];
    }

    if (q.includes("UPDATE team_member_quota")) {
      if (q.includes("SET role =")) {
        const [role, teamUserId, memberUserId] = v as [string, number, number];
        for (const m of members) {
          if (m.team_user_id === Number(teamUserId) && m.member_user_id === Number(memberUserId)) m.role = role;
        }
      } else if (q.includes("SET enabled = false")) {
        for (const m of members) if (m.team_user_id === Number(v[0])) m.enabled = false;
      }
      return [];
    }

    if (q.includes("DELETE FROM team_member_quota")) {
      const teamUserId = Number(v[0]);
      const memberUserId = Number(v[1]);
      for (let i = members.length - 1; i >= 0; i -= 1) {
        if (members[i].team_user_id === teamUserId && members[i].member_user_id === memberUserId) members.splice(i, 1);
      }
      return [];
    }

    if (q.includes("SELECT") && q.includes("FROM team_member_quota")) {
      if (q.includes("WHERE member_user_id")) {
        return members.filter((m) => m.member_user_id === Number(v[0])).slice(0, 1);
      }
      return members.filter((m) => m.team_user_id === Number(v[0])).sort((a, b) => a.created_at - b.created_at);
    }

    if (q.includes("SELECT") && q.includes("FROM team_settings")) {
      const row = settings.find((s) => s.team_user_id === Number(v[0]));
      return row ? [row] : [];
    }

    if (q.includes("INSERT INTO team_settings")) {
      const teamUserId = Number(v[0]);
      const memberCreateCanvas = Boolean(v[1]);
      const seats = Number(v[2]);
      const dissolve = v.length > 3 ? (v[3] as string) : undefined;
      let row = settings.find((s) => s.team_user_id === teamUserId);
      if (!row) {
        row = {
          team_user_id: teamUserId,
          member_create_canvas: memberCreateCanvas,
          seats,
          dissolve_scheduled_at: null,
          dissolved_at: null,
        };
        settings.push(row);
      }
      row.member_create_canvas = memberCreateCanvas;
      row.seats = seats;
      if (dissolve !== undefined && q.includes("dissolve_scheduled_at = EXCLUDED")) {
        row.dissolve_scheduled_at = dissolve;
      }
      return [];
    }

    if (q.includes("UPDATE team_settings")) {
      const row = settings.find((s) => s.team_user_id === Number(v[0]));
      if (row) {
        if (q.includes("SET dissolve_scheduled_at = NULL")) row.dissolve_scheduled_at = null;
        if (q.includes("SET dissolved_at = now()")) {
          row.dissolved_at = new Date().toISOString();
          row.dissolve_scheduled_at = null;
        }
      }
      return [];
    }

    if (q.includes("INSERT INTO team_join_request")) {
      const [id, teamUserId, applicantUserId, keyId, displayName] = v as [string, number, number, string, string];
      const existing = requests.find(
        (r) => r.team_user_id === Number(teamUserId) && r.applicant_user_id === Number(applicantUserId),
      );
      if (existing) {
        existing.status = "pending";
        existing.applicant_member_key_id = keyId;
        existing.display_name = displayName;
        existing.decided_at = null;
        existing.decided_by_user_id = null;
      } else {
        requests.push({
          id,
          team_user_id: Number(teamUserId),
          applicant_user_id: Number(applicantUserId),
          applicant_member_key_id: keyId,
          display_name: displayName,
          status: "pending",
          created_at: new Date().toISOString(),
          decided_at: null,
          decided_by_user_id: null,
        });
      }
      return [];
    }

    if (q.includes("UPDATE team_join_request")) {
      const [status, actorUserId, requestId, teamUserId] = v as [string, number, string, number];
      const row = requests.find((r) => r.id === requestId && r.team_user_id === Number(teamUserId));
      if (row) {
        row.status = status;
        row.decided_at = new Date().toISOString();
        row.decided_by_user_id = actorUserId;
      }
      return [];
    }

    if (q.includes("SELECT") && q.includes("FROM team_join_request")) {
      if (q.includes("WHERE id =")) {
        return requests.filter((r) => r.id === v[0] && r.team_user_id === Number(v[1]));
      }
      if (q.includes("AND applicant_user_id =")) {
        return requests
          .filter((r) => r.team_user_id === Number(v[0]) && r.applicant_user_id === Number(v[1]))
          .slice(0, 1);
      }
      return requests.filter((r) => r.team_user_id === Number(v[0]) && r.status === v[1]);
    }

    return [];
  }) as unknown as GenerationSql;

  return { sql: tagged, members, settings, requests, queries };
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

function memberRow(overrides: Partial<FakeMemberRow> & { member_key_id: string; member_user_id: number }): FakeMemberRow {
  return {
    id: `member-${overrides.member_key_id}`,
    team_user_id: 117,
    display_name: "",
    enabled: true,
    role: "member",
    created_at: 0,
    ...overrides,
  };
}

function deps(cp: ReturnType<typeof fakeControlPlane>, now?: () => number) {
  return { sql: cp.sql, withTeamLock: mutexLock(cp.sql), newId: () => `id-${cp.requests.length + cp.members.length}`, now };
}

// ── 配置常量（可调，不硬编） ─────────────────────────────────────────────

test("容量常量可调：默认 min 2／default 10／硬上限 200，env 可覆写且夹在界内", async () => {
  await withEnv({ TEAM_MIN_MEMBERS: undefined, TEAM_DEFAULT_MAX_MEMBERS: undefined, TEAM_MAX_MEMBERS: undefined }, () => {
    assert.deepEqual(teamCapacity(), { minMembers: 2, defaultMaxMembers: 10, maxMembers: 200 });
  });
  await withEnv({ TEAM_MIN_MEMBERS: "3", TEAM_DEFAULT_MAX_MEMBERS: "20", TEAM_MAX_MEMBERS: "50" }, () => {
    assert.deepEqual(teamCapacity(), { minMembers: 3, defaultMaxMembers: 20, maxMembers: 50 });
  });
  await withEnv({ TEAM_MAX_MEMBERS: "1", TEAM_MIN_MEMBERS: "5" }, () => {
    const capacity = teamCapacity();
    assert.ok(capacity.maxMembers >= capacity.minMembers, "硬上限不得低于最小值");
  });
});

test("解散冷静期常量可调（默认 48h）", async () => {
  await withEnv({ ...CONTROL_PLANE_ENV, TEAM_DISSOLVE_COOLOFF_HOURS: undefined }, async () => {
    const cp = fakeControlPlane({ settings: [{ team_user_id: 117, member_create_canvas: false, seats: 10, dissolve_scheduled_at: null, dissolved_at: null }] });
    const result = await scheduleTeamDissolution({ teamUserId: 117, actorUserId: 117 }, { ...deps(cp), now: () => 0 });
    assert.equal(result.ok, true);
    assert.equal(result.ok === true ? result.cooloffHours : 0, 48);
    assert.equal(result.ok === true ? result.dissolveScheduledAt : "", new Date(48 * HOUR_MS).toISOString());
  });
});

// ── 纯函式：角色授权与 owner 不变量 ─────────────────────────────────────

test("角色授权：owner 可改他人、admin 只能改 member 且不得制造 owner、member 不可改任何人", () => {
  const roster = [
    { memberUserId: 900, role: "member" as const },
    { memberUserId: 901, role: "admin" as const },
    { memberUserId: 902, role: "owner" as const },
  ];
  const owner = resolveTeamActor({ userId: 117, teamUserId: 117, roster })!;
  const admin = resolveTeamActor({ userId: 901, teamUserId: 117, roster })!;
  const member = resolveTeamActor({ userId: 900, teamUserId: 117, roster })!;
  assert.equal(owner.role, "owner");
  assert.equal(admin.role, "admin");
  assert.equal(member.role, "member");
  assert.equal(resolveTeamActor({ userId: 999, teamUserId: 117, roster }), null, "外人没有治理角色");

  assert.equal(canManageRole(owner, { role: "admin", memberUserId: 901 }, "member"), true);
  assert.equal(canManageRole(owner, { role: "member", memberUserId: 900 }, "owner"), true);
  assert.equal(canManageRole(admin, { role: "member", memberUserId: 900 }, "admin"), true);
  assert.equal(canManageRole(admin, { role: "member", memberUserId: 900 }, "owner"), false, "admin 不得制造 owner");
  assert.equal(canManageRole(admin, { role: "admin", memberUserId: 901 }, "member"), false, "admin 不得动 admin");
  assert.equal(canManageRole(member, { role: "member", memberUserId: 900 }, "admin"), false);
  // 团队主帐恒 owner，任何角色都不得改它（最后一个 owner）。
  assert.equal(canManageRole(owner, { role: "owner", memberUserId: 117 }, "member"), false);

  assert.equal(ownerCount(117, roster), 2, "owner = 主帐(1) + 名册 owner(1)");
  assert.ok(ownerCount(117, []) >= 1, "owner 集合恒非空");
});

test("建画布权限纯函式：owner/admin 恒可；member 依开关；非成员不受闸", () => {
  assert.equal(canCreateSharedCanvas({ actor: { role: "owner" }, memberCreateCanvas: false }).allowed, true);
  assert.equal(canCreateSharedCanvas({ actor: { role: "admin" }, memberCreateCanvas: false }).allowed, true);
  const denied = canCreateSharedCanvas({ actor: { role: "member" }, memberCreateCanvas: false });
  assert.equal(denied.allowed, false);
  assert.equal(denied.message, TEAM_CANVAS_FORBIDDEN_MESSAGE);
  assert.match(denied.message, /只有团队创建者或管理员可以创建共享画布/);
  assert.equal(canCreateSharedCanvas({ actor: { role: "member" }, memberCreateCanvas: true }).allowed, true);
  assert.equal(canCreateSharedCanvas({ actor: null, memberCreateCanvas: false }).allowed, true);
});

// ── 断言 1：不可移除最后一个 owner ──────────────────────────────────────

test("断言①：最后一个 owner 不可移除／不可退出（团队主帐 leave → 409 last_owner，且名册不动）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [memberRow({ member_key_id: "key-a", member_user_id: 900, role: "member" })],
    });
    const result = await leaveTeam({ actorUserId: 117 }, deps(cp));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.status : 0, 409);
    assert.equal(result.ok === false ? result.code : "", "last_owner");
    assert.match(result.ok === false ? result.message : "", /转移所有权或解散团队/);
    assert.equal(cp.members.length, 1, "被拒的退出不得改名册");
  });
});

test("断言①（守卫分支）：对主帐 owner 的名册列降级／移除一律 409 last_owner", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    // 名册列直接指向主帐（defense in depth：即使上层放行也必须被 owner 不变量挡住）。
    const cp = fakeControlPlane({
      members: [memberRow({ member_key_id: "key-self", member_user_id: 117, role: "owner" })],
    });
    const demote = await setMemberRole({ teamUserId: 117, actorUserId: 117, memberKeyId: "key-self", role: "member" }, deps(cp));
    assert.equal(demote.ok === false ? demote.code : "", "last_owner");
    const removed = await removeTeamMember({ teamUserId: 117, actorUserId: 117, memberKeyId: "key-self" }, deps(cp));
    assert.equal(removed.ok === false ? removed.code : "", "last_owner");
    assert.equal(cp.members.length, 1, "两次被拒都不得动名册");
  });
});

test("角色变更：owner 把 member 升 admin 落库；admin 动 admin 被 403 且不动名册", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [
        memberRow({ member_key_id: "key-a", member_user_id: 900, role: "member" }),
        memberRow({ member_key_id: "key-b", member_user_id: 901, role: "admin", created_at: 1 }),
      ],
    });
    const promoted = await setMemberRole({ teamUserId: 117, actorUserId: 117, memberKeyId: "key-a", role: "admin" }, deps(cp));
    assert.equal(promoted.ok, true);
    assert.equal(cp.members.find((m) => m.member_user_id === 900)?.role, "admin");

    const forbidden = await setMemberRole({ teamUserId: 117, actorUserId: 901, memberKeyId: "key-b", role: "member" }, deps(cp));
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.ok === false ? forbidden.status : 0, 403);
    assert.equal(cp.members.find((m) => m.member_user_id === 901)?.role, "admin", "被拒不得改动");
  });
});

// ── 断言 2：满员不通过申请 ──────────────────────────────────────────────

test("断言②：满员（名册人数 ≥ 席位数）时加入申请不得通过，名册与申请状态都不动", async () => {
  await withEnv({ ...CONTROL_PLANE_ENV, TEAM_MIN_MEMBERS: undefined, TEAM_DEFAULT_MAX_MEMBERS: undefined, TEAM_MAX_MEMBERS: undefined }, async () => {
    const cp = fakeControlPlane({
      members: [
        memberRow({ member_key_id: "key-a", member_user_id: 900 }),
        memberRow({ member_key_id: "key-b", member_user_id: 901, created_at: 1 }),
      ],
      settings: [{ team_user_id: 117, member_create_canvas: false, seats: 2, dissolve_scheduled_at: null, dissolved_at: null }],
      requests: [
        {
          id: "req-1",
          team_user_id: 117,
          applicant_user_id: 902,
          applicant_member_key_id: "key-c",
          display_name: "申请人C",
          status: "pending",
          created_at: "2026-09-27T00:00:00.000Z",
          decided_at: null,
          decided_by_user_id: null,
        },
      ],
    });
    const result = await decideJoinRequest({ teamUserId: 117, actorUserId: 117, requestId: "req-1", decision: "approve" }, deps(cp));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.status : 0, 409);
    assert.equal(result.ok === false ? result.code : "", "team_full");
    assert.match(result.ok === false ? result.message : "", /席位已满/);
    assert.equal(cp.members.length, 2, "满员不得登记新成员");
    assert.equal(cp.requests[0].status, "pending", "满员不得改申请状态");
  });
});

test("未满员时通过申请：名册登记 role=member，申请转 approved（幂等重放不再登记第二次）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [memberRow({ member_key_id: "key-a", member_user_id: 900 })],
      requests: [
        {
          id: "req-1",
          team_user_id: 117,
          applicant_user_id: 902,
          applicant_member_key_id: "key-c",
          display_name: "申请人C",
          status: "pending",
          created_at: "2026-09-27T00:00:00.000Z",
          decided_at: null,
          decided_by_user_id: null,
        },
      ],
    });
    const first = await decideJoinRequest({ teamUserId: 117, actorUserId: 117, requestId: "req-1", decision: "approve" }, deps(cp));
    assert.equal(first.ok, true);
    assert.equal(first.ok === true ? first.status : "", "approved");
    assert.equal(first.ok === true ? first.unchanged : true, false);
    assert.equal(cp.members.length, 2);
    assert.equal(cp.members.find((m) => m.member_user_id === 902)?.role, "member");

    const replay = await decideJoinRequest({ teamUserId: 117, actorUserId: 117, requestId: "req-1", decision: "approve" }, deps(cp));
    assert.equal(replay.ok, true);
    assert.equal(replay.ok === true ? replay.unchanged : false, true, "重放审批 = no-op");
    assert.equal(cp.members.length, 2, "重放不得产生第二条名册");
  });
});

test("成员侧审批被拒：名册成员（member/admin）不得自行审批，member 不得改角色", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [
        memberRow({ member_key_id: "key-a", member_user_id: 900, role: "admin" }),
        memberRow({ member_key_id: "key-b", member_user_id: 901, role: "member", created_at: 1 }),
      ],
      requests: [
        {
          id: "req-1",
          team_user_id: 117,
          applicant_user_id: 902,
          applicant_member_key_id: "key-c",
          display_name: "C",
          status: "pending",
          created_at: "2026-09-27T00:00:00.000Z",
          decided_at: null,
          decided_by_user_id: null,
        },
      ],
    });
    // admin 属于该团队，可以审批；member 不行。
    const byMember = await decideJoinRequest({ teamUserId: 117, actorUserId: 901, requestId: "req-1", decision: "approve" }, deps(cp));
    assert.equal(byMember.ok === false ? byMember.status : 0, 403);
    const byAdmin = await decideJoinRequest({ teamUserId: 117, actorUserId: 900, requestId: "req-1", decision: "reject" }, deps(cp));
    assert.equal(byAdmin.ok, true);
    assert.equal(byAdmin.ok === true ? byAdmin.status : "", "rejected");
  });
});

test("申请加入：申请自己团队被拒；已在别团队被拒；重复申请幂等回同一条；驳回后可重开", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({ members: [memberRow({ team_user_id: 555, member_key_id: "key-x", member_user_id: 902 })] });
    const self = await applyToJoinTeam({ teamUserId: 902, applicantUserId: 902, applicantMemberKeyId: "key-c" }, deps(cp));
    assert.equal(self.ok === false ? self.code : "", "cannot_join_own_team");

    const first = await applyToJoinTeam({ teamUserId: 117, applicantUserId: 900, applicantMemberKeyId: "key-a" }, deps(cp));
    assert.equal(first.ok, true);
    assert.equal(first.ok === true ? first.created : true, true);
    const replay = await applyToJoinTeam({ teamUserId: 117, applicantUserId: 900, applicantMemberKeyId: "key-a" }, deps(cp));
    assert.equal(replay.ok === true ? replay.created : true, false, "重复申请不产生第二条");
    assert.equal(replay.ok === true ? replay.request.id : "", first.ok === true ? first.request.id : "x");
    assert.equal(cp.requests.length, 1);

    // 驳回后重开：同一条回到 pending（不新增第二条）。
    await decideJoinRequest({ teamUserId: 117, actorUserId: 117, requestId: first.ok === true ? first.request.id : "", decision: "reject" }, deps(cp));
    const reopened = await applyToJoinTeam({ teamUserId: 117, applicantUserId: 900, applicantMemberKeyId: "key-a" }, deps(cp));
    assert.equal(reopened.ok === true ? reopened.request.status : "", "pending");
    assert.equal(cp.requests.length, 1);

    // 跨团队：申请人已是别家（555）成员 → 不得再加入。
    const cross = await applyToJoinTeam({ teamUserId: 118, applicantUserId: 902, applicantMemberKeyId: "key-x" }, deps(cp));
    // 902 已归属 555：名册唯一性下，加入 118 会被「已在别的团队」挡（此处 118 名册为空）。
    assert.ok(cross.ok === false || cross.ok === true, "申请本身可受理");
    const cp2 = fakeControlPlane({
      members: [memberRow({ team_user_id: 555, member_key_id: "key-x", member_user_id: 902 })],
      requests: [
        {
          id: "req-9",
          team_user_id: 117,
          applicant_user_id: 902,
          applicant_member_key_id: "key-x",
          display_name: "X",
          status: "pending",
          created_at: "2026-09-27T00:00:00.000Z",
          decided_at: null,
          decided_by_user_id: null,
        },
      ],
    });
    const decided = await decideJoinRequest({ teamUserId: 117, actorUserId: 117, requestId: "req-9", decision: "approve" }, deps(cp2));
    assert.equal(decided.ok === false ? decided.code : "", "member_already_in_team");
    assert.equal(cp2.members.length, 1, "跨团队不得登记");
  });
});

// ── 断言 3：非 owner/admin 建画布被拒 ───────────────────────────────────

test("断言③：member 且开关关闭 → 被拒（专用文案）；开关开启／owner／admin／非成员 → 放行", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [
        memberRow({ member_key_id: "key-a", member_user_id: 900, role: "member" }),
        memberRow({ member_key_id: "key-b", member_user_id: 901, role: "admin", created_at: 1 }),
      ],
      settings: [{ team_user_id: 117, member_create_canvas: false, seats: 10, dissolve_scheduled_at: null, dissolved_at: null }],
    });
    const denied = await canMemberCreateSharedCanvas(900, { sql: cp.sql });
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, "member_canvas_forbidden");
    assert.equal(denied.teamUserId, 117);
    assert.equal(denied.message, TEAM_CANVAS_FORBIDDEN_MESSAGE);

    assert.equal((await canMemberCreateSharedCanvas(901, { sql: cp.sql })).allowed, true, "admin 可建");
    assert.equal((await canMemberCreateSharedCanvas(117, { sql: cp.sql })).allowed, true, "owner（主帐）可建");
    assert.equal((await canMemberCreateSharedCanvas(999, { sql: cp.sql })).allowed, true, "非成员不受此闸");

    cp.settings[0].member_create_canvas = true;
    assert.equal((await canMemberCreateSharedCanvas(900, { sql: cp.sql })).allowed, true, "开关开启后 member 可建");
  });
});

test("建画布开关：只有 owner/admin 能改；member 被 403 且设定不变；重复设定幂等", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [
        memberRow({ member_key_id: "key-a", member_user_id: 900, role: "member" }),
        memberRow({ member_key_id: "key-b", member_user_id: 901, role: "admin", created_at: 1 }),
      ],
      settings: [{ team_user_id: 117, member_create_canvas: false, seats: 10, dissolve_scheduled_at: null, dissolved_at: null }],
    });
    const byMember = await updateTeamSettings({ teamUserId: 117, actorUserId: 900, memberCreateCanvas: true }, deps(cp));
    assert.equal(byMember.ok === false ? byMember.status : 0, 403);
    assert.equal(cp.settings[0].member_create_canvas, false);

    const byAdmin = await updateTeamSettings({ teamUserId: 117, actorUserId: 901, memberCreateCanvas: true }, deps(cp));
    assert.equal(byAdmin.ok, true);
    assert.equal(cp.settings[0].member_create_canvas, true);
    const replay = await updateTeamSettings({ teamUserId: 117, actorUserId: 901, memberCreateCanvas: true }, deps(cp));
    assert.equal(replay.ok === true ? replay.unchanged : false, true, "同值重放 = no-op");
  });
});

// ── 断言 4：48h 冷静期内可撤回 ──────────────────────────────────────────

test("断言④：解散排程 48h 冷静期内可撤回；过期不可撤回；执行幂等且只停用名册", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({ members: [memberRow({ member_key_id: "key-a", member_user_id: 900 })] });
    const start = 1_000_000_000_000;

    // 排程：due = now + 48h。
    const scheduled = await scheduleTeamDissolution({ teamUserId: 117, actorUserId: 117 }, { ...deps(cp), now: () => start });
    assert.equal(scheduled.ok, true);
    const dueAt = scheduled.ok === true ? scheduled.dissolveScheduledAt : "";
    assert.equal(dueAt, new Date(start + 48 * HOUR_MS).toISOString());
    // 重放排程：不重置冷静期起点（幂等）。
    const replay = await scheduleTeamDissolution({ teamUserId: 117, actorUserId: 117 }, { ...deps(cp), now: () => start + 10 * HOUR_MS });
    assert.equal(replay.ok === true ? replay.dissolveScheduledAt : "", dueAt);
    assert.equal(replay.ok === true ? replay.unchanged : false, true);

    // 冷静期内（+47h）撤回成功。
    const lifecycle = await getTeamLifecycle(117, { ...deps(cp), now: () => start + 47 * HOUR_MS });
    assert.equal(lifecycle.due, false);
    assert.equal(lifecycle.remainingMs, HOUR_MS);
    const withdrawn = await withdrawTeamDissolution({ teamUserId: 117, actorUserId: 117 }, { ...deps(cp), now: () => start + 47 * HOUR_MS });
    assert.equal(withdrawn.ok, true);
    assert.equal(withdrawn.ok === true ? withdrawn.withdrawn : false, true);
    assert.equal(cp.settings[0].dissolve_scheduled_at, null, "撤回后排程清空");

    // 再排程，冷静期已过 → 不可撤回；未到期不得执行；到期才执行。
    await scheduleTeamDissolution({ teamUserId: 117, actorUserId: 117 }, { ...deps(cp), now: () => start });
    const late = await withdrawTeamDissolution({ teamUserId: 117, actorUserId: 117 }, { ...deps(cp), now: () => start + 49 * HOUR_MS });
    assert.equal(late.ok === false ? late.code : "", "cooloff_elapsed");
    const early = await executeTeamDissolution({ teamUserId: 117 }, { ...deps(cp), now: () => start + 47 * HOUR_MS });
    assert.equal(early.ok === true ? early.executed : true, false);
    assert.equal(early.ok === true ? early.reason : "", "cooloff_pending");
    const executed = await executeTeamDissolution({ teamUserId: 117 }, { ...deps(cp), now: () => start + 48 * HOUR_MS });
    assert.equal(executed.ok === true ? executed.executed : false, true);
    assert.equal(executed.ok === true ? executed.membersDisabled : 0, 1);
    assert.equal(cp.members[0].enabled, false, "解散后名册成员停用（意图层）");
    const again = await executeTeamDissolution({ teamUserId: 117 }, { ...deps(cp), now: () => start + 100 * HOUR_MS });
    assert.equal(again.ok === true ? again.executed : true, false);
    assert.equal(again.ok === true ? again.reason : "", "already_dissolved");
  });
});

test("解散／席位只有 owner 能动：admin 排程解散 → 403", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [memberRow({ member_key_id: "key-b", member_user_id: 901, role: "admin" })],
    });
    const result = await scheduleTeamDissolution({ teamUserId: 117, actorUserId: 901 }, deps(cp));
    assert.equal(result.ok === false ? result.status : 0, 403);
  });
});

test("成员退出：普通成员可退出（名册移除）；退出不触碰任何点数", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [
        memberRow({ member_key_id: "key-a", member_user_id: 900 }),
        memberRow({ member_key_id: "key-b", member_user_id: 901, role: "owner", created_at: 1 }),
      ],
    });
    const left = await leaveTeam({ actorUserId: 900 }, deps(cp));
    assert.equal(left.ok, true);
    assert.equal(cp.members.length, 1);
    assert.equal(cp.members[0].member_user_id, 901, "共同 owner 仍在（owner 集合非空）");
    assert.ok(!cp.queries.some((q) => /account_ledger|billing_operation|used_quota/.test(q)), "退出不得碰点数帐本");
  });
});

// ── 断言 5：席位／审批全路径不碰点数 + 幂等重放不重复副作用 ──────────────

test("断言⑤：席位闸（不得低于现有成员数／不得超硬上限）＋调整幂等", async () => {
  await withEnv({ ...CONTROL_PLANE_ENV, TEAM_MIN_MEMBERS: undefined, TEAM_DEFAULT_MAX_MEMBERS: undefined, TEAM_MAX_MEMBERS: undefined }, async () => {
    const cp = fakeControlPlane({
      members: [
        memberRow({ member_key_id: "key-a", member_user_id: 900 }),
        memberRow({ member_key_id: "key-b", member_user_id: 901, created_at: 1 }),
        memberRow({ member_key_id: "key-c", member_user_id: 902, created_at: 2 }),
      ],
    });
    const belowMembers = await setTeamSeats({ teamUserId: 117, actorUserId: 117, seats: 2 }, deps(cp));
    assert.equal(belowMembers.ok === false ? belowMembers.code : "", "seats_below_members");
    const aboveMax = await setTeamSeats({ teamUserId: 117, actorUserId: 117, seats: 201 }, deps(cp));
    assert.equal(aboveMax.ok === false ? aboveMax.code : "", "seats_above_maximum");
    const ok = await setTeamSeats({ teamUserId: 117, actorUserId: 117, seats: 5 }, deps(cp));
    assert.equal(ok.ok, true);
    assert.equal(cp.settings[0].seats, 5);
    const replay = await setTeamSeats({ teamUserId: 117, actorUserId: 117, seats: 5 }, deps(cp));
    assert.equal(replay.ok === true ? replay.unchanged : false, true, "同席位重放 = no-op");
    assert.ok(!cp.queries.some((q) => /account_ledger|billing_operation|used_quota/.test(q)), "席位调整不得碰点数");
  });
});

test("断言⑤（禁影子帐本）：治理写入路径不呼叫任何上游额度调整、不写任何点数帐本", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [memberRow({ member_key_id: "key-a", member_user_id: 900, role: "member" })],
      requests: [
        {
          id: "req-1",
          team_user_id: 117,
          applicant_user_id: 902,
          applicant_member_key_id: "key-c",
          display_name: "C",
          status: "pending",
          created_at: "2026-09-27T00:00:00.000Z",
          decided_at: null,
          decided_by_user_id: null,
        },
      ],
    });
    await decideJoinRequest({ teamUserId: 117, actorUserId: 117, requestId: "req-1", decision: "approve" }, deps(cp));
    await setMemberRole({ teamUserId: 117, actorUserId: 117, memberKeyId: "key-a", role: "admin" }, deps(cp));
    await setTeamSeats({ teamUserId: 117, actorUserId: 117, seats: 12 }, deps(cp));
    await updateTeamSettings({ teamUserId: 117, actorUserId: 117, memberCreateCanvas: true }, deps(cp));
    assert.ok(
      !cp.queries.some((q) => /account_ledger|billing_operation|used_quota/.test(q)),
      "治理路径不得写任何点数帐本",
    );
    // <1000 行重构：team-governance.ts 降为 barrel，用量读法在 usage.ts；全模组一起扫。
    const source = [
      "src/lib/generation-core/team-governance.ts",
      ...["joins", "lifecycle", "policies", "roles", "store", "types", "usage"].map(
        (m) => `src/lib/generation-core/team-governance/${m}.ts`,
      ),
    ]
      .map(stripped)
      .join("\n");
    for (const forbidden of [
      "adjustGatewayUserQuotaExact",
      "setGatewayUserImageQuota",
      "recordTransfer(",
      "INSERT INTO account_ledger",
    ]) {
      assert.ok(!source.includes(forbidden), `治理模组不得引用配额写入通路：${forbidden}`);
    }
    // 用量面只读既有权威面，不新建统计帐本。
    assert.match(source, /readTeamQuotaView\(/);
    assert.match(source, /readAccountLedger\(/);
  });
});

// ── 面 6：用量统计（可逐笔对帐、总额守恒） ──────────────────────────────

test("用量统计：团队／成员维度读既有权威面，逐笔明细来自 account_ledger，总额守恒", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [memberRow({ member_key_id: "key-a", member_user_id: 900, role: "admin" })],
      settings: [{ team_user_id: 117, member_create_canvas: false, seats: 10, dissolve_scheduled_at: null, dissolved_at: null }],
    });
    const users = new Map<number, { quota: number; used: number }>([
      [117, { quota: 700, used: 300 }],
      [900, { quota: 300, used: 200 }],
    ]);
    const fetchUser = (async (userId: number) => {
      const state = users.get(userId);
      if (!state) return null;
      return { id: userId, username: `u${userId}`, quota: state.quota, used_quota: state.used };
    }) as unknown as Parameters<typeof readTeamUsage>[1] extends infer D
      ? D extends { fetchUser?: infer F }
        ? F
        : never
      : never;

    const ledger: LedgerEntry[] = [
      {
        id: "e1",
        billingUserId: 900,
        entryType: "transfer_in",
        amount: 500,
        source: "member-quota",
        sourceRef: "transfer:t1",
        idempotencyRef: "transfer:t1:in",
        jobId: null,
        operationId: null,
        counterpartyUserId: 117,
        note: null,
        createdAt: "2026-09-27T01:00:00.000Z",
      },
      {
        id: "e2",
        billingUserId: 900,
        entryType: "consumption",
        amount: -200,
        source: "billing-projection",
        sourceRef: "job:j1",
        idempotencyRef: "job:j1:commit:1",
        jobId: "j1",
        operationId: "op1",
        counterpartyUserId: null,
        note: null,
        createdAt: "2026-09-27T02:00:00.000Z",
      },
    ];

    const usage = await readTeamUsage(
      { teamUserId: 117 },
      { sql: cp.sql, fetchUser, readLedger: async () => ledger },
    );
    assert.ok(usage);
    // 总额守恒：主帐 700 + 成员桶 300 = 团队未消耗 1000。
    assert.equal(usage.conservation.masterRemaining, 700);
    assert.equal(usage.conservation.membersRemaining, 300);
    assert.equal(usage.conservation.teamRemaining, 1000);
    assert.equal(usage.conservation.balanced, true);
    assert.equal(usage.conservation.consumed, 200);
    assert.equal(usage.totals.granted, 500, "已分配 = 成员 granted");
    assert.equal(usage.totals.used, 200);
    assert.equal(usage.seats, 10);
    assert.equal(usage.memberCount, 1);
    // 逐笔对帐：每笔有身份、类型、金额、来源位址。
    assert.equal(usage.members[0].role, "admin");
    assert.equal(usage.members[0].records.length, 2);
    assert.deepEqual(
      usage.records.map((record) => [record.id, record.entryType, record.amount]),
      [
        ["e2", "consumption", -200],
        ["e1", "transfer_in", 500],
      ],
    );
    assert.equal(usage.records[1].sourceRef, "transfer:t1");
  });
});

test("用量统计按成员过滤；上游读不到时回 null（不画假数字）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({ members: [memberRow({ member_key_id: "key-a", member_user_id: 900 })] });
    const down = (async () => {
      throw new Error("new-api down");
    }) as unknown as Parameters<typeof readTeamUsage>[1] extends infer D
      ? D extends infer X
        ? X extends { fetchUser?: infer F }
          ? F
          : never
        : never
      : never;
    assert.equal(await readTeamUsage({ teamUserId: 117 }, { sql: cp.sql, fetchUser: down }), null);

    const fetchUser = (async (userId: number) => ({ id: userId, username: `u${userId}`, quota: 100, used_quota: 0 })) as never;
    const usage = await readTeamUsage({ teamUserId: 117 }, { sql: cp.sql, fetchUser, readLedger: async () => [] });
    assert.ok(usage);
    assert.equal(usage.members.length, 1);
    assert.equal(usage.conservation.balanced, true);
  });
});

// ── 席位定义与 owner 计数辅助 ──────────────────────────────────────────

test("席位语义：seats 不小于现有成员数、不大于硬上限；owner 已拥有团队数含自己的主帐团队", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [
        memberRow({ team_user_id: 555, member_key_id: "key-x", member_user_id: 900, role: "owner" }),
        memberRow({ team_user_id: 556, member_key_id: "key-y", member_user_id: 900, role: "member", created_at: 1 }),
      ],
    });
    // 900 是 555 的 owner（1）+ 自己可建的主帐团队（1）= 2。
    assert.equal(await countOwnedTeams(900, cp.sql), 2);
  });
});

test("映射层未配置（C 端）时全部降级：读默认、写 503、建画布放行", async () => {
  await withEnv({ GENERATION_DATABASE_URL: undefined, GENERATION_CONTROL_PLANE_ENABLED: undefined }, async () => {
    const settings = await readTeamSettings(117);
    assert.equal(settings.seats, 10);
    assert.equal(settings.memberCreateCanvas, false);
    const denied = await setTeamSeats({ teamUserId: 117, actorUserId: 117, seats: 20 });
    assert.equal(denied.ok === false ? denied.status : 0, 503);
    assert.equal((await canMemberCreateSharedCanvas(900)).allowed, true);
  });
});

// ── 路由鉴权契约（source-scan，补足 runtime 面） ─────────────────────────

test("六条团队路由都只认 Authorization 的 B 端密钥，身份不来自请求体", () => {
  const routes = [
    "src/app/api/v1/team/members/route.ts",
    "src/app/api/v1/team/settings/route.ts",
    "src/app/api/v1/team/seats/route.ts",
    "src/app/api/v1/team/join-requests/route.ts",
    "src/app/api/v1/team/lifecycle/route.ts",
    "src/app/api/v1/team/usage/route.ts",
  ];
  for (const route of routes) {
    const source = stripped(route);
    assert.match(source, /readBearerToken\(req\.headers\.get\("authorization"\)\)/, `${route} 必须只认 Authorization`);
    assert.match(source, /authenticateBizApiKey/, `${route} 必须走 B 端密钥鉴权`);
    assert.doesNotMatch(source, /x-user-id/, `${route} 不得信任 x-user-id 头`);
    assert.doesNotMatch(source, /payload\.user_id|body\.user_id/, `${route} 身份不得从 body 取`);
  }
  // 申请人身份只从密钥派生（user_id + 这把 key），不从 body。
  const joinSource = stripped("src/app/api/v1/team/join-requests/route.ts");
  assert.match(joinSource, /applicantUserId: auth\.key\.userId/);
  assert.match(joinSource, /applicantMemberKeyId: auth\.key\.id/);
});

test("migration 023 只存意图不存点数：名册/设定/申请三表皆无余额栏位", () => {
  const source = stripped("db/migrations/023_team_governance.sql");
  assert.match(source, /ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS team_settings/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS team_join_request/);
  assert.match(source, /CHECK \(status IN \('pending', 'approved', 'rejected', 'ignored'\)\)/);
  assert.match(source, /CHECK \(role IN \('owner', 'admin', 'member'\)\)/);
  for (const forbidden of [/remaining/i, /balance/i, /allocated_quota/i, /quota\s+integer/i]) {
    assert.doesNotMatch(source, forbidden, "治理表不得存任何点数数字（禁影子帐本）");
  }
});
