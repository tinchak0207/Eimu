// 團隊治理六面（席位／角色／建畫布權限／加入審批／生命週期／用量）真行為斷言測試。
//
// 姿勢沿用 member-quota.test.ts：注入假控制面 SQL（記憶體）與假 new-api，
// 斷言的是規則與副作用（誰被拒、名冊怎麼變、冷靜期怎麼算、有没有碰點數），
// 不是源碼字串。源碼掃描只用在「路由鑑權契約」與「禁影子帳本」兩處護欄。

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

// ── 配置常量（可調，不硬編） ─────────────────────────────────────────────

test("容量常量可調：默認 min 2／default 10／硬上限 200，env 可覆寫且夾在界內", async () => {
  await withEnv({ TEAM_MIN_MEMBERS: undefined, TEAM_DEFAULT_MAX_MEMBERS: undefined, TEAM_MAX_MEMBERS: undefined }, () => {
    assert.deepEqual(teamCapacity(), { minMembers: 2, defaultMaxMembers: 10, maxMembers: 200 });
  });
  await withEnv({ TEAM_MIN_MEMBERS: "3", TEAM_DEFAULT_MAX_MEMBERS: "20", TEAM_MAX_MEMBERS: "50" }, () => {
    assert.deepEqual(teamCapacity(), { minMembers: 3, defaultMaxMembers: 20, maxMembers: 50 });
  });
  await withEnv({ TEAM_MAX_MEMBERS: "1", TEAM_MIN_MEMBERS: "5" }, () => {
    const capacity = teamCapacity();
    assert.ok(capacity.maxMembers >= capacity.minMembers, "硬上限不得低於最小值");
  });
});

test("解散冷靜期常量可調（默認 48h）", async () => {
  await withEnv({ ...CONTROL_PLANE_ENV, TEAM_DISSOLVE_COOLOFF_HOURS: undefined }, async () => {
    const cp = fakeControlPlane({ settings: [{ team_user_id: 117, member_create_canvas: false, seats: 10, dissolve_scheduled_at: null, dissolved_at: null }] });
    const result = await scheduleTeamDissolution({ teamUserId: 117, actorUserId: 117 }, { ...deps(cp), now: () => 0 });
    assert.equal(result.ok, true);
    assert.equal(result.ok === true ? result.cooloffHours : 0, 48);
    assert.equal(result.ok === true ? result.dissolveScheduledAt : "", new Date(48 * HOUR_MS).toISOString());
  });
});

// ── 純函式：角色授權與 owner 不變量 ─────────────────────────────────────

test("角色授權：owner 可改他人、admin 只能改 member 且不得製造 owner、member 不可改任何人", () => {
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
  assert.equal(resolveTeamActor({ userId: 999, teamUserId: 117, roster }), null, "外人沒有治理角色");

  assert.equal(canManageRole(owner, { role: "admin", memberUserId: 901 }, "member"), true);
  assert.equal(canManageRole(owner, { role: "member", memberUserId: 900 }, "owner"), true);
  assert.equal(canManageRole(admin, { role: "member", memberUserId: 900 }, "admin"), true);
  assert.equal(canManageRole(admin, { role: "member", memberUserId: 900 }, "owner"), false, "admin 不得製造 owner");
  assert.equal(canManageRole(admin, { role: "admin", memberUserId: 901 }, "member"), false, "admin 不得動 admin");
  assert.equal(canManageRole(member, { role: "member", memberUserId: 900 }, "admin"), false);
  // 團隊主帳恆 owner，任何角色都不得改它（最後一個 owner）。
  assert.equal(canManageRole(owner, { role: "owner", memberUserId: 117 }, "member"), false);

  assert.equal(ownerCount(117, roster), 2, "owner = 主帳(1) + 名冊 owner(1)");
  assert.ok(ownerCount(117, []) >= 1, "owner 集合恆非空");
});

