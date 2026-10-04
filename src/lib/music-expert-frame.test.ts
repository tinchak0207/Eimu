/**
 * 音乐 Expert 框架测试（MOE 改革 Wave1 片B3，2026-09-08）。
 * 跑法（package.json 现有 test 跑法定向执行本档）：
 *   npx --yes tsx --test src/lib/music-expert-frame.test.ts
 *
 * 覆盖：
 *   1. OFF：委派 prompt 不含宪法文本；委派单形状与 blender 版同构断言
 *   2. ON：宪法原文注入 prompt 头（readBeastMode(settings)===true 门禁）；
 *      载入失败结构化报错（诚实铁律，不静默降级）
 *   3. 交付物过 validateExpertDeliverable 组装闸门；篡改签名拒
 *   4. routeExpert("music"/"mv_theme") 命中激活行
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";

import {
  EXPERT_CONSTITUTION_PATH,
  MUSIC_DELIVERABLES,
  assembleMusicDirectorPrompt,
  collectMusicDeliverableFromToolResult,
  composeMusicDelegation,
} from "./music-delegate.ts";
import { readBeastMode, routeExpert, EXPERT_REGISTRY } from "./expert-registry.ts";
import { computeQcSignature, validateExpertDeliverable, type ExpertTaskContract } from "./expert-contract.ts";
import { composeDelegation } from "./blender-delegate.ts";
import { assembleMusicDirectorReply } from "./music-director-persona.ts";

// ── 共用夹具 ─────────────────────────────────────────────────────────────────

const VALID_INPUT = {
  effect_description: "MV 副歌段落主题曲，人声女声，情绪从压抑到爆发",
  emotion_contract: {
    style: "cinematic pop ballad, lush strings",
    genre: "cinematic pop",
    bpm: 92,
    musicalKey: "D minor",
    mood: "melancholic building to triumphant",
    structure: "[0:00-0:10] Intro, [0:10-0:40] Verse, [0:40-1:10] Chorus",
  },
  lyrics: "[Verse]\n夜色压低了呼吸\n[Chorus]\n把名字喊进风里",
  deliverables: ["emotion_contract", "lyrics", "melody_notation", "audio_url", "duration_source", "qc"],
} as const;

const TASK_CONTRACT: ExpertTaskContract = {
  expertId: "music",
  intent: "MV 主题曲",
  materials: ["canvas-node-42"],
  acceptance: ["音频可播放", "时长口径如实标注"],
};

function okToolResult(): { title: string; output: string } {
  return {
    title: "音乐生成完成",
    output: JSON.stringify({
      ok: true,
      url: "https://gw.example.test/agent/v1/audio/music-gen-1.mp3",
      path_source: "gateway_uploads",
      duration_seconds: 182.4,
      duration_source: "ffprobe",
      duration_hint: "full",
      model: "lyria-3.5",
      mime_type: "audio/mpeg",
      audio_bytes: 4_200_000,
      lyrics_echo: "[Verse]\n夜色压低了呼吸\n[Chorus]\n把名字喊进风里",
      prompt_used: "cinematic pop ballad, lush strings, 92 BPM, key of D minor, mood: melancholic building to triumphant",
      reference_image_count: 0,
    }),
  };
}

// ── 1. 委托单：形状与 blender 版同构 ─────────────────────────────────────────

test("composeMusicDelegation：成功形状与 blender composeDelegation 同构（ok/delegation/serialized/estimated_tokens）", () => {
  const music = composeMusicDelegation(VALID_INPUT);
  const blender = composeDelegation({
    effect_description: "台球撞击特写",
    shot_count: 1,
    deliverables: ["turntable", "stills"],
  });
  assert.ok(music.ok && blender.ok);
  assert.deepEqual(Object.keys(music).sort(), Object.keys(blender).sort());
  // serialized 往返等价（委托单形即 schema 形）
  assert.deepEqual(JSON.parse(music.serialized), music.delegation);
  assert.ok(music.estimated_tokens > 0 && music.estimated_tokens <= 2_000);
});

test("composeMusicDelegation：缺 emotion_contract / 空 deliverables / 非法 duration_hint 结构化报错", () => {
  const missing = composeMusicDelegation({ effect_description: "x", deliverables: ["lyrics"] });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "invalid_delegation");
    assert.deepEqual(missing.fields, ["emotion_contract"]);
  }
  const badDeliverables = composeMusicDelegation({ ...VALID_INPUT, deliverables: ["turntable"] });
  assert.equal(badDeliverables.ok, false);
  const badHint = composeMusicDelegation({ ...VALID_INPUT, duration_hint: "60s" });
  assert.equal(badHint.ok, false);
  if (!badHint.ok) assert.ok(badHint.fields.includes("duration_hint"));
});

test("composeMusicDelegation：emotion_contract 白名单收敛（style 必填、未知键丢弃、bpm 取整）", () => {
  const r = composeMusicDelegation({
    effect_description: "x",
    emotion_contract: { style: "lo-fi", bpm: 88.6, evil_key: "inject" },
    deliverables: ["audio_url"],
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.delegation.emotion_contract, { style: "lo-fi", bpm: 89 });
  }
});

// ── 2. 宪法注入：OFF 一个字不多 / ON 头部注入 / 失败结构化报错 ────────────────

test("委派 prompt：deliverables 含 melody_notation 时给出可判形态指引（刀 I 契约栏）", () => {
  const composed = composeMusicDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleMusicDirectorPrompt(composed.delegation, { beastMode: false });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("交付字段：emotion_contract、lyrics、melody_notation、audio_url、duration_source、qc"));
  // 机器判据口径：栏位名逐字出现 + 实质内容形态（调性/节拍/音名字符序列示例）。
  assert.ok(r.prompt.includes("melody_notation 需含调性＋节拍＋至少一段人声主旋律以音名字符序列标注"));
  assert.ok(r.prompt.includes("A4–C5–B4–A4"));
  assert.ok(r.prompt.includes("缺整栏＝未交付"));
});

test("委派 prompt：deliverables 含 melody_notation 时形态指引附带 score_abc 真源句（YuE2 白盒接线）", () => {
  const composed = composeMusicDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleMusicDirectorPrompt(composed.delegation, { beastMode: false });
  assert.ok(r.ok);
  if (!r.ok) return;
  // 2026-09-19 additive：真源句（既有形态指引行一字未动，紧跟其后注入）。
  assert.ok(r.prompt.includes("真源优先：music_gen 回执的 score_abc 栏带 ABC 乐谱"));
  assert.ok(r.prompt.includes("melody_notation 直接引用其 Vocal 声部"));
  assert.ok(r.prompt.includes("score_abc 为 null 时仍由你自行标注"));
});

test("委派 prompt：deliverables 不含 melody_notation 时形态指引零出现（零多余注入）", () => {
  const composed = composeMusicDelegation({ ...VALID_INPUT, deliverables: ["emotion_contract", "audio_url"] });
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleMusicDirectorPrompt(composed.delegation, { beastMode: false });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.prompt.includes("melody_notation"), false);
});

test("OFF：readBeastMode({})=false，委派 prompt 不含宪法文本", () => {
  const composed = composeMusicDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleMusicDirectorPrompt(composed.delegation, { beastMode: readBeastMode({}) });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.prompt.includes("音乐导演委托单"));
  assert.ok(r.prompt.includes("风格契约（Lyria prompt）："));
  // 宪法特征句一个字不多（繁体宪法原文不出现在 OFF 输出）
  assert.equal(r.prompt.includes("诚实铁律"), false);
  assert.equal(r.prompt.includes("诚实铁律"), false);
  assert.equal(r.prompt.includes("以下五条是硬约束"), false);
  assert.equal(r.prompt.includes("Expert 宪法"), false);
});

test("ON：readBeastMode({beast_mode:true})=true，宪法落位稿原文注入 prompt 头", () => {
  const composed = composeMusicDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleMusicDirectorPrompt(composed.delegation, {
    beastMode: readBeastMode({ beast_mode: true }),
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  // 与落位稿逐字对账（默认 loader = fs 读 EXPERT_CONSTITUTION_PATH）
  const constitution = readFileSync(nodePath.resolve(process.cwd(), EXPERT_CONSTITUTION_PATH), "utf8");
  assert.ok(constitution.includes("诚实铁律"));
  assert.ok(r.prompt.startsWith(constitution), "宪法原文必须逐字注入 prompt 头");
  assert.ok(r.prompt.includes("音乐导演委托单"));
  assert.ok(r.prompt.indexOf("Expert 宪法") < r.prompt.indexOf("音乐导演委托单"));
});

test("ON：宪法经 loadConstitution DI 注入头部（范式同 resolveArtifactUrl/uploadOverride）", () => {
  const composed = composeMusicDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleMusicDirectorPrompt(composed.delegation, {
    beastMode: true,
    loadConstitution: () => "SENTINEL_CONSTITUTION 你是 Expert。",
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.prompt.startsWith("SENTINEL_CONSTITUTION 你是 Expert。\n\n# 音乐导演委托单"));
});

test("ON：宪法载入失败结构化报错（constitution_unavailable，不静默降级成无宪法派遣）", () => {
  const composed = composeMusicDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = assembleMusicDirectorPrompt(composed.delegation, {
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

// ── 3. 交付物：六栏契约（工具回执五栏全形 + melody_notation 导演文案栏）+ QC 签名 + 组装闸门 ─

test("collectMusicDeliverableFromToolResult：契约六栏，工具回执路径产五栏 payload 全形且过 validateExpertDeliverable", () => {
  const composed = composeMusicDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = collectMusicDeliverableFromToolResult(okToolResult(), {
    emotion_contract: composed.delegation.emotion_contract,
    contract: TASK_CONTRACT,
  });
  assert.ok(r.ok, r.ok ? "" : r.hint);
  if (!r.ok) return;
  assert.equal(r.deliverable.expertId, "music");
  assert.equal(r.deliverable.kind, "music_track");
  for (const field of MUSIC_DELIVERABLES) {
    if (field === "melody_notation") {
      // melody_notation 是导演文案交付栏（VPS 闸门按正文「栏位名逐字出现＋实质内容」判定），
      // music_gen 工具回执不产音高序列，collect 不伪造回填（诚实铁律）。
      assert.equal(field in r.deliverable.payload, false, `工具回执路径不应回填 ${field}`);
      continue;
    }
    assert.ok(field in r.deliverable.payload, `payload 缺栏 ${field}`);
  }
  assert.deepEqual([...MUSIC_DELIVERABLES], ["emotion_contract", "lyrics", "melody_notation", "audio_url", "duration_source", "qc"]);
  assert.equal(r.deliverable.payload.duration_source, "ffprobe");
  assert.equal(r.deliverable.evidence.url, "https://gw.example.test/agent/v1/audio/music-gen-1.mp3");
  assert.equal(r.deliverable.evidence.durationSec, 182.4);
  const gate = validateExpertDeliverable(r.deliverable);
  assert.deepEqual(gate, { ok: true, errors: [] });
});

test("交付物：payload 任一改动 → QC 签名失配被拒（篡改可检）", () => {
  const composed = composeMusicDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const r = collectMusicDeliverableFromToolResult(okToolResult(), {
    emotion_contract: composed.delegation.emotion_contract,
    contract: TASK_CONTRACT,
  });
  assert.ok(r.ok);
  if (!r.ok) return;

  const tampered = JSON.parse(JSON.stringify(r.deliverable));
  tampered.payload.lyrics = "被篡改的歌词";
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

test("collect：工具失败回执（ok:false）= no_output；缺 audio_url = missing_deliverables", () => {
  const composed = composeMusicDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const failed = collectMusicDeliverableFromToolResult(
    { title: "失败", output: JSON.stringify({ ok: false, error: { code: "lyria_http_429", hint: "quota" } }) },
    { emotion_contract: composed.delegation.emotion_contract, contract: TASK_CONTRACT },
  );
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, "no_output");

  const noUrl = collectMusicDeliverableFromToolResult(
    {
      title: "音乐生成完成但上传失败",
      output: JSON.stringify({ ok: true, audio_base64: "AAAA", duration_seconds: 30, duration_source: "ffprobe" }),
    },
    { emotion_contract: composed.delegation.emotion_contract, contract: TASK_CONTRACT },
  );
  assert.equal(noUrl.ok, false);
  if (!noUrl.ok) {
    assert.equal(noUrl.code, "missing_deliverables");
    assert.ok(noUrl.hint.includes("audio_url"));
  }
});

test("persona 组装：assembleMusicDirectorReply 与 blender assembleDirectorReply 同构（ok/code/hint 契约）", () => {
  const composed = composeMusicDelegation(VALID_INPUT);
  assert.ok(composed.ok);
  if (!composed.ok) return;
  const reply = assembleMusicDirectorReply(okToolResult(), {
    emotion_contract: composed.delegation.emotion_contract,
    contract: TASK_CONTRACT,
  });
  assert.ok(reply.ok);
  if (!reply.ok) return;
  assert.equal(reply.deliverable.expertId, "music");
  assert.ok(reply.music_summary.length > 0);
  assert.ok(reply.music_summary.includes("MV 主题曲"));

  const bad = assembleMusicDirectorReply(
    { title: "失败", output: "不是 JSON" },
    { emotion_contract: composed.delegation.emotion_contract, contract: TASK_CONTRACT },
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.code, "no_output");
    assert.ok(bad.hint.length > 0);
  }
});

// ── 4. 路由：激活行命中 ──────────────────────────────────────────────────────

test("routeExpert：music 与 mv_theme 命中激活的 music Expert 行", () => {
  assert.equal(routeExpert("music"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("mv_theme"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("theme_song"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("musical"), null, "无边界的相似词不误命中");
});
