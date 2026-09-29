// 生成物類別切分（P2-2／對稱差 D8b）——真行為斷言。
//
// 獨立 oracle：`generation_job.kind` 的白名單**逐字抄自遷移檔**
// `db/migrations/001_generation_control_plane.sql:109`
// （`CHECK (kind IN ('image_generate','image_edit','video_generate'))`），
// 不是從被測模組讀出來的。
//
// 真執行器：`npx tsx --test src/lib/generation-core/usage-asset-kind.test.ts`

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

/** 遷移檔 001:109 的 kind 白名單（逐字）。 */
const MIGRATION_KINDS = ["image_generate", "image_edit", "video_generate"];

test("遷移檔白名單裡的每一種 kind 都有確定的類別（沒有一種落進 unclassified）", () => {
  for (const kind of MIGRATION_KINDS) {
    const assetKind = usageAssetKindForJobKind(kind);
    assert.notEqual(assetKind, "unclassified", `落盤合法的 ${kind} 不該被判 unclassified`);
    assert.ok(isUsageAssetKind(assetKind));
  }
  // 逐條釘住映射本身（不靠函式自己回什麼就信什麼）。
  assert.equal(usageAssetKindForJobKind("video_generate"), "shot_video", "影片提交路徑＝分鏡影片");
  assert.equal(usageAssetKindForJobKind("image_generate"), "still_image");
  assert.equal(usageAssetKindForJobKind("image_edit"), "still_image");
});

test("未知／缺席的 kind 一律 unclassified（不猜、不攤進任何類別）", () => {
  for (const bad of ["tts", "avatar", "lipsync", "video_generate_2k", "", "  ", 123, null, undefined, {}, []]) {
    assert.equal(usageAssetKindForJobKind(bad), "unclassified", `${JSON.stringify(bad)} 不得被歸類`);
  }
});

test("D8b 的三類（角色/場景/道具）在值域裡但**不指派**——誠實標記尚無落盤事實", () => {
  const assigned = new Set(ASSIGNED_USAGE_ASSET_KINDS);
  for (const kind of ["character", "scene", "prop"] as const) {
    assert.equal(USAGE_ASSET_KINDS.includes(kind), true, "值域要保留（補資料時不必改形狀）");
    assert.equal(assigned.has(kind), false, "目前不指派：提交端沒有任何欄位記得住這個事實");
    assert.ok(USAGE_ASSET_KIND_LABELS[kind].length > 0, "標籤先備好");
  }
  // 反面：任何 kind 都判不出這三類（今天它們必然為空，不是漏算）。
  for (const kind of MIGRATION_KINDS) {
    assert.equal(assigned.has(usageAssetKindForJobKind(kind)), true);
  }
});

test("列級入口：優先讀 jobKind，退回 kind；兩者都缺＝unclassified", () => {
  assert.equal(usageAssetKindForRow({ jobKind: "video_generate" }), "shot_video");
  assert.equal(usageAssetKindForRow({ kind: "video_generate" }), "shot_video", "舊查詢欄位名（kind）也要認");
  assert.equal(
    usageAssetKindForRow({ jobKind: "image_generate", kind: "video_generate" }),
    "still_image",
    "jobKind（真源欄位）優先於 kind（舊欄位名）",
  );
  assert.equal(usageAssetKindForRow({}), "unclassified");
  assert.equal(usageAssetKindForRow({ jobKind: null, kind: undefined }), "unclassified");
});

test("值域守門：只認封閉值域，外部字串不得混進桶", () => {
  assert.equal(isUsageAssetKind("shot_video"), true);
  assert.equal(isUsageAssetKind("character"), true);
  assert.equal(isUsageAssetKind("video"), false);
  assert.equal(isUsageAssetKind(""), false);
  assert.equal(isUsageAssetKind(7), false);
  // 值域與標籤必須一一對應（漏標籤＝報表上出現裸鍵）。
  assert.deepEqual(Object.keys(USAGE_ASSET_KIND_LABELS).sort(), [...USAGE_ASSET_KINDS].sort());
});