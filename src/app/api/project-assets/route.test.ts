// REQ-B2 團隊資產空間：API 路由守門件測試（源碼層契約）。
//
// 為什麼走源碼層：/api/project-assets 用 requireVerifiedUser（要打上游 /api/user/self 驗身分），
// 離線測不起來；但兩條紅線是**順序與形狀**問題，源碼層斷言就能釘死，
// 且與本倉既有守門件慣例一致（見 src/app/api/v1/assets/route.test.ts 的「零計費端點」節）。
//   ① 不可見即不可用：掛用前必須先過可見性裁決，不可見回 403（不得先落庫再判）
//   ② 不碰計費語義：作用域層不許出現 reserve / refund / quota 這類字眼
//
// REQ-B2b 起，本檔新增的斷言一律標「變更探針，不計入已驗證」（TG-02）：
// 掛用 copy-on-use 的**行為**斷言在 src/lib/asset-mount-copy.test.ts（真建副本、真刪來源、
// 真冪等、真環路拒絕）；本檔只釘住路由/前端接線沒被拆掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROUTE_PATH = "src/app/api/project-assets/route.ts";
const SHARES_PATH = "src/app/api/project-assets/shares/route.ts";
const PANEL_PATH = "src/components/assets/ProjectAssetLibraryPanel.tsx";
const EMBED_PATH = "src/components/canvas/CanvasEmbed.tsx";
const CARDS_HOOK_PATH = "src/hooks/canvas/use-canvas-cards.ts";

