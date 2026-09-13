// 誠實門禁測試（2026-09-08）：blender 產出「交付前自檢」硬流程。
// 背景（eval-moe-beast/REPORT.md §2/§4）：agent 宣稱「鏡面立方體 metallic 1.0
// 鏡面反光掃過…全部完成」，實際抽幀是啞光深灰＋構圖裁頂——產出後無視覺自檢，
// 話術憑空編。治本 = 自檢硬流程寫進 persona 提示詞（blender-director-persona.ts
// DIRECTOR_SELF_CHECK_SECTION，隨憲法注入）。
// 覆蓋三條驗收線：
//   ① persona prompt（ON）含自檢硬流程關鍵句：親眼看／無讀圖通路必須明說／
//      逐項對照委託單（材質/入框/機位）／不符如實報／「全部完成」話術閘門／
//      自檢行與交付物閘門 qc 欄呼應。
//   ② ON/OFF 兩態契約不破：OFF prompt = composeDelegation serialized 原文
//      一個字不多（零回歸，與 blender-expert-frame.test.ts 同判準）；
//      ON = 憲法全文前綴 → 自檢節 → 分隔線 → 委託單 JSON 尾隨（順序釘死）。
//   ③ 單一真源：注入文本 ≡ 導出常量 DIRECTOR_SELF_CHECK_SECTION（逐字），
//      關鍵句清單兜底（防常量被掏空後注入仍過）。
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

// ── ① ON：自檢硬流程關鍵句在 prompt 裡 ──────────────────────────────────────

test("ON：prompt 含自檢節標題與『親眼看』硬指令（抽 ≥2 幀/stills 逐張）", async () => {
  const r = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("交付前自檢（硬流程，跳過=事故）"), "自檢節標題必須在 prompt");
  assert.ok(r.prompt.includes("親眼看"), "『親眼看』硬指令必須在 prompt");
  assert.ok(r.prompt.includes("≥2 幀"), "抽幀下限（≥2 幀）必須釘進 prompt");
  assert.ok(r.prompt.includes("stills 逐張"), "stills 逐張通路必須在 prompt");
});

test("ON：無讀圖通路必須明說『無法自檢，需暴君終驗』，禁止假裝看過", async () => {
  const r = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("無法自檢，需暴君終驗"));
  assert.ok(r.prompt.includes("禁止假裝看過"));
});

test("ON：自檢清單逐項對照委託單——材質關鍵詞可見/主體完整入框/機位構圖一致", async () => {
  const r = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("材質"), "材質關鍵詞核對項");
  assert.ok(r.prompt.includes("鏡面"), "鏡面（評測事故主詞）核對項");
  assert.ok(r.prompt.includes("啞光"), "啞光（評測事故實拍）核對項");
  assert.ok(r.prompt.includes("完整入框"), "主體入框核對項");
  assert.ok(r.prompt.includes("機位構圖"), "機位構圖核對項");
  assert.ok(r.prompt.includes("委託單"), "對照基準=委託單");
});

test("ON：不符如實報＋重渲分流＋『全部完成』話術只在自檢全過後許出現", async () => {
  const r = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("自檢未過"), "如實報句式必須在 prompt");
  assert.ok(r.prompt.includes("重渲"), "可修→修後重渲分流");
  assert.ok(r.prompt.includes("「全部完成」只在自檢全過後才許出現"), "話術閘門原文");
});

test("ON：自檢結果寫進回覆（『自檢：材質✓』句式）且與 qc 欄呼應", async () => {
  const r = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("自檢：材質✓"), "自檢行句式示例必須在 prompt");
  assert.ok(r.prompt.includes("qc"), "與交付物閘門 qc 欄呼應");
});

// ── ② ON/OFF 兩態契約不破 ──────────────────────────────────────────────────

