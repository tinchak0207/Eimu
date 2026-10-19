// 创作流水线状态机契约测试（2026-09-15 吞 AID 产品层刀 1）。
//
// 锁住三件事：
//   1. 7 步常量与 `isValidCreationStep` 的值域（1..7 整数）；
//   2. `normalizeProject` 对新栏位（projectType/currentStep/episodes）的逐栏白名单清洗；
//   3. 向后相容：不含新栏位的旧 payload 仍正常解析，且不冒出空栏位。
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
    title: "测试画布",
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

test("CREATION_STEPS：长度 7、value 为 1..7 连续、label 非空", () => {
  assert.equal(CREATION_STEPS.length, 7);
  CREATION_STEPS.forEach((step, i) => {
    assert.equal(step.value, i + 1, `第 ${i} 项 value 应为 ${i + 1}`);
    assert.ok(step.label.trim().length > 0, `空 label @ step ${step.value}`);
    assert.ok(step.key.trim().length > 0, `空 key @ step ${step.value}`);
  });
});

test("CREATION_STEPS：label 逐字照 AID desc（繁体输入已正规化为简体）", () => {
  assert.deepEqual(
    CREATION_STEPS.map((s) => s.label),
    ["项目配置", "剧本创作", "素材准备", "分镜设计", "视频生成", "音画同步", "成品预览"],
  );
});

test("isValidCreationStep：边界（0/8/null/undefined/1.5/NaN/字串皆 false；1/7 true）", () => {
  for (const bad of [0, 8, -1, null, undefined, 1.5, NaN, Infinity, "1", "", {}, []]) {
    assert.equal(isValidCreationStep(bad), false, `应判 false：${JSON.stringify(bad)}`);
  }
  for (const good of [1, 2, 3, 4, 5, 6, 7]) {
    assert.equal(isValidCreationStep(good), true, `应判 true：${good}`);
  }
});

test("creationStepMeta：合法值回元资料，非法值回 undefined", () => {
  assert.equal(creationStepMeta(1)?.key, "global-setting");
  assert.equal(creationStepMeta(7)?.key, "preview");
  assert.equal(creationStepMeta(0), undefined);
  assert.equal(creationStepMeta("3"), undefined);
});

test("episodeStatusFromAid：六态收敛为本站三态（审核三态折入 finished）", () => {
  assert.equal(episodeStatusFromAid(0), "draft");
  assert.equal(episodeStatusFromAid(1), "processing");
  assert.equal(episodeStatusFromAid(2), "finished");
  assert.equal(episodeStatusFromAid(3), "finished");
  assert.equal(episodeStatusFromAid(4), "finished");
  assert.equal(episodeStatusFromAid(5), "processing");
  assert.equal(episodeStatusFromAid(6), undefined);
  assert.equal(episodeStatusFromAid(null), undefined);
});

// ─────────────────────────────────────────── 2. normalizeProject 白名单

test("normalizeProject：合法 projectType/currentStep/episodes 原样保留", () => {
  const out = normalizeProject(
    basePayload({
      projectType: "series",
      currentStep: 3,
      episodes: [episode(1, { script: "第一集剧本", status: "processing" })],
    }),
  );
  assert.ok(out);
  assert.equal(out.projectType, "series");
  assert.equal(out.currentStep, 3);
  assert.equal(out.episodes?.length, 1);
  assert.equal(out.episodes?.[0].episodeNo, 1);
  assert.equal(out.episodes?.[0].script, "第一集剧本");
  assert.equal(out.episodes?.[0].status, "processing");
});

test("normalizeProject：非法 projectType 省略栏位（不写预设冒充用户设定）", () => {
  for (const bad of ["tv", "MOVIE", "", 1, null, {}, []]) {
    const out = normalizeProject(basePayload({ projectType: bad }));
    assert.ok(out);
    assert.ok(!("projectType" in out), `非法值不应落栏：${JSON.stringify(bad)}`);
  }
});

