// 團隊建畫布閘接線的真行為斷言測試（片F 面 2 接線）。
//
// 姿勢沿用 team-governance.test.ts：注入**假控制面 SQL**（記憶體）＋**真畫布 store**
// （無 Blob 後端時走進程內記憶體），斷言的是可觀察行為——放行/拒絕、專案數、
// 有無半成品——不是源碼字串。
//
// 覆蓋四條硬斷言：
//   ① 成員（role=member）且團隊開關關閉 → 拒，且專案數不變（無半成品）
//   ② 開關開啟 → 放行且專案真的落盤
//   ③ owner（團隊主帳）與 admin → 恆放行
//   ④ 非成員（個人帳號）建畫布 → 恆放行（個人畫布不受此閘）
//   ⑤ 既有專案的自動存檔（更新）不受事後關閘影響

import assert from "node:assert/strict";
import test from "node:test";

import type { GenerationSql } from "@/lib/generation-core/database";

import { listCanvasProjects, saveCanvasProject, __resetCanvasStoreForTests } from "./project-store";
import { saveCanvasProjectWithTeamGate } from "./team-canvas-gate";
import type { CanvasProject } from "./types";

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
    if (result instanceof Promise) return await result.finally(restore);
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

// ── 假控制面：只支援本閘真正會打到的兩條讀取（名冊一條、設定一條） ──────────

interface FakeMember {
  team_user_id: number;
  member_user_id: number;
  role: "owner" | "admin" | "member";
}

function fakeControlPlane(seed: { members?: FakeMember[]; memberCreateCanvas: boolean }): {
  sql: GenerationSql;
} {
  const members = [...(seed.members ?? [])];
  const settings = { team_user_id: 0, member_create_canvas: seed.memberCreateCanvas };

  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(" ? ");
    if (q.includes("SELECT") && q.includes("FROM team_member_quota")) {
      return members.filter((m) => m.member_user_id === Number(values[0])).slice(0, 1);
    }
    if (q.includes("SELECT") && q.includes("FROM team_settings")) {
      return [{ ...settings, team_user_id: Number(values[0]) }];
    }
    throw new Error(`fake sql 未覆蓋的查詢：${q}`);
  }) as unknown as GenerationSql;

  return { sql: tagged };
}

function project(id: string): CanvasProject {
  return {
    id,
    title: "測試畫布",
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    nodes: [],
    connections: [],
    viewport: { x: 0, y: 0, k: 1 },
    backgroundMode: "dots",
  };
}

const MEMBER_TEAM = 117;

test("① 成員且開關關閉 → 拒；專案數不變（先判後存，無半成品）", async () => {
  __resetCanvasStoreForTests();
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [{ team_user_id: MEMBER_TEAM, member_user_id: 900, role: "member" }],
      memberCreateCanvas: false,
    });
    const before = (await listCanvasProjects(900)).length;
    const result = await saveCanvasProjectWithTeamGate(900, project("p-denied"), { sql: cp.sql });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 403);
    assert.equal(result.code, "member_canvas_forbidden");
    assert.match(result.message, /成员创建画布|成员/);
    assert.equal((await listCanvasProjects(900)).length, before, "拒絕時不得落盤（專案數不變）");
  });
});

test("② 開關開啟 → 成員放行且專案真的落盤", async () => {
  __resetCanvasStoreForTests();
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [{ team_user_id: MEMBER_TEAM, member_user_id: 900, role: "member" }],
      memberCreateCanvas: true,
    });
    const result = await saveCanvasProjectWithTeamGate(900, project("p-allowed"), { sql: cp.sql });
    assert.equal(result.ok, true);
    const projects = await listCanvasProjects(900);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, "p-allowed");
  });
});

test("③ owner（團隊主帳）與 admin → 恆放行（開關無效）", async () => {
  __resetCanvasStoreForTests();
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [
        { team_user_id: MEMBER_TEAM, member_user_id: 901, role: "admin" },
        { team_user_id: MEMBER_TEAM, member_user_id: 902, role: "owner" },
      ],
      memberCreateCanvas: false,
    });
    assert.equal((await saveCanvasProjectWithTeamGate(901, project("p-admin"), { sql: cp.sql })).ok, true);
    assert.equal((await saveCanvasProjectWithTeamGate(902, project("p-coowner"), { sql: cp.sql })).ok, true);
    // 團隊主帳不入名冊（019 CHECK）：非成員 ⇒ 一律放行。
    assert.equal((await saveCanvasProjectWithTeamGate(MEMBER_TEAM, project("p-master"), { sql: cp.sql })).ok, true);
    assert.equal((await listCanvasProjects(901)).length, 1);
    assert.equal((await listCanvasProjects(902)).length, 1);
    assert.equal((await listCanvasProjects(MEMBER_TEAM)).length, 1);
  });
});

test("④ 非成員（個人帳號）建畫布 → 恆放行（個人畫布不受此閘）", async () => {
  __resetCanvasStoreForTests();
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({ members: [], memberCreateCanvas: false });
    const result = await saveCanvasProjectWithTeamGate(903, project("p-personal"), { sql: cp.sql });
    assert.equal(result.ok, true);
    assert.equal((await listCanvasProjects(903)).length, 1);
  });
});

test("⑤ 治理層未配置（C 端／本地）→ 全部放行，不擋創作", async () => {
  __resetCanvasStoreForTests();
  await withEnv({ GENERATION_DATABASE_URL: undefined, GENERATION_CONTROL_PLANE_ENABLED: undefined }, async () => {
    const result = await saveCanvasProjectWithTeamGate(900, project("p-degraded"));
    assert.equal(result.ok, true);
    assert.equal((await listCanvasProjects(900)).length, 1);
  });
});

test("⑥ 成員既有專案的自動存檔（更新）不受事後關閘影響", async () => {
  __resetCanvasStoreForTests();
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const cp = fakeControlPlane({
      members: [{ team_user_id: MEMBER_TEAM, member_user_id: 900, role: "member" }],
      memberCreateCanvas: false,
    });
    // 先在閘開啟時建好，再關閘——既有畫布仍可存（否則關一下開關＝成員資料損失）。
    await saveCanvasProject(900, project("p-existing"));
    const update = await saveCanvasProjectWithTeamGate(
      900,
      { ...project("p-existing"), title: "改過標題" },
      { sql: cp.sql },
    );
    assert.equal(update.ok, true, "更新既有專案不得被閘攔");
    const projects = await listCanvasProjects(900);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].title, "改過標題");
  });
});
