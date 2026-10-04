/**
 * 剪辑域 Agent 能力面活化 验收测试（2026-09-27）。
 *
 * 跑法：npx --yes tsx --test src/lib/editor-timeline-activation.test.ts
 *
 * 本片三刀（全部在「让现有 timeline 工具被真调用」，不造新工具；禁新增第 11 个
 * timeline_* id，已有 10 件）：
 *   刀1 配方库：skills/editor/ 落库 + persona skillPaths 指真实路径。
 *   刀2 闸门：成片交付与 timeline 工具回执绑死——机器层 = collect 闸门（缺 qc
 *            回执直接判 missing_deliverables）+ 契约检查器（required_fields）；
 *            纪律层 = 委派 prompt 的质检闸硬规则。
 *   刀3 默认注入：persona toolIds 覆盖十件套 + skillPaths 进 Expert 注册表摘要
 *            （buildExpertLine，beast ON 时进 Orchestrator 主 prompt）。
 *
 * 断言口径（守门件不是 oracle 铁律）：
 *   - 真行为断言：呼叫实际函数看输入→输出（collect 闸门、validateExpertDeliverable、
 *     checkJsonOutput、buildExpertLine、assembleEditorPrompt），非扫源码字串。
 *   - 档案存在性（fs）为档案系统 oracle（配方落盘的客观事实）；配方**内容**提及
 *     工具名只算「路由声明探针」，不是能力已验的 oracle（执行链在 VPS）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

import {
  EDITOR_DELIVERABLES,
  EDITOR_TIMELINE_KIND,
  assembleEditorPrompt,
  collectEditorDeliverableFromToolResult,
  composeEditorDelegation,
  type EditorToolResult,
} from "./editor-delegate.ts";
import {
  EDITOR_PERSONA_ID,
  EDITOR_PERSONA_SKILL_PATHS,
  EDITOR_PERSONA_TOOL_IDS,
} from "./editor-persona.ts";
import { computeQcSignature, validateExpertDeliverable } from "./expert-contract.ts";
import { HARNESS_TOOL_IDS } from "./harness-tool-registry.ts";
import { EXPERT_REGISTRY } from "./expert-registry.ts";
import { EXPERT_LINE_SKILL_PATHS_UNCONFIGURED, buildExpertLine, buildExpertRegistryDigest } from "./orchestrator-beast-frame.ts";
import { getContract } from "./agent-prompt-contracts.ts";
import { checkJsonOutput } from "./agent-prompt-contract-check.ts";

// ── 域真源：剪辑域十件套（harness-tool-registry 已登记的既有 id，禁新增） ─────

const TIMELINE_DOMAIN_TOOL_IDS = [
  "timeline_lint",
  "timeline_master",
  "timeline_mix",
  "timeline_ops",
  "timeline_query",
  "timeline_restore",
  "timeline_rhythm",
  "timeline_style",
  "editing_manifest",
  "audio_first_timeline",
] as const;

/** 每份配方的工具链（路由声明探针：内容须点名链上工具）。 */
const RECIPE_TOOL_CHAIN: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["skills/editor/SKILL.md", TIMELINE_DOMAIN_TOOL_IDS],
  ["skills/editor/assembly/SKILL.md", ["video_upload", "editing_manifest", "timeline_query", "timeline_ops", "timeline_restore"]],
  ["skills/editor/audio-first/SKILL.md", ["audio_first_timeline", "timeline_ops", "timeline_lint"]],
  ["skills/editor/rhythm/SKILL.md", ["timeline_query", "timeline_rhythm", "timeline_ops"]],
  ["skills/editor/look/SKILL.md", ["timeline_style", "timeline_lint"]],
  ["skills/editor/mix/SKILL.md", ["timeline_mix", "timeline_lint"]],
  ["skills/editor/qc-master/SKILL.md", ["timeline_lint", "timeline_master"]],
];

const VALID_INPUT = {
  source_clips: ["canvas-node-01 开场空镜", "canvas-node-02 产品特写"],
  timeline_ops: ["卡点剪切", "转场叠化 0.5s"],
  duration_hint: 45,
  deliverables: ["timeline_ops", "duration_sec", "qc"],
} as const;

const TASK_CONTRACT = {
  expertId: "editor" as const,
  intent: "45 秒产品口播成片",
  materials: ["canvas-node-01"],
  acceptance: ["成片可导出", "时长口径如实标注"],
};

