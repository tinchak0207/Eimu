// 分鏡 → 配音台詞表 → 回寫分鏡（橋接純函式層）行為測試。
//
// 全部是**真函式行為斷言**：真組行、真拒寫、真回寫、真比對漂移；無源碼字串掃描。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAudioTimelineToShots,
  AUDIO_TOOL_MAX_LINES,
  audioDurationDrift,
  DURATION_DRIFT_THRESHOLD_SEC,
  shotsToAudioScript,
} from "./storyboard-audio-bridge";
import type {
  AudioSourceRef,
  AudioTimelineEntry,
  StoryboardAudioShot,
} from "./storyboard-audio-bridge";

const MP3 = (n: number) => `https://store.tinchak0207.xyz/tts_${n}.mp3`;

/** 一顆最小分鏡（只帶本層會讀的欄位）。 */
function shot(shotNumber: string, extra: Partial<StoryboardAudioShot> = {}): StoryboardAudioShot {
  return { shotNumber, ...extra };
}

/** 六鏡各有一段旁白（P2 病灶的長相：旁白貫穿鏡1-6，必須得到 6 行而非 1 行）。 */
function sixNarrationShots(): StoryboardAudioShot[] {
  return [1, 2, 3, 4, 5, 6].map((n) =>
    shot(`S0${n}`, { narration: `第 ${n} 鏡的旁白台詞`, durationSeconds: 10 }),
  );
}

// ─────────────────────────────────────────── ① shotsToAudioScript

test("6 鏡旁白 → 6 行（不摺成 1 行），source 逐行對回鏡號", () => {
  const plan = shotsToAudioScript(sixNarrationShots());
  assert.equal(plan.refused, undefined);
  assert.equal(plan.source.length, 6);
  const rows = JSON.parse(plan.script) as Array<{ role: string; text: string }>;
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.map((r) => r.text),
    ["第 1 鏡的旁白台詞", "第 2 鏡的旁白台詞", "第 3 鏡的旁白台詞", "第 4 鏡的旁白台詞", "第 5 鏡的旁白台詞", "第 6 鏡的旁白台詞"],
  );
  assert.deepEqual(
    plan.source,
    ["S01", "S02", "S03", "S04", "S05", "S06"].map((shotNumber) => ({ shotNumber, field: "narration" })),
  );
  // 鏡號**不得**出現在送去合成的 role/text 上。
  assert.ok(rows.every((r) => !r.text.includes("S0") && r.role === "narration"));
});

test("同一鏡對白＋旁白 → 各一行（對白先於旁白），source.field 正確", () => {
  const plan = shotsToAudioScript([shot("S01", { dialogue: "站住！", narration: "夜色沉沉" })]);
  assert.equal(plan.source.length, 2);
  assert.deepEqual(plan.source, [
    { shotNumber: "S01", field: "dialogue" },
    { shotNumber: "S01", field: "narration" },
  ]);
  const rows = JSON.parse(plan.script) as Array<{ role: string; text: string }>;
  assert.deepEqual(rows, [
    { role: "dialogue", text: "站住！" },
    { role: "narration", text: "夜色沉沉" },
  ]);
});

test("空／純空白欄位不產生行（不送空行）；無鏡號項略過", () => {
  const plan = shotsToAudioScript([
    shot("S01", { dialogue: "   ", narration: "" }),
    shot("", { narration: "沒有鏡號" }),
    shot("S02", { narration: "有效旁白" }),
    shot("S03", { dialogue: "" }),
  ]);
  assert.equal(plan.source.length, 1);
  assert.deepEqual(plan.source, [{ shotNumber: "S02", field: "narration" }]);
});

test("對白中的 [角色]：「…」 標記逐字照送（本層不切分、不改寫）", () => {
  const raw = "[阿明]：「我不會走的。」";
  const plan = shotsToAudioScript([shot("S01", { dialogue: raw })]);
  const rows = JSON.parse(plan.script) as Array<{ text: string }>;
  assert.equal(rows[0].text, raw);
});

