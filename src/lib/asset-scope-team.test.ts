// P0-2 資產團隊維度：作用域層 + 寫入端閘的**行為**測試（實際呼叫，非源碼字串掃描）。
//
// 本刀只做「維度」：AssetScope 加 team / 可見性加 in-team / AssetUseContext 加 teamId /
// /api/assets 寫入端以 relay 權威 teamId 蓋章。**不碰**計費、配額、席位、RBAC。
//
// 反同源斷言（AGENTS.md「禁同源斷言」）：可見性一節用**手寫期望表**
//（EXPECTED_VISIBILITY：人工枚舉「情境 → 期望值」），表中的期望值**不呼叫被測函式**得出，
// 而是本刀設計者逐格手填；若實作改動語義，表與實作會分叉 → 紅。
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
import { decideTeamAssetScope } from "../app/api/assets/route";
import type { TeamMembership } from "./team-membership-lookup";

const TEAM_A = "team-a";
const TEAM_B = "team-b";

// ─────────────────────────────────────────── ① 清洗收口：向後相容 + 鬼狀態

test("normalize 相容：舊資料（無 scope / 非物件 / 非法 owner）仍逐位收斂為 personal", () => {
  assert.deepEqual(normalizeAssetScope(undefined), { owner: "personal" });
  assert.deepEqual(normalizeAssetScope(null), { owner: "personal" });
  assert.deepEqual(normalizeAssetScope("team"), { owner: "personal" });
  assert.deepEqual(normalizeAssetScope(42), { owner: "personal" });
  assert.deepEqual(normalizeAssetScope({}), { owner: "personal" });
  assert.deepEqual(normalizeAssetScope({ owner: "personal" }), { owner: "personal" });
  // 未知 owner（拼錯的檔位）不猜 → personal（與舊版對 "project" 以外一律 personal 同尺）。
  assert.deepEqual(normalizeAssetScope({ owner: "organisation", teamId: TEAM_A }), { owner: "personal" });
  // personal 不得被塞進任何座標欄（否則同一個 scope 有兩個座標）。
  assert.deepEqual(normalizeAssetScope({ owner: "personal", teamId: TEAM_A, projectId: "proj-a" }), {
    owner: "personal",
  });
});

test("normalize 團隊維度：team + teamId 保留；team 無 teamId = 鬼狀態 → null（**不降格 personal**）", () => {
  assert.deepEqual(normalizeAssetScope({ owner: "team", teamId: TEAM_A }), { owner: "team", teamId: TEAM_A });
  assert.deepEqual(normalizeAssetScope({ owner: "team", teamId: `  ${TEAM_A} ` }), { owner: "team", teamId: TEAM_A });
  // 鬼狀態兩態：缺欄 / 空字串 / 全空白。
  assert.equal(normalizeAssetScope({ owner: "team" }), null);
  assert.equal(normalizeAssetScope({ owner: "team", teamId: "" }), null);
  assert.equal(normalizeAssetScope({ owner: "team", teamId: "   " }), null);
  assert.equal(normalizeAssetScope({ owner: "team", teamId: 123 }), null);
  // 超長 teamId 截斷到 120（與 projectId 同一界），不是回 null。
  assert.deepEqual(normalizeAssetScope({ owner: "team", teamId: "t".repeat(200) }), {
    owner: "team",
    teamId: "t".repeat(120),
  });
});

test("normalize 每種 owner 只留自己那一個座標欄（跨欄殘留一律剝除）", () => {
  // project 帶 teamId：teamId 是別維度的殘留 → 剝掉（否則讀者要猜聽哪一個）。
  assert.deepEqual(normalizeAssetScope({ owner: "project", projectId: "proj-a", teamId: TEAM_A }), {
    owner: "project",
    projectId: "proj-a",
  });
  assert.deepEqual(normalizeAssetScope({ owner: "team", teamId: TEAM_A, projectId: "proj-a" }), {
    owner: "team",
    teamId: TEAM_A,
  });
});

test("sameAssetScope：owner 不同即不等值；team 座標參與比較", () => {
  assert.equal(sameAssetScope({ owner: "team", teamId: TEAM_A }, { owner: "team", teamId: TEAM_A }), true);
  assert.equal(sameAssetScope({ owner: "team", teamId: TEAM_A }, { owner: "team", teamId: TEAM_B }), false);
  assert.equal(sameAssetScope({ owner: "team", teamId: TEAM_A }, { owner: "team" }), false);
  // 跨 owner：即使座標字串相同也不等值（維度優先序明確）。
  assert.equal(sameAssetScope({ owner: "personal" }, { owner: "team" }), false);
  assert.equal(sameAssetScope({ owner: "project", projectId: TEAM_A }, { owner: "team", teamId: TEAM_A }), false);
  // 既有行為不變：personal 與 project 的比較逐位沿用。
  assert.equal(sameAssetScope({ owner: "personal" }, { owner: "personal" }), true);
  assert.equal(sameAssetScope({ owner: "project", projectId: "p" }, { owner: "project", projectId: "p" }), true);
  assert.equal(sameAssetScope({ owner: "project", projectId: "p" }, { owner: "project" }), false);
});

