// 团队画布作用域 + 成员闸的真行为断言测试（2026-09-27 片P 刀 1/2/3）。
//
// 姿势沿用原片F 面 2 测试：注入**假成员查询**（真 relay 需要控制面端点，未部署前必回 null）
// ＋**真画布 store**（无 Blob 后端时走进程内记忆体），断言可观察行为——放行/拒绝、
// 专案数、落在哪个命名空间、成员读得到谁的——不是源码字串。
//
// 覆盖六条硬断言：
//   ① scope 缺省＝personal 且路径不变（个人画布零改变）
//   ② 团队画布写在 team 命名空间且成员可读（非成员看不到）
//   ③ 非成员读团队画布被拒（403 member_canvas_forbidden）
//   ④ relay 回 null（含未配置 env）→ 放行（fail-open）
//   ⑤ member 且团队开关关闭 → 拒 403 member_canvas_forbidden，且不落盘
//   ⑥ owner/admin → 恒放行

import assert from "node:assert/strict";
import test from "node:test";

import { signBizKeySync } from "@/lib/biz-key-sync";
import { lookupTeamMembershipViaRelay, type TeamMembership } from "@/lib/team-membership-lookup";

import {
  __resetCanvasStoreForTests,
  listCanvasProjects,
  listTeamCanvasProjects,
  saveCanvasProject,
  teamCanvasNamespace,
} from "./project-store";
import {
  listCanvasProjectsForCaller,
  readTeamCanvasProjectsForCaller,
  saveCanvasProjectWithTeamGate,
} from "./team-canvas-gate";
import type { CanvasProject } from "./types";

const TEAM_ID = "T-1";

function membership(over: Partial<TeamMembership> = {}): TeamMembership {
  return { teamId: TEAM_ID, userId: 900, role: "member", memberCreateCanvas: true, seats: 5, ...over };
}

/** 假查询注入（缺省＝真 relay，测试一律显式注入以免打网路）。 */
function asUser(m: TeamMembership | null): (userId: number) => Promise<TeamMembership | null> {
  return async () => m;
}

function project(id: string, over: Partial<CanvasProject> = {}): CanvasProject {
  return {
    id,
    title: "测试画布",
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    nodes: [],
    connections: [],
    viewport: { x: 0, y: 0, k: 1 },
    backgroundMode: "dots",
    ...over,
  };
}

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
    if (result instanceof Promise) return await result.finally(restore);
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

// ── ① scope 缺省＝personal 且路径不变 ──────────────────────────────────────

test("① scope 缺省＝personal：不带 scope 的画布只落个人命名空间，不进 team", async () => {
  __resetCanvasStoreForTests();
  const result = await saveCanvasProjectWithTeamGate(900, project("p-personal"), {
    membership: asUser(membership()),
  });
  assert.equal(result.ok, true);

  const personal = await listCanvasProjects(900);
  assert.equal(personal.length, 1);
  assert.equal(personal[0].id, "p-personal");
  assert.equal(personal[0].scope, undefined, "缺省＝personal（不写 scope 栏位冒充用户设定）");
  assert.equal(personal[0].teamId, undefined);

  // 团队命名空间不得沾到这一份（同一团队也不行——没宣告 scope=team 就是个人画布）。
  assert.equal((await listTeamCanvasProjects(TEAM_ID)).length, 0);
  // 命名空间确实是两个（路径不变：个人仍是 canvas/<userId>，团队另立 canvas/team/<teamId>）。
  assert.equal(teamCanvasNamespace(TEAM_ID), `canvas/team/${TEAM_ID}`);
  assert.notEqual(teamCanvasNamespace(TEAM_ID), `canvas/${TEAM_ID}`);
});

// ── ② 团队画布写在 team 命名空间且成员可读 ────────────────────────────────

test("② scope=team 写进 team 命名空间：同团队成员可读同一份，非成员看不到", async () => {
  __resetCanvasStoreForTests();
  const result = await saveCanvasProjectWithTeamGate(
    900,
    project("p-team", { scope: "team" }),
    { membership: asUser(membership()) },
  );
  assert.equal(result.ok, true);

  // 落在团队命名空间，且 teamId 以权威值盖章。
  const team = await listTeamCanvasProjects(TEAM_ID);
  assert.equal(team.length, 1);
  assert.equal(team[0].id, "p-team");
  assert.equal(team[0].scope, "team");
  assert.equal(team[0].teamId, TEAM_ID);
  // 个人命名空间不留影子（不会两份）。
  assert.equal((await listCanvasProjects(900)).length, 0);

  // 同团队另一成员（901）读清单：拿得到同一份。
  const mate = await listCanvasProjectsForCaller(901, { membership: asUser(membership({ userId: 901 })) });
  assert.deepEqual(mate.map((p) => p.id), ["p-team"]);
  // 非成员（903）读清单：看不到（个人 + 团队都没有）。
  const stranger = await listCanvasProjectsForCaller(903, { membership: asUser(null) });
  assert.deepEqual(stranger.map((p) => p.id), []);
  // 成员自己的个人画布也一起回来（我个人的 + 我所属团队的）。
  await saveCanvasProject(901, project("p-mate-personal"));
  const merged = await listCanvasProjectsForCaller(901, { membership: asUser(membership({ userId: 901 })) });
  assert.deepEqual(merged.map((p) => p.id).sort(), ["p-mate-personal", "p-team"]);
});