test(`恰好 ${AUDIO_TOOL_MAX_LINES} 行放行、第 ${AUDIO_TOOL_MAX_LINES + 1} 行具名拒且不截斷`, () => {
  const make = (count: number) =>
    Array.from({ length: count }, (_, i) => shot(`S${i + 1}`, { narration: `旁白 ${i + 1}` }));

  const atLimit = shotsToAudioScript(make(AUDIO_TOOL_MAX_LINES));
  assert.equal(atLimit.refused, undefined);
  assert.equal(atLimit.source.length, AUDIO_TOOL_MAX_LINES);

  const overLimit = shotsToAudioScript(make(AUDIO_TOOL_MAX_LINES + 1));
  assert.equal(overLimit.refused?.code, "too_many_lines");
  assert.match(overLimit.refused?.note ?? "", /50/);
  // 不默默截斷：script 與 source 仍是**完整**的 51 行。
  assert.equal(overLimit.source.length, AUDIO_TOOL_MAX_LINES + 1);
  assert.equal((JSON.parse(overLimit.script) as unknown[]).length, AUDIO_TOOL_MAX_LINES + 1);
});

// ─────────────────────────────────────────── ② applyAudioTimelineToShots

test("正常回寫：narrationAudioId 與 audioAnchorId 生效，且不動輸入分鏡", () => {
  const shots = sixNarrationShots();
  const snapshot = structuredClone(shots);
  const { source } = shotsToAudioScript(shots);
  const timeline: AudioTimelineEntry[] = source.map((_, i) => ({
    index: i,
    role: "narration",
    audio_url: MP3(i),
    duration_ms: 9000 + i,
  }));

  const result = applyAudioTimelineToShots(shots, timeline, source);
  assert.equal(result.applied, true);
  assert.equal(result.refused, undefined);
  assert.deepEqual(result.unmeasuredDurations, []);
  result.shots.forEach((s, i) => {
    assert.equal(s.narrationAudioId, MP3(i));
    assert.equal(s.audioAnchorId, MP3(i));
  });
  assert.deepEqual(shots, snapshot, "輸入分鏡不得被突變");
});

test("對白軌優先於旁白軌（audioAnchorId = dialogueAudioId || narrationAudioId）", () => {
  const shots = [shot("S01", { dialogue: "站住", narration: "夜色" })];
  const { source } = shotsToAudioScript(shots);
  const timeline: AudioTimelineEntry[] = [
    { audio_url: MP3(1), duration_ms: 500 }, // dialogue
    { audio_url: MP3(2), duration_ms: 700 }, // narration
  ];
  const result = applyAudioTimelineToShots(shots, timeline, source);
  assert.equal(result.applied, true);
  assert.equal(result.shots[0].dialogueAudioId, MP3(1));
  assert.equal(result.shots[0].narrationAudioId, MP3(2));
  assert.equal(result.shots[0].audioAnchorId, MP3(1));
});

test("timeline 少一行 → 整批拒寫、分鏡原樣（含未截斷的來源）", () => {
  const shots = sixNarrationShots();
  const snapshot = structuredClone(shots);
  const { source } = shotsToAudioScript(shots);
  const timeline: AudioTimelineEntry[] = source.slice(0, 5).map((_, i) => ({
    audio_url: MP3(i),
    duration_ms: 9000,
  }));

  const result = applyAudioTimelineToShots(shots, timeline, source);
  assert.equal(result.applied, false);
  assert.equal(result.refused?.code, "length_mismatch");
  assert.deepEqual(result.shots, snapshot, "整批拒寫時分鏡必須原樣");
  assert.deepEqual(result.unmeasuredDurations, []);
});

test("任一行的 audio_url 缺失 → 整批拒寫、無部分寫入", () => {
  const shots = sixNarrationShots();
  const snapshot = structuredClone(shots);
  const { source } = shotsToAudioScript(shots);
  const timeline: AudioTimelineEntry[] = source.map((_, i) => ({
    audio_url: i === 3 ? "" : MP3(i),
    duration_ms: 9000,
  }));

  const result = applyAudioTimelineToShots(shots, timeline, source);
  assert.equal(result.applied, false);
  assert.equal(result.refused?.code, "missing_audio_url");
  assert.deepEqual(result.shots, snapshot);
  // 前 3 行雖有效，也一律未寫（拒絕＝全不寫）。
  assert.ok(result.shots.every((s) => s.narrationAudioId === undefined));
});

test("非音頻 URL（.png）→ 整批拒寫，不冒充綁定", () => {
  const shots = [shot("S01", { narration: "旁白" })];
  const snapshot = structuredClone(shots);
  const { source } = shotsToAudioScript(shots);
  const result = applyAudioTimelineToShots(
    shots,
    [{ audio_url: "https://x.test/frame.png", duration_ms: 1000 }],
    source,
  );
  assert.equal(result.applied, false);
  assert.equal(result.refused?.code, "unusable_audio_url");
  assert.deepEqual(result.shots, snapshot);
});

