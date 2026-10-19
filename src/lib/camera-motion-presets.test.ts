// 运镜预设库 + 公开 API 端点的**真行为**测试（2026-09-27 立）。
//
// 依 [[verification-guards-not-oracles-0923]]：源码字串断言只算变更探针。
// 本档以行为断言为主——真的呼叫 list/get/compose 与 route handler（NextRequest →
// Response），外加两个独立来源的 oracle：①`HARNESS_TOOL_IDS`（harness 注册表，
// 非本档资料）②`CAMERA_MOVE_TO_PROMPT`（既有轨迹映射表，用来反证本档没有复制它）。
// 未验：任一条预设在生产 harness 上「跑得动」（toolId 合法 ≠ 该工具可用），
// 以及运镜结果的视觉品质——那是生成端与项目负责人验收的事。

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  CAMERA_MOTION_PRESETS,
  cameraMotionPrompt,
  getCameraMotionPreset,
  listCameraMotionPresetTags,
  listCameraMotionPresets,
  type CameraMotionPreset,
} from "./camera-motion-presets";
import { CAMERA_MOVE_TO_PROMPT, describeCameraTrajectory } from "./camera-trajectory-to-prompt";
import { HARNESS_STUB_TOOLS, HARNESS_TOOL_IDS } from "./harness-tool-registry";
import { GET } from "../app/api/camera-motion-presets/route.ts";

const ALL = CAMERA_MOTION_PRESETS;

/** 覆盖度清单（每格必须恰有一条互斥预设承接；tagLabel 为权威键）。 */
const REQUIRED_CATEGORIES = [
  "固定",
  "推轨",
  "拉远",
  "横移",
  "跟拍",
  "环绕",
  "升降",
  "手持",
  "摇臂",
  "俯冲",
  "仰拍",
  "变焦",
  "眩晕变焦",
  "一镜到底",
  "第一人称",
  "越肩",
  "贴地",
  "航拍",
  "螺旋",
  "甩镜",
  "延时",
  "稳定器",
  "跟焦",
] as const;

// ───────────────────────────── 目录契约（真资料断言）

test("条数落在 20-24 区间（互斥覆盖目标）", () => {
  assert.ok(ALL.length >= 20, `太少：${ALL.length}`);
  assert.ok(ALL.length <= 24, `太多：${ALL.length}`);
});

test("key 全库唯一、kebab-case、cm- 前缀", () => {
  const keys = ALL.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length, "key 必须唯一");
  for (const key of keys) {
    assert.match(key, /^cm-[a-z0-9]+(?:-[a-z0-9]+)*$/, `非 kebab/cm- 前缀：${key}`);
  }
});

test("tagLabel 全库唯一且 ≤4 个码位（胶囊标签）；name 非空", () => {
  const labels = ALL.map((p) => p.tagLabel);
  assert.equal(new Set(labels).size, labels.length, `tagLabel 必须互斥：${labels.join("/")}`);
  for (const p of ALL) {
    assert.ok([...p.tagLabel].length <= 4, `${p.key} tagLabel 过长：${p.tagLabel}`);
    assert.ok([...p.tagLabel].length >= 1, `${p.key} tagLabel 为空`);
    assert.ok(p.name.trim().length > 0, `${p.key} name 为空`);
  }
});

test("prompt 非空且长度 ≥20；tags 有 3-6 个非空检索词", () => {
  for (const p of ALL) {
    assert.ok(p.prompt.trim().length >= 20, `${p.key} prompt 过短`);
    assert.ok(p.tags.length >= 3 && p.tags.length <= 6, `${p.key} tags 数量 ${p.tags.length}`);
    for (const tag of p.tags) assert.ok(tag.trim().length > 0, `${p.key} 有空 tag`);
  }
});

test("toolId ⊆ HARNESS_TOOL_IDS，且不是已知 stub（独立来源 oracle）", () => {
  for (const p of ALL) {
    assert.equal(typeof p.toolId, "string");
    assert.ok(HARNESS_TOOL_IDS.has(p.toolId), `${p.key} 的 toolId 未注册：${p.toolId}`);
    assert.equal(HARNESS_STUB_TOOLS[p.toolId], undefined, `${p.key} 指向 stub 工具：${p.toolId}`);
  }
});

test("prompt 不逐字复制既有 CAMERA_MOVE_TO_PROMPT（防第二份映射表）", () => {
  const existing = new Set(Object.values(CAMERA_MOVE_TO_PROMPT));
  for (const p of ALL) {
    assert.equal(existing.has(p.prompt), false, `${p.key} 逐字复制既有映射值`);
  }
});

test("互斥覆盖：REQUIRED_CATEGORIES 每格恰有一条承接（tagLabel 权威键）", () => {
  const byLabel = new Map<string, CameraMotionPreset>();
  for (const p of ALL) byLabel.set(p.tagLabel, p);
  for (const label of REQUIRED_CATEGORIES) {
    assert.ok(byLabel.has(label), `缺类别：${label}`);
  }
  assert.equal(byLabel.size, ALL.length, "有未被覆盖清单收录的预设");
});

