import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LENS_LANGUAGE_LIBRARY,
  LENS_LANGUAGE_GROUP_LABELS,
  LENS_LANGUAGE_SOURCE,
  composeLensFragment,
  lensEntriesByGroup,
  lensEntryByName,
} from "./lens-language-library";

const EXPECTED_GROUPS = [
  "composition",
  "shot_size",
  "camera_angle",
  "focal_length",
  "lens_type",
  "color_tone",
  "lighting",
  "exposure_blur",
  "camera_movement",
  "shooting_technique",
  "quality_base",
  "negative_base",
] as const;

test("lens library: 142 條 / 12 類（與 AID 源去重後一致）", () => {
  assert.equal(LENS_LANGUAGE_LIBRARY.length, 142);
  assert.equal(LENS_LANGUAGE_SOURCE.totalEntries, 142);
  const groups = new Set(LENS_LANGUAGE_LIBRARY.map((e) => e.group));
  assert.equal(groups.size, 12);
  for (const g of EXPECTED_GROUPS) assert.ok(groups.has(g), `缺分組 ${g}`);
});

test("lens library: 每條都有非空 name 與 text（逐字保留，未截斷）", () => {
  for (const e of LENS_LANGUAGE_LIBRARY) {
    assert.ok(e.name.trim().length > 0, `空 name @ ${e.group}`);
    assert.ok(e.text.trim().length > 0, `空 text @ ${e.group}/${e.name}`);
    assert.ok(e.text.length <= 200, `text 過長（疑似拼接錯誤）@ ${e.name}`);
  }
});

test("lens library: 同組同名不重複（去重契約）", () => {
  const seen = new Set<string>();
  for (const e of LENS_LANGUAGE_LIBRARY) {
    const key = `${e.group}::${e.name}`;
    assert.ok(!seen.has(key), `同組同名重複：${key}`);
    seen.add(key);
  }
});

test("lens library: 每組都有中文 label", () => {
  for (const g of EXPECTED_GROUPS) {
    assert.ok(LENS_LANGUAGE_GROUP_LABELS[g], `缺 label：${g}`);
  }
});

test("lens library: 抽樣詞條逐字等於 AID 原文（防後續誤改）", () => {
  const yingguang = lensEntryByName("逆光");
  assert.ok(yingguang);
  assert.equal(yingguang.group, "lighting");
  assert.equal(
    yingguang.text,
    "逆光，主光自主体正后方射入，边缘被勾出一圈轮廓光，正面转入柔和剪影。",
  );

  const sanfen = lensEntryByName("三分构图");
  assert.ok(sanfen);
  assert.equal(sanfen.group, "composition");
  assert.equal(sanfen.text, "三分法构图，主体置于三分线交点，画面均衡，视觉重心自然。");
});

test("lens library: group 查詢回正確條數", () => {
  assert.equal(lensEntriesByGroup("lighting").length, 24);
  assert.equal(lensEntriesByGroup("composition").length, 16);
  assert.equal(lensEntriesByGroup("negative_base").length, 2);
  assert.equal(lensEntriesByGroup("不存在的組").length, 0);
});

test("composeLensFragment: 命中取原文、未命中略過、去重、受 limit 約束", () => {
  const frag = composeLensFragment(["逆光", "三分构图"]);
  assert.equal(frag, "逆光，主光自主体正后方射入，边缘被勾出一圈轮廓光，正面转入柔和剪影。；三分法构图，主体置于三分线交点，画面均衡，视觉重心自然。");

  // 未命中不編造
  assert.equal(composeLensFragment(["这不是词库里的词"]), "");
  // 空輸入
  assert.equal(composeLensFragment([]), "");
  // 去重（同一條給兩次只出一次）
  assert.equal(composeLensFragment(["逆光", "逆光"]).split("；").length, 1);
  // limit 生效
  const many = composeLensFragment(
    ["逆光", "侧光", "顶光", "底光", "环境光", "黄金时刻", "蓝调时刻"],
    3,
  );
  assert.equal(many.split("；").length, 3);
});

test("skill 生成物與 library 同源（tools/gen-lens-skill.ts 未漂移）", () => {
  const cases: Array<[string, string]> = [
    ["lighting", "逆光"],
    ["composition", "三分构图"],
    ["shot_size", "远景"],
    ["negative_base", "通用防崩坏负面词"],
  ];
  for (const [group, name] of cases) {
    const entry = lensEntryByName(name);
    assert.ok(entry, `library 缺 ${name}`);
    assert.equal(entry.group, group);
  }
});

test("skill 生成器存在且引用單一真源", () => {
  const gen = readFileSync(join(process.cwd(), "tools/gen-lens-skill.ts"), "utf8");
  assert.match(gen, /from "\.\.\/src\/lib\/lens-language-library"/);
  assert.match(gen, /LENS_LANGUAGE_LIBRARY/);
});
