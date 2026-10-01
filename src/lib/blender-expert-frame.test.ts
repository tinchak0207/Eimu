// MOE Wave1-A 框架接線測試：3D 導演（proto-Expert）掛 Expert 框架。
// 覆蓋三條驗收線：
//   ① OFF 零回歸：assembleDirectorReply（settings 缺省/false/非布林）回覆
//      鍵集合與 scene_op/scene_summary 與現狀逐欄位一致；委託單 prompt =
//      composeDelegation serialized 原文一個字不多。
//   ② ON 憲法注入 + 交付物契約：prompt 頭部 = expert-constitution.md 全文；
//      deliverable 過 validateExpertDeliverable；篡改簽名被拒；
//      契約摘要行（expertId/kind/簽名前 8 位）附在 scene_summary 且不超帽。
//   ③ readBeastMode 三態（缺/false/true）經 settings 入口驅動野獸分支；
//      未 prime → 內聯後備判準、prime 後 → registry 真源，兩路行為一致。
// 跑法（package.json 既有 node:test 範式；主 tsconfig exclude *.test.ts）：
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
    scene_summary: "低多邊形山丘場景，三點打光",
    stdout_tail: "RENDER_DONE: turntable",
    duration_ms: 3_700,
  };
}

function delegationInput() {
  return {
    effect_description: "主角站在懸崖邊，風吹披風",
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

// ── ① OFF 零回歸（回覆形與現狀逐欄位一致） ───────────────────────────────────

test("OFF（settings 缺省）：回覆鍵集合 = ok/scene_op/scene_summary，無 deliverable", () => {
  const reply = assembleDirectorReply(executeResult(), { title: "懸崖場景" });
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.deepEqual(Object.keys(reply).sort(), ["ok", "scene_op", "scene_summary"]);
  assert.equal(reply.deliverable, undefined);
  assert.equal(reply.scene_op.type, "add_node");
  assert.equal(reply.scene_op.node.type, "scene_3d");
  assert.equal(reply.scene_op.node.title, "懸崖場景");
  assert.ok(reply.scene_op.node.metadata.sceneCard.turntable_url.endsWith("turntable.mp4"));
  assert.equal(reply.scene_summary, "低多邊形山丘場景，三點打光");
});

test("OFF（beast_mode=false / 非布林 / settings 非物件）：同現狀形", () => {
  const settingsCases: unknown[] = [
    { beast_mode: false },
    { beast_mode: "yes" },
    { beast_mode: 1 },
    {},
    null,
    "on",
  ];
  for (const settings of settingsCases) {
    const reply = assembleDirectorReply(executeResult(), { title: "懸崖場景" }, { settings });
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    assert.deepEqual(Object.keys(reply).sort(), ["ok", "scene_op", "scene_summary"]);
    assert.equal(reply.deliverable, undefined);
    assert.equal(reply.scene_summary, "低多邊形山丘場景，三點打光");
  }
});

test("OFF：委託單 prompt = composeDelegation serialized 原文（一個字不多）", async () => {
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

test("OFF：摘要過長也不截斷（截斷只屬於 ON 契約路徑，現狀零回歸）", () => {
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

// ── ② ON：憲法注入 + 交付物契約 + 摘要行 ────────────────────────────────────

test("ON：prompt 頭部 = 憲法全文（trimEnd 後逐字前綴），原委託單 JSON 尾隨", async () => {
  const constitution = readConstitution();
  assert.ok(constitution.includes("Expert 憲法"), "憲法檔真源在位");
  const base = composeDirectorDelegation(delegationInput());
  assert.equal(base.ok, true);
  if (!base.ok) return;
  const on = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(on.ok, true);
  if (!on.ok) return;
  assert.equal(on.constitutionInjected, true);
  assert.ok(on.prompt.startsWith(constitution.trimEnd()), "prompt 必須以憲法全文開頭");
  const tail = on.prompt.slice(on.prompt.lastIndexOf("\n") + 1);
  assert.equal(tail, base.serialized);
  assert.ok(on.prompt.includes("---"));
});

test("ON：組裝回覆附 deliverable，validateExpertDeliverable 通過、payload=sceneCard 六欄", () => {
  const reply = assembleDirectorReply(
    executeResult(),
    { title: "懸崖場景" },
    { settings: { beast_mode: true } },
  );
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.ok(reply.deliverable, "ON 時必附 deliverable");
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
  assert.equal(d.contract.intent, "懸崖場景");
  const gate = validateExpertDeliverable(d);
  assert.equal(gate.ok, true, `閘門必過：${gate.errors.join("；")}`);
});

test("ON：scene_summary 附契約摘要行（expertId/kind/簽名前 8 位）且總長不超帽", () => {
  const reply = assembleDirectorReply(
    executeResult(),
    { title: "懸崖場景" },
    { settings: { beast_mode: true } },
  );
  assert.equal(reply.ok, true);
  if (!reply.ok || !reply.deliverable) return;
  assert.ok(reply.scene_summary.startsWith("低多邊形山丘場景，三點打光"));
  const line = reply.scene_summary.split("\n")[1];
  assert.match(line, /^deliverable expertId=director3d kind=scene_3d qc=[0-9a-f]{8}$/);
  assert.ok(
    line.includes(reply.deliverable.qcSignature.slice(0, 8)),
    "摘要行攜帶簽名前 8 位",
  );
  assert.ok(estimateTokens(reply.scene_summary) <= DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);
});

test("ON：摘要過長時契約行保留、總長壓回帽內（帽強制只在 ON 生效）", () => {
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
    "契約行完整保留在尾部",
  );
  assert.ok(estimateTokens(reply.scene_summary) <= DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);
});

test("ON：篡改簽名被 validateExpertDeliverable 拒（閘門可檢篡改）", () => {
  const reply = assembleDirectorReply(
    executeResult(),
    { title: "懸崖場景" },
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
  // 另案：payload 被改 → 重算簽名不一致
  const tamperedPayload = {
    ...reply.deliverable,
    payload: { ...reply.deliverable.payload, evil: true },
  };
  assert.equal(validateExpertDeliverable(tamperedPayload).ok, false);
  // 另案：computeQcSignature 重算 = 原簽名（簽名口徑閉環）
  const { qcSignature, ...rest } = reply.deliverable;
  assert.equal(qcSignature, computeQcSignature(rest));
});

test("ON：delegation.materials 回指（reference_refs 進契約 materials）", () => {
  const reply = assembleDirectorReply(
    executeResult(),
    { title: "懸崖場景" },
    {
      settings: { beast_mode: true },
      delegation: {
        effect_description: "主角站在懸崖邊，風吹披風",
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

test("ON：無 title 時 contract.intent 退回 scene_summary", () => {
  const reply = assembleDirectorReply(executeResult(), {}, { settings: { beast_mode: true } });
  assert.equal(reply.ok, true);
  if (!reply.ok || !reply.deliverable) return;
  assert.equal(reply.deliverable.contract.intent, "低多邊形山丘場景，三點打光");
});

test("ON：委託單校驗不過 = 結構化錯誤透傳（不走注入路徑）", async () => {
  const r = await composeDirectorDelegationPrompt(
    { effect_description: "缺 deliverables 與 shot_count" },
    { beast_mode: true },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "invalid_delegation");
  assert.ok(r.hint.includes("必填"));
});

test("ON + 憲法檔缺失：constitution_unavailable 結構化報錯（不靜默裸奔派單）", async () => {
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

// ── ③ readBeastMode 三態 + registry 讀取路徑（內聯後備 ↔ 動態 import 真源） ──

test("讀取路徑：未 prime → 內聯後備判準；prime 後 → registry 真源，注入結果逐字一致", async () => {
  __resetExpertRegistryForTest();
  const base = composeDirectorDelegation(delegationInput());
  assert.equal(base.ok, true);
  if (!base.ok) return;

  // 未 prime：readBeastModeSync 走內聯後備（判準 = beast_mode === true 嚴格）。
  const onFallback = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(onFallback.ok, true);
  if (!onFallback.ok) return;
  assert.equal(onFallback.constitutionInjected, true);

  // ON 分支已自 prime：之後走 registry 真源，三態行為與後備一致。
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

test("載入失敗留痕：inject 拋錯 loader → prime false＋死因出口＋決策現場 additive 透傳", async () => {
  __resetExpertRegistryForTest();
  try {
    // 注入會拋錯的 loader：prime 如實回 false，死因可讀（誠實鐵律：禁靜默降級）。
    const ok = await primeExpertRegistry(async () => {
      throw new Error("boom");
    });
    assert.equal(ok, false);
    const failure = getExpertRegistryLoadFailure();
    assert.equal(typeof failure, "string");
    assert.ok(failure?.includes("boom"));

    // 決策現場（野獸 ON）接住 prime 結果：失敗時回傳物件帶 registry_load_failure 且含死因。
    const onFailed = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
    assert.equal(onFailed.ok, true);
    if (!onFailed.ok) return;
    assert.ok("registry_load_failure" in onFailed);
    assert.ok(onFailed.registry_load_failure?.includes("boom"));

    // 再注入成功 loader：prime true、死因出口清空、決策現場欄位缺席（成功時不寫 undefined）。
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