test("source 指向不存在的鏡號 → 整批拒寫", () => {
  const shots = [shot("S01", { narration: "旁白" })];
  const source: AudioSourceRef[] = [{ shotNumber: "S99", field: "narration" }];
  const result = applyAudioTimelineToShots(shots, [{ audio_url: MP3(1), duration_ms: 1000 }], source);
  assert.equal(result.applied, false);
  assert.equal(result.refused?.code, "unknown_shot");
  assert.deepEqual(result.shots, [shot("S01", { narration: "旁白" })]);
});

test("duration_ms 未實測（null）仍寫 URL，但記進 unmeasuredDurations", () => {
  const shots = [shot("S01", { narration: "旁白一" }), shot("S02", { narration: "旁白二" })];
  const { source } = shotsToAudioScript(shots);
  const timeline: AudioTimelineEntry[] = [
    { audio_url: MP3(1), duration_ms: null },
    { audio_url: MP3(2), duration_ms: 1200 },
  ];
  const result = applyAudioTimelineToShots(shots, timeline, source);
  assert.equal(result.applied, true);
  assert.equal(result.shots[0].narrationAudioId, MP3(1));
  assert.deepEqual(result.unmeasuredDurations, ["S01"]);
});

// ─────────────────────────────────────────── ③ audioDurationDrift

test("逐鏡漂移：超 0.5 秒被標出、未超不被標", () => {
  const shots = [
    shot("S01", { narration: "旁白一", durationSeconds: 10 }),
    shot("S02", { narration: "旁白二", durationSeconds: 10 }),
    shot("S03", { narration: "旁白三", durationSeconds: 10 }),
  ];
  const { source } = shotsToAudioScript(shots);
  const timeline: AudioTimelineEntry[] = [
    { audio_url: MP3(1), duration_ms: 10_400 }, // +0.4s → 未超
    { audio_url: MP3(2), duration_ms: 13_000 }, // +3.0s → 超
    { audio_url: MP3(3), duration_ms: 5_000 }, // -5.0s → 超
  ];
  const drift = audioDurationDrift(shots, timeline, source);
  assert.equal(drift.length, 3);
  assert.deepEqual(
    drift.map((d) => ({ shot: d.shotNumber, over: d.overThreshold })),
    [
      { shot: "S01", over: false },
      { shot: "S02", over: true },
      { shot: "S03", over: true },
    ],
  );
  assert.equal(drift[0].deltaSec, 0.4);
  assert.equal(drift[1].deltaSec, 3);
  assert.equal(drift[2].deltaSec, -5);
  assert.equal(DURATION_DRIFT_THRESHOLD_SEC, 0.5);
});

test("漂移：本批無此鏡的行 → actualSec 0 且被標；計畫值缺席 → 不比對", () => {
  const shots = [
    shot("S01", { narration: "旁白一", durationSeconds: 8 }),
    shot("S02", { narration: "旁白二", durationSeconds: 8 }),
    shot("S03", { narration: "旁白三" }), // 無計畫值
  ];
  const { source } = shotsToAudioScript(shots);
  // 只回 S01 一行（S02/S03 沒合成出來＝P2 病灶長相）
  const timeline: AudioTimelineEntry[] = [{ audio_url: MP3(1), duration_ms: 8_000 }];
  const drift = audioDurationDrift(shots, timeline, source);

  assert.deepEqual(drift[0], {
    shotNumber: "S01",
    plannedSec: 8,
    actualSec: 8,
    deltaSec: 0,
    overThreshold: false,
  });
  assert.equal(drift[1].actualSec, 0);
  assert.equal(drift[1].overThreshold, true);
  assert.match(drift[1].note ?? "", /無此鏡的配音行/);
  assert.equal(drift[2].plannedSec, null);
  assert.equal(drift[2].deltaSec, null);
  assert.equal(drift[2].overThreshold, false);
  assert.match(drift[2].note ?? "", /計畫值/);
});

test("漂移：時長未實測 → actualSec/deltaSec 皆 null，不冒充", () => {
  const shots = [shot("S01", { narration: "旁白", durationSeconds: 10 })];
  const { source } = shotsToAudioScript(shots);
  const drift = audioDurationDrift(shots, [{ audio_url: MP3(1), duration_ms: null }], source);
  assert.equal(drift[0].actualSec, null);
  assert.equal(drift[0].deltaSec, null);
  assert.equal(drift[0].overThreshold, false);
  assert.match(drift[0].note ?? "", /未實測/);
});