// P0-2 资产团队维度：作用域层 + 写入端闸的**行为**测试（实际呼叫，非源码字串扫描）。
//
// 本刀只做「维度」：AssetScope 加 team / 可见性加 in-team / AssetUseContext 加 teamId /
// /api/assets 写入端以 relay 权威 teamId 盖章。**不碰**计费、配额、席位、RBAC。
//
// 反同源断言（AGENTS.md「禁同源断言」）：可见性一节用**手写期望表**
//（EXPECTED_VISIBILITY：人工枚举「情境 → 期望值」），表中的期望值**不呼叫被测函式**得出，
// 而是本刀设计者逐格手填；若实作改动语义，表与实作会分叉 → 红。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ASSET_SCOPE,
  GHOST_ASSET_SCOPE,
  canUseAsset,
  filterUsableAssets,
  normalizeAssetScope,
  resolveAssetScopeVisibility,
  resolveAssetVisibility,
  sameAssetScope,
  teamIdOfScope,
} from "./asset-scope";
import type { AssetScope, AssetUseContext, AssetVisibility, ScopedAssetLike } from "./asset-scope";
import { normalizeAssetPack } from "./asset-pack-store";
import { normalizeCharacterCard } from "./character-cards";
import { decideTeamAssetScope } from "./asset-team-scope";
import type { TeamMembership } from "./team-membership-lookup";

const TEAM_A = "team-a";
const TEAM_B = "team-b";

// ─────────────────────────────────────────── ① 清洗收口：向后相容 + 鬼状态

test("normalize 相容：旧资料（无 scope / 非物件 / 非法 owner）仍逐位收敛为 personal", () => {
  assert.deepEqual(normalizeAssetScope(undefined), { owner: "personal" });
  assert.deepEqual(normalizeAssetScope(null), { owner: "personal" });
  assert.deepEqual(normalizeAssetScope("team"), { owner: "personal" });
  assert.deepEqual(normalizeAssetScope(42), { owner: "personal" });
  assert.deepEqual(normalizeAssetScope({}), { owner: "personal" });
  assert.deepEqual(normalizeAssetScope({ owner: "personal" }), { owner: "personal" });
  // 未知 owner（拼错的档位）不猜 → personal（与旧版对 "project" 以外一律 personal 同尺）。
  assert.deepEqual(normalizeAssetScope({ owner: "organisation", teamId: TEAM_A }), { owner: "personal" });
  // personal 不得被塞进任何座标栏（否则同一个 scope 有两个座标）。
  assert.deepEqual(normalizeAssetScope({ owner: "personal", teamId: TEAM_A, projectId: "proj-a" }), {
    owner: "personal",
  });
});

test("normalize 团队维度：team + teamId 保留；team 无 teamId = 鬼状态 → null（**不降格 personal**）", () => {
  assert.deepEqual(normalizeAssetScope({ owner: "team", teamId: TEAM_A }), { owner: "team", teamId: TEAM_A });
  assert.deepEqual(normalizeAssetScope({ owner: "team", teamId: `  ${TEAM_A} ` }), { owner: "team", teamId: TEAM_A });
  // 鬼状态两态：缺栏 / 空字串 / 全空白。
  assert.equal(normalizeAssetScope({ owner: "team" }), null);
  assert.equal(normalizeAssetScope({ owner: "team", teamId: "" }), null);
  assert.equal(normalizeAssetScope({ owner: "team", teamId: "   " }), null);
  assert.equal(normalizeAssetScope({ owner: "team", teamId: 123 }), null);
  // 超长 teamId 截断到 120（与 projectId 同一界），不是回 null。
  assert.deepEqual(normalizeAssetScope({ owner: "team", teamId: "t".repeat(200) }), {
    owner: "team",
    teamId: "t".repeat(120),
  });
});

test("normalize 每种 owner 只留自己那一个座标栏（跨栏残留一律剥除）", () => {
  // project 带 teamId：teamId 是别维度的残留 → 剥掉（否则读者要猜听哪一个）。
  assert.deepEqual(normalizeAssetScope({ owner: "project", projectId: "proj-a", teamId: TEAM_A }), {
    owner: "project",
    projectId: "proj-a",
  });
  assert.deepEqual(normalizeAssetScope({ owner: "team", teamId: TEAM_A, projectId: "proj-a" }), {
    owner: "team",
    teamId: TEAM_A,
  });
});

test("sameAssetScope：owner 不同即不等值；team 座标参与比较", () => {
  assert.equal(sameAssetScope({ owner: "team", teamId: TEAM_A }, { owner: "team", teamId: TEAM_A }), true);
  assert.equal(sameAssetScope({ owner: "team", teamId: TEAM_A }, { owner: "team", teamId: TEAM_B }), false);
  assert.equal(sameAssetScope({ owner: "team", teamId: TEAM_A }, { owner: "team" }), false);
  // 跨 owner：即使座标字串相同也不等值（维度优先序明确）。
  assert.equal(sameAssetScope({ owner: "personal" }, { owner: "team" }), false);
  assert.equal(sameAssetScope({ owner: "project", projectId: TEAM_A }, { owner: "team", teamId: TEAM_A }), false);
  // 既有行为不变：personal 与 project 的比较逐位沿用。
  assert.equal(sameAssetScope({ owner: "personal" }, { owner: "personal" }), true);
  assert.equal(sameAssetScope({ owner: "project", projectId: "p" }, { owner: "project", projectId: "p" }), true);
  assert.equal(sameAssetScope({ owner: "project", projectId: "p" }, { owner: "project" }), false);
});

test("DEFAULT/GHOST 常数语义未被改动；teamIdOfScope 只认 team", () => {
  assert.deepEqual(DEFAULT_ASSET_SCOPE, { owner: "personal" });
  assert.deepEqual(GHOST_ASSET_SCOPE, { owner: "project" });
  assert.equal(teamIdOfScope({ owner: "team", teamId: TEAM_A }), TEAM_A);
  assert.equal(teamIdOfScope({ owner: "team" }), "");
  assert.equal(teamIdOfScope({ owner: "personal" }), "");
  assert.equal(teamIdOfScope({ owner: "project", projectId: "proj-a" }), "");
  assert.equal(teamIdOfScope(undefined), "");
});

test("持久化代理人：包/卡清洗收口对 team 作用域同样不降格成 personal", () => {
  const scoped = normalizeAssetPack({
    id: "pack-team",
    title: "团队包",
    items: [{ kind: "prompt", title: "提示词", content: "x" }],
    scope: { owner: "team", teamId: TEAM_A },
  });
  assert.ok(scoped);
  assert.deepEqual(scoped.scope, { owner: "team", teamId: TEAM_A });

  // 鬼状态：team 无 teamId → normalizeAssetPack 回 null（契约是「缺 id 栏＝不可判定」），
  // 由呼叫端（写入端闸）负责降级；这里只证明它**没有**被静默收成 personal。
  const ghostTeam = normalizeAssetPack({ id: "pack-ghost-team", title: "x", scope: { owner: "team" } });
  assert.ok(ghostTeam);
  assert.notDeepEqual(ghostTeam.scope, { owner: "personal" });

  const cardScoped = normalizeCharacterCard({ id: "card-team", name: "团队卡", kind: "character", scope: { owner: "team", teamId: TEAM_A } });
  assert.ok(cardScoped);
  assert.deepEqual(cardScoped.scope, { owner: "team", teamId: TEAM_A });
  const cardGhost = normalizeCharacterCard({ id: "card-ghost-team", name: "x", kind: "character", scope: { owner: "team" } });
  assert.ok(cardGhost);
  assert.notDeepEqual(cardGhost.scope, { owner: "personal" });
});

// ─────────────────────────────────────────── ② 可见性：手写期望表（反同源）

/**
 * 手写期望表：每格 = (资产作用域, 使用上下文) → 期望可见性。
 * 期望值由设计者人工填写（见 §一 裁决顺序），**不呼叫被测函式**产生。
 * ctx 固定 viewerUserId=42，资产 ownerUserId=42（本表不测跨帐号，那段另有专测）。
 */
