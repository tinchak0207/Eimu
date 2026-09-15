// 創作流水線狀態機契約測試（2026-09-15 吞 AID 產品層刀 1）。
//
// 鎖住三件事：
//   1. 7 步常量與 `isValidCreationStep` 的值域（1..7 整數）；
//   2. `normalizeProject` 對新欄位（projectType/currentStep/episodes）的逐欄白名單清洗；
//   3. 向後相容：不含新欄位的舊 payload 仍正常解析，且不冒出空欄位。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CREATION_STEPS,
  creationStepMeta,
  episodeStatusFromAid,
  isValidCreationStep,
} from "../creation-flow-steps";
import { normalizeProject } from "./project-store";

// ─────────────────────────────────────────── fixtures

function basePayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "canvas-1",
    title: "測試畫布",
    nodes: [],
    ...extra,
  };
}

function episode(no: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `ep-${no}`,
    episodeNo: no,
    title: `第 ${no} 集`,
    status: "draft",
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    ...extra,
  };
}

// ─────────────────────────────────────────── 1. 7 步常量

test("CREATION_STEPS：長度 7、value 為 1..7 連續、label 非空", () => {
  assert.equal(CREATION_STEPS.length, 7);
  CREATION_STEPS.forEach((step, i) => {
    assert.equal(step.value, i + 1, `第 ${i} 項 value 應為 ${i + 1}`);
    assert.ok(step.label.trim().length > 0, `空 label @ step ${step.value}`);
    assert.ok(step.key.trim().length > 0, `空 key @ step ${step.value}`);
  });
});

test("CREATION_STEPS：label 逐字照 AID desc（繁體輸入已正規化為簡體）", () => {
  assert.deepEqual(
    CREATION_STEPS.map((s) => s.label),
    ["项目配置", "剧本创作", "素材准备", "分镜设计", "视频生成", "音画同步", "成品预览"],
  );
});

test("isValidCreationStep：邊界（0/8/null/undefined/1.5/NaN/字串皆 false；1/7 true）", () => {
  for (const bad of [0, 8, -1, null, undefined, 1.5, NaN, Infinity, "1", "", {}, []]) {
    assert.equal(isValidCreationStep(bad), false, `應判 false：${JSON.stringify(bad)}`);
  }
  for (const good of [1, 2, 3, 4, 5, 6, 7]) {
    assert.equal(isValidCreationStep(good), true, `應判 true：${good}`);
  }
});

test("creationStepMeta：合法值回元資料，非法值回 undefined", () => {
  assert.equal(creationStepMeta(1)?.key, "global-setting");
  assert.equal(creationStepMeta(7)?.key, "preview");
  assert.equal(creationStepMeta(0), undefined);
  assert.equal(creationStepMeta("3"), undefined);
});

test("episodeStatusFromAid：六態收斂為本站三態（審核三態折入 finished）", () => {
  assert.equal(episodeStatusFromAid(0), "draft");
  assert.equal(episodeStatusFromAid(1), "processing");
  assert.equal(episodeStatusFromAid(2), "finished");
  assert.equal(episodeStatusFromAid(3), "finished");
  assert.equal(episodeStatusFromAid(4), "finished");
  assert.equal(episodeStatusFromAid(5), "processing");
  assert.equal(episodeStatusFromAid(6), undefined);
  assert.equal(episodeStatusFromAid(null), undefined);
});

// ─────────────────────────────────────────── 2. normalizeProject 白名單

test("normalizeProject：合法 projectType/currentStep/episodes 原樣保留", () => {
  const out = normalizeProject(
    basePayload({
      projectType: "series",
      currentStep: 3,
      episodes: [episode(1, { script: "第一集劇本", status: "processing" })],
    }),
  );
  assert.ok(out);
  assert.equal(out.projectType, "series");
  assert.equal(out.currentStep, 3);
  assert.equal(out.episodes?.length, 1);
  assert.equal(out.episodes?.[0].episodeNo, 1);
  assert.equal(out.episodes?.[0].script, "第一集劇本");
  assert.equal(out.episodes?.[0].status, "processing");
});

test("normalizeProject：非法 projectType 省略欄位（不寫預設冒充用戶設定）", () => {
  for (const bad of ["tv", "MOVIE", "", 1, null, {}, []]) {
    const out = normalizeProject(basePayload({ projectType: bad }));
    assert.ok(out);
    assert.ok(!("projectType" in out), `非法值不應落欄：${JSON.stringify(bad)}`);
  }
});