test("DEFAULT/GHOST 常數語義未被改動；teamIdOfScope 只認 team", () => {
  assert.deepEqual(DEFAULT_ASSET_SCOPE, { owner: "personal" });
  assert.deepEqual(GHOST_ASSET_SCOPE, { owner: "project" });
  assert.equal(teamIdOfScope({ owner: "team", teamId: TEAM_A }), TEAM_A);
  assert.equal(teamIdOfScope({ owner: "team" }), "");
  assert.equal(teamIdOfScope({ owner: "personal" }), "");
  assert.equal(teamIdOfScope({ owner: "project", projectId: "proj-a" }), "");
  assert.equal(teamIdOfScope(undefined), "");
});

test("持久化代理人：包/卡清洗收口對 team 作用域同樣不降格成 personal", () => {
  const scoped = normalizeAssetPack({
    id: "pack-team",
    title: "團隊包",
    items: [{ kind: "prompt", title: "提示词", content: "x" }],
    scope: { owner: "team", teamId: TEAM_A },
  });
  assert.ok(scoped);
  assert.deepEqual(scoped.scope, { owner: "team", teamId: TEAM_A });

  // 鬼狀態：team 無 teamId → normalizeAssetPack 回 null（契約是「缺 id 欄＝不可判定」），
  // 由呼叫端（寫入端閘）負責降級；這裡只證明它**沒有**被靜默收成 personal。
  const ghostTeam = normalizeAssetPack({ id: "pack-ghost-team", title: "x", scope: { owner: "team" } });
  assert.ok(ghostTeam);
  assert.notDeepEqual(ghostTeam.scope, { owner: "personal" });

  const cardScoped = normalizeCharacterCard({ id: "card-team", name: "團隊卡", kind: "character", scope: { owner: "team", teamId: TEAM_A } });
  assert.ok(cardScoped);
  assert.deepEqual(cardScoped.scope, { owner: "team", teamId: TEAM_A });
  const cardGhost = normalizeCharacterCard({ id: "card-ghost-team", name: "x", kind: "character", scope: { owner: "team" } });
  assert.ok(cardGhost);
  assert.notDeepEqual(cardGhost.scope, { owner: "personal" });
});

// ─────────────────────────────────────────── ② 可見性：手寫期望表（反同源）

/**
 * 手寫期望表：每格 = (資產作用域, 使用上下文) → 期望可見性。
 * 期望值由設計者人工填寫（見 §一 裁決順序），**不呼叫被測函式**產生。
 * ctx 固定 viewerUserId=42，資產 ownerUserId=42（本表不測跨帳號，那段另有專測）。
 */
const EXPECTED_VISIBILITY: Array<{
  label: string;
  scope: AssetScope | undefined;
  ctx: Pick<AssetUseContext, "projectId" | "teamId">;
  expected: AssetVisibility | null;
}> = [
  // — personal（含缺 scope 的舊資產）：任何上下文恆可見 → owner
  { label: "personal / 有項目", scope: { owner: "personal" }, ctx: { projectId: "proj-a" }, expected: "owner" },
  { label: "personal / 無項目無團隊", scope: { owner: "personal" }, ctx: { projectId: null }, expected: "owner" },
  { label: "personal / 有團隊", scope: { owner: "personal" }, ctx: { projectId: null, teamId: TEAM_A }, expected: "owner" },
  { label: "缺 scope（舊資產）/ 有團隊", scope: undefined, ctx: { projectId: null, teamId: TEAM_A }, expected: "owner" },

  // — project：本項目 → in-project；他項目 → null（無分享時）
  { label: "project A / 項目 A", scope: { owner: "project", projectId: "proj-a" }, ctx: { projectId: "proj-a" }, expected: "in-project" },
  { label: "project A / 項目 B", scope: { owner: "project", projectId: "proj-a" }, ctx: { projectId: "proj-b" }, expected: null },
  { label: "project A / 無項目（有團隊 A）", scope: { owner: "project", projectId: "proj-a" }, ctx: { projectId: null, teamId: TEAM_A }, expected: null },
  { label: "project 鬼狀態 / 任何上下文", scope: { owner: "project" }, ctx: { projectId: "proj-a" }, expected: null },

  // — team：本團隊 → in-team；他隊 → null；無團隊上下文 → null
  { label: "team A / 團隊 A", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: null, teamId: TEAM_A }, expected: "in-team" },
  { label: "team A / 團隊 A + 項目 a", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: "proj-a", teamId: TEAM_A }, expected: "in-team" },
  { label: "team A / 團隊 B（跨隊）", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: null, teamId: TEAM_B }, expected: null },
  { label: "team A / 團隊 B + 項目 a（跨隊）", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: "proj-a", teamId: TEAM_B }, expected: null },
  { label: "team A / 無團隊上下文（查不到成員身份）", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: null }, expected: null },
  { label: "team A / 團隊上下文為 null", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: null, teamId: null }, expected: null },
  { label: "team A / 團隊上下文為空字串", scope: { owner: "team", teamId: TEAM_A }, ctx: { projectId: null, teamId: "  " }, expected: null },
  { label: "team 鬼狀態（無 teamId）/ 任何上下文", scope: { owner: "team" }, ctx: { projectId: null, teamId: TEAM_A }, expected: null },
  { label: "team 鬼狀態（無 teamId）/ 查不到成員身份", scope: { owner: "team" }, ctx: { projectId: null }, expected: null },

  // — 維度優先序：team 資產不會因「項目 id 剛好等於本項目」而變成 in-project
  { label: "team A（無 teamId）/ 項目 id 同名的項目 A", scope: { owner: "team" }, ctx: { projectId: "proj-a" }, expected: null },
];