test("OFF：prompt = serialized 原文一個字不多（零回歸，無憲法/自檢節）", async () => {
  const base = composeDirectorDelegation(delegationInput());
  assert.equal(base.ok, true);
  if (!base.ok) return;
  for (const settings of [undefined, {}, { beast_mode: false }, { other_key: true }]) {
    const off = await composeDirectorDelegationPrompt(delegationInput(), settings);
    assert.equal(off.ok, true);
    if (!off.ok) return;
    assert.equal(off.constitutionInjected, false);
    assert.equal(off.prompt, base.serialized, "OFF prompt 必須逐字等於 serialized 原文");
    assert.ok(!off.prompt.includes("交付前自檢"), "OFF 裸單不含自檢節（契約真源走導出常量）");
    assert.ok(!off.prompt.includes("Expert 憲法"), "OFF 裸單不含憲法");
  }
});

test("ON：順序釘死 = 憲法全文前綴 → 自檢節 → 分隔線 → 委託單 JSON 尾隨", async () => {
  const constitution = readConstitution();
  const base = composeDirectorDelegation(delegationInput());
  assert.equal(base.ok, true);
  if (!base.ok) return;
  const on = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(on.ok, true);
  if (!on.ok) return;
  assert.equal(on.constitutionInjected, true);
  // 頭部仍是憲法全文（前綴契約不破）。
  assert.ok(on.prompt.startsWith(constitution.trimEnd()), "prompt 必須以憲法全文開頭");
  // 憲法結束 → 自檢節 → 分隔線 → serialized 尾隨。
  const afterConstitution = on.prompt.slice(constitution.trimEnd().length);
  assert.ok(
    afterConstitution.startsWith(`\n\n${DIRECTOR_SELF_CHECK_SECTION}\n\n---\n\n`),
    "自檢節必須緊隨憲法且以分隔線與委託單 JSON 相隔",
  );
  assert.ok(on.prompt.endsWith(base.serialized), "原委託單 JSON 必須完整尾隨");
  // 自檢節在分隔線之前、serialized 之後不重複出現。
  assert.equal(
    on.prompt.indexOf(DIRECTOR_SELF_CHECK_SECTION),
    on.prompt.lastIndexOf(DIRECTOR_SELF_CHECK_SECTION),
    "自檢節只注入一次",
  );
});

test("ON：自檢節併入不改 estimated_tokens 口徑（= estimateTokens(prompt)）", async () => {
  const { estimateTokens } = await import("./blender-delegate");
  const on = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: true });
  assert.equal(on.ok, true);
  if (!on.ok) return;
  assert.equal(on.estimated_tokens, estimateTokens(on.prompt), "token 估算隨注入文本同步增長");
  const off = await composeDirectorDelegationPrompt(delegationInput(), { beast_mode: false });
  assert.equal(off.ok, true);
  if (!off.ok) return;
  assert.ok(on.estimated_tokens > off.estimated_tokens, "ON（憲法+自檢）預算必須大於 OFF 裸單");
});

// ── ③ 單一真源：導出常量 ≡ 注入文本，關鍵句兜底 ──────────────────────────────

test("自檢節導出常量非空且含全部關鍵句（防掏空：注入過≠句還在）", () => {
  assert.ok(DIRECTOR_SELF_CHECK_SECTION.length > 100);
  for (const key of [
    "交付前自檢（硬流程，跳過=事故）",
    "親眼看",
    "≥2 幀",
    "無法自檢，需暴君終驗",
    "禁止假裝看過",
    "材質",
    "完整入框",
    "機位構圖",
    "自檢未過",
    "「全部完成」只在自檢全過後才許出現",
    "自檢：材質✓ 構圖✓ 機位✓",
  ]) {
    assert.ok(DIRECTOR_SELF_CHECK_SECTION.includes(key), `自檢節缺關鍵句：${key}`);
  }
});

test("自檢節常量與憲法檔同置於 repo 真源位（憲法檔可讀，注入路徑健康）", () => {
  const constitution = readConstitution();
  assert.ok(constitution.includes("Expert 憲法"), "憲法檔真源在位（自檢節的注入宿主）");
});
