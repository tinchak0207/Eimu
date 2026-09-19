import test from "node:test";
import assert from "node:assert/strict";
import { MUSIC_LAYER_IDS, directMusicPrompt } from "./music-prompt-director";

/** runes = Unicode code points（DATA_FLOWMUSIC 的上限以 rune 計）。 */
const runes = (text: string) => Array.from(text).length;

// ─────────────────────────────────────────────── 契約

test("frozen API：MUSIC_LAYER_IDS 為六層固定順序", () => {
  assert.deepEqual(MUSIC_LAYER_IDS, ["genre", "mood", "instrumentation", "vocal", "structure", "production"]);
});

// ─────────────────────────────────────────────── 六層偵測與補齊

const FULL_SIX_LAYERS =
  "late-60s Laurel Canyon folk, bittersweet and unhurried, fingerpicked nylon-string guitar with brushed drums and distant pedal steel, female alto, unpolished and conversational, verse and chorus, warm analog tape, dry room, 78 BPM";

test("六層全在：layers 逐層 true、applied 為空、原文不改", () => {
  const out = directMusicPrompt(FULL_SIX_LAYERS);
  assert.deepEqual(out.layers, {
    genre: true,
    mood: true,
    instrumentation: true,
    vocal: true,
    structure: true,
    production: true,
  });
  assert.deepEqual(out.applied, []);
  assert.deepEqual(out.truncated, []);
  assert.equal(out.prompt, FULL_SIX_LAYERS);
});

test("缺層補齊：缺的層補中性指令，不替用戶決定流派／樂器", () => {
  const out = directMusicPrompt("a sad song");
  assert.equal(out.layers.genre, false);
  assert.match(out.prompt, /Genre:/);
  assert.match(out.prompt, /Instrumentation:/);
  assert.match(out.prompt, /Vocal:/);
  assert.match(out.prompt, /Structure:/);
  assert.match(out.prompt, /Production:/);
  assert.ok(out.applied.includes("fill-genre"));
  assert.ok(out.applied.includes("fill-production"));
  assert.doesNotMatch(out.prompt, /\b(piano|guitar|drum|techno|folk|jazz)\b/i);
});

test("layers 如實回報：補齊不把 layers 變真", () => {
  const out = directMusicPrompt("a sad song");
  assert.equal(out.layers.vocal, false);
  assert.equal(out.layers.structure, false);
});

// ─────────────────────────────────────────────── 偽標籤剝除