test("可見性手寫期望表：逐格比對（personal / project / team / 鬼狀態 / 跨隊）", () => {
  for (const row of EXPECTED_VISIBILITY) {
    const ctx: AssetUseContext = { viewerUserId: 42, projectId: row.ctx.projectId, shares: [], ...(("teamId" in row.ctx) ? { teamId: row.ctx.teamId } : {}) };
    const actual = resolveAssetScopeVisibility({ id: "asset-x", kind: "card", scope: row.scope }, ctx);
    assert.equal(actual, row.expected, `[${row.label}] 期望 ${String(row.expected)}，實得 ${String(actual)}`);
  }
});

test("可見性手寫期望表：resolveAssetVisibility 對同表逐格同值（owner 相符時）", () => {
  for (const row of EXPECTED_VISIBILITY) {
    const asset: ScopedAssetLike = { id: "asset-x", kind: "card", ownerUserId: 42, ...(row.scope ? { scope: row.scope } : {}) };
    const ctx: AssetUseContext = { viewerUserId: 42, projectId: row.ctx.projectId, shares: [], ...(("teamId" in row.ctx) ? { teamId: row.ctx.teamId } : {}) };
    assert.equal(resolveAssetVisibility(asset, ctx), row.expected, `[${row.label}] resolveAssetVisibility 必須與作用域裁決同值`);
  }
});

test("跨帳號仍一律不可見（團隊維度不得放寬 owner 閘）", () => {
  const asset: ScopedAssetLike = { id: "asset-x", kind: "card", scope: { owner: "team", teamId: TEAM_A }, ownerUserId: 7 };
  // 團隊上下文相符也不行：先過 owner，再談作用域。
  assert.equal(resolveAssetVisibility(asset, { viewerUserId: 42, projectId: null, teamId: TEAM_A, shares: [] }), null);
  assert.equal(
    resolveAssetVisibility({ ...asset, ownerUserId: 42 }, { viewerUserId: 42, projectId: null, teamId: TEAM_A, shares: [] }),
    "in-team",
    "反向對照：僅 owner 相符時同一份上下文才可見（證明上面的 null 不是恆真）",
  );
});

test("使用路徑包裝：filterUsableAssets / canUseAsset 對 team 資產同結論（不可見即不可用）", () => {
  const assets: ScopedAssetLike[] = [
    { id: "pack-personal", kind: "pack", ownerUserId: 42 },
    { id: "pack-team-a", kind: "pack", scope: { owner: "team", teamId: TEAM_A }, ownerUserId: 42 },
    { id: "pack-team-b", kind: "pack", scope: { owner: "team", teamId: TEAM_B }, ownerUserId: 42 },
    { id: "pack-project-a", kind: "pack", scope: { owner: "project", projectId: "proj-a" }, ownerUserId: 42 },
  ];
  const inTeamA: AssetUseContext = { viewerUserId: 42, projectId: null, teamId: TEAM_A, shares: [] };
  assert.deepEqual(filterUsableAssets(assets, inTeamA).map((a) => a.id), ["pack-personal", "pack-team-a"]);
  assert.equal(canUseAsset(assets[1], inTeamA), true);
  assert.equal(canUseAsset(assets[2], inTeamA), false, "跨隊不可用（切隊嚴格隔離）");
  // 查不到成員身份（無 teamId）：team 資產全不可用，個人資產照用。
  const noTeam: AssetUseContext = { viewerUserId: 42, projectId: null, shares: [] };
  assert.deepEqual(filterUsableAssets(assets, noTeam).map((a) => a.id), ["pack-personal"]);
  // 團隊 + 項目並存：本項目資產仍可見（team 維度不得把 project 段吃掉）。
  const both: AssetUseContext = { viewerUserId: 42, projectId: "proj-a", teamId: TEAM_A, shares: [] };
  assert.deepEqual(filterUsableAssets(assets, both).map((a) => a.id), ["pack-personal", "pack-team-a", "pack-project-a"]);
});