// ── ③ 非成员读团队画布被拒 ────────────────────────────────────────────────

test("③ 非成员读团队画布 → 403 member_canvas_forbidden", async () => {
  __resetCanvasStoreForTests();
  await saveCanvasProjectWithTeamGate(900, project("p-team", { scope: "team" }), {
    membership: asUser(membership()),
  });

  // 查不到成员身份（＝非成员）→ 拒。
  const stranger = await readTeamCanvasProjectsForCaller(903, TEAM_ID, { membership: asUser(null) });
  assert.equal(stranger.ok, false);
  if (stranger.ok) return;
  assert.equal(stranger.status, 403);
  assert.equal(stranger.code, "member_canvas_forbidden");
  assert.match(stranger.message, /团队/);

  // 别的团队的成员 → 也拒（不得跨团读）。
  const otherTeam = await readTeamCanvasProjectsForCaller(904, TEAM_ID, {
    membership: asUser(membership({ teamId: "T-2", userId: 904 })),
  });
  assert.equal(otherTeam.ok, false);

  // 本团队成员 → 放行且拿得到。
  const mate = await readTeamCanvasProjectsForCaller(901, TEAM_ID, {
    membership: asUser(membership({ userId: 901 })),
  });
  assert.equal(mate.ok, true);
  if (!mate.ok) return;
  assert.deepEqual(mate.projects.map((p) => p.id), ["p-team"]);

  // teamId 不存在（成员身份不匹配）→ 拒，不得 500。
  const ghost = await readTeamCanvasProjectsForCaller(901, "T-does-not-exist", {
    membership: asUser(membership({ userId: 901 })),
  });
  assert.equal(ghost.ok, false);
});

// ── ④ relay 回 null → 放行（fail-open） ───────────────────────────────────

test("④ relay 回 null → 放行（未配置 env 的真实查询也回 null，不丢例外）", async () => {
  __resetCanvasStoreForTests();
  // 4a：真查询在未配置 env 时回 null（不打网路、不丢例外）。
  await withEnv(
    { GENERATION_CONTROL_PLANE_PROXY_ORIGIN: undefined, GENERATION_BILLING_RELAY_SECRET: undefined },
    async () => {
      assert.equal(await lookupTeamMembershipViaRelay(900), null);
      // 默认 deps（＝真 relay）下闸放行。
      const viaRealRelay = await saveCanvasProjectWithTeamGate(900, project("p-null-env"));
      assert.equal(viaRealRelay.ok, true);
    },
  );

  // 4b：注入 null（控制面挂掉／查不到）→ 放行。
  __resetCanvasStoreForTests();
  const viaNull = await saveCanvasProjectWithTeamGate(900, project("p-null"), { membership: asUser(null) });
  assert.equal(viaNull.ok, true);
  assert.equal((await listCanvasProjects(900)).length, 1);

  // 4c：宣告 scope=team 但查不到成员身份 → 降级落个人（fail-open，不拒、不写进别人的团队）。
  __resetCanvasStoreForTests();
  const degraded = await saveCanvasProjectWithTeamGate(900, project("p-degraded", { scope: "team" }), {
    membership: asUser(null),
  });
  assert.equal(degraded.ok, true);
  const personal = await listCanvasProjects(900);
  assert.equal(personal.length, 1);
  assert.equal(personal[0].scope, undefined, "查不到成员身份 ⇒ 不得留下幽灵 team 标记");
});

