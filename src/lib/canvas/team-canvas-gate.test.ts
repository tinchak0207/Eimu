// 團隊畫布作用域 + 成員閘的真行為斷言測試（2026-09-27 片P 刀 1/2/3）。
//
// 姿勢沿用原片F 面 2 測試：注入**假成員查詢**（真 relay 需要控制面端點，未部署前必回 null）
// ＋**真畫布 store**（無 Blob 後端時走進程內記憶體），斷言可觀察行為——放行/拒絕、
// 專案數、落在哪個命名空間、成員讀得到誰的——不是源碼字串。
//
// 覆蓋六條硬斷言：
//   ① scope 缺省＝personal 且路徑不變（個人畫布零改變）
//   ② 團隊畫布寫在 team 命名空間且成員可讀（非成員看不到）
//   ③ 非成員讀團隊畫布被拒（403 member_canvas_forbidden）
//   ④ relay 回 null（含未配置 env）→ 放行（fail-open）
//   ⑤ member 且團隊開關關閉 → 拒 403 member_canvas_forbidden，且不落盤
//   ⑥ owner/admin → 恆放行

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

/** 假查詢注入（缺省＝真 relay，測試一律顯式注入以免打網路）。 */
function asUser(m: TeamMembership | null): (userId: number) => Promise<TeamMembership | null> {
  return async () => m;
}

