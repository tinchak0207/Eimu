// 诚实门禁测试（2026-09-08）：blender 产出「交付前自检」硬流程。
// 背景（eval-moe-beast/REPORT.md §2/§4）：agent 宣称「镜面立方体 metallic 1.0
// 镜面反光扫过…全部完成」，实际抽帧是哑光深灰＋构图裁顶——产出后无视觉自检，
// 话术凭空编。治本 = 自检硬流程写进 persona 提示词（blender-director-persona.ts
// DIRECTOR_SELF_CHECK_SECTION，随宪法注入）。
// 覆盖三条验收线：
//   ① persona prompt（ON）含自检硬流程关键句：亲眼看／无读图通路必须明说／
//      逐项对照委托单（材质/入框/机位）／不符如实报／「全部完成」话术闸门／
//      自检行与交付物闸门 qc 栏呼应。
//   ② ON/OFF 两态契约不破：OFF prompt = composeDelegation serialized 原文
//      一个字不多（零回归，与 blender-expert-frame.test.ts 同判准）；
//      ON = 宪法全文前缀 → 自检节 → 分隔线 → 委托单 JSON 尾随（顺序钉死）。
//   ③ 单一真源：注入文本 ≡ 导出常量 DIRECTOR_SELF_CHECK_SECTION（逐字），
//      关键句清单兜底（防常量被掏空后注入仍过）。
// 跑法：npx tsx --test src/lib/blender-honesty-gate.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIRECTOR_EXPERT_CONSTITUTION_PATH,
  DIRECTOR_SELF_CHECK_SECTION,
  composeDirectorDelegation,
  composeDirectorDelegationPrompt,
} from "./blender-director-persona";

function delegationInput() {
  return {
    effect_description: "镜面金属立方体，反光扫过表面",
    shot_count: 2,
    deliverables: ["turntable", "stills", "blend", "glb"] as const,
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

// ── ① ON：自检硬流程关键句在 prompt 里 ──────────────────────────────────────

test("ON：prompt 含自检节标题与『亲眼看』硬指令（抽 ≥2 帧/stills 逐张）", async () => {
  const r = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("交付前自检（硬流程，跳过=事故）"), "自检节标题必须在 prompt");
  assert.ok(r.prompt.includes("亲眼看"), "『亲眼看』硬指令必须在 prompt");
  assert.ok(r.prompt.includes("≥2 帧"), "抽帧下限（≥2 帧）必须钉进 prompt");
  assert.ok(r.prompt.includes("stills 逐张"), "stills 逐张通路必须在 prompt");
});

test("ON：无读图通路必须明说『无法自检，需项目负责人终验』，禁止假装看过", async () => {
  const r = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("无法自检，需项目负责人终验"));
  assert.ok(r.prompt.includes("禁止假装看过"));
});

test("ON：自检清单逐项对照委托单——材质关键词可见/主体完整入框/机位构图一致", async () => {
  const r = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("材质"), "材质关键词核对项");
  assert.ok(r.prompt.includes("镜面"), "镜面（评测事故主词）核对项");
  assert.ok(r.prompt.includes("哑光"), "哑光（评测事故实拍）核对项");
  assert.ok(r.prompt.includes("完整入框"), "主体入框核对项");
  assert.ok(r.prompt.includes("机位构图"), "机位构图核对项");
  assert.ok(r.prompt.includes("委托单"), "对照基准=委托单");
});

test("ON：不符如实报＋重渲分流＋『全部完成』话术只在自检全过后许出现", async () => {
  const r = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("自检未过"), "如实报句式必须在 prompt");
  assert.ok(r.prompt.includes("重渲"), "可修→修后重渲分流");
  assert.ok(r.prompt.includes("「全部完成」只在自检全过后才许出现"), "话术闸门原文");
});

test("ON：自检结果写进回覆（『自检：材质✓』句式）且与 qc 栏呼应", async () => {
  const r = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("自检：材质✓"), "自检行句式示例必须在 prompt");
  assert.ok(r.prompt.includes("qc"), "与交付物闸门 qc 栏呼应");
});