test("④b relay 契约：GET ?user_id=、签名域 team-membership、空 body、trailing slash 剥除", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withEnv(
      {
        GENERATION_CONTROL_PLANE_PROXY_ORIGIN: "https://cp.example.com/",
        GENERATION_BILLING_RELAY_SECRET: "s3cret",
      },
      async () => {
        let capturedUrl = "";
        let capturedInit: RequestInit | undefined;
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
          capturedUrl = String(url);
          capturedInit = init;
          return new Response(
            JSON.stringify({
              ok: true,
              membership: { teamId: TEAM_ID, userId: 900, role: "member", memberCreateCanvas: false, seats: 5 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as typeof fetch;

        const found = await lookupTeamMembershipViaRelay(900);
        assert.equal(
          capturedUrl,
          `https://cp.example.com/image-control/api/internal/team-membership?user_id=900`,
        );
        assert.equal(capturedInit?.method, "GET");
        const headers = capturedInit?.headers as Record<string, string>;
        const ts = headers["X-Biz-Key-Sync-Timestamp"];
        assert.match(ts, /^\d+$/);
        // 签名原文＝空 body，域分隔＝team-membership（与控制面侧验签同值）。
        assert.equal(headers["X-Biz-Key-Sync-Signature"], signBizKeySync("s3cret", ts, "", "team-membership"));
        assert.deepEqual(found, {
          teamId: TEAM_ID,
          userId: 900,
          role: "member",
          memberCreateCanvas: false,
          seats: 5,
        });
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("④c relay 失败/坏载荷 → 一律 null（非 200、ok:false、栏位不合法）", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withEnv(
      { GENERATION_CONTROL_PLANE_PROXY_ORIGIN: "https://cp.example.com", GENERATION_BILLING_RELAY_SECRET: "s3cret" },
      async () => {
        const cases: { status: number; body: unknown }[] = [
          { status: 500, body: { ok: true, membership: membership() } },
          { status: 200, body: { ok: false } },
          { status: 200, body: { ok: true, membership: { teamId: TEAM_ID, userId: 900, role: "boss" } } },
          { status: 200, body: { ok: true, membership: null } },
          { status: 200, body: "not json" },
        ];
        for (const item of cases) {
          globalThis.fetch = (async () =>
            new Response(JSON.stringify(item.body), {
              status: item.status,
              headers: { "content-type": "application/json" },
            })) as typeof fetch;
          assert.equal(await lookupTeamMembershipViaRelay(900), null, `case ${JSON.stringify(item)}`);
        }
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── ⑤ member 且开关关闭 → 拒，且不落盘 ────────────────────────────────────

test("⑤ 成员且开关关闭 → 403 拒；专案数不变（先判后存，无半成品）", async () => {
  __resetCanvasStoreForTests();
  const closed = membership({ memberCreateCanvas: false });
  const before = (await listCanvasProjects(900)).length;
  const result = await saveCanvasProjectWithTeamGate(900, project("p-denied"), { membership: asUser(closed) });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 403);
  assert.equal(result.code, "member_canvas_forbidden");
  assert.match(result.message, /团队/);
  assert.equal((await listCanvasProjects(900)).length, before, "拒绝时不得落盘");
  assert.equal((await listTeamCanvasProjects(TEAM_ID)).length, 0);

  // 团队画布也一样被拒（关的是「建画布」不是「建个人画布」）。
  const teamAttempt = await saveCanvasProjectWithTeamGate(900, project("p-denied-team", { scope: "team" }), {
    membership: asUser(closed),
  });
  assert.equal(teamAttempt.ok, false);
  assert.equal((await listTeamCanvasProjects(TEAM_ID)).length, 0);
});

test("⑤b 既有专案的自动存档（更新）不受事后关闸影响", async () => {
  __resetCanvasStoreForTests();
  await saveCanvasProject(900, project("p-existing"));
  const update = await saveCanvasProjectWithTeamGate(
    900,
    { ...project("p-existing"), title: "改过标题" },
    { membership: asUser(membership({ memberCreateCanvas: false })) },
  );
  assert.equal(update.ok, true, "更新既有专案不得被闸拦");
  const projects = await listCanvasProjects(900);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].title, "改过标题");
});

// ── ⑥ owner/admin 恒放行 ─────────────────────────────────────────────────

test("⑥ owner/admin → 恒放行（开关关闭也放行）", async () => {
  __resetCanvasStoreForTests();
  const closed = { memberCreateCanvas: false };
  const owner = await saveCanvasProjectWithTeamGate(901, project("p-owner", { scope: "team" }), {
    membership: asUser(membership({ userId: 901, role: "owner", ...closed })),
  });
  assert.equal(owner.ok, true);
  const admin = await saveCanvasProjectWithTeamGate(902, project("p-admin", { scope: "team" }), {
    membership: asUser(membership({ userId: 902, role: "admin", ...closed })),
  });
  assert.equal(admin.ok, true);
  assert.deepEqual(
    (await listTeamCanvasProjects(TEAM_ID)).map((p) => p.id).sort(),
    ["p-admin", "p-owner"],
  );
});

// ── 跨团写入防护（不得写进别人的团队） ────────────────────────────────────

test("⑦ 宣告 scope=team 但 teamId 与权威值不符 → 403，不落任何命名空间", async () => {
  __resetCanvasStoreForTests();
  const result = await saveCanvasProjectWithTeamGate(
    900,
    project("p-cross", { scope: "team", teamId: "T-someone-else" }),
    { membership: asUser(membership()) },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 403);
  assert.equal(result.code, "member_canvas_forbidden");
  assert.equal((await listTeamCanvasProjects(TEAM_ID)).length, 0);
  assert.equal((await listTeamCanvasProjects("T-someone-else")).length, 0);
  assert.equal((await listCanvasProjects(900)).length, 0);
});