// ─────────────────────────────────────────── ③ 寫入端閘（/api/assets 的權威蓋章）

function membership(teamId: string): TeamMembership {
  return { teamId, userId: 42, role: "member", memberCreateCanvas: true, seats: 3 };
}

test("寫入端閘：成員宣告 team → 以 relay 權威 teamId 蓋章（客戶端送的 teamId 被忽略）", () => {
  // 沒送 teamId（只宣告 owner=team）：用權威值。
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: undefined, membership: membership(TEAM_A) }), {
    ok: true,
    scope: { owner: "team", teamId: TEAM_A },
  });
  // 送了自己的團隊 id：相符 → 蓋章（值仍來自權威）。
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: TEAM_A, membership: membership(TEAM_A) }), {
    ok: true,
    scope: { owner: "team", teamId: TEAM_A },
  });
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: ` ${TEAM_A} `, membership: membership(TEAM_A) }), {
    ok: true,
    scope: { owner: "team", teamId: TEAM_A },
  });
});

test("寫入端閘：非成員 / 查不到（relay null）→ 不通過 ⇒ 呼叫端降級個人（不拒、不寫進別人的團隊）", () => {
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: undefined, membership: null }), { ok: false });
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: TEAM_A, membership: null }), { ok: false });
  // 載荷不合法（teamId 空）＝查不到，同一路徑。
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: TEAM_A, membership: { ...membership(TEAM_A), teamId: "  " } }), { ok: false });
});

test("寫入端閘：宣告 team 但送進別的團隊 id → 不通過（不得寫進別人的團隊）", () => {
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: TEAM_B, membership: membership(TEAM_A) }), { ok: false });
});

test("寫入端閘：宣告 team 但 teamId 是鬼值（空字串）→ 走權威值（不是拒，也不是空團隊）", () => {
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: "", membership: membership(TEAM_A) }), {
    ok: true,
    scope: { owner: "team", teamId: TEAM_A },
  });
  assert.deepEqual(decideTeamAssetScope({ declaredTeamId: 123, membership: membership(TEAM_A) }), {
    ok: true,
    scope: { owner: "team", teamId: TEAM_A },
  });
});

// ─────────────────────────────────────────── ④ 既有行為逐位不變（零回歸）

test("零回歸：personal / project 的既有可見性與清洗結果逐位不變", () => {
  // 舊測試的關鍵格：這裡用同一組輸入再跑一次，確認本刀沒有動到舊路徑。
  const personal: ScopedAssetLike = { id: "pack-personal", kind: "pack", ownerUserId: 42 };
  assert.equal(resolveAssetVisibility(personal, { viewerUserId: 42, projectId: "proj-a", shares: [] }), "owner");
  assert.equal(resolveAssetVisibility(personal, { viewerUserId: 42, projectId: null, shares: [] }), "owner");
  const inA: ScopedAssetLike = { id: "pack-in-a", kind: "pack", scope: { owner: "project", projectId: "proj-a" }, ownerUserId: 42 };
  assert.equal(resolveAssetVisibility(inA, { viewerUserId: 42, projectId: "proj-a", shares: [] }), "in-project");
  assert.equal(resolveAssetVisibility(inA, { viewerUserId: 42, projectId: "proj-b", shares: [] }), null);
  assert.equal(resolveAssetVisibility(inA, { viewerUserId: 42, projectId: null, shares: [] }), null);
  // 缺 scope 的舊資產（含帶 teamId 的殘留欄位）依舊 personal 可見。
  const legacy: ScopedAssetLike = { id: "pack-legacy", kind: "pack", ownerUserId: 42 };
  assert.deepEqual(normalizeAssetScope({ owner: "personal", projectId: "" }), { owner: "personal" });
  assert.equal(resolveAssetVisibility(legacy, { viewerUserId: 42, projectId: null, teamId: TEAM_A, shares: [] }), "owner");
});