test("normalizeProject：非法 currentStep 省略栏位", () => {
  for (const bad of [0, 8, -1, 1.5, "3", null, NaN, {}]) {
    const out = normalizeProject(basePayload({ currentStep: bad }));
    assert.ok(out);
    assert.ok(!("currentStep" in out), `非法值不应落栏：${JSON.stringify(bad)}`);
  }
  assert.equal(normalizeProject(basePayload({ currentStep: 7 }))?.currentStep, 7);
  assert.equal(normalizeProject(basePayload({ currentStep: 1 }))?.currentStep, 1);
});

test("normalizeProject：episodes 非阵列省略栏位；垃圾项逐项丢弃（不整份作废）", () => {
  for (const bad of ["x", 1, null, {}, { 0: episode(1) }]) {
    const out = normalizeProject(basePayload({ episodes: bad }));
    assert.ok(out, "非阵列不应整份作废");
    assert.ok(!("episodes" in out), `非阵列不应落栏：${JSON.stringify(bad)}`);
  }

  const out = normalizeProject(
    basePayload({
      episodes: [
        episode(1),
        null, // 非物件
        { id: "", episodeNo: 2, title: "空 id" }, // 空 id
        { id: "ep-3", episodeNo: 3, title: "" }, // 空 title
        { id: "ep-4", episodeNo: 0, title: "集号 0" }, // 集号 <1
        { id: "ep-5", episodeNo: 1.5, title: "非整数集号" },
        { id: "ep-6", episodeNo: "6", title: "字串集号" },
        episode(7),
      ],
    }),
  );
  assert.ok(out);
  assert.deepEqual(out.episodes?.map((e) => e.episodeNo), [1, 7]);
});

test("normalizeProject：status 非三态值回落 draft；script 非字串省略", () => {
  const out = normalizeProject(
    basePayload({
      episodes: [
        episode(1, { status: "auditing" }), // AID 审核态：本站不收
        episode(2, { status: undefined }),
        episode(3, { script: 123 }),
      ],
    }),
  );
  assert.ok(out);
  assert.deepEqual(out.episodes?.map((e) => e.status), ["draft", "draft", "draft"]);
  assert.ok(!("script" in (out.episodes?.[2] ?? {})), "script 非字串应省略");
});

test("normalizeProject：episodes 超过 200 集被截断", () => {
  const many = Array.from({ length: 250 }, (_, i) => episode(i + 1));
  const out = normalizeProject(basePayload({ episodes: many }));
  assert.ok(out);
  assert.equal(out.episodes?.length, 200);
  assert.equal(out.episodes?.[199].episodeNo, 200);
});

test("normalizeProject：episodeNo 重复去重（保留首见）", () => {
  const out = normalizeProject(
    basePayload({
      episodes: [
        episode(1, { title: "首见" }),
        episode(1, { title: "重复" }),
        episode(2),
      ],
    }),
  );
  assert.ok(out);
  assert.deepEqual(out.episodes?.map((e) => e.episodeNo), [1, 2]);
  assert.equal(out.episodes?.[0].title, "首见");
});

// ─────────────────────────────────────────── 3. 向后相容

test("向后相容：不含新栏位的旧 payload 正常解析且不冒出空栏位", () => {
  const out = normalizeProject(basePayload({ cardIds: ["c1"] }));
  assert.ok(out, "旧 payload 必须仍可解析");
  assert.equal(out.id, "canvas-1");
  assert.equal(out.backgroundMode, "dots");
  assert.deepEqual(out.cardIds, ["c1"]);
  assert.ok(!("projectType" in out));
  assert.ok(!("currentStep" in out));
  assert.ok(!("episodes" in out));
});

test("向后相容：核心栏位缺失仍回 null（不因新栏位放宽入口）", () => {
  assert.equal(normalizeProject(null), null);
  assert.equal(normalizeProject("x"), null);
  assert.equal(normalizeProject({ title: "t", nodes: [] }), null);
  assert.equal(normalizeProject({ id: "i", nodes: [] }), null);
  assert.equal(normalizeProject({ id: "i", title: "t" }), null);
});