const EXPECTED_VISIBILITY: Array<{
  label: string;
  scope: AssetScope | undefined;
  ctx: Pick<AssetUseContext, "projectId" | "teamId">;
  expected: AssetVisibility | null;
}> = [
  // — personal（含缺 scope 的旧资产）：任何上下文恒可见 → owner
  { label: "personal / 有项目", scope: { owner: "personal" }, ctx: { projectId: "proj-a" }, expected: "owner" },
  { label: "personal / 无项目无团队", scope: { owner: "personal" }, ctx: { projectId: null }, expected: "owner" },
  { label: "personal / 有团队", scope: { owner: "personal" }, ctx: { projectId: null, teamId: TEAM_A }, expected: "owner" },
  { label: "缺 scope（旧资产）/ 有团队", scope: undefined, ctx: { projectId: null, teamId: TEAM_A }, expected: "owner" },

  // — project：本项目 → in-project；他项目 → null（无分享时）
  { label: "project A / 项目 A", scope: { owner: "project", projectId: "proj-a" }, ctx: { projectId: "proj-a" }, expected: "in-project" },
  { label: "project A / 项目 B", scope: { owner: "project", projectId: "proj-a" }, ctx: { projectId: "proj-b" }, expected: null },
  { label: "project A / 无项目（有团队 A）", scope: { owner: "project", projectId: "proj-a" }, ctx: { projectId: null, teamId: TEAM_A }, expected: null },
  { label: "project 鬼状态 / 任何上下文", scope: { owner: "project" }, ctx: { projectId: "proj-a" }, expected: null },

  // — team：本团队 → in-team；他队 → null；无团队上下文 → null
  { label: "team A / 团队 A", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: null, teamId: TEAM_A }, expected: "in-team" },
  { label: "team A / 团队 A + 项目 a", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: "proj-a", teamId: TEAM_A }, expected: "in-team" },
  { label: "team A / 团队 B（跨队）", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: null, teamId: TEAM_B }, expected: null },
  { label: "team A / 团队 B + 项目 a（跨队）", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: "proj-a", teamId: TEAM_B }, expected: null },
  { label: "team A / 无团队上下文（查不到成员身份）", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: null }, expected: null },
  { label: "team A / 团队上下文为 null", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: null, teamId: null }, expected: null },
  { label: "team A / 团队上下文为空字串", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: null, teamId: "  " }, expected: null },
  { label: "team 鬼状态（无 teamId）/ 任何上下文", scope: { owner: "team" }, ctx: { projectId: null, teamId: TEAM_A }, expected: null },
  { label: "team 鬼状态（无 teamId）/ 查不到成员身份", scope: { owner: "team" }, ctx: { projectId: null }, expected: null },

  // — 维度优先序：team 资产不会因「项目 id 刚好等于本项目」而变成 in-project
  { label: "team A（无 teamId）/ 项目 id 同名的项目 A", scope: { owner: "team" }, ctx: { projectId: "proj-a" }, expected: null },
];

test("可见性手写期望表：逐格比对（personal / project / team / 鬼状态 / 跨队）", () => {
  for (const row of EXPECTED_VISIBILITY) {
    const ctx: AssetUseContext = { viewerUserId: 42, projectId: row.ctx.projectId, shares: [], ...(("teamId" in row.ctx) ? { teamId: row.ctx.teamId } : {}) };
    const actual = resolveAssetScopeVisibility({ id: "asset-x", kind: "card", scope: row.scope }, ctx);
    assert.equal(actual, row.expected, `[${row.label}] 期望 ${String(row.expected)}，实得 ${String(actual)}`);
  }
});

test("可见性手写期望表：resolveAssetVisibility 对同表逐格同值（owner 相符时）", () => {
  for (const row of EXPECTED_VISIBILITY) {
    const asset: ScopedAssetLike = { id: "asset-x", kind: "card", ownerUserId: 42, ...(row.scope ? { scope: row.scope } : {}) };
    const ctx: AssetUseContext = { viewerUserId: 42, projectId: row.ctx.projectId, shares: [], ...(("teamId" in row.ctx) ? { teamId: row.ctx.teamId } : {}) };
    assert.equal(resolveAssetVisibility(asset, ctx), row.expected, `[${row.label}] resolveAssetVisibility 必须与作用域裁决同值`);
  }
});

test("跨帐号仍一律不可见（团队维度不得放宽 owner 闸）", () => {
  const asset: ScopedAssetLike = { id: "asset-x", kind: "card", scope: { owner: "team", teamId: TEAM_A }, ownerUserId: 7 };
  // 团队上下文相符也不行：先过 owner，再谈作用域。
  assert.equal(resolveAssetVisibility(asset, { viewerUserId: 42, projectId: null, teamId: TEAM_A, shares: [] }), null);
  assert.equal(
    resolveAssetVisibility({ ...asset, ownerUserId: 42 }, { viewerUserId: 42, projectId: null, teamId: TEAM_A, shares: [] }),
    "in-team",
    "反向对照：仅 owner 相符时同一份上下文才可见（证明上面的 null 不是恒真）",
  );
});