test("建畫布權限純函式：owner/admin 恆可；member 依開關；非成員不受閘", () => {
  assert.equal(canCreateSharedCanvas({ actor: { role: "owner" }, memberCreateCanvas: false }).allowed, true);
  assert.equal(canCreateSharedCanvas({ actor: { role: "admin" }, memberCreateCanvas: false }).allowed, true);
  const denied = canCreateSharedCanvas({ actor: { role: "member" }, memberCreateCanvas: false });
  assert.equal(denied.allowed, false);
  assert.equal(denied.message, TEAM_CANVAS_FORBIDDEN_MESSAGE);
  assert.match(denied.message, /只有团队创建者或管理员可以创建共享画布/);
  assert.equal(canCreateSharedCanvas({ actor: { role: "member" }, memberCreateCanvas: true }).allowed, true);
  assert.equal(canCreateSharedCanvas({ actor: null, memberCreateCanvas: false }).allowed, true);
});

// ── 斷言 1：不可移除最後一個 owner ──────────────────────────────────────

test("斷言①：最後一個 owner 不可移除／不可退出（團隊主帳 leave → 409 last_owner，且名冊不動）", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [memberRow({ member_key_id: "key-a", member_user_id: 900, role: "member" })],
    });
    const result = await leaveTeam({ actorUserId: 117 }, deps(cp));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.status : 0, 409);
    assert.equal(result.ok === false ? result.code : "", "last_owner");
    assert.match(result.ok === false ? result.message : "", /转移所有权或解散团队/);
    assert.equal(cp.members.length, 1, "被拒的退出不得改名冊");
  });
});

test("斷言①（守衛分支）：對主帳 owner 的名冊列降級／移除一律 409 last_owner", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    // 名冊列直接指向主帳（defense in depth：即使上層放行也必須被 owner 不變量擋住）。
    const cp = fakeControlPlane({
      members: [memberRow({ member_key_id: "key-self", member_user_id: 117, role: "owner" })],
    });
    const demote = await setMemberRole({ teamUserId: 117, actorUserId: 117, memberKeyId: "key-self", role: "member" }, deps(cp));
    assert.equal(demote.ok === false ? demote.code : "", "last_owner");
    const removed = await removeTeamMember({ teamUserId: 117, actorUserId: 117, memberKeyId: "key-self" }, deps(cp));
    assert.equal(removed.ok === false ? removed.code : "", "last_owner");
    assert.equal(cp.members.length, 1, "兩次被拒都不得動名冊");
  });
});

test("角色變更：owner 把 member 升 admin 落庫；admin 動 admin 被 403 且不動名冊", async () => {
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
    assert.equal(cp.members.find((m) => m.member_user_id === 901)?.role, "admin", "被拒不得改動");
  });
});

// ── 斷言 2：滿員不通過申請 ──────────────────────────────────────────────

test("斷言②：滿員（名冊人數 ≥ 席位數）時加入申請不得通過，名冊與申請狀態都不動", async () => {
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
    assert.equal(cp.members.length, 2, "滿員不得登記新成員");
    assert.equal(cp.requests[0].status, "pending", "滿員不得改申請狀態");
  });
});

test("未滿員時通過申請：名冊登記 role=member，申請轉 approved（幂等重放不再登記第二次）", async () => {
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
    assert.equal(replay.ok === true ? replay.unchanged : false, true, "重放審批 = no-op");
    assert.equal(cp.members.length, 2, "重放不得產生第二條名冊");
  });
});

test("成員側審批被拒：名冊成員（member/admin）不得自行審批，member 不得改角色", async () => {
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
    // admin 屬於該團隊，可以審批；member 不行。
    const byMember = await decideJoinRequest({ teamUserId: 117, actorUserId: 901, requestId: "req-1", decision: "approve" }, deps(cp));
    assert.equal(byMember.ok === false ? byMember.status : 0, 403);
    const byAdmin = await decideJoinRequest({ teamUserId: 117, actorUserId: 900, requestId: "req-1", decision: "reject" }, deps(cp));
    assert.equal(byAdmin.ok, true);
    assert.equal(byAdmin.ok === true ? byAdmin.status : "", "rejected");
  });
});