function project(id: string, over: Partial<CanvasProject> = {}): CanvasProject {
  return {
    id,
    title: "測試畫布",
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

// ── ① scope 缺省＝personal 且路徑不變 ──────────────────────────────────────

test("① scope 缺省＝personal：不帶 scope 的畫布只落個人命名空間，不進 team", async () => {
  __resetCanvasStoreForTests();
  const result = await saveCanvasProjectWithTeamGate(900, project("p-personal"), {
    membership: asUser(membership()),
  });
  assert.equal(result.ok, true);

  const personal = await listCanvasProjects(900);
  assert.equal(personal.length, 1);
  assert.equal(personal[0].id, "p-personal");
  assert.equal(personal[0].scope, undefined, "缺省＝personal（不寫 scope 欄位冒充用戶設定）");
  assert.equal(personal[0].teamId, undefined);

  // 團隊命名空間不得沾到這一份（同一團隊也不行——沒宣告 scope=team 就是個人畫布）。
  assert.equal((await listTeamCanvasProjects(TEAM_ID)).length, 0);
  // 命名空間確實是兩個（路徑不變：個人仍是 canvas/<userId>，團隊另立 canvas/team/<teamId>）。
  assert.equal(teamCanvasNamespace(TEAM_ID), `canvas/team/${TEAM_ID}`);
  assert.notEqual(teamCanvasNamespace(TEAM_ID), `canvas/${TEAM_ID}`);
});

// ── ② 團隊畫布寫在 team 命名空間且成員可讀 ────────────────────────────────

test("② scope=team 寫進 team 命名空間：同團隊成員可讀同一份，非成員看不到", async () => {
  __resetCanvasStoreForTests();
  const result = await saveCanvasProjectWithTeamGate(
    900,
    project("p-team", { scope: "team" }),
    { membership: asUser(membership()) },
  );
  assert.equal(result.ok, true);

  // 落在團隊命名空間，且 teamId 以權威值蓋章。
  const team = await listTeamCanvasProjects(TEAM_ID);
  assert.equal(team.length, 1);
  assert.equal(team[0].id, "p-team");
  assert.equal(team[0].scope, "team");
  assert.equal(team[0].teamId, TEAM_ID);
  // 個人命名空間不留影子（不會兩份）。
  assert.equal((await listCanvasProjects(900)).length, 0);

  // 同團隊另一成員（901）讀清單：拿得到同一份。
  const mate = await listCanvasProjectsForCaller(901, { membership: asUser(membership({ userId: 901 })) });
  assert.deepEqual(mate.map((p) => p.id), ["p-team"]);
  // 非成員（903）讀清單：看不到（個人 + 團隊都沒有）。
  const stranger = await listCanvasProjectsForCaller(903, { membership: asUser(null) });
  assert.deepEqual(stranger.map((p) => p.id), []);
  // 成員自己的個人畫布也一起回來（我個人的 + 我所屬團隊的）。
  await saveCanvasProject(901, project("p-mate-personal"));
  const merged = await listCanvasProjectsForCaller(901, { membership: asUser(membership({ userId: 901 })) });
  assert.deepEqual(merged.map((p) => p.id).sort(), ["p-mate-personal", "p-team"]);
});

// ── ③ 非成員讀團隊畫布被拒 ────────────────────────────────────────────────

test("③ 非成員讀團隊畫布 → 403 member_canvas_forbidden", async () => {
  __resetCanvasStoreForTests();
  await saveCanvasProjectWithTeamGate(900, project("p-team", { scope: "team" }), {
    membership: asUser(membership()),
  });

  // 查不到成員身份（＝非成員）→ 拒。
  const stranger = await readTeamCanvasProjectsForCaller(903, TEAM_ID, { membership: asUser(null) });
  assert.equal(stranger.ok, false);
  if (stranger.ok) return;
  assert.equal(stranger.status, 403);
  assert.equal(stranger.code, "member_canvas_forbidden");
  assert.match(stranger.message, /团队/);

  // 別的團隊的成員 → 也拒（不得跨團讀）。
  const otherTeam = await readTeamCanvasProjectsForCaller(904, TEAM_ID, {
    membership: asUser(membership({ teamId: "T-2", userId: 904 })),
  });
  assert.equal(otherTeam.ok, false);

  // 本團隊成員 → 放行且拿得到。
  const mate = await readTeamCanvasProjectsForCaller(901, TEAM_ID, {
    membership: asUser(membership({ userId: 901 })),
  });
  assert.equal(mate.ok, true);
  if (!mate.ok) return;
  assert.deepEqual(mate.projects.map((p) => p.id), ["p-team"]);

  // teamId 不存在（成員身份不匹配）→ 拒，不得 500。
  const ghost = await readTeamCanvasProjectsForCaller(901, "T-does-not-exist", {
    membership: asUser(membership({ userId: 901 })),
  });
  assert.equal(ghost.ok, false);
});

// ── ④ relay 回 null → 放行（fail-open） ───────────────────────────────────

test("④ relay 回 null → 放行（未配置 env 的真實查詢也回 null，不丟例外）", async () => {
  __resetCanvasStoreForTests();
  // 4a：真查詢在未配置 env 時回 null（不打網路、不丟例外）。
  await withEnv(
    { GENERATION_CONTROL_PLANE_PROXY_ORIGIN: undefined, GENERATION_BILLING_RELAY_SECRET: undefined },
    async () => {
      assert.equal(await lookupTeamMembershipViaRelay(900), null);
      // 默認 deps（＝真 relay）下閘放行。
      const viaRealRelay = await saveCanvasProjectWithTeamGate(900, project("p-null-env"));
      assert.equal(viaRealRelay.ok, true);
    },
  );

  // 4b：注入 null（控制面掛掉／查不到）→ 放行。
  __resetCanvasStoreForTests();
  const viaNull = await saveCanvasProjectWithTeamGate(900, project("p-null"), { membership: asUser(null) });
  assert.equal(viaNull.ok, true);
  assert.equal((await listCanvasProjects(900)).length, 1);

  // 4c：宣告 scope=team 但查不到成員身份 → 降級落個人（fail-open，不拒、不寫進別人的團隊）。
  __resetCanvasStoreForTests();
  const degraded = await saveCanvasProjectWithTeamGate(900, project("p-degraded", { scope: "team" }), {
    membership: asUser(null),
  });
  assert.equal(degraded.ok, true);
  const personal = await listCanvasProjects(900);
  assert.equal(personal.length, 1);
  assert.equal(personal[0].scope, undefined, "查不到成員身份 ⇒ 不得留下幽靈 team 標記");
});

test("④b relay 契約：GET ?user_id=、簽名域 team-membership、空 body、trailing slash 剝除", async () => {
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
        // 簽名原文＝空 body，域分隔＝team-membership（與控制面側驗簽同值）。
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

test("④c relay 失敗/壞載荷 → 一律 null（非 200、ok:false、欄位不合法）", async () => {
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

// ── ⑤ member 且開關關閉 → 拒，且不落盤 ────────────────────────────────────

test("⑤ 成員且開關關閉 → 403 拒；專案數不變（先判後存，無半成品）", async () => {
  __resetCanvasStoreForTests();
  const closed = membership({ memberCreateCanvas: false });
  const before = (await listCanvasProjects(900)).length;
  const result = await saveCanvasProjectWithTeamGate(900, project("p-denied"), { membership: asUser(closed) });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 403);
  assert.equal(result.code, "member_canvas_forbidden");
  assert.match(result.message, /团队/);
  assert.equal((await listCanvasProjects(900)).length, before, "拒絕時不得落盤");
  assert.equal((await listTeamCanvasProjects(TEAM_ID)).length, 0);

  // 團隊畫布也一樣被拒（關的是「建畫布」不是「建個人畫布」）。
  const teamAttempt = await saveCanvasProjectWithTeamGate(900, project("p-denied-team", { scope: "team" }), {
    membership: asUser(closed),
  });
  assert.equal(teamAttempt.ok, false);
  assert.equal((await listTeamCanvasProjects(TEAM_ID)).length, 0);
});

test("⑤b 既有專案的自動存檔（更新）不受事後關閘影響", async () => {
  __resetCanvasStoreForTests();
  await saveCanvasProject(900, project("p-existing"));
  const update = await saveCanvasProjectWithTeamGate(
    900,
    { ...project("p-existing"), title: "改過標題" },
    { membership: asUser(membership({ memberCreateCanvas: false })) },
  );
  assert.equal(update.ok, true, "更新既有專案不得被閘攔");
  const projects = await listCanvasProjects(900);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].title, "改過標題");
});

// ── ⑥ owner/admin 恆放行 ─────────────────────────────────────────────────

test("⑥ owner/admin → 恆放行（開關關閉也放行）", async () => {
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

// ── 跨團寫入防護（不得寫進別人的團隊） ────────────────────────────────────

test("⑦ 宣告 scope=team 但 teamId 與權威值不符 → 403，不落任何命名空間", async () => {
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