test("偽標籤剝除：假參數改寫成散文（BPM／Key／Reverb／Mood）", () => {
  const out = directMusicPrompt("cinematic orchestral, [BPM: 120], [Key: D minor], [Reverb: 30%], [Mood: Uplifting]");
  assert.doesNotMatch(out.prompt, /\[(?:bpm|key|reverb|mood)\s*:/i);
  assert.match(out.prompt, /120 BPM/);
  assert.match(out.prompt, /key of D minor/);
  assert.match(out.prompt, /30% reverb/);
  assert.ok(out.applied.includes("strip-pseudo-tags"));
});

test("偽標籤剝除：品質模式假參數（MAX）整條刪除", () => {
  const out = directMusicPrompt("cinematic orchestral, [Is_MAX_MODE: MAX], [QUALITY: MAX]");
  assert.doesNotMatch(out.prompt, /\bmax\b/i);
  assert.ok(out.applied.includes("strip-pseudo-tags"));
});

test("偽標籤剝除：Energy 假標籤落成 CORE_01 §4 的散文寫法", () => {
  const out = directMusicPrompt("cinematic orchestral, [Energy: High]");
  assert.doesNotMatch(out.prompt, /\[Energy:/i);
  assert.match(out.prompt, /full-force, everything at once/);
});

// ─────────────────────────────────────────────── flowmusic 通路硬規則

test("flowmusic 無歌詞標籤：剝除時間戳、保留描述、壓成單行、≤220 runes", () => {
  const prompt =
    "cinematic orchestral, tense and driving, strings and taiko drums, instrumental only no vocals, [0:00 - 0:10] sparse low drone intro, [0:10 - 0:40] main ostinato theme, 60 BPM, key of D minor";
  const out = directMusicPrompt(prompt, { channel: "flowmusic" });
  assert.doesNotMatch(out.prompt, /0:00|0:10|0:40/);
  assert.match(out.prompt, /sparse low drone intro/);
  assert.match(out.prompt, /main ostinato theme/);
  assert.doesNotMatch(out.prompt, /\n/);
  assert.ok(out.applied.includes("strip-timestamps"));
  assert.ok(runes(out.prompt) <= 220);
  assert.deepEqual(out.truncated, []);
});

test("flowmusic 超 220：依權重由低到高整層丟棄並記 truncated", () => {
  const out = directMusicPrompt("late-60s Laurel Canyon folk, bittersweet and unhurried", { channel: "flowmusic" });
  assert.ok(runes(out.prompt) <= 220);
  assert.equal(out.truncated[0], "production");
  assert.ok(out.truncated.includes("structure"));
  assert.ok(out.applied.includes("fill-instrumentation"));
  assert.ok(out.applied.includes("fill-vocal"));
  assert.ok(!out.applied.includes("fill-production"));
  assert.ok(!out.applied.includes("fill-structure"));
});

test("flowmusic 丟無可丟仍超 220：子句邊界硬截並記 applied", () => {
  const longCore = Array.from(
    { length: 12 },
    (_, index) => `late-60s Laurel Canyon folk phrase number ${index} keeps going`,
  ).join(", ");
  const out = directMusicPrompt(longCore, { channel: "flowmusic" });
  assert.ok(runes(out.prompt) <= 220);
  assert.ok(out.applied.includes("truncate-220-hard"));
  // genre 在場（folk），其餘五層的補層在硬截前已被丟光。
  assert.equal(out.truncated.length, 5);
});

test("flowmusic 硬截用滿預算：首個 `.` 之後是無逗號長串時不再退到 15 runes（回歸 2026-09-12 缺陷）", () => {
  const bad =
    "[0:00 - 0:10] Intro: soft pad. [BPM:120] [Key:D minor] [Reverb:30%] a beautiful epic amazing cinematic orchestral track that builds and builds with strings and brass and drums and choir and synth pads and piano and guitar and flute and erhu and guzheng and taiko and cello and violin with a very dramatic emotional climax and a gentle outro that fades away slowly into silence";
  const out = directMusicPrompt(bad, { channel: "flowmusic" });
  assert.ok(runes(out.prompt) >= 0.6 * 220);
  // 保語義：mood（intense／dramatic 家族）與 instrumentation 都還在，不是只剩 "Intro: soft pad"。
  assert.match(out.prompt, /cinematic orchestral track that builds/);
  assert.match(out.prompt, /strings and brass/);
  assert.match(out.prompt, /\bintense\b/);
  assert.ok(out.applied.includes("truncate-220-hard"));
});

test("flowmusic 硬截：純 CJK 長串無標點無空白 → 就在 cap 處切（不為找邊界大幅退讓）", () => {
  const cjk = "溫暖的民謠吉他撥奏夜色微光".repeat(30);
  const out = directMusicPrompt(cjk, { channel: "flowmusic" });
  assert.equal(runes(out.prompt), 220);
  assert.equal(out.prompt, Array.from(cjk).slice(0, 220).join(""));
  assert.ok(out.applied.includes("truncate-220-hard"));
});

test("flowmusic 硬截：199 runes 處有逗號（≥60% cap）→ 退到該逗號保語義完整", () => {
  const core = `${"a".repeat(199)},${"b".repeat(300)}`;
  const out = directMusicPrompt(core, { channel: "flowmusic" });
  assert.equal(runes(out.prompt), 199);
  assert.equal(out.prompt, "a".repeat(199));
  assert.ok(out.applied.includes("truncate-220-hard"));
});

test("flowmusic 硬截：30 runes 處有逗號但之後無邊界 → 不退到 30（回歸本次缺陷）", () => {
  const core = `${"a".repeat(30)},${"b".repeat(300)}`;
  const out = directMusicPrompt(core, { channel: "flowmusic" });
  assert.ok(runes(out.prompt) >= 0.6 * 220);
  assert.equal(runes(out.prompt), 220);
  assert.match(out.prompt, /b/);
});

test("flowmusic 有歌詞標籤：換行保留、上限 3000 runes", () => {
  const lyrics =
    "[Verse]\nindie folk, warm and nostalgic, acoustic guitar and brushed drums, male tenor vocal, verse and chorus, 90 BPM, key of G major\n" +
    "walking down the river road again\n".repeat(200);
  const out = directMusicPrompt(lyrics, { channel: "flowmusic" });
  assert.ok(runes(out.prompt) <= 3000);
  assert.match(out.prompt, /\n/);
  assert.ok(out.applied.includes("truncate-3000-hard"));
});

test("flowmusic 有歌詞標籤且超 3000：先丟補層記 truncated，仍超才硬截", () => {
  const lyrics =
    "indie folk, 90 BPM\n[Verse]\n" + "walking down the river road again\n".repeat(200);
  const out = directMusicPrompt(lyrics, { channel: "flowmusic" });
  assert.ok(runes(out.prompt) <= 3000);
  assert.match(out.prompt, /\n/);
  assert.ok(out.truncated.includes("vocal"));
  assert.ok(out.truncated.includes("instrumentation"));
  assert.ok(out.truncated.includes("mood"));
  assert.ok(out.applied.includes("truncate-3000-hard"));
});

test("flowmusic hasLyrics 明示時走保版面分支，不壓單行", () => {
  const out = directMusicPrompt("cinematic orchestral, 60 BPM\nsecond line here", {
    channel: "flowmusic",
    hasLyrics: true,
  });
  assert.match(out.prompt, /\n/);
  assert.ok(!out.applied.includes("collapse-single-line"));
});

// ─────────────────────────────────────────────── yue2 通路（2026-09-18 加第三通路）

test("yue2：剝除時間戳（上游不認時間戳結構控制），段落標籤與換行保留", () => {
  const prompt = "city pop, 105 BPM\n[Verse]\n[0:00 - 0:10] sparse synth intro";
  const out = directMusicPrompt(prompt, { channel: "yue2" });
  assert.doesNotMatch(out.prompt, /0:00|0:10/);
  assert.match(out.prompt, /\[Verse\]/);
  assert.match(out.prompt, /\n/);
  assert.ok(out.applied.includes("strip-timestamps"));
  assert.ok(!out.applied.includes("collapse-single-line"));
});

test("yue2：六層齊備且帶 [Verse]/[Chorus] → 原文逐字不動（段落標籤不是偽標籤）", () => {
  const prompt =
    "city pop, bittersweet and nostalgic, synth pads with slap bass, female alto, [Verse] verse and chorus, warm analog tape, 105 BPM";
  const out = directMusicPrompt(prompt, { channel: "yue2" });
  assert.equal(out.prompt, prompt);
  assert.deepEqual(out.applied, []);
  assert.deepEqual(out.truncated, []);
});

test("yue2：style 是散文 → 不套 flowmusic 的 220 平面，長散文原樣保留", () => {
  const long = `city pop, bittersweet and nostalgic, synth pads with slap bass, female alto, [Verse] verse and chorus, warm analog tape, 105 BPM, ${"patiently unfolding without hurry ".repeat(20).trim()}`;
  const out = directMusicPrompt(long, { channel: "yue2" });
  assert.ok(runes(long) > 220);
  assert.equal(out.prompt, long);
  assert.ok(!out.applied.includes("truncate-220-hard"));
  assert.ok(!out.applied.includes("collapse-single-line"));
});

test("yue2：超 3000 runes 走版面硬截（truncate-3000-hard）", () => {
  const huge = `city pop, 105 BPM, ${"warm analog synth pad with tape saturation, ".repeat(120)}`;
  const out = directMusicPrompt(huge, { channel: "yue2" });
  assert.ok(runes(out.prompt) <= 3000);
  assert.ok(out.applied.includes("truncate-3000-hard"));
});

// ─────────────────────────────────────────────── lyria 通路

test("lyria：保留官方時間戳，不套 220 上限", () => {
  const prompt = "cinematic orchestral, [0:00 - 0:10] sparse low drone intro, 60 BPM, key of D minor";
  const out = directMusicPrompt(prompt, { channel: "lyria" });
  assert.match(out.prompt, /\[0:00 - 0:10\]/);
  assert.ok(!out.applied.includes("strip-timestamps"));
  assert.deepEqual(out.layers, directMusicPrompt(prompt).layers);
});

test("lyria 缺省：超 220 也不截斷、truncated 為空", () => {
  const longCore = Array.from(
    { length: 12 },
    (_, index) => `late-60s Laurel Canyon folk phrase number ${index} keeps going`,
  ).join(", ");
  const out = directMusicPrompt(longCore);
  assert.ok(runes(out.prompt) > 220);
  assert.deepEqual(out.truncated, []);
  assert.ok(!out.applied.includes("truncate-220-hard"));
});

// ─────────────────────────────────────────────── MOOD ≤2

test("mood > 2：多的移除、記 trim-mood 並進 warnings", () => {
  const out = directMusicPrompt("cinematic orchestral, dark, euphoric, peaceful");
  assert.match(out.prompt, /dark/);
  assert.match(out.prompt, /euphoric/);
  assert.doesNotMatch(out.prompt, /peaceful/);
  assert.ok(out.applied.includes("trim-mood"));
  assert.ok(out.warnings.some((warning) => /mood/i.test(warning) && /peaceful/.test(warning)));
});

// ─────────────────────────────────────────────── anti-slop

test("anti-slop：缺陷詞與空泛片語換成具體可採樣語彙", () => {
  const out = directMusicPrompt("cinematic orchestral, muddy low end, low quality, epic");
  assert.doesNotMatch(out.prompt, /\bmuddy\b/i);
  assert.match(out.prompt, /clear and defined/);
  assert.match(out.prompt, /studio-grade/);
  assert.match(out.prompt, /intense/);
  assert.ok(out.applied.includes("anti-slop"));
});

test("anti-slop：庫內無替換目標的空詞只回報 warnings，不改字", () => {
  const out = directMusicPrompt("cinematic orchestral, beautiful, nice");
  assert.match(out.prompt, /beautiful/);
  assert.match(out.prompt, /nice/);
  assert.ok(!out.applied.includes("anti-slop"));
  assert.ok(out.warnings.some((warning) => /anti-slop/.test(warning) && /beautiful/.test(warning)));
});

// ─────────────────────────────────────────────── warnings（不得虛報）

test("front-loading：genre 在場但不在首子句 → warning", () => {
  const out = directMusicPrompt("tense and driving, cinematic orchestral");
  assert.equal(out.layers.genre, true);
  assert.ok(out.warnings.some((warning) => /front-loading/i.test(warning)));
});

test("genre 在首子句 → 無 front-loading warning", () => {
  const out = directMusicPrompt(FULL_SIX_LAYERS);
  assert.ok(!out.warnings.some((warning) => /front-loading/i.test(warning)));
});

test("樂器過多 → instrumentation warning", () => {
  const out = directMusicPrompt("cinematic orchestral, piano, guitar, drums, bass, strings, brass, 90 BPM");
  assert.ok(out.warnings.some((warning) => /instrumentation: \d+ instruments/i.test(warning)));
});

// ─────────────────────────────────────────────── 邊界與決定性

test("空輸入原樣返回空字串、零改寫", () => {
  const out = directMusicPrompt("   ");
  assert.equal(out.prompt, "");
  assert.deepEqual(out.applied, []);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.truncated, []);
  assert.equal(Object.values(out.layers).some(Boolean), false);
});

test("純中文 prompt：原文保留、偵測不到就如實 false 並補中性指令", () => {
  const out = directMusicPrompt("一首溫暖的民謠，吉他撥奏，副歌高昂");
  assert.match(out.prompt, /一首溫暖的民謠/);
  assert.equal(out.layers.genre, false);
  assert.equal(out.layers.vocal, false);
  assert.ok(out.applied.includes("fill-genre"));
});

test("決定性：同輸入同輸出（含通路分支）", () => {
  const prompt =
    "cinematic orchestral, tense and driving, strings and taiko drums, instrumental only no vocals, [0:00 - 0:10] sparse low drone intro, 60 BPM";
  const first = directMusicPrompt(prompt, { channel: "flowmusic", durationSeconds: 180 });
  const second = directMusicPrompt(prompt, { channel: "flowmusic", durationSeconds: 180 });
  assert.deepEqual(first, second);
});

test("durationSeconds ≥ 120：結構補層改用整曲措辭", () => {
  const out = directMusicPrompt("cinematic orchestral, 60 BPM", { durationSeconds: 180 });
  assert.match(out.prompt, /across the full runtime/);
});
