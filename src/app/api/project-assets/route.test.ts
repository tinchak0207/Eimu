// REQ-B2 团队资产空间：API 路由守门件测试（源码层契约）。
//
// 为什么走源码层：/api/project-assets 用 requireVerifiedUser（要打上游 /api/user/self 验身分），
// 离线测不起来；但两条红线是**顺序与形状**问题，源码层断言就能钉死，
// 且与本仓既有守门件惯例一致（见 src/app/api/v1/assets/route.test.ts 的「零计费端点」节）。
//   ① 不可见即不可用：挂用前必须先过可见性裁决，不可见回 403（不得先落库再判）
//   ② 不碰计费语义：作用域层不许出现 reserve / refund / quota 这类字眼
//
// REQ-B2b 起，本档新增的断言一律标「变更探针，不计入已验证」（TG-02）：
// 挂用 copy-on-use 的**行为**断言在 src/lib/asset-mount-copy.test.ts（真建副本、真删来源、
// 真幂等、真环路拒绝）；本档只钉住路由/前端接线没被拆掉。
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

test("项目资产路由：挂用前先过可见性裁决，不可见回 403 asset_not_visible", () => {
  const source = code(ROUTE_PATH);
  const decideAt = source.indexOf("resolveMountable(");
  const mountAt = source.indexOf("mountAssetWithCopy(");
  assert.ok(decideAt >= 0, "必须调用 resolveMountable");
  assert.ok(mountAt >= 0, "必须调用 mountAssetWithCopy（REQ-B2b：挂用＝copy-on-use）");
  assert.ok(decideAt < mountAt, "可见性裁决必须早于落库（否则不可见资产会被静默挂上）");
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
  assert.ok(decideAt < grantAt, "权限裁决必须早于落库");
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

// ─────────────────────────────────────────── REQ-B2b：copy-on-use 的接线探针

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

test("B2b 变更探针（不计入已验证）：面板标签变更走 onTagsChange，CanvasEmbed 接到 hook 的 refreshCharacterCards", () => {
  // 5c8f87b0 起面板只剩「打项目标签／只看本项目标签」：挂用/分享交互已删除，
  // 「打标签立即进生成」的硬接线改为 onTagsChange → refreshCharacterCards 重读卡库。
  const panel = code(PANEL_PATH);
  assert.match(panel, /onTagsChange\?\.\(\)/, "标签落库后必须通知父层重读（否则打标签不进生成）");
  assert.match(panel, /assignAssetProjectTags\(/, "面板必须走项目标签写入接口");
  // <1000 行重构：CanvasEmbed 的视图装配在 embed/CanvasEmbedView.tsx。
  const embed = code(EMBED_PATH) + "\n" + code("src/components/canvas/embed/CanvasEmbedView.tsx");
  assert.match(
    embed,
    /onTagsChange=\{canvas\.refreshCharacterCards\}/,
    "CanvasEmbed 必须把面板接到 hook 的卡库重读入口",
  );
});

test("B2b 变更探针（不计入已验证）：锁定卡读取端过作用域闸（filterLockedCardsForProjectUse）", () => {
  // 行为断言：asset-mount-copy.test.ts 的「读取闸」一节（a 类剔除 / b 类零回归 / 与裁决函数同结论）。
  const hook = code(CARDS_HOOK_PATH);
  assert.match(hook, /filterLockedCardsForProjectUse\(/, "生成注入读的 activeCharacterCards 必须先过作用域闸");
  // 闸必须作用在「锁定集」（可能并入同创作项目标签卡）的集合上，而不是原始全量卡库。
  assert.match(
    hook,
    /const locked = characterCards\.filter\(\(c\) => activeCardIds\.includes\(c\.id\)\)/,
    "先算出锁定卡集合",
  );
  assert.match(hook, /let merged = locked;/, "注入集必须以锁定卡集合为基底");
  assert.match(
    hook,
    /return filterLockedCardsForProjectUse\(\s*merged\s*,/,
    "闸必须作用在锁定卡集合（merged）上",
  );
});
