// MOE Wave1-A 框架接线测试：3D 导演（proto-Expert）挂 Expert 框架。
// 覆盖三条验收线：
//   ① OFF 零回归：assembleDirectorReply（settings 缺省/false/非布林）回覆
//      键集合与 scene_op/scene_summary 与现状逐栏位一致；委托单 prompt =
//      composeDelegation serialized 原文一个字不多。
//   ② ON 宪法注入 + 交付物契约：prompt 头部 = expert-constitution.md 全文；
//      deliverable 过 validateExpertDeliverable；篡改签名被拒；
//      契约摘要行（expertId/kind/签名前 8 位）附在 scene_summary 且不超帽。
//   ③ readBeastMode 三态（缺/false/true）经 settings 入口驱动野兽分支；
//      未 prime → 内联后备判准、prime 后 → registry 真源，两路行为一致。
// 跑法（package.json 既有 node:test 范式；主 tsconfig exclude *.test.ts）：
//   npx tsx --test src/lib/blender-expert-frame.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIRECTOR_DELIVERABLE_KIND,
  DIRECTOR_EXPERT_CONSTITUTION_PATH,
  DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
  __resetExpertRegistryForTest,
  assembleDirectorReply,
  composeDirectorDelegation,
  composeDirectorDelegationPrompt,
  getExpertRegistryLoadFailure,
  primeExpertRegistry,
} from "./blender-director-persona";
import { estimateTokens, type BlenderDelegation } from "./blender-delegate";
import { computeQcSignature, validateExpertDeliverable } from "./expert-contract";
import type { BlenderExecuteSuccess } from "./blender-tools";

// ── fixtures（同款 blender-director-persona.test.ts executeResult 形） ──────

function executeResult(): BlenderExecuteSuccess {
  return {
    ok: true,
    artifacts: [
      { path: "turntable.mp4", bytes: 1_024, kind: "mp4" },
      { path: "render_f0001.png", bytes: 2_048, kind: "png" },
      { path: "scene.blend", bytes: 4_096, kind: "blend" },
      { path: "scene.glb", bytes: 8_192, kind: "glb" },
    ],
    scene_summary: "低多边形山丘场景，三点打光",
    stdout_tail: "RENDER_DONE: turntable",
    duration_ms: 3_700,
  };
}

function delegationInput() {
  return {
    effect_description: "主角站在悬崖边，风吹披风",
    shot_count: 2,
    deliverables: ["turntable", "blend", "glb"] as const,
  };
}

function readConstitution(): string {
  const abs = path.resolve(
    fileURLToPath(import.meta.url),
    "../../..",
    DIRECTOR_EXPERT_CONSTITUTION_PATH,
  );
  return readFileSync(abs, "utf8");
}

// ── ① OFF 零回归（回覆形与现状逐栏位一致） ───────────────────────────────────

test("OFF（settings 缺省）：回覆键集合 = ok/scene_op/scene_summary，无 deliverable", () => {
  const reply = assembleDirectorReply(executeResult(), { title: "悬崖场景" });
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.deepEqual(Object.keys(reply).sort(), ["ok", "scene_op", "scene_summary"]);
  assert.equal(reply.deliverable, undefined);
  assert.equal(reply.scene_op.type, "add_node");
  assert.equal(reply.scene_op.node.type, "scene_3d");
  assert.equal(reply.scene_op.node.title, "悬崖场景");
  assert.ok(reply.scene_op.node.metadata.sceneCard.turntable_url.endsWith("turntable.mp4"));
  assert.equal(reply.scene_summary, "低多边形山丘场景，三点打光");
});

test("OFF（beast_mode=false / 非布林 / settings 非物件）：同现状形", () => {
  const settingsCases: unknown[] = [
    { beast_mode: false },
    { beast_mode: "yes" },
    { beast_mode: 1 },
    {},
    null,
    "on",
  ];
  for (const settings of settingsCases) {
    const reply = assembleDirectorReply(executeResult(), { title: "悬崖场景" }, { settings });
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    assert.deepEqual(Object.keys(reply).sort(), ["ok", "scene_op", "scene_summary"]);
    assert.equal(reply.deliverable, undefined);
    assert.equal(reply.scene_summary, "低多边形山丘场景，三点打光");
  }
});

test("OFF：委托单 prompt = composeDelegation serialized 原文（一个字不多）", async () => {
  const base = composeDirectorDelegation(delegationInput());
  assert.equal(base.ok, true);
  if (!base.ok) return;
  for (const settings of [undefined, {}, { beast_mode: false }, { other_key: true }]) {
    const off = await composeDirectorDelegationPrompt(delegationInput(), settings);
    assert.equal(off.ok, true);
    if (!off.ok) return;
    assert.equal(off.constitutionInjected, false);
    assert.equal(off.prompt, base.serialized);
    assert.equal(off.estimated_tokens, base.estimated_tokens);
  }
});