// ── ② ON/OFF 两态契约不破 ──────────────────────────────────────────────────

test("OFF：prompt = serialized 原文一个字不多（零回归，无宪法/自检节）", async () => {
  const base = composeDirectorDelegation(delegationInput());
  assert.equal(base.ok, true);
  if (!base.ok) return;
  for (const settings of [undefined, {}, { beast_mode: false }, { other_key: true }]) {
    const off = await composeDirectorDelegationPrompt(delegationInput(), settings);
    assert.equal(off.ok, true);
    if (!off.ok) return;
    assert.equal(off.constitutionInjected, false);
    assert.equal(off.prompt, base.serialized, "OFF prompt 必须逐字等于 serialized 原文");
    assert.ok(!off.prompt.includes("交付前自检"), "OFF 裸单不含自检节（契约真源走导出常量）");
    assert.ok(!off.prompt.includes("Expert 宪法"), "OFF 裸单不含宪法");
  }
});

test("ON：顺序钉死 = 宪法全文前缀 → 自检节 → 分隔线 → 委托单 JSON 尾随", async () => {
  const constitution = readConstitution();
  const base = composeDirectorDelegation(delegationInput());
  assert.equal(base.ok, true);
  if (!base.ok) return;
  const on = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(on.ok, true);
  if (!on.ok) return;
  assert.equal(on.constitutionInjected, true);
  // 头部仍是宪法全文（前缀契约不破）。
  assert.ok(on.prompt.startsWith(constitution.trimEnd()), "prompt 必须以宪法全文开头");
  // 宪法结束 → 自检节 → 分隔线 → serialized 尾随。
  const afterConstitution = on.prompt.slice(constitution.trimEnd().length);
  assert.ok(
    afterConstitution.startsWith(`\n\n${DIRECTOR_SELF_CHECK_SECTION}\n\n---\n\n`),
    "自检节必须紧随宪法且以分隔线与委托单 JSON 相隔",
  );
  assert.ok(on.prompt.endsWith(base.serialized), "原委托单 JSON 必须完整尾随");
  // 自检节在分隔线之前、serialized 之后不重复出现。
  assert.equal(
    on.prompt.indexOf(DIRECTOR_SELF_CHECK_SECTION),
    on.prompt.lastIndexOf(DIRECTOR_SELF_CHECK_SECTION),
    "自检节只注入一次",
  );
});

test("ON：自检节并入不改 estimated_tokens 口径（= estimateTokens(prompt)）", async () => {
  const { estimateTokens } = await import("./blender-delegate");
  const on = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(on.ok, true);
  if (!on.ok) return;
  assert.equal(on.estimated_tokens, estimateTokens(on.prompt), "token 估算随注入文本同步增长");
  const off = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: false });
  assert.equal(off.ok, true);
  if (!off.ok) return;
  assert.ok(on.estimated_tokens > off.estimated_tokens, "ON（宪法+自检）预算必须大于 OFF 裸单");
});

// ── ③ 单一真源：导出常量 ≡ 注入文本，关键句兜底 ──────────────────────────────

test("自检节导出常量非空且含全部关键句（防掏空：注入过≠句还在）", () => {
  assert.ok(DIRECTOR_SELF_CHECK_SECTION.length > 100);
  for (const key of [
    "交付前自检（硬流程，跳过=事故）",
    "亲眼看",
    "≥2 帧",
    "无法自检，需项目负责人终验",
    "禁止假装看过",
    "材质",
    "完整入框",
    "机位构图",
    "自检未过",
    "「全部完成」只在自检全过后才许出现",
    "自检：材质✓ 构图✓ 机位✓",
  ]) {
    assert.ok(DIRECTOR_SELF_CHECK_SECTION.includes(key), `自检节缺关键句：${key}`);
  }
});

test("自检节常量与宪法档同置于 repo 真源位（宪法档可读，注入路径健康）", () => {
  const constitution = readConstitution();
  assert.ok(constitution.includes("Expert 宪法"), "宪法档真源在位（自检节的注入宿主）");
});