const CTX = (() => {
  const composed = composeEditorDelegation(VALID_INPUT);
  if (!composed.ok) throw new Error(`夹具委托单非法：${composed.hint}`);
  return { delegation: composed.delegation, contract: TASK_CONTRACT };
})();

/** 完整且 qc 通过的真实工具回执（timeline_master 导出成功形）。 */
function passingToolResult(): EditorToolResult {
  return {
    title: "成片导出完成",
    output: JSON.stringify({
      ok: true,
      url: "https://gw.example.test/agent/v1/timeline/final-1.mp4",
      timeline_ops_echo: ["trim clip3 0-3.2", "crossfade 0.5", "loudnorm I=-16"],
      duration_seconds: 45,
      qc: "lint must 0/should 2; master gate 14/14 pass",
      video_bytes: 21_000_000,
    }),
  };
}

// ── 刀1：配方库落库（档案系统 oracle + 路由声明探针） ─────────────────────────

test("刀1：skills/editor/ 七份配方全部落盘，且 persona skillPaths 逐条指向真实档案", () => {
  assert.ok(EDITOR_PERSONA_SKILL_PATHS.length > 0, "配方库落库后 skillPaths 不得为空");
  assert.deepEqual(
    [...EDITOR_PERSONA_SKILL_PATHS],
    RECIPE_TOOL_CHAIN.map(([p]) => p),
    "persona skillPaths 必须逐条等于已落库的配方档（禁幻影路径）",
  );
  for (const p of EDITOR_PERSONA_SKILL_PATHS) {
    const abs = nodePath.resolve(process.cwd(), p);
    assert.ok(existsSync(abs), `配方档不存在（幻影路径禁入 skillPaths）：${p}`);
    assert.ok(readFileSync(abs, "utf8").trim().length > 200, `配方档内容为空/过短：${p}`);
  }
});

test("刀1：每份配方 frontmatter 有 name/description（可被 skill 索引收录），且点名其工具链", () => {
  for (const [p, tools] of RECIPE_TOOL_CHAIN) {
    const body = readFileSync(nodePath.resolve(process.cwd(), p), "utf8");
    // 2026-09-27 修：原本的 /---\n([\s\S]*?)\n---/.exec(body.slice(0, 800)) 允许
    // frontmatter 前有前置注解（HTML 注解块），是假阳性破口——VPS opencode 1.18.14
    // 实测只解析 byte 0 的 frontmatter，前置注解者静默不进索引。
    // 此处改为 byte 0 锚定；repo 级全量扫描见 skill-frontmatter-indexability.test.ts。
    assert.ok(
      body.startsWith("---\n"),
      `${p} frontmatter 未在 byte 0（前置注解＝opencode 静默不收录）`,
    );
    const fm = /^---\n([\s\S]*?)\n---/.exec(body);
    assert.ok(fm, `${p} 缺 frontmatter（skill 索引收录面）`);
    assert.match(fm[1], /^name:\s*\S+/m, `${p} frontmatter 缺 name`);
    assert.match(fm[1], /^description:\s*\S+/m, `${p} frontmatter 缺 description`);
    for (const tool of tools) {
      assert.ok(body.includes(tool), `${p} 未点名工具「${tool}」（路由声明探针，非能力 oracle）`);
    }
  }
});

test("刀1：timeline_lint 在域根与 qc-master 配方中被写成闸门（未过不得交付），不是可选项", () => {
  for (const p of ["skills/editor/SKILL.md", "skills/editor/qc-master/SKILL.md"]) {
    const body = readFileSync(nodePath.resolve(process.cwd(), p), "utf8");
    assert.ok(body.includes("timeline_lint"), `${p} 未点名 lint`);
    assert.ok(body.includes("闸门") || body.includes("闸门"), `${p} 未把 lint 写成闸门`);
    assert.ok(body.includes("未清不得交付"), `${p} 缺「must 未清不得交付」闸门语义`);
  }
});

// ── 刀2：闸门（机器层真行为：缺栏被拒 / 完整放行） ───────────────────────────