test("OFF：摘要过长也不截断（截断只属于 ON 契约路径，现状零回归）", () => {
  const huge = "山".repeat(3000);
  const reply = assembleDirectorReply(
    { ...executeResult(), scene_summary: huge },
    {},
    { settings: { beast_mode: false } },
  );
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.equal(reply.scene_summary, huge);
});

// ── ② ON：宪法注入 + 交付物契约 + 摘要行 ────────────────────────────────────

test("ON：prompt 头部 = 宪法全文（trimEnd 后逐字前缀），原委托单 JSON 尾随", async () => {
  const constitution = readConstitution();
  assert.ok(constitution.includes("Expert 宪法"), "宪法档真源在位");
  const base = composeDirectorDelegation(delegationInput());
  assert.equal(base.ok, true);
  if (!base.ok) return;
  const on = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(on.ok, true);
  if (!on.ok) return;
  assert.equal(on.constitutionInjected, true);
  assert.ok(on.prompt.startsWith(constitution.trimEnd()), "prompt 必须以宪法全文开头");
  const tail = on.prompt.slice(on.prompt.lastIndexOf("\n") + 1);
  assert.equal(tail, base.serialized);
  assert.ok(on.prompt.includes("---"));
});

test("ON：组装回覆附 deliverable，validateExpertDeliverable 通过、payload=sceneCard 六栏", () => {
  const reply = assembleDirectorReply(
    executeResult(),
    { title: "悬崖场景" },
    { settings: { beast_mode: true } },
  );
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.ok(reply.deliverable, "ON 时必附 deliverable");
  const d = reply.deliverable;
  assert.equal(d.expertId, "director3d");
  assert.equal(d.kind, DIRECTOR_DELIVERABLE_KIND);
  assert.equal(d.kind, "scene_3d");
  const card = d.payload.sceneCard as Record<string, unknown>;
  assert.deepEqual(Object.keys(card).sort(), [
    "blend_path",
    "duration_ms",
    "glb_path",
    "scene_summary",
    "stills_urls",
    "turntable_url",
  ]);
  assert.equal(d.evidence.artifactPath, "turntable.mp4");
  assert.equal(d.evidence.bytes, 1_024);
  assert.equal(d.contract.expertId, "director3d");
  assert.equal(d.contract.intent, "悬崖场景");
  const gate = validateExpertDeliverable(d);
  assert.equal(gate.ok, true, `闸门必过：${gate.errors.join("；")}`);
});

test("ON：scene_summary 附契约摘要行（expertId/kind/签名前 8 位）且总长不超帽", () => {
  const reply = assembleDirectorReply(
    executeResult(),
    { title: "悬崖场景" },
    { settings: { beast_mode: true } },
  );
  assert.equal(reply.ok, true);
  if (!reply.ok || !reply.deliverable) return;
  assert.ok(reply.scene_summary.startsWith("低多边形山丘场景，三点打光"));
  const line = reply.scene_summary.split("\n")[1];
  assert.match(line, /^deliverable expertId=director3d kind=scene_3d qc=[0-9a-f]{8}$/);
  assert.ok(
    line.includes(reply.deliverable.qcSignature.slice(0, 8)),
    "摘要行携带签名前 8 位",
  );
  assert.ok(estimateTokens(reply.scene_summary) <= DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);
});

test("ON：摘要过长时契约行保留、总长压回帽内（帽强制只在 ON 生效）", () => {
  const huge = "山".repeat(3000);
  const reply = assembleDirectorReply(
    { ...executeResult(), scene_summary: huge },
    {},
    { settings: { beast_mode: true } },
  );
  assert.equal(reply.ok, true);
  if (!reply.ok || !reply.deliverable) return;
  assert.match(
    reply.scene_summary,
    /deliverable expertId=director3d kind=scene_3d qc=[0-9a-f]{8}$/,
    "契约行完整保留在尾部",
  );
  assert.ok(estimateTokens(reply.scene_summary) <= DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);
});

test("ON：篡改签名被 validateExpertDeliverable 拒（闸门可检篡改）", () => {
  const reply = assembleDirectorReply(
    executeResult(),
    { title: "悬崖场景" },
    { settings: { beast_mode: true } },
  );
  assert.equal(reply.ok, true);
  if (!reply.ok || !reply.deliverable) return;
  const tampered = {
    ...reply.deliverable,
    qcSignature: reply.deliverable.qcSignature.replace(/^./, "0"),
  };
  const gate = validateExpertDeliverable(tampered);
  assert.equal(gate.ok, false);
  assert.ok(gate.errors.some((e) => e.includes("篡改")));
  // 另案：payload 被改 → 重算签名不一致
  const tamperedPayload = {
    ...reply.deliverable,
    payload: { ...reply.deliverable.payload, evil: true },
  };
  assert.equal(validateExpertDeliverable(tamperedPayload).ok, false);
  // 另案：computeQcSignature 重算 = 原签名（签名口径闭环）
  const { qcSignature, ...rest } = reply.deliverable;
  assert.equal(qcSignature, computeQcSignature(rest));
});