// ───────────────────────────── listCameraMotionPresets（检索行为）

test("无参数＝全库，顺序与内容逐位元等于 CAMERA_MOTION_PRESETS", () => {
  const listed = listCameraMotionPresets();
  assert.equal(listed.length, ALL.length);
  assert.deepEqual(listed, ALL);
  assert.equal(listCameraMotionPresets({}), ALL);
  assert.equal(listCameraMotionPresets({ query: "", tag: "" }), ALL);
});

test("query 命中真子集（中文名）＋ 空 query 不筛", () => {
  const hit = listCameraMotionPresets({ query: "推轨" });
  assert.ok(hit.length >= 1 && hit.length < ALL.length, `应为真子集：${hit.length}/${ALL.length}`);
  assert.ok(hit.some((p) => p.key === "cm-dolly-in"), "推轨 应命中 cm-dolly-in");
  for (const p of hit) assert.ok(ALL.includes(p), "命中项必须来自全库");
  assert.equal(listCameraMotionPresets({ query: "  " }).length, ALL.length, "纯空白 query 不得筛掉任何条");
});

test("query 负向对照：乱码回 0（不得无脑全命中）", () => {
  assert.deepEqual(listCameraMotionPresets({ query: "zzz乱码zzz" }), []);
  assert.deepEqual(listCameraMotionPresets({ query: "QQ_NOPE_0927" }), []);
});

test("query 大小写不敏感、可命中 prompt 内的英文术语", () => {
  const lower = listCameraMotionPresets({ query: "dolly" });
  const upper = listCameraMotionPresets({ query: "DOLLY" });
  assert.equal(lower.length, upper.length);
  assert.ok(lower.length >= 2, "dolly 应命中推轨/拉远/眩晕变焦");
  assert.ok(lower.every((p) => p.key.includes("dolly") || p.prompt.toLowerCase().includes("dolly")));
});

test("tag 精确命中 tags；未知 tag 回 0；query＋tag 取交集", () => {
  const aerial = listCameraMotionPresets({ tag: "航拍" });
  assert.ok(aerial.length >= 1);
  for (const p of aerial) assert.ok(p.tags.includes("航拍"), `${p.key} 不含该 tag`);
  assert.deepEqual(listCameraMotionPresets({ tag: "不存在的标签" }), []);
  const both = listCameraMotionPresets({ query: "无人机", tag: "航拍" });
  for (const p of both) {
    assert.ok(p.tags.includes("航拍"));
    assert.match([p.prompt, p.name, p.tagLabel, ...p.tags].join(" ").toLowerCase(), /无人机/);
  }
});

test("每条都能被自己的 tagLabel 与 name 检索到；每个 tag 都有归属", () => {
  for (const p of ALL) {
    assert.ok(
      listCameraMotionPresets({ query: p.tagLabel }).some((x) => x.key === p.key),
      `${p.key} 无法用 tagLabel 检索到`,
    );
    assert.ok(
      listCameraMotionPresets({ query: p.name }).some((x) => x.key === p.key),
      `${p.key} 无法用 name 检索到`,
    );
  }
  const facet = listCameraMotionPresetTags();
  assert.ok(facet.length >= 40, `tags facet 太少：${facet.length}`);
  for (const tag of facet) {
    assert.ok(listCameraMotionPresets({ tag }).length >= 1, `tag 无任一条目引用：${tag}`);
  }
  assert.deepEqual(listCameraMotionPresetTags(), facet, "facet 必须确定性（同输入同输出）");
});

// ───────────────────────────── getCameraMotionPreset

test("getCameraMotionPreset：已知回同一物件参照、容忍大小写与空白；未知回 null", () => {
  for (const p of ALL) {
    assert.equal(getCameraMotionPreset(p.key), p, "必须回全库同一物件（不做复制）");
  }
  assert.equal(getCameraMotionPreset("CM-DOLLY-IN"), ALL.find((p) => p.key === "cm-dolly-in"));
  assert.equal(getCameraMotionPreset("  cm-fixed  "), ALL.find((p) => p.key === "cm-fixed"));
  assert.equal(getCameraMotionPreset("cm-not-exist"), null);
  assert.equal(getCameraMotionPreset(""), null);
});

// ───────────────────────────── cameraMotionPrompt（组装行为）

test("cameraMotionPrompt：未知 key 回 null；每条已知 key 都能组出含本文的提示词", () => {
  assert.equal(cameraMotionPrompt("cm-nope"), null);
  assert.equal(cameraMotionPrompt(""), null);
  for (const p of ALL) {
    const out = cameraMotionPrompt(p.key);
    assert.ok(out && out.length > p.prompt.length, `${p.key} 组装结果为空`);
    assert.ok(out.includes(p.prompt), `${p.key} 组装结果丢失 preset 本文`);
    assert.match(out, /^Camera: /, `${p.key} 未走既有 Camera 槽编排`);
    assert.match(out, /ending framed on the subject\.$/, `${p.key} 未走既有尾句`);
  }
});