test("刀2 机器层：完整工具回执（qc 通过）→ collect 放行且全闸过（payload 三栏全形）", () => {
  const r = collectEditorDeliverableFromToolResult(passingToolResult(), CTX);
  assert.ok(r.ok, r.ok ? "" : r.hint);
  if (!r.ok) return;
  assert.equal(r.deliverable.expertId, EDITOR_PERSONA_ID);
  assert.equal(r.deliverable.kind, EDITOR_TIMELINE_KIND);
  for (const field of EDITOR_DELIVERABLES) {
    assert.ok(field in r.deliverable.payload, `payload 缺栏 ${field}`);
  }
  assert.equal(r.deliverable.payload.duration_sec, 45);
  assert.match(String(r.deliverable.payload.qc), /verdict=lint must 0\/should 2; master gate 14\/14 pass/);
  assert.deepEqual(validateExpertDeliverable(r.deliverable), { ok: true, errors: [] });
});

test("刀2 机器层：回执缺 qc → 闸门拒（missing_deliverables，成片 URL 有了也不算交付）", () => {
  const noQc = collectEditorDeliverableFromToolResult(
    {
      title: "成片导出完成但无质检结论",
      output: JSON.stringify({
        ok: true,
        url: "https://gw.example.test/agent/v1/timeline/final-2.mp4",
        duration_seconds: 45,
        timeline_ops_echo: ["trim clip3"],
      }),
    },
    CTX,
  );
  assert.equal(noQc.ok, false);
  if (!noQc.ok) {
    assert.equal(noQc.code, "missing_deliverables");
    assert.ok(noQc.missing.some((m) => m.includes("qc")), "缺栏清单须点名 qc");
  }
});

test("刀2 机器层：qc 为空串 / 空白 → 同样拒（非空判定，不许用空串占位）", () => {
  for (const emptyQc of ["", "   "]) {
    const r = collectEditorDeliverableFromToolResult(
      {
        title: "空 qc 占位",
        output: JSON.stringify({
          ok: true,
          url: "https://gw.example.test/agent/v1/timeline/final-3.mp4",
          duration_seconds: 45,
          qc: emptyQc,
        }),
      },
      CTX,
    );
    assert.equal(r.ok, false, `qc=${JSON.stringify(emptyQc)} 必须拒`);
    if (!r.ok) assert.equal(r.code, "missing_deliverables");
  }
});

test("刀2 机器层：非工具回执（ok:false / 非 JSON）→ no_output（禁手拼交付物绕过工具）", () => {
  const failed = collectEditorDeliverableFromToolResult(
    { title: "导出失败", output: JSON.stringify({ ok: false, error: { code: "master_gate_rejected", hint: "av_mismatch must" } }) },
    CTX,
  );
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, "no_output");

  const handWritten = collectEditorDeliverableFromToolResult(
    { title: "手写", output: JSON.stringify({ url: "https://x/y.mp4", duration_seconds: 45, qc: "自评通过" }) },
    CTX,
  );
  assert.equal(handWritten.ok, false, "无 ok:true 的手拼回执必须拒");
  if (!handWritten.ok) assert.equal(handWritten.code, "no_output");
});

test("刀2 机器层（契约检查器）：editor 回执文本缺 qc → required_fields 违规；完整 → 零违规", () => {
  const contract = getContract(EDITOR_PERSONA_ID);
  assert.ok(contract, "editor 必须有提示词契约（agent-prompt-contracts）");
  if (!contract) return;
  assert.equal(contract.outputMode, "json");

  const incomplete = JSON.stringify({ ok: true, url: "https://gw/x.mp4", duration_seconds: 45 });
  const bad = checkJsonOutput(incomplete, contract);
  assert.ok(
    bad.some((v) => v.rule === "required_fields" && v.detail.includes("qc")),
    "缺 qc 的回执必须被契约检查器判 required_fields 违规",
  );

  const complete = JSON.stringify({ ok: true, url: "https://gw/x.mp4", duration_seconds: 45, qc: "lint must 0; master 14/14" });
  assert.deepEqual(checkJsonOutput(complete, contract), [], "完整回执零违规（放行）");
});

// ── 刀2：纪律层（委派 prompt 硬规则，真函数输出） ────────────────────────────

