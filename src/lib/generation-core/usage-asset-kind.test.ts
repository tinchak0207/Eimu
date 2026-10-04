// 生成物类别切分（P2-2／对称差 D8b）——真行为断言。
//
// 独立 oracle：`generation_job.kind` 的白名单**逐字抄自迁移档**
// `db/migrations/001_generation_control_plane.sql:109`
// （`CHECK (kind IN ('image_generate','image_edit','video_generate'))`），
// 不是从被测模组读出来的。
//
// 真执行器：`npx tsx --test src/lib/generation-core/usage-asset-kind.test.ts`

import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSIGNED_USAGE_ASSET_KINDS,
  USAGE_ASSET_KIND_LABELS,
  USAGE_ASSET_KINDS,
  isUsageAssetKind,
  usageAssetKindForJobKind,
  usageAssetKindForRow,
} from "./usage-asset-kind";

/** 迁移档 001:109 的 kind 白名单（逐字）。 */
const MIGRATION_KINDS = ["image_generate", "image_edit", "video_generate"];

test("迁移档白名单里的每一种 kind 都有确定的类别（没有一种落进 unclassified）", () => {
  for (const kind of MIGRATION_KINDS) {
    const assetKind = usageAssetKindForJobKind(kind);
    assert.notEqual(assetKind, "unclassified", `落盘合法的 ${kind} 不该被判 unclassified`);
    assert.ok(isUsageAssetKind(assetKind));
  }
  // 逐条钉住映射本身（不靠函式自己回什么就信什么）。
  assert.equal(usageAssetKindForJobKind("video_generate"), "shot_video", "影片提交路径＝分镜影片");
  assert.equal(usageAssetKindForJobKind("image_generate"), "still_image");
  assert.equal(usageAssetKindForJobKind("image_edit"), "still_image");
});

test("未知／缺席的 kind 一律 unclassified（不猜、不摊进任何类别）", () => {
  for (const bad of ["tts", "avatar", "lipsync", "video_generate_2k", "", "  ", 123, null, undefined, {}, []]) {
    assert.equal(usageAssetKindForJobKind(bad), "unclassified", `${JSON.stringify(bad)} 不得被归类`);
  }
});

test("D8b 的三类（角色/场景/道具）在值域里但**不指派**——诚实标记尚无落盘事实", () => {
  const assigned = new Set(ASSIGNED_USAGE_ASSET_KINDS);
  for (const kind of ["character", "scene", "prop"] as const) {
    assert.equal(USAGE_ASSET_KINDS.includes(kind), true, "值域要保留（补资料时不必改形状）");
    assert.equal(assigned.has(kind), false, "目前不指派：提交端没有任何栏位记得住这个事实");
    assert.ok(USAGE_ASSET_KIND_LABELS[kind].length > 0, "标签先备好");
  }
  // 反面：任何 kind 都判不出这三类（今天它们必然为空，不是漏算）。
  for (const kind of MIGRATION_KINDS) {
    assert.equal(assigned.has(usageAssetKindForJobKind(kind)), true);
  }
});

test("列级入口：优先读 jobKind，退回 kind；两者都缺＝unclassified", () => {
  assert.equal(usageAssetKindForRow({ jobKind: "video_generate" }), "shot_video");
  assert.equal(usageAssetKindForRow({ kind: "video_generate" }), "shot_video", "旧查询栏位名（kind）也要认");
  assert.equal(
    usageAssetKindForRow({ jobKind: "image_generate", kind: "video_generate" }),
    "still_image",
    "jobKind（真源栏位）优先于 kind（旧栏位名）",
  );
  assert.equal(usageAssetKindForRow({}), "unclassified");
  assert.equal(usageAssetKindForRow({ jobKind: null, kind: undefined }), "unclassified");
});

test("值域守门：只认封闭值域，外部字串不得混进桶", () => {
  assert.equal(isUsageAssetKind("shot_video"), true);
  assert.equal(isUsageAssetKind("character"), true);
  assert.equal(isUsageAssetKind("video"), false);
  assert.equal(isUsageAssetKind(""), false);
  assert.equal(isUsageAssetKind(7), false);
  // 值域与标签必须一一对应（漏标签＝报表上出现裸键）。
  assert.deepEqual(Object.keys(USAGE_ASSET_KIND_LABELS).sort(), [...USAGE_ASSET_KINDS].sort());
});