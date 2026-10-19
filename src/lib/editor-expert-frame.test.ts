/**
 * 剪辑师 Expert 框架测试（MOE 改革 Wave2b 剪辑师域，2026-09-08）。
 * 跑法（package.json 现有 test 跑法定向执行本档）：
 *   npx --yes tsx --test src/lib/editor-expert-frame.test.ts
 *
 * 覆盖：
 *   1. persona 形状：id/label/工具白名单逐 id 对照 harness-tool-registry 真源
 *      （防幻影工具；11 id 行号考古 2026-09-08：timeline_lint L90/timeline_master
 *      L91/timeline_mix L92/timeline_ops L93/timeline_query L94/timeline_restore
 *      L95/timeline_rhythm L96/timeline_style L97/editing_manifest L70/
 *      audio_first_timeline L150/video_upload L100）+ 回复 token 帽
 *      ※ 2026-09-28：本组行号只为考古记录（本档只做 id 白名单断言，不断言行号）；
 *        当天 registry 档头注记 +10 行、新增 4 支影片工具，现场行号以
 *        harness-tool-registry.ts 为准（timeline_* →100~107 / editing_manifest 80 /
 *        video_upload 117 / audio_first_timeline 167）。
 *   2. composeEditorDelegation：白名单收敛/未知键丢弃/时长秒取整/边界结构化报错
 *   3. OFF：委派 prompt 不含宪法文本；ON：宪法经 loadConstitution DI 注入头部
 *      （样本串，不读真档）；载入失败 constitution_unavailable 拒绝裸奔
 *   4. collectEditorDeliverable：三栏 payload 全形 + computeQcSignature 形状
 *      断言（Wave2 收口翻正："editor" 已在 ExpertId 联合内，
 *      validateExpertDeliverable 全闸直用）
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as nodePath from "node:path";

import {
  EXPERT_CONSTITUTION_PATH,
  EDITOR_DELIVERABLES,
  EDITOR_TIMELINE_KIND,
  assembleEditorPrompt,
  collectEditorDeliverableFromToolResult,
  composeEditorDelegation,
  type EditorToolResult,
} from "./editor-delegate.ts";
import { readBeastMode } from "./expert-registry.ts";
import { computeQcSignature, validateExpertDeliverable } from "./expert-contract.ts";
import { composeVideoDelegation } from "./video-delegate.ts";
import { HARNESS_TOOL_IDS } from "./harness-tool-registry.ts";
import {
  assembleEditorReply,
  EDITOR_PERSONA_ID,
  EDITOR_PERSONA_LABEL,
  EDITOR_PERSONA_SKILL_PATHS,
  EDITOR_PERSONA_TOOL_IDS,
  EDITOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./editor-persona.ts";

// ── 共用夹具 ─────────────────────────────────────────────────────────────────

const VALID_INPUT = {
  source_clips: ["canvas-node-01 开场空镜", "canvas-node-02 产品特写", "https://gw.example.test/agent/v1/uploads/narration.mp3"],
  timeline_ops: ["卡点剪切", "去气口", "转场叠化 0.5s"],
  rhythm_notes: "日常口播保留气口，高潮段切紧卡点",
  mix_notes: "旁白 -16 LUFS，BGM 人声下 ducking 6dB",
  duration_hint: 45.6,
  delivery_spec: "1080p H.264 + AAC",
  deliverables: ["timeline_ops", "duration_sec", "qc"],
} as const;

const TASK_CONTRACT = {
  expertId: "editor",
  intent: "45 秒产品口播成片",
  materials: ["canvas-node-01"],
  acceptance: ["成片可导出", "时长口径如实标注"],
};

function okToolResult(): EditorToolResult {
  return {
    title: "成片导出完成",
    output: JSON.stringify({
      ok: true,
      url: "https://gw.example.test/agent/v1/timeline/final-1.mp4",
      timeline_ops_echo: ["trim clip3 0-3.2", "crossfade 0.5", "loudnorm I=-16"],
      duration_seconds: 45.6,
      qc: "lint 8/8 pass; master gate 14/14 pass",
      mime_type: "video/mp4",
      video_bytes: 21_000_000,
    }),
  };
}

// ── 1. persona 形状：防幻影工具 + 身份契约 ───────────────────────────────────

test("persona 形状：id/label 钉死、工具白名单逐 id 存在于 harness 真源（防幻影）", () => {
  assert.equal(EDITOR_PERSONA_ID, "editor");
  assert.equal(EDITOR_PERSONA_LABEL, "剪辑师");
  assert.equal(EDITOR_REPLY_SUMMARY_TOKEN_CAP, 500);
  for (const toolId of EDITOR_PERSONA_TOOL_IDS) {
    assert.ok(
      HARNESS_TOOL_IDS.has(toolId),
      `工具 id "${toolId}" 不在 harness-tool-registry 真源集（幻影工具禁入白名单）`,
    );
  }
  // 白名单钉死 11 件：timeline_* 八件套 + editing_manifest + audio_first_timeline + video_upload
  assert.deepEqual([...EDITOR_PERSONA_TOOL_IDS], [
    "timeline_ops",
    "timeline_query",
    "timeline_rhythm",
    "timeline_style",
    "timeline_mix",
    "timeline_master",
    "timeline_lint",
    "timeline_restore",
    "editing_manifest",
    "audio_first_timeline",
    "video_upload",
  ]);
});

test("persona 形状：SKILL 挂载逐条真实存在（禁幻影路径；2026-09-27 配方库落库）", () => {
  // 配方库落库前本断言是「置空有声明」；落库后语义翻正为「逐条存在且非幻影」。
  assert.ok(EDITOR_PERSONA_SKILL_PATHS.length > 0, "配方库已落库，skillPaths 不得为空（默认注入面）");
  for (const p of EDITOR_PERSONA_SKILL_PATHS) {
    assert.ok(existsSync(nodePath.resolve(process.cwd(), p)), `skill 路径不存在（幻影路径禁入）：${p}`);
  }
  // 域根 + 六子配方（每条对应一条真链路），顺序钉死
  assert.deepEqual([...EDITOR_PERSONA_SKILL_PATHS], [
    "skills/editor/SKILL.md",
    "skills/editor/assembly/SKILL.md",
    "skills/editor/audio-first/SKILL.md",
    "skills/editor/rhythm/SKILL.md",
    "skills/editor/look/SKILL.md",
    "skills/editor/mix/SKILL.md",
    "skills/editor/qc-master/SKILL.md",
  ]);
});

// ── 2. 委托单：形状与 video 版同构 ───────────────────────────────────────────

test("composeEditorDelegation：成功形状与 video composeVideoDelegation 同构（ok/delegation/serialized/estimated_tokens）", () => {
  const editor = composeEditorDelegation(VALID_INPUT);
  const video = composeVideoDelegation({
    subject: "新品上市 15 秒竖屏广告",
    action: "产品特写旋转展示",
    deliverables: ["shots", "duration_sec", "model_hint", "qc"],
  });
  assert.ok(editor.ok && video.ok);
  assert.deepEqual(Object.keys(editor).sort(), Object.keys(video).sort());
  // serialized 往返等价（委托单形即 schema 形）
  assert.deepEqual(JSON.parse(editor.serialized), editor.delegation);
  assert.ok(editor.estimated_tokens > 0 && editor.estimated_tokens <= 2_000);
});

test("composeEditorDelegation：缺 source_clips / deliverables 结构化报错", () => {
  const missing = composeEditorDelegation({ deliverables: ["timeline_ops"] });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "invalid_delegation");
    assert.deepEqual(missing.fields, ["source_clips"]);
  }
  const noDeliverables = composeEditorDelegation({ source_clips: ["clip-1"] });
  assert.equal(noDeliverables.ok, false);
  if (!noDeliverables.ok) assert.ok(noDeliverables.fields.includes("deliverables"));
});

test("composeEditorDelegation：未知键丢弃（防 payload 注入）", () => {
  const r = composeEditorDelegation({
    ...VALID_INPUT,
    bpm: 120,
    subject: "inject",
    emotion_contract: { style: "inject" },
    evil_key: "inject",
  });
  assert.ok(r.ok);
  if (r.ok) {
    const keys = Object.keys(r.delegation);
    assert.equal(keys.includes("bpm"), false);
    assert.equal(keys.includes("subject"), false);
    assert.equal(keys.includes("emotion_contract"), false);
    assert.equal(keys.includes("evil_key"), false);
    assert.deepEqual(
      keys.sort(),
      ["deliverables", "delivery_spec", "duration_hint", "mix_notes", "rhythm_notes", "source_clips", "timeline_ops"],
    );
  }
});

test("composeEditorDelegation：时长秒取整（镜像 video/music 版取整逻辑）", () => {
  const r = composeEditorDelegation({ ...VALID_INPUT, duration_hint: 59.7 });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.delegation.duration_hint, 60);
  for (const bad of [-5, 0, Number.NaN, "60s"]) {
    const rb = composeEditorDelegation({ ...VALID_INPUT, duration_hint: bad });
    assert.equal(rb.ok, false, `duration_hint=${String(bad)} 必须拒`);
    if (!rb.ok) assert.ok(rb.fields.includes("duration_hint"));
  }
});

test("composeEditorDelegation：deliverables 白名单收敛（越域值拒）+ 非法 source_clips 形拒", () => {
  const badDeliverables = composeEditorDelegation({ ...VALID_INPUT, deliverables: ["audio_url"] });
  assert.equal(badDeliverables.ok, false);
  const badClips = composeEditorDelegation({ ...VALID_INPUT, source_clips: "clip-1" });
  assert.equal(badClips.ok, false);
  if (!badClips.ok) assert.ok(badClips.fields.includes("source_clips"));
  const emptyClips = composeEditorDelegation({ ...VALID_INPUT, source_clips: ["  "] });
  assert.equal(emptyClips.ok, false);
  if (!emptyClips.ok) assert.ok(emptyClips.fields.includes("source_clips"));
});

// ── 3. 宪法注入：OFF 一个字不多 / ON DI 注入 / 失败结构化报错 ─────────────────

test("OFF：readBeastMode({})=false，委派 prompt 不含宪法文本", () => {
  const composed = composeEditorDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleEditorPrompt(composed.delegation, { beastMode: readBeastMode({}) });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("剪辑师委托单"));
  assert.ok(r.prompt.includes("源素材：canvas-node-01 开场空镜"));
  assert.ok(r.prompt.includes("时间线操作：卡点剪切"));
  assert.ok(r.prompt.includes("时长：46 秒"), "时长秒取整后进任务段");
  assert.ok(r.prompt.includes("交付规格：1080p H.264 + AAC"));
  // 宪法特征句一个字不多（繁体宪法原文不出现在 OFF 输出）
  assert.equal(r.prompt.includes("诚实铁律"), false);
  assert.equal(r.prompt.includes("诚实铁律"), false);
  assert.equal(r.prompt.includes("以下五条是硬约束"), false);
  assert.equal(r.prompt.includes("Expert 宪法"), false);
});

test("ON：readBeastMode({beast_mode:true})=true，宪法经 loadConstitution DI 注入头部（样本串，不读真档）", () => {
  const composed = composeEditorDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleEditorPrompt(composed.delegation, {
    beastMode: readBeastMode({ beast_mode: true }),
    loadConstitution: () => "SENTINEL_CONSTITUTION 你是 Expert。",
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.prompt.startsWith("SENTINEL_CONSTITUTION 你是 Expert。\n\n# 剪辑师委托单"), "宪法原文必须逐字注入 prompt 头");
  assert.ok(r.prompt.includes("交付字段："));
});

test("ON：宪法载入失败结构化报错（constitution_unavailable，拒绝裸奔不静默降级）", () => {
  const composed = composeEditorDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleEditorPrompt(composed.delegation, {
    beastMode: true,
    loadConstitution: () => {
      throw new Error("ENOENT: no such file");
    },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "constitution_unavailable");
  assert.ok(r.hint.includes(EXPERT_CONSTITUTION_PATH));
  assert.ok(r.hint.includes("ENOENT"));
});

// ── 4. 交付物：三栏全形 + QC 签名 + 组装闸门（本地形状断言） ──────────────────

test("collectEditorDeliverableFromToolResult：三栏 payload 全形 + computeQcSignature 本地形状断言", () => {
  const composed = composeEditorDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = collectEditorDeliverableFromToolResult(okToolResult(), {
    delegation: composed.delegation,
    contract: TASK_CONTRACT,
  });
  assert.ok(r.ok, r.ok ? "" : r.hint);
  if (!r.ok) return;
  assert.equal(r.deliverable.expertId, "editor");
  assert.equal(r.deliverable.kind, EDITOR_TIMELINE_KIND);
  for (const field of EDITOR_DELIVERABLES) {
    assert.ok(field in r.deliverable.payload, `payload 缺栏 ${field}`);
  }
  assert.deepEqual(r.deliverable.payload.timeline_ops, ["trim clip3 0-3.2", "crossfade 0.5", "loudnorm I=-16"]);
  assert.equal(r.deliverable.payload.duration_sec, 45.6);
  assert.ok((r.deliverable.payload.qc as string).includes("lint 8/8 pass"));
  assert.equal(r.deliverable.evidence.url, "https://gw.example.test/agent/v1/timeline/final-1.mp4");
  assert.equal(r.deliverable.evidence.durationSec, 45.6);
  // 全闸断言（Wave2 收口翻正："editor" 已接进 ExpertId/EXPERT_IDS，
  // QC 签名与同口径重算一致 + validateExpertDeliverable 全闸过）
  assert.equal(
    r.deliverable.qcSignature,
    computeQcSignature({
      expertId: "editor",
      kind: EDITOR_TIMELINE_KIND,
      payload: r.deliverable.payload,
      evidence: r.deliverable.evidence,
      contract: TASK_CONTRACT,
    }),
  );
  assert.deepEqual(validateExpertDeliverable(r.deliverable), { ok: true, errors: [] });
});

test("collect：缺 qc 拒（missing_deliverables，质检结论必须随回执上交）", () => {
  const composed = composeEditorDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const ctx = { delegation: composed.delegation, contract: TASK_CONTRACT };
  const noQc = collectEditorDeliverableFromToolResult(
    {
      title: "成片导出完成但缺质检结论",
      output: JSON.stringify({
        ok: true,
        url: "https://gw.example.test/agent/v1/timeline/final-2.mp4",
        duration_seconds: 45.6,
        timeline_ops_echo: ["trim clip3"],
      }),
    },
    ctx,
  );
  assert.equal(noQc.ok, false);
  if (!noQc.ok) {
    assert.equal(noQc.code, "missing_deliverables");
    assert.ok(noQc.hint.includes("qc"));
  }
});

test("collect：缺 url / 缺 duration_seconds = missing_deliverables（不产半形交付物）", () => {
  const composed = composeEditorDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const ctx = { delegation: composed.delegation, contract: TASK_CONTRACT };
  const noUrl = collectEditorDeliverableFromToolResult(
    {
      title: "母带闸过但导出失败",
      output: JSON.stringify({ ok: true, duration_seconds: 45.6, qc: "lint pass", timeline_ops_echo: ["trim clip3"] }),
    },
    ctx,
  );
  assert.equal(noUrl.ok, false);
  if (!noUrl.ok) {
    assert.equal(noUrl.code, "missing_deliverables");
    assert.ok(noUrl.hint.includes("video_url"));
  }

  const noDuration = collectEditorDeliverableFromToolResult(
    {
      title: "成片导出完成",
      output: JSON.stringify({ ok: true, url: "https://gw.example.test/agent/v1/timeline/final-3.mp4", qc: "lint pass" }),
    },
    ctx,
  );
  assert.equal(noDuration.ok, false);
  if (!noDuration.ok) {
    assert.equal(noDuration.code, "missing_deliverables");
    assert.ok(noDuration.hint.includes("duration_sec"));
  }
});

test("交付物：payload 任一改动 → QC 签名失配被本地闸拒（篡改可检，重算可复原）", () => {
  const composed = composeEditorDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = collectEditorDeliverableFromToolResult(okToolResult(), {
    delegation: composed.delegation,
    contract: TASK_CONTRACT,
  });
  assert.ok(r.ok);
  if (!r.ok) return;

  const tampered = JSON.parse(JSON.stringify(r.deliverable));
  tampered.payload.duration_sec = 1;
  const gate = validateExpertDeliverable(tampered);
  assert.equal(gate.ok, false);
  assert.ok(gate.errors.some((e) => e.includes("qcSignature")));

  // 同口径重算可复原（篡改后按原文重交的通路存在）
  const resign = computeQcSignature({
    expertId: tampered.expertId,
    kind: tampered.kind,
    payload: tampered.payload,
    evidence: tampered.evidence,
    contract: tampered.contract,
  });
  tampered.qcSignature = resign;
  assert.deepEqual(validateExpertDeliverable(tampered), { ok: true, errors: [] });
});

test("collect：工具失败回执（ok:false）与非 JSON 回执 = no_output", () => {
  const composed = composeEditorDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const ctx = { delegation: composed.delegation, contract: TASK_CONTRACT };
  const failed = collectEditorDeliverableFromToolResult(
    { title: "失败", output: JSON.stringify({ ok: false, error: { code: "master_gate_rejected", hint: "av_mismatch" } }) },
    ctx,
  );
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, "no_output");

  const notJson = collectEditorDeliverableFromToolResult({ title: "异常", output: "不是 JSON" }, ctx);
  assert.equal(notJson.ok, false);
  if (!notJson.ok) {
    assert.equal(notJson.code, "no_output");
    assert.ok(notJson.hint.includes("JSON"));
  }
});

test("collect：timeline_ops 取值链 工具回显 echo → 委托单清单 → 占位（剪辑师自主编排）", () => {
  const composed = composeEditorDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const ctx = { delegation: composed.delegation, contract: TASK_CONTRACT };

  // ① 工具回显优先（实际执行的操作）
  const echoed = collectEditorDeliverableFromToolResult(okToolResult(), ctx);
  assert.ok(echoed.ok);
  if (echoed.ok) assert.deepEqual(echoed.deliverable.payload.timeline_ops, ["trim clip3 0-3.2", "crossfade 0.5", "loudnorm I=-16"]);

  // ② 无回显 → 委托单 timeline_ops 兜底
  const noEcho = collectEditorDeliverableFromToolResult(
    {
      title: "成片导出完成",
      output: JSON.stringify({
        ok: true,
        url: "https://gw.example.test/agent/v1/timeline/final-4.mp4",
        duration_seconds: 45.6,
        qc: "lint pass",
      }),
    },
    ctx,
  );
  assert.ok(noEcho.ok);
  if (noEcho.ok) assert.deepEqual(noEcho.deliverable.payload.timeline_ops, ["卡点剪切", "去气口", "转场叠化 0.5s"]);

  // ③ 两处都空 → 占位标注（诚实：不冒充显式操作清单）
  const bare = composeEditorDelegation({
    source_clips: ["canvas-node-09 素材"],
    deliverables: ["timeline_ops", "duration_sec", "qc"],
  });
  assert.ok(bare.ok);
  if (!bare.ok) return;
  const placeholder = collectEditorDeliverableFromToolResult(
    {
      title: "成片导出完成",
      output: JSON.stringify({
        ok: true,
        url: "https://gw.example.test/agent/v1/timeline/final-5.mp4",
        duration_seconds: 30,
        qc: "lint pass",
      }),
    },
    { delegation: bare.delegation, contract: { ...TASK_CONTRACT, intent: "品牌氛围成片" } },
  );
  assert.ok(placeholder.ok);
  if (placeholder.ok) assert.deepEqual(placeholder.deliverable.payload.timeline_ops, ["（剪辑师自主编排，未显式指定）"]);
});

test("persona 组装：assembleEditorReply 与 video assembleVideoDirectorReply 同构（ok/code/hint 契约）", () => {
  const composed = composeEditorDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const reply = assembleEditorReply(okToolResult(), {
    delegation: composed.delegation,
    contract: TASK_CONTRACT,
  });
  assert.ok(reply.ok);
  if (!reply.ok) return;
  assert.equal(reply.deliverable.expertId, "editor");
  assert.ok(reply.edit_summary.length > 0);
  assert.ok(reply.edit_summary.includes("45 秒产品口播成片"));
  assert.ok(reply.edit_summary.includes("https://gw.example.test/agent/v1/timeline/final-1.mp4"));

  const bad = assembleEditorReply(
    { title: "失败", output: "不是 JSON" },
    { delegation: composed.delegation, contract: TASK_CONTRACT },
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.code, "no_output");
    assert.ok(bad.hint.length > 0);
  }
});