test("刀2 纪律层：委派 prompt 带质检闸硬规则（timeline_lint / timeline_master / qc 未过视为未交付）", () => {
  const composed = composeEditorDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleEditorPrompt(composed.delegation, { beastMode: false });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("硬规则（质检闸，未过不得交付）"), "缺质检闸硬规则段");
  assert.ok(r.prompt.includes("timeline_lint"), "硬规则必须点名 timeline_lint");
  assert.ok(r.prompt.includes("timeline_master"), "硬规则必须点名 timeline_master");
  assert.ok(r.prompt.includes("qc 缺失或未过 lint 视为未交付"), "硬规则必须写死 qc 闸语义");
  // OFF 仍不得出现宪法文本（零回归：纪律段不等于宪法注入）
  assert.equal(r.prompt.includes("Expert 宪法"), false);
  assert.equal(r.prompt.includes("以下五条是硬约束"), false);
});

// ── 刀3：默认注入（工具白名单覆盖十件套 + skillPaths 进注入面） ───────────────

test("刀3：EDITOR_PERSONA_TOOL_IDS 完整覆盖剪辑域十件套，且全部在 harness 真源登记（防幻影）", () => {
  const persona = new Set<string>(EDITOR_PERSONA_TOOL_IDS);
  assert.equal(persona.size, EDITOR_PERSONA_TOOL_IDS.length, "persona 工具白名单不得有重复 id");
  const covered = TIMELINE_DOMAIN_TOOL_IDS.filter((id) => persona.has(id));
  assert.deepEqual(
    covered,
    [...TIMELINE_DOMAIN_TOOL_IDS],
    `十件套覆盖不全：缺 ${TIMELINE_DOMAIN_TOOL_IDS.filter((id) => !persona.has(id)).join("、")}`,
  );
  for (const id of EDITOR_PERSONA_TOOL_IDS) {
    assert.ok(HARNESS_TOOL_IDS.has(id), `persona 工具 id「${id}」不在 harness-tool-registry 真源集（幻影工具）`);
  }
  // 剪辑域十件套不得新增第 11 个 timeline_* id（硬禁令）
  const timelineStar = EDITOR_PERSONA_TOOL_IDS.filter((id) => id.startsWith("timeline_"));
  assert.equal(timelineStar.length, 8, `timeline_* 应为既有八件套，实为 ${timelineStar.length}`);
});

test("刀3：skillPaths 进 Expert 注册表摘要（buildExpertLine）——beast ON 默认注入，不再标「未配置」", () => {
  const editor = EXPERT_REGISTRY["editor"];
  assert.ok(editor, "registry 必须有 editor 行");
  if (!editor) return;
  assert.deepEqual([...editor.skillPaths], [...EDITOR_PERSONA_SKILL_PATHS], "registry 行与 persona 常量同源");

  const line = buildExpertLine(editor);
  assert.equal(line.includes(EXPERT_LINE_SKILL_PATHS_UNCONFIGURED), false, "配方库已配置，不得再标未配置");
  for (const p of EDITOR_PERSONA_SKILL_PATHS) {
    assert.ok(line.includes(p), `注入行缺配方路径：${p}`);
  }
  // 注入面真行为：注册表摘要确实带 editor 行与其配方库
  const digest = buildExpertRegistryDigest();
  assert.ok(digest.includes("editor"), "摘要缺 editor 行");
  assert.ok(digest.includes("skills/editor/SKILL.md"), "摘要缺剪辑域配方库路径（默认注入面）");
  for (const id of TIMELINE_DOMAIN_TOOL_IDS) {
    assert.ok(line.includes(id), `注入行缺剪辑域工具 id：${id}`);
  }
});

test("刀3：交付契约（三栏）与 QC 签名口径自洽（editor 行 requiredFields = EDITOR_DELIVERABLES）", () => {
  const editor = EXPERT_REGISTRY["editor"];
  assert.ok(editor);
  if (!editor) return;
  assert.deepEqual([...editor.deliverableContract.requiredFields], [...EDITOR_DELIVERABLES]);
  assert.equal(editor.deliverableContract.qcSignatureRequired, true);

  const r = collectEditorDeliverableFromToolResult(passingToolResult(), CTX);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(
    r.deliverable.qcSignature,
    computeQcSignature({
      expertId: EDITOR_PERSONA_ID,
      kind: EDITOR_TIMELINE_KIND,
      payload: r.deliverable.payload,
      evidence: r.deliverable.evidence,
      contract: TASK_CONTRACT,
    }),
  );
});