function code(relPath: string): string {
  return readFileSync(relPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("项目资产路由：挂用前先过可见性裁決，不可见回 403 asset_not_visible", () => {
  const source = code(ROUTE_PATH);
  const decideAt = source.indexOf("resolveMountable(");
  const mountAt = source.indexOf("mountAssetWithCopy(");
  assert.ok(decideAt >= 0, "必须调用 resolveMountable");
  assert.ok(mountAt >= 0, "必须调用 mountAssetWithCopy（REQ-B2b：挂用＝copy-on-use）");
  assert.ok(decideAt < mountAt, "可见性裁決必须早于落库（否则不可见资产会被静默挂上）");
  assert.match(source, /403/);
  assert.match(source, /asset_not_visible/);
});

test("项目资产路由：零计费语义（作用域层只挂用与授权，不碰 reserve/refund/quota）", () => {
  for (const path of [ROUTE_PATH, SHARES_PATH]) {
    const source = code(path);
    assert.doesNotMatch(source, /reserveImageQuota|refundImageQuota|QUOTA_PER_COIN|imageGenerationCoins|recordBizApiKeyUsage/);
    assert.doesNotMatch(source, /billingAmount|billing_operation|adjustGatewayUserQuota/);
  }
});

test("分享路由：授权前必过 decideAssetShareGrant，越权回 403（不是静默成功）", () => {
  const source = code(SHARES_PATH);
  const decideAt = source.indexOf("decideAssetShareGrant(");
  const grantAt = source.indexOf("grantAssetShare(");
  assert.ok(decideAt >= 0, "必须调用 decideAssetShareGrant");
  assert.ok(grantAt >= 0, "必须调用 grantAssetShare");
  assert.ok(decideAt < grantAt, "权限裁決必须早于落库");
  assert.match(source, /403/);
  assert.match(source, /cross_user/);
});

test("两条路由都走 requireVerifiedUser（不信任 x-user-id 自称身份）", () => {
  for (const path of [ROUTE_PATH, SHARES_PATH]) {
    const source = code(path);
    assert.match(source, /requireVerifiedUser/);
    assert.doesNotMatch(source, /getStoredUserFromHeaders|x-user-id/);
  }
});

test("B2-1 碰撞禁静默成功：确定性键冲突分支回 409 且不得回 success（**变更探针，不计入已验证**，TG-02）", () => {
  // 真正的**行为**断言在 asset-scope.test.ts（applyAssetMount/applyAssetShareGrant 的
  // conflict:true）与 asset-scope-store.test.ts（store 抛 AssetMountConflictError）。
  // 本档只钉住路由把冲突映射成可辨识失败、且没有在冲突分支里冒充成功。
  const cases: Array<[string, string, string]> = [
    [ROUTE_PATH, "AssetMountConflictError", "asset_mount_conflict"],
    [SHARES_PATH, "AssetShareConflictError", "asset_share_conflict"],
  ];
  for (const [path, errorName, codeName] of cases) {
    const source = code(path);
    const at = source.indexOf(`error instanceof ${errorName}`);
    assert.ok(at >= 0, `${path} 必须区分 ${errorName}（否则碰撞落进 500/静默）`);
    const block = source.slice(at, source.indexOf("}", at));
    assert.match(block, /409/, "碰撞必须是可辨识的冲突状态");
    assert.match(block, new RegExp(codeName), "碰撞必须有专属错误码");
    assert.doesNotMatch(block, /success:\s*true/, "碰撞分支不得回 success:true（禁静默成功）");
  }
});

// ─────────────────────────────────────────── REQ-B2b：copy-on-use 的接線探針

test("B2b 变更探针（不计入已验证）：路由回 localCopyId/localCopyIds，冲突类错误各有专属码", () => {
  // 行为断言在 asset-mount-copy.test.ts；这里只钉「回应形状与错误映射没被拆掉」。
  const source = code(ROUTE_PATH);
  assert.match(source, /localCopyId/, "回应必须带 localCopyId（否则前端无从锁定副本）");
  assert.match(source, /localCopyIds/, "回应必须带 localCopyIds（包＝逐 item 副本卡）");
  assert.match(source, /error\.message/, "拒绝/冲突必须回可读原因（不吞）");
  for (const [errorName, codeName] of [
    ["AssetMountCopyConflictError", "asset_copy_conflict"],
    ["AssetMountCopyRejectedError", "asset_copy_rejected"],
    ["AssetSourceMissingError", "asset_not_found"],
    ["AssetCopyLimitError", "asset_copy_limit"],
  ] as const) {
    const at = source.indexOf(`error instanceof ${errorName}`);
    assert.ok(at >= 0, `路由必须区分 ${errorName}（否则落进 500/静默）`);
    const block = source.slice(at, source.indexOf("}", at));
    assert.match(block, new RegExp(codeName), `${errorName} 必须有专属错误码`);
    assert.doesNotMatch(block, /success:\s*true/, `${errorName} 分支不得回 success:true`);
  }
});

test("B2b 变更探针（不计入已验证）：面板把副本 id 交给 onCopyChange，CanvasEmbed 接到 hook 的 applyMountCopyChange", () => {
  // 这是本刀生效的硬接線：挂用拿到 localCopyIds 却不锁进 cardIds = 画面说已挂用、生成仍注入来源。
  const panel = code(PANEL_PATH);
  assert.match(panel, /localCopyIds/, "面板必须读 localCopyIds（不是只读 localCopyId）");
  assert.match(panel, /onCopyChange\?\.\(\{\s*locked:/, "面板必须把副本 id 作为 locked 上报");
  assert.match(panel, /res\.data\.localCopyIds/, "上报的必须是回应里的副本 id");
  const embed = code(EMBED_PATH);
  assert.match(embed, /onCopyChange=\{canvas\.applyMountCopyChange\}/, "CanvasEmbed 必须把面板接到 hook 的副本锁入口");
});

test("B2b 变更探针（不计入已验证）：锁定卡读取端过作用域闸（filterLockedCardsForProjectUse）", () => {
  // 行为断言：asset-mount-copy.test.ts 的「读取闸」一节（a 类剔除 / b 类零回归 / 与裁决函数同结论）。
  const hook = code(CARDS_HOOK_PATH);
  assert.match(hook, /filterLockedCardsForProjectUse\(/, "生成注入读的 activeCharacterCards 必须先过作用域闸");
  assert.match(hook, /return filterLockedCardsForProjectUse\(locked/, "闸必须作用在锁定卡集合上");
});
