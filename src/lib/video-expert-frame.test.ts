/**
 * 视频 Expert 框架测试（MOE 改革 Wave2b 视频导演域，2026-09-08）。
 * 跑法（package.json 现有 test 跑法定向执行本档）：
 *   npx --yes tsx --test src/lib/video-expert-frame.test.ts
 *
 * 覆盖：
 *   1. persona 形状：id/label/工具白名单逐 id 对照 harness-tool-registry 真源
 *      （防幻影工具）+ 回复 token 帽
 *   2. composeVideoDelegation：白名单收敛/未知键丢弃/时长秒取整/边界结构化报错
 *   3. OFF：委派 prompt 不含宪法文本；ON：宪法经 loadConstitution DI 注入头部
 *      （样本串，不读真档）；载入失败 constitution_unavailable 拒绝裸奔
 *   4. collectVideoDeliverable：四栏 payload 全形 + computeQcSignature 形状
 *      断言（Wave2 收口翻正："video-director" 已在 ExpertId 联合内，
 *      validateExpertDeliverable 全闸直用）
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPERT_CONSTITUTION_PATH,
  VIDEO_CLIP_KIND,
  VIDEO_DELIVERABLES,
  assembleVideoDirectorPrompt,
  collectVideoDeliverableFromToolResult,
  composeVideoDelegation,
  type VideoToolResult,
} from "./video-delegate.ts";
import { readBeastMode } from "./expert-registry.ts";
import { computeQcSignature, validateExpertDeliverable } from "./expert-contract.ts";
import { composeDelegation } from "./blender-delegate.ts";
import { HARNESS_TOOL_IDS } from "./harness-tool-registry.ts";
import {
  assembleVideoDirectorReply,
  VIDEO_DIRECTOR_PERSONA_ID,
  VIDEO_DIRECTOR_PERSONA_LABEL,
  VIDEO_DIRECTOR_PERSONA_TOOL_IDS,
  VIDEO_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./video-director-persona.ts";

// ── 共用夹具 ─────────────────────────────────────────────────────────────────

const VALID_INPUT = {
  subject: "新品上市 15 秒竖屏广告",
  action: "产品从暗场中被一束顶光点亮，特写旋转展示质感，收在 logo 定帧",
  shots: ["顶光点亮特写", "360 度产品旋转", "logo 定帧"],
  duration_hint: 15.4,
  resolution: "720p",
  model_hint: "seedance-2.5",
  camera_notes: "浅景深，微距质感，节奏卡点",
  deliverables: ["shots", "duration_sec", "model_hint", "qc"],
} as const;

const TASK_CONTRACT = {
  expertId: "video-director",
  intent: "新品上市 15 秒竖屏广告",
  materials: ["canvas-node-42"],
  acceptance: ["成片可播放", "时长口径如实标注"],
};

function okToolResult(): VideoToolResult {
  return {
    title: "视频生成完成",
    output: JSON.stringify({
      ok: true,
      url: "https://gw.example.test/agent/v1/video/clip-1.mp4",
      path_source: "gateway_uploads",
      duration_seconds: 15.2,
      model: "seedance-2.5",
      mime_type: "video/mp4",
      video_bytes: 12_500_000,
      shots_echo: ["顶光点亮特写", "360 度产品旋转", "logo 定帧"],
    }),
  };
}

// ── 1. persona 形状：防幻影工具 + 身份契约 ───────────────────────────────────

test("persona 形状：id/label 钉死、工具白名单逐 id 存在于 harness 真源（防幻影）", () => {
  assert.equal(VIDEO_DIRECTOR_PERSONA_ID, "video-director");
  assert.equal(VIDEO_DIRECTOR_PERSONA_LABEL, "视频导演");
  assert.equal(VIDEO_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP, 500);
  for (const toolId of VIDEO_DIRECTOR_PERSONA_TOOL_IDS) {
    assert.ok(
      HARNESS_TOOL_IDS.has(toolId),
      `工具 id "${toolId}" 不在 harness-tool-registry 真源集（幻影工具禁入白名单）`,
    );
  }
  // 白名单钉死十件：三个视频域工具 + 报价对偶 image_quote；2026-10-01 art-style
  // 接线新增六件视觉资产生成/风格深研工具（全在 harness-tool-registry 真源）。
  assert.deepEqual([...VIDEO_DIRECTOR_PERSONA_TOOL_IDS], [
    "video_quote",
    "video_upload",
    "last_frame_video_chain",
    "image_quote",
    "image_generate",
    "canvas_get_state",
    "canvas_apply_ops",
    "style_dna_extract",
    "style_aligned_batch",
    "asset_provenance_archive",
  ]);
});

// ── 2. 委托单：形状与 blender/music 版同构 ───────────────────────────────────

test("composeVideoDelegation：成功形状与 blender composeDelegation 同构（ok/delegation/serialized/estimated_tokens）", () => {
  const video = composeVideoDelegation(VALID_INPUT);
  const blender = composeDelegation({
    effect_description: "台球撞击特写",
    shot_count: 1,
    deliverables: ["turntable", "stills"],
  });
  assert.ok(video.ok && blender.ok);
  assert.deepEqual(Object.keys(video).sort(), Object.keys(blender).sort());
  // serialized 往返等价（委托单形即 schema 形）
  assert.deepEqual(JSON.parse(video.serialized), video.delegation);
  assert.ok(video.estimated_tokens > 0 && video.estimated_tokens <= 2_000);
});

test("composeVideoDelegation：缺 subject / action / deliverables 结构化报错", () => {
  const missing = composeVideoDelegation({ subject: "x", deliverables: ["shots"] });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "invalid_delegation");
    assert.deepEqual(missing.fields, ["action"]);
  }
  const noDeliverables = composeVideoDelegation({ subject: "x", action: "y" });
  assert.equal(noDeliverables.ok, false);
  if (!noDeliverables.ok) assert.ok(noDeliverables.fields.includes("deliverables"));
});

test("composeVideoDelegation：未知键丢弃（防 payload 注入）", () => {
  const r = composeVideoDelegation({
    ...VALID_INPUT,
    bpm: 120,
    emotion_contract: { style: "inject" },
    evil_key: "inject",
  });
  assert.ok(r.ok);
  if (r.ok) {
    const keys = Object.keys(r.delegation);
    assert.equal(keys.includes("bpm"), false);
    assert.equal(keys.includes("emotion_contract"), false);
    assert.equal(keys.includes("evil_key"), false);
    assert.deepEqual(
      keys.sort(),
      ["action", "camera_notes", "deliverables", "duration_hint", "model_hint", "resolution", "shots", "subject"],
    );
  }
});

test("composeVideoDelegation：时长秒取整（镜像 music 版 bpm 取整逻辑）", () => {
  const r = composeVideoDelegation({ ...VALID_INPUT, duration_hint: 29.7 });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.delegation.duration_hint, 30);
  for (const bad of [-5, 0, Number.NaN, "60s"]) {
    const rb = composeVideoDelegation({ ...VALID_INPUT, duration_hint: bad });
    assert.equal(rb.ok, false, `duration_hint=${String(bad)} 必须拒`);
    if (!rb.ok) assert.ok(rb.fields.includes("duration_hint"));
  }
});

test("composeVideoDelegation：deliverables 白名单收敛（越域值拒）+ 非法 shots 形拒", () => {
  const badDeliverables = composeVideoDelegation({ ...VALID_INPUT, deliverables: ["audio_url"] });
  assert.equal(badDeliverables.ok, false);
  const badShots = composeVideoDelegation({ ...VALID_INPUT, shots: "顶光特写" });
  assert.equal(badShots.ok, false);
  if (!badShots.ok) assert.ok(badShots.fields.includes("shots"));
});

// ── 3. 宪法注入：OFF 一个字不多 / ON DI 注入 / 失败结构化报错 ─────────────────

test("OFF：readBeastMode({})=false，委派 prompt 不含宪法文本", () => {
  const composed = composeVideoDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleVideoDirectorPrompt(composed.delegation, { beastMode: readBeastMode({}) });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("视频导演委托单"));
  assert.ok(r.prompt.includes("主题：新品上市 15 秒竖屏广告"));
  assert.ok(r.prompt.includes("时长：15 秒"), "时长秒取整后进任务段");
  assert.ok(r.prompt.includes("分辨率：720p"));
  assert.ok(r.prompt.includes("模型提示：seedance-2.5"));
  // 宪法特征句一个字不多（繁体宪法原文不出现在 OFF 输出）
  assert.equal(r.prompt.includes("诚实铁律"), false);
  assert.equal(r.prompt.includes("誠實鐵律"), false);
  assert.equal(r.prompt.includes("以下五條是硬約束"), false);
  assert.equal(r.prompt.includes("Expert 憲法"), false);
});

test("ON：readBeastMode({beast_mode:true})=true，宪法经 loadConstitution DI 注入头部（样本串，不读真档）", () => {
  const composed = composeVideoDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleVideoDirectorPrompt(composed.delegation, {
    beastMode: readBeastMode({ beast_mode: true }),
    loadConstitution: () => "SENTINEL_CONSTITUTION 你是 Expert。",
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.prompt.startsWith("SENTINEL_CONSTITUTION 你是 Expert。\n\n# 视频导演委托单"), "宪法原文必须逐字注入 prompt 头");
  assert.ok(r.prompt.includes("交付字段："));
});

test("ON：宪法载入失败结构化报错（constitution_unavailable，拒绝裸奔不静默降级）", () => {
  const composed = composeVideoDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleVideoDirectorPrompt(composed.delegation, {
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

// ── 4. 交付物：四栏全形 + QC 签名 + 组装闸门（本地形状断言） ──────────────────

test("collectVideoDeliverableFromToolResult：四栏 payload 全形 + computeQcSignature 本地形状断言", () => {
  const composed = composeVideoDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = collectVideoDeliverableFromToolResult(okToolResult(), {
    delegation: composed.delegation,
    contract: TASK_CONTRACT,
  });
  assert.ok(r.ok, r.ok ? "" : r.hint);
  if (!r.ok) return;
  assert.equal(r.deliverable.expertId, "video-director");
  assert.equal(r.deliverable.kind, VIDEO_CLIP_KIND);
  for (const field of VIDEO_DELIVERABLES) {
    assert.ok(field in r.deliverable.payload, `payload 缺栏 ${field}`);
  }
  assert.deepEqual(r.deliverable.payload.shots, ["顶光点亮特写", "360 度产品旋转", "logo 定帧"]);
  assert.equal(r.deliverable.payload.duration_sec, 15.2);
  assert.equal(r.deliverable.payload.model_hint, "seedance-2.5");
  assert.equal(r.deliverable.evidence.url, "https://gw.example.test/agent/v1/video/clip-1.mp4");
  assert.equal(r.deliverable.evidence.durationSec, 15.2);
  // 全闸断言（Wave2 收口翻正："video-director" 已接进 ExpertId/EXPERT_IDS，
  // QC 签名与同口径重算一致 + validateExpertDeliverable 全闸过）
  assert.equal(
    r.deliverable.qcSignature,
    computeQcSignature({
      expertId: "video-director",
      kind: VIDEO_CLIP_KIND,
      payload: r.deliverable.payload,
      evidence: r.deliverable.evidence,
      contract: TASK_CONTRACT,
    }),
  );
  assert.deepEqual(validateExpertDeliverable(r.deliverable), { ok: true, errors: [] });
});

test("交付物：payload 任一改动 → QC 签名失配被本地闸拒（篡改可检，重算可复原）", () => {
  const composed = composeVideoDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = collectVideoDeliverableFromToolResult(okToolResult(), {
    delegation: composed.delegation,
    contract: TASK_CONTRACT,
  });
  assert.ok(r.ok);
  if (!r.ok) return;

  const tampered = JSON.parse(JSON.stringify(r.deliverable));
  tampered.payload.model_hint = "被篡改的模型";
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
  const composed = composeVideoDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const ctx = { delegation: composed.delegation, contract: TASK_CONTRACT };
  const failed = collectVideoDeliverableFromToolResult(
    { title: "失败", output: JSON.stringify({ ok: false, error: { code: "video_http_429", hint: "quota" } }) },
    ctx,
  );
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, "no_output");

  const notJson = collectVideoDeliverableFromToolResult({ title: "异常", output: "不是 JSON" }, ctx);
  assert.equal(notJson.ok, false);
  if (!notJson.ok) {
    assert.equal(notJson.code, "no_output");
    assert.ok(notJson.hint.includes("JSON"));
  }
});

test("collect：缺 url / 缺 duration_seconds = missing_deliverables（不产半形交付物）", () => {
  const composed = composeVideoDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const ctx = { delegation: composed.delegation, contract: TASK_CONTRACT };
  const noUrl = collectVideoDeliverableFromToolResult(
    {
      title: "视频生成完成但上传失败",
      output: JSON.stringify({ ok: true, duration_seconds: 15.2, model: "seedance-2.5" }),
    },
    ctx,
  );
  assert.equal(noUrl.ok, false);
  if (!noUrl.ok) {
    assert.equal(noUrl.code, "missing_deliverables");
    assert.ok(noUrl.hint.includes("video_url"));
  }

  const noDuration = collectVideoDeliverableFromToolResult(
    {
      title: "视频生成完成",
      output: JSON.stringify({ ok: true, url: "https://gw.example.test/agent/v1/video/clip-2.mp4" }),
    },
    ctx,
  );
  assert.equal(noDuration.ok, false);
  if (!noDuration.ok) {
    assert.equal(noDuration.code, "missing_deliverables");
    assert.ok(noDuration.hint.includes("duration_sec"));
  }
});

test("collect：shots 取值链 工具回显 shots_echo → 委托单 shots → 占位（导演自主分镜）", () => {
  const composed = composeVideoDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const ctx = { delegation: composed.delegation, contract: TASK_CONTRACT };

  // ① 工具回显优先（实际分镜）
  const echoed = collectVideoDeliverableFromToolResult(okToolResult(), ctx);
  assert.ok(echoed.ok);
  if (echoed.ok) assert.deepEqual(echoed.deliverable.payload.shots, ["顶光点亮特写", "360 度产品旋转", "logo 定帧"]);

  // ② 无回显 → 委托单 shots 兜底
  const noEcho = collectVideoDeliverableFromToolResult(
    {
      title: "视频生成完成",
      output: JSON.stringify({ ok: true, url: "https://gw.example.test/agent/v1/video/clip-2.mp4", duration_seconds: 15.2 }),
    },
    ctx,
  );
  assert.ok(noEcho.ok);
  if (noEcho.ok) assert.deepEqual(noEcho.deliverable.payload.shots, ["顶光点亮特写", "360 度产品旋转", "logo 定帧"]);

  // ③ 两处都空 → 占位标注（诚实：不冒充显式分镜）
  const bare = composeVideoDelegation({
    subject: "品牌氛围短片",
    action: "城市空镜渐亮",
    deliverables: ["shots", "duration_sec", "model_hint", "qc"],
  });
  assert.ok(bare.ok);
  if (!bare.ok) return;
  const placeholder = collectVideoDeliverableFromToolResult(
    {
      title: "视频生成完成",
      output: JSON.stringify({ ok: true, url: "https://gw.example.test/agent/v1/video/clip-3.mp4", duration_seconds: 10 }),
    },
    { delegation: bare.delegation, contract: { ...TASK_CONTRACT, intent: "品牌氛围短片" } },
  );
  assert.ok(placeholder.ok);
  if (placeholder.ok) assert.deepEqual(placeholder.deliverable.payload.shots, ["（导演自主分镜，未显式指定）"]);
});

test("persona 组装：assembleVideoDirectorReply 与 music assembleMusicDirectorReply 同构（ok/code/hint 契约）", () => {
  const composed = composeVideoDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const reply = assembleVideoDirectorReply(okToolResult(), {
    delegation: composed.delegation,
    contract: TASK_CONTRACT,
  });
  assert.ok(reply.ok);
  if (!reply.ok) return;
  assert.equal(reply.deliverable.expertId, "video-director");
  assert.ok(reply.video_summary.length > 0);
  assert.ok(reply.video_summary.includes("新品上市 15 秒竖屏广告"));
  assert.ok(reply.video_summary.includes("https://gw.example.test/agent/v1/video/clip-1.mp4"));

  const bad = assembleVideoDirectorReply(
    { title: "失败", output: "不是 JSON" },
    { delegation: composed.delegation, contract: TASK_CONTRACT },
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.code, "no_output");
    assert.ok(bad.hint.length > 0);
  }
});