test("零情境逐位元等价退化：undefined / 空字串 / 纯空白三路完全相同，且不注入空段", () => {
  for (const p of ALL) {
    const base = cameraMotionPrompt(p.key);
    assert.equal(cameraMotionPrompt(p.key, undefined), base);
    assert.equal(cameraMotionPrompt(p.key, ""), base);
    assert.equal(cameraMotionPrompt(p.key, "   \n\t "), base);
    assert.doesNotMatch(base ?? "", /,\s*,|,\s*\./, `${p.key} 注入了空情境段`);
  }
});

test("有情境时差异只落在情境段；情境首尾空白被 trim", () => {
  const ctx = "雨夜天台，主角背对镜头站定";
  for (const p of ALL) {
    const base = cameraMotionPrompt(p.key) as string;
    const withCtx = cameraMotionPrompt(p.key, ctx) as string;
    assert.notEqual(withCtx, base, `${p.key} 情境未生效`);
    assert.ok(withCtx.includes(ctx), `${p.key} 情境遗失`);
    // 去掉情境段（含其前置分隔符）后必须逐位元还原基准输出
    assert.equal(withCtx.replace(`, ${ctx}`, ""), base, `${p.key} 基准段被情境污染`);
    assert.equal(cameraMotionPrompt(p.key, `  ${ctx}  `), withCtx, `${p.key} 未 trim 情境`);
  }
});

test("复用契约：组装结果逐字等于既有 describeCameraTrajectory 的输出（零第二套逻辑）", () => {
  const ctx = "海面晨雾，孤舟向右出画";
  for (const p of ALL) {
    assert.equal(cameraMotionPrompt(p.key), describeCameraTrajectory({ summary: p.prompt }));
    assert.equal(cameraMotionPrompt(p.key, ctx), describeCameraTrajectory({ summary: `${p.prompt}, ${ctx}` }));
  }
});

// ───────────────────────────── GET /api/camera-motion-presets（端点真行为）

function req(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: "GET" });
}

async function bodyOf(res: Response) {
  return (await res.json()) as {
    presets?: CameraMotionPreset[];
    total?: number;
    tags?: string[];
    success?: boolean;
    code?: string;
  };
}

test("公开只读：无任何登入环境也回 200 全量，body 形状 {presets,total,tags}", async () => {
  const prevMode = process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  const prevKey = process.env.IMAGE_STUDIO_BIZ_KEY;
  delete process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  delete process.env.IMAGE_STUDIO_BIZ_KEY;
  try {
    const res = await GET(req("/api/camera-motion-presets"));
    assert.equal(res.status, 200, "公开端点不得要求登入");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await bodyOf(res);
    assert.equal(body.total, ALL.length);
    assert.equal(body.presets?.length, ALL.length);
    assert.deepEqual(body.presets, ALL, "端点必须回全库（无分页截断）");
    assert.ok((body.tags?.length ?? 0) >= 40);
    for (const tag of body.tags ?? []) {
      assert.ok(ALL.some((p) => p.tags.includes(tag)), `facet tag 无归属：${tag}`);
    }
  } finally {
    if (prevMode !== undefined) process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = prevMode;
    if (prevKey !== undefined) process.env.IMAGE_STUDIO_BIZ_KEY = prevKey;
  }
});

test("端点 q / tag 筛选与纯函式层一致；负向对照 total=0", async () => {
  const hit = await bodyOf(await GET(req("/api/camera-motion-presets?q=%E6%8E%A8%E8%BD%A8"))); // q=推轨
  assert.ok((hit.total ?? 0) >= 1 && (hit.total ?? 0) < ALL.length);
  assert.ok(hit.presets?.some((p) => p.key === "cm-dolly-in"));
  assert.equal(hit.total, hit.presets?.length, "total 必须等于过滤后回传条数");

  const neg = await bodyOf(await GET(req("/api/camera-motion-presets?q=zzz%E4%B9%B1%E7%A0%81zzz"))); // q=zzz乱码zzz
  assert.equal(neg.total, 0);
  assert.deepEqual(neg.presets, []);

  const byTag = await bodyOf(await GET(req("/api/camera-motion-presets?tag=%E8%88%AA%E6%8B%8D"))); // tag=航拍
  assert.ok((byTag.total ?? 0) >= 1);
  for (const p of byTag.presets ?? []) assert.ok(p.tags.includes("航拍"));

  const both = await bodyOf(await GET(req("/api/camera-motion-presets?q=dolly&tag=dolly%20zoom")));
  for (const p of both.presets ?? []) assert.ok(p.tags.includes("dolly zoom"));
});