test("normalizeProject：非法 currentStep 省略欄位", () => {
  for (const bad of [0, 8, -1, 1.5, "3", null, NaN, {}]) {
    const out = normalizeProject(basePayload({ currentStep: bad }));
    assert.ok(out);
    assert.ok(!("currentStep" in out), `非法值不應落欄：${JSON.stringify(bad)}`);
  }
  assert.equal(normalizeProject(basePayload({ currentStep: 7 }))?.currentStep, 7);
  assert.equal(normalizeProject(basePayload({ currentStep: 1 }))?.currentStep, 1);
});

test("normalizeProject：episodes 非陣列省略欄位；垃圾項逐項丟棄（不整份作廢）", () => {
  for (const bad of ["x", 1, null, {}, { 0: episode(1) }]) {
    const out = normalizeProject(basePayload({ episodes: bad }));
    assert.ok(out, "非陣列不應整份作廢");
    assert.ok(!("episodes" in out), `非陣列不應落欄：${JSON.stringify(bad)}`);
  }

  const out = normalizeProject(
    basePayload({
      episodes: [
        episode(1),
        null, // 非物件
        { id: "", episodeNo: 2, title: "空 id" }, // 空 id
        { id: "ep-3", episodeNo: 3, title: "" }, // 空 title
        { id: "ep-4", episodeNo: 0, title: "集號 0" }, // 集號 <1
        { id: "ep-5", episodeNo: 1.5, title: "非整數集號" },
        { id: "ep-6", episodeNo: "6", title: "字串集號" },
        episode(7),
      ],
    }),
  );
  assert.ok(out);
  assert.deepEqual(out.episodes?.map((e) => e.episodeNo), [1, 7]);
});

test("normalizeProject：status 非三態值回落 draft；script 非字串省略", () => {
  const out = normalizeProject(
    basePayload({
      episodes: [
        episode(1, { status: "auditing" }), // AID 審核態：本站不收
        episode(2, { status: undefined }),
        episode(3, { script: 123 }),
      ],
    }),
  );
  assert.ok(out);
  assert.deepEqual(out.episodes?.map((e) => e.status), ["draft", "draft", "draft"]);
  assert.ok(!("script" in (out.episodes?.[2] ?? {})), "script 非字串應省略");
});

test("normalizeProject：episodes 超過 200 集被截斷", () => {
  const many = Array.from({ length: 250 }, (_, i) => episode(i + 1));
  const out = normalizeProject(basePayload({ episodes: many }));
  assert.ok(out);
  assert.equal(out.episodes?.length, 200);
  assert.equal(out.episodes?.[199].episodeNo, 200);
});

test("normalizeProject：episodeNo 重複去重（保留首見）", () => {
  const out = normalizeProject(
    basePayload({
      episodes: [
        episode(1, { title: "首見" }),
        episode(1, { title: "重複" }),
        episode(2),
      ],
    }),
  );
  assert.ok(out);
  assert.deepEqual(out.episodes?.map((e) => e.episodeNo), [1, 2]);
  assert.equal(out.episodes?.[0].title, "首見");
});

// ─────────────────────────────────────────── 3. 向後相容

test("向後相容：不含新欄位的舊 payload 正常解析且不冒出空欄位", () => {
  const out = normalizeProject(basePayload({ cardIds: ["c1"] }));
  assert.ok(out, "舊 payload 必須仍可解析");
  assert.equal(out.id, "canvas-1");
  assert.equal(out.backgroundMode, "dots");
  assert.deepEqual(out.cardIds, ["c1"]);
  assert.ok(!("projectType" in out));
  assert.ok(!("currentStep" in out));
  assert.ok(!("episodes" in out));
});

test("向後相容：核心欄位缺失仍回 null（不因新欄位放寬入口）", () => {
  assert.equal(normalizeProject(null), null);
  assert.equal(normalizeProject("x"), null);
  assert.equal(normalizeProject({ title: "t", nodes: [] }), null);
  assert.equal(normalizeProject({ id: "i", nodes: [] }), null);
  assert.equal(normalizeProject({ id: "i", title: "t" }), null);
});