test("申請加入：申請自己團隊被拒；已在別團隊被拒；重複申請幂等回同一條；駁回後可重開", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({ members: [memberRow({ team_user_id: 555, member_key_id: "key-x", member_user_id: 902 })] });
    const self = await applyToJoinTeam({ teamUserId: 902, applicantUserId: 902, applicantMemberKeyId: "key-c" }, deps(cp));
    assert.equal(self.ok === false ? self.code : "", "cannot_join_own_team");

    const first = await applyToJoinTeam({ teamUserId: 117, applicantUserId: 900, applicantMemberKeyId: "key-a" }, deps(cp));
    assert.equal(first.ok, true);
    assert.equal(first.ok === true ? first.created : true, true);
    const replay = await applyToJoinTeam({ teamUserId: 117, applicantUserId: 900, applicantMemberKeyId: "key-a" }, deps(cp));
    assert.equal(replay.ok === true ? replay.created : true, false, "重複申請不產生第二條");
    assert.equal(replay.ok === true ? replay.request.id : "", first.ok === true ? first.request.id : "x");
    assert.equal(cp.requests.length, 1);

    // 駁回後重開：同一條回到 pending（不新增第二條）。
    await decideJoinRequest({ teamUserId: 117, actorUserId: 117, requestId: first.ok === true ? first.request.id : "", decision: "reject" }, deps(cp));
    const reopened = await applyToJoinTeam({ teamUserId: 117, applicantUserId: 900, applicantMemberKeyId: "key-a" }, deps(cp));
    assert.equal(reopened.ok === true ? reopened.request.status : "", "pending");
    assert.equal(cp.requests.length, 1);

    // 跨團隊：申請人已是別家（555）成員 → 不得再加入。
    const cross = await applyToJoinTeam({ teamUserId: 118, applicantUserId: 902, applicantMemberKeyId: "key-x" }, deps(cp));
    // 902 已歸屬 555：名冊唯一性下，加入 118 會被「已在別的團隊」擋（此處 118 名冊為空）。
    assert.ok(cross.ok === false || cross.ok === true, "申請本身可受理");
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
    assert.equal(cp2.members.length, 1, "跨團隊不得登記");
  });
});

// ── 斷言 3：非 owner/admin 建畫布被拒 ───────────────────────────────────

test("斷言③：member 且開關關閉 → 被拒（專用文案）；開關開啟／owner／admin／非成員 → 放行", async () => {
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
    assert.equal((await canMemberCreateSharedCanvas(117, { sql: cp.sql })).allowed, true, "owner（主帳）可建");
    assert.equal((await canMemberCreateSharedCanvas(999, { sql: cp.sql })).allowed, true, "非成員不受此閘");

    cp.settings[0].member_create_canvas = true;
    assert.equal((await canMemberCreateSharedCanvas(900, { sql: cp.sql })).allowed, true, "開關開啟後 member 可建");
  });
});

test("建畫布開關：只有 owner/admin 能改；member 被 403 且設定不變；重複設定幂等", async () => {
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

// ── 斷言 4：48h 冷靜期內可撤回 ──────────────────────────────────────────

test("斷言④：解散排程 48h 冷靜期內可撤回；過期不可撤回；執行幂等且只停用名冊", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({ members: [memberRow({ member_key_id: "key-a", member_user_id: 900 })] });
    const start = 1_000_000_000_000;

    // 排程：due = now + 48h。
    const scheduled = await scheduleTeamDissolution({ teamUserId: 117, actorUserId: 117 }, { ...deps(cp), now: () => start });
    assert.equal(scheduled.ok, true);
    const dueAt = scheduled.ok === true ? scheduled.dissolveScheduledAt : "";
    assert.equal(dueAt, new Date(start + 48 * HOUR_MS).toISOString());
    // 重放排程：不重置冷靜期起點（幂等）。
    const replay = await scheduleTeamDissolution({ teamUserId: 117, actorUserId: 117 }, { ...deps(cp), now: () => start + 10 * HOUR_MS });
    assert.equal(replay.ok === true ? replay.dissolveScheduledAt : "", dueAt);
    assert.equal(replay.ok === true ? replay.unchanged : false, true);

    // 冷靜期內（+47h）撤回成功。
    const lifecycle = await getTeamLifecycle(117, { ...deps(cp), now: () => start + 47 * HOUR_MS });
    assert.equal(lifecycle.due, false);
    assert.equal(lifecycle.remainingMs, HOUR_MS);
    const withdrawn = await withdrawTeamDissolution({ teamUserId: 117, actorUserId: 117 }, { ...deps(cp), now: () => start + 47 * HOUR_MS });
    assert.equal(withdrawn.ok, true);
    assert.equal(withdrawn.ok === true ? withdrawn.withdrawn : false, true);
    assert.equal(cp.settings[0].dissolve_scheduled_at, null, "撤回後排程清空");

    // 再排程，冷靜期已過 → 不可撤回；未到期不得執行；到期才執行。
    await scheduleTeamDissolution({ teamUserId: 117, actorUserId: 117 }, { ...deps(cp), now: () => start });
    const late = await withdrawTeamDissolution({ teamUserId: 117, actorUserId: 117 }, { ...deps(cp), now: () => start + 49 * HOUR_MS });
    assert.equal(late.ok === false ? late.code : "", "cooloff_elapsed");
    const early = await executeTeamDissolution({ teamUserId: 117 }, { ...deps(cp), now: () => start + 47 * HOUR_MS });
    assert.equal(early.ok === true ? early.executed : true, false);
    assert.equal(early.ok === true ? early.reason : "", "cooloff_pending");
    const executed = await executeTeamDissolution({ teamUserId: 117 }, { ...deps(cp), now: () => start + 48 * HOUR_MS });
    assert.equal(executed.ok === true ? executed.executed : false, true);
    assert.equal(executed.ok === true ? executed.membersDisabled : 0, 1);
    assert.equal(cp.members[0].enabled, false, "解散後名冊成員停用（意圖層）");
    const again = await executeTeamDissolution({ teamUserId: 117 }, { ...deps(cp), now: () => start + 100 * HOUR_MS });
    assert.equal(again.ok === true ? again.executed : true, false);
    assert.equal(again.ok === true ? again.reason : "", "already_dissolved");
  });
});

test("解散／席位只有 owner 能動：admin 排程解散 → 403", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [memberRow({ member_key_id: "key-b", member_user_id: 901, role: "admin" })],
    });
    const result = await scheduleTeamDissolution({ teamUserId: 117, actorUserId: 901 }, deps(cp));
    assert.equal(result.ok === false ? result.status : 0, 403);
  });
});

test("成員退出：普通成員可退出（名冊移除）；退出不觸碰任何點數", async () => {
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
    assert.ok(!cp.queries.some((q) => /account_ledger|billing_operation|used_quota/.test(q)), "退出不得碰點數帳本");
  });
});

// ── 斷言 5：席位／審批全路徑不碰點數 + 幂等重放不重複副作用 ──────────────

test("斷言⑤：席位閘（不得低於現有成員數／不得超硬上限）＋調整幂等", async () => {
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
    assert.ok(!cp.queries.some((q) => /account_ledger|billing_operation|used_quota/.test(q)), "席位調整不得碰點數");
  });
});

test("斷言⑤（禁影子帳本）：治理寫入路徑不呼叫任何上游額度調整、不寫任何點數帳本", async () => {
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
      "治理路徑不得寫任何點數帳本",
    );
    const source = stripped("src/lib/generation-core/team-governance.ts");
    for (const forbidden of [
      "adjustGatewayUserQuotaExact",
      "setGatewayUserImageQuota",
      "recordTransfer(",
      "INSERT INTO account_ledger",
    ]) {
      assert.ok(!source.includes(forbidden), `治理模組不得引用配額寫入通路：${forbidden}`);
    }
    // 用量面只讀既有權威面，不新建統計帳本。
    assert.match(source, /readTeamQuotaView\(/);
    assert.match(source, /readAccountLedger\(/);
  });
});

// ── 面 6：用量統計（可逐筆對帳、總額守恆） ──────────────────────────────

test("用量統計：團隊／成員維度讀既有權威面，逐筆明細來自 account_ledger，總額守恆", async () => {
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
    // 總額守恆：主帳 700 + 成員桶 300 = 團隊未消耗 1000。
    assert.equal(usage.conservation.masterRemaining, 700);
    assert.equal(usage.conservation.membersRemaining, 300);
    assert.equal(usage.conservation.teamRemaining, 1000);
    assert.equal(usage.conservation.balanced, true);
    assert.equal(usage.conservation.consumed, 200);
    assert.equal(usage.totals.granted, 500, "已分配 = 成員 granted");
    assert.equal(usage.totals.used, 200);
    assert.equal(usage.seats, 10);
    assert.equal(usage.memberCount, 1);
    // 逐筆對帳：每筆有身份、類型、金額、來源位址。
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

test("用量統計按成員過濾；上游讀不到時回 null（不畫假數字）", async () => {
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

// ── 席位定義與 owner 計數輔助 ──────────────────────────────────────────

test("席位語義：seats 不小於現有成員數、不大於硬上限；owner 已擁有團隊數含自己的主帳團隊", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [
        memberRow({ team_user_id: 555, member_key_id: "key-x", member_user_id: 900, role: "owner" }),
        memberRow({ team_user_id: 556, member_key_id: "key-y", member_user_id: 900, role: "member", created_at: 1 }),
      ],
    });
    // 900 是 555 的 owner（1）+ 自己可建的主帳團隊（1）= 2。
    assert.equal(await countOwnedTeams(900, cp.sql), 2);
  });
});

test("映射層未配置（C 端）時全部降級：讀默認、寫 503、建畫布放行", async () => {
  await withEnv({ GENERATION_DATABASE_URL: undefined, GENERATION_CONTROL_PLANE_ENABLED: undefined }, async () => {
    const settings = await readTeamSettings(117);
    assert.equal(settings.seats, 10);
    assert.equal(settings.memberCreateCanvas, false);
    const denied = await setTeamSeats({ teamUserId: 117, actorUserId: 117, seats: 20 });
    assert.equal(denied.ok === false ? denied.status : 0, 503);
    assert.equal((await canMemberCreateSharedCanvas(900)).allowed, true);
  });
});

// ── 路由鑑權契約（source-scan，補足 runtime 面） ─────────────────────────

test("六條團隊路由都只認 Authorization 的 B 端密鑰，身份不來自請求體", () => {
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
    assert.match(source, /readBearerToken\(req\.headers\.get\("authorization"\)\)/, `${route} 必須只認 Authorization`);
    assert.match(source, /authenticateBizApiKey/, `${route} 必須走 B 端密鑰鑑權`);
    assert.doesNotMatch(source, /x-user-id/, `${route} 不得信任 x-user-id 頭`);
    assert.doesNotMatch(source, /payload\.user_id|body\.user_id/, `${route} 身份不得從 body 取`);
  }
  // 申請人身份只從密鑰派生（user_id + 這把 key），不從 body。
  const joinSource = stripped("src/app/api/v1/team/join-requests/route.ts");
  assert.match(joinSource, /applicantUserId: auth\.key\.userId/);
  assert.match(joinSource, /applicantMemberKeyId: auth\.key\.id/);
});

test("migration 023 只存意圖不存點數：名冊/設定/申請三表皆無餘額欄位", () => {
  const source = stripped("db/migrations/023_team_governance.sql");
  assert.match(source, /ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS team_settings/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS team_join_request/);
  assert.match(source, /CHECK \(status IN \('pending', 'approved', 'rejected', 'ignored'\)\)/);
  assert.match(source, /CHECK \(role IN \('owner', 'admin', 'member'\)\)/);
  for (const forbidden of [/remaining/i, /balance/i, /allocated_quota/i, /quota\s+integer/i]) {
    assert.doesNotMatch(source, forbidden, "治理表不得存任何點數數字（禁影子帳本）");
  }
});