test("ON：delegation.materials 回指（reference_refs 进契约 materials）", () => {
  const reply = assembleDirectorReply(
    executeResult(),
    { title: "悬崖场景" },
    {
      settings: { beast_mode: true },
      delegation: {
        effect_description: "主角站在悬崖边，风吹披风",
        shot_count: 2,
        reference_refs: ["node-1", "/uploads/ref.png"],
        deliverables: ["turntable", "blend", "glb"],
      } satisfies BlenderDelegation,
    },
  );
  assert.equal(reply.ok, true);
  if (!reply.ok || !reply.deliverable) return;
  assert.deepEqual(reply.deliverable.contract.materials, ["node-1", "/uploads/ref.png"]);
});

test("ON：无 title 时 contract.intent 退回 scene_summary", () => {
  const reply = assembleDirectorReply(executeResult(), {}, { settings: { beast_mode: true } });
  assert.equal(reply.ok, true);
  if (!reply.ok || !reply.deliverable) return;
  assert.equal(reply.deliverable.contract.intent, "低多边形山丘场景，三点打光");
});

test("ON：委托单校验不过 = 结构化错误透传（不走注入路径）", async () => {
  const r = await composeDirectorDelegationPrompt(
    { effect_description: "缺 deliverables 与 shot_count" },
    { beast_mode: true },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "invalid_delegation");
  assert.ok(r.hint.includes("必填"));
});

test("ON + 宪法档缺失：constitution_unavailable 结构化报错（不静默裸奔派单）", async () => {
  const r = await composeDirectorDelegationPrompt(
    delegationInput(),
    { beast_mode: true },
    { constitutionPath: "deploy-staging/expert-gateway/definitely-missing.md" },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "constitution_unavailable");
  assert.ok(r.hint.includes(DIRECTOR_EXPERT_CONSTITUTION_PATH));
  assert.ok(r.hint.includes("ENOENT"));
});

// ── ③ readBeastMode 三态 + registry 读取路径（内联后备 ↔ 动态 import 真源） ──

test("读取路径：未 prime → 内联后备判准；prime 后 → registry 真源，注入结果逐字一致", async () => {
  __resetExpertRegistryForTest();
  const base = composeDirectorDelegation(delegationInput());
  assert.equal(base.ok, true);
  if (!base.ok) return;

  // 未 prime：readBeastModeSync 走内联后备（判准 = beast_mode === true 严格）。
  const onFallback = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(onFallback.ok, true);
  if (!onFallback.ok) return;
  assert.equal(onFallback.constitutionInjected, true);

  // ON 分支已自 prime：之后走 registry 真源，三态行为与后备一致。
  assert.equal(await primeExpertRegistry(), true);
  const onPrimed = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(onPrimed.ok, true);
  if (!onPrimed.ok) return;
  assert.equal(onPrimed.prompt, onFallback.prompt);

  for (const settings of [{}, { beast_mode: false }]) {
    const offPrimed = await composeDirectorDelegationPrompt(delegationInput(), settings);
    assert.equal(offPrimed.ok, true);
    if (!offPrimed.ok) return;
    assert.equal(offPrimed.constitutionInjected, false);
    assert.equal(offPrimed.prompt, base.serialized);
  }
});

test("载入失败留痕：inject 抛错 loader → prime false＋死因出口＋决策现场 additive 透传", async () => {
  __resetExpertRegistryForTest();
  try {
    // 注入会抛错的 loader：prime 如实回 false，死因可读（诚实铁律：禁静默降级）。
    const ok = await primeExpertRegistry(async () => {
      throw new Error("boom");
    });
    assert.equal(ok, false);
    const failure = getExpertRegistryLoadFailure();
    assert.equal(typeof failure, "string");
    assert.ok(failure?.includes("boom"));

    // 决策现场（野兽 ON）接住 prime 结果：失败时回传物件带 registry_load_failure 且含死因。
    const onFailed = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
    assert.equal(onFailed.ok, true);
    if (!onFailed.ok) return;
    assert.ok("registry_load_failure" in onFailed);
    assert.ok(onFailed.registry_load_failure?.includes("boom"));

    // 再注入成功 loader：prime true、死因出口清空、决策现场栏位缺席（成功时不写 undefined）。
    const okLoad = await primeExpertRegistry(async () => ({
      readBeastMode: (s: unknown) =>
        typeof s === "object" && s !== null && (s as { beast_mode?: unknown }).beast_mode === true,
    }));
    assert.equal(okLoad, true);
    assert.equal(getExpertRegistryLoadFailure(), undefined);
    const onLoaded = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
    assert.equal(onLoaded.ok, true);
    if (!onLoaded.ok) return;
    assert.equal("registry_load_failure" in onLoaded, false);
    assert.equal(onLoaded.registry_load_failure, undefined);
  } finally {
    __resetExpertRegistryForTest();
  }
});