test("使用路径包装：filterUsableAssets / canUseAsset 对 team 资产同结论（不可见即不可用）", () => {
  const assets: ScopedAssetLike[] = [
    { id: "pack-personal", kind: "pack", ownerUserId: 42 },
    { id: "pack-team-a", kind: "pack", scope: { owner: "team", teamId: TEAM_A }, ownerUserId: 42 },
    { id: "pack-team-b", kind: "pack", scope: { owner: "team", teamId: TEAM_B }, ownerUserId: 42 },
    { id: "pack-project-a", kind: "pack", scope: { owner: "project", projectId: "proj-a" }, ownerUserId: 42 },
  ];
  const inTeamA: AssetUseContext = { viewerUserId: 42, projectId: null, teamId: TEAM_A, shares: [] };
  assert.deepEqual(filterUsableAssets(assets, inTeamA).map((a) => a.id), ["pack-personal", "pack-team-a"]);
  assert.equal(canUseAsset(assets[1], inTeamA), true);
  assert.equal(canUseAsset(assets[2], inTeamA), false, "跨队不可用（切队严格隔离）");
  // 查不到成员身份（无 teamId）：team 资产全不可用，个人资产照用。
  const noTeam: AssetUseContext = { viewerUserId: 42, projectId: null, shares: [] };
  assert.deepEqual(filterUsableAssets(assets, noTeam).map((a) => a.id), ["pack-personal"]);
  // 团队 + 项目并存：本项目资产仍可见（team 维度不得把 project 段吃掉）。
  const both: AssetUseContext = { viewerUserId: 42, projectId: "proj-a", teamId: TEAM_A, shares: [] };
  assert.deepEqual(filterUsableAssets(assets, both).map((a) => a.id), ["pack-personal", "pack-team-a", "pack-project-a"]);
});

// ─────────────────────────────────────────── ③ 写入端闸（/api/assets 的权威盖章）

function membership(teamId: string): TeamMembership {
  return { teamId, userId: 42, role: "member", memberCreateCanvas: true, seats: 3 };
}

test("写入端闸：成员宣告 team → 以 relay 权威 teamId 盖章（客户端送的 teamId 被忽略）", () => {
  // 没送 teamId（只宣告 owner=team）：用权威值。
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: undefined, membership: membership(TEAM_A) }), {
    ok: true,
    scope: { owner: "team", teamId: TEAM_A },
  });
  // 送了自己的团队 id：相符 → 盖章（值仍来自权威）。
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: TEAM_A, membership: membership(TEAM_A) }), {
    ok: true,
    scope: { owner: "team", teamId: TEAM_A },
  });
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: ` ${TEAM_A} `, membership: membership(TEAM_A) }), {
    ok: true,
    scope: { owner: "team", teamId: TEAM_A },
  });
});

test("写入端闸：非成员 / 查不到（relay null）→ 不通过 ⇒ 呼叫端降级个人（不拒、不写进别人的团队）", () => {
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: undefined, membership: null }), { ok: false });
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: TEAM_A, membership: null }), { ok: false });
  // 载荷不合法（teamId 空）＝查不到，同一路径。
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: TEAM_A, membership: { ...membership(TEAM_A), teamId: "  " } }), { ok: false });
});

test("写入端闸：宣告 team 但送进别的团队 id → 不通过（不得写进别人的团队）", () => {
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: TEAM_B, membership: membership(TEAM_A) }), { ok: false });
});

test("写入端闸：宣告 team 但 teamId 是鬼值（空字串）→ 走权威值（不是拒，也不是空团队）", () => {
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: "", membership: membership(TEAM_A) }), {
    ok: true,
    scope: { owner: "team", teamId: TEAM_A },
  });
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: 123, membership: membership(TEAM_A) }), {
    ok: true,
    scope: { owner: "team", teamId: TEAM_A },
  });
});

// ─────────────────────────────────────────── ④ 既有行为逐位不变（零回归）

test("零回归：personal / project 的既有可见性与清洗结果逐位不变", () => {
  // 旧测试的关键格：这里用同一组输入再跑一次，确认本刀没有动到旧路径。
  const personal: ScopedAssetLike = { id: "pack-personal", kind: "pack", ownerUserId: 42 };
  assert.equal(resolveAssetVisibility(personal, { viewerUserId: 42, projectId: "proj-a", shares: [] }), "owner");
  assert.equal(resolveAssetVisibility(personal, { viewerUserId: 42, projectId: null, shares: [] }), "owner");
  const inA: ScopedAssetLike = { id: "pack-in-a", kind: "pack", scope: { owner: "project", projectId: "proj-a" }, ownerUserId: 42 };
  assert.equal(resolveAssetVisibility(inA, { viewerUserId: 42, projectId: "proj-a", shares: [] }), "in-project");
  assert.equal(resolveAssetVisibility(inA, { viewerUserId: 42, projectId: "proj-b", shares: [] }), null);
  assert.equal(resolveAssetVisibility(inA, { viewerUserId: 42, projectId: null, shares: [] }), null);
  // 缺 scope 的旧资产（含带 teamId 的残留栏位）依旧 personal 可见。
  const legacy: ScopedAssetLike = { id: "pack-legacy", kind: "pack", ownerUserId: 42 };
  assert.deepEqual(normalizeAssetScope({ owner: "personal", projectId: "" }), { owner: "personal" });
  assert.equal(resolveAssetVisibility(legacy, { viewerUserId: 42, projectId: null, teamId: TEAM_A, shares: [] }), "owner");
});
