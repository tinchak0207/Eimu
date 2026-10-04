/**
 * music-take-entropy.ts 测试（2026-10-03）。
 *
 * runner：node:test + node:assert/strict（不是 vitest）。
 *   npx --yes tsx --test src/lib/music-take-entropy.test.ts
 *
 * 覆盖：
 *   1. 真实双 take（2026-10-03 安慰剂组实跑《隐秘的折痕》两个 clips）→ 熵低于闸门、不问
 *   2. 合成高熵双 take → 问
 *   3. 三个两两最大相异 take → maxEntropyBits = log2(3) 且熵不超上限
 *   4. 两个完全相同 take → 熵 0、不问
 *   5. 单一 take → 不问、suggestedIndex = 0
 *   6. 两条退路必定出现在 options 尾端
 *   7. 选项总数（take 选项 + 2 条退路）≤ 4
 *   8. selectEntropyOptions 不会挑出那一对近乎相同的
 *   9. isPreferenceSaturated 的饱和判定与样本数下限（新分母 log2(相异标签数)）
 *  10. 空阵列边界不抛错
 *  11. 偏好饱和时强制不问并沿用主候选
 *  12. 高熵双 take 问时 suggestedIndex 指向被选中的 take
 *  13. v1/v2 形（metadata 全同、只差人声演唱窗口）→ 由「逐轴实质差异」这条闸放行
 *  14. 真实双 take（无 ASR 栏位）→ 仍不问（时长差 2.7% < 5%）
 *  15. isPreferenceSaturated([{A,50},{B,50}]) → false（防回归；旧分母会误判 true）
 *  16. isPreferenceSaturated([{A,40},{B,1}]) → true
 *  17. 两个完全相同的 take → materialAxes 为空阵列
 *  18. 9:1 与 3:2:2 在新分母下的实际正规化熵值
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMusicPreferenceQuestion,
  evaluateTakeSetEntropy,
  isPreferenceSaturated,
  selectEntropyOptions,
  type MusicTakeFeature,
} from "./music-take-entropy";

/**
 * 真实 fixture：取自 2026-10-03 实跑的上游 FlowMusic 回包
 * artifacts/ab-flowmusic-placebo-20261003/flowmusic-response.json，同标题《隐秘的折痕》
 * 的两个 take；标题相同、时长仅差约 5 秒、歌词相同。
 */
const REAL_TAKES: MusicTakeFeature[] = [
  {
    url: "https://storage.googleapis.com/producer-app-public/clips/cb0c31e8-8520-4a40-8522-7b1dac5315c3.m4a",
    candidateIndex: 0,
    durationSeconds: 179.53,
    title: "隐秘的折痕",
    lyricsEcho: "[Intro]\n(嗒 嗒 嗒)\n\n[Verse 1]\n课桌下藏着一角方纸",
  },
  {
    url: "https://storage.googleapis.com/producer-app-public/clips/345f106a-4823-4e33-accb-5b11406f6da8.m4a",
    candidateIndex: 1,
    durationSeconds: 174.62,
    title: "隐秘的折痕",
    lyricsEcho: "[Intro]\n(嗒 嗒 嗒)\n\n[Verse 1]\n课桌下藏着一角方纸",
  },
];

/** 合成的高熵双 take：时长、标题、soundPrompt、歌词全都拉开。 */
const HIGH_ENTROPY_TAKES: MusicTakeFeature[] = [
  {
    url: "https://example.test/high-a.m4a",
    candidateIndex: 0,
    durationSeconds: 90,
    title: "晨光",
    soundPrompt: "gentle piano ballad warm strings",
    lyricsEcho: "春眠不觉晓处处闻啼鸟夜来风雨声花落知多少",
  },
  {
    url: "https://example.test/high-b.m4a",
    candidateIndex: 1,
    durationSeconds: 200,
    title: "暗涌",
    soundPrompt: "industrial techno harsh metallic bass",
    lyricsEcho: "abcdefghijklmnopqrstuvwxyz0123456789",
  },
];

/**
 * v1/v2 形 fixture：metadata（时长 / 标题 / 歌词）完全相同，只有人声演唱窗口
 * 128s vs 113.9s。这是 2026-10-03 实战真正的岔路口——正规化熵几乎为 0，
 * 必须靠「逐轴实质差异」这条闸放行。
 */
const V1V2_TAKES: MusicTakeFeature[] = [
  {
    url: "https://example.test/v1.m4a",
    candidateIndex: 0,
    durationSeconds: 180,
    title: "同一首歌",
    lyricsEcho: "同一份歌词稿内容完全一致",
    vocalWindowSeconds: 128,
  },
  {
    url: "https://example.test/v2.m4a",
    candidateIndex: 1,
    durationSeconds: 180,
    title: "同一首歌",
    lyricsEcho: "同一份歌词稿内容完全一致",
    vocalWindowSeconds: 113.9,
  },
];

function makeTake(overrides: Partial<MusicTakeFeature> & { url: string }): MusicTakeFeature {
  return { candidateIndex: 0, ...overrides };
}

/**
 * 测试侧独立计算 isPreferenceSaturated 用的正规化熵（仅供印出实际数字对照；
 * 真正的断言是 isPreferenceSaturated 的布林回传）。
 */
function saturationNormalizedEntropy(history: { label: string; count: number }[]): number {
  const samples = history.filter((entry) => Number.isFinite(entry.count) && entry.count > 0);
  const total = samples.reduce((acc, entry) => acc + entry.count, 0);
  const distinct = new Set(samples.map((entry) => entry.label)).size;
  if (total < 3) return 0;
  if (distinct <= 1) return 0;
  let entropy = 0;
  for (const entry of samples) {
    const probability = entry.count / total;
    entropy -= probability * Math.log2(probability);
  }
  return entropy / Math.log2(distinct);
}

test("1. 真实双 take（同标题、近似时长、同歌词）→ 熵低于闸门、不问", () => {
  const question = buildMusicPreferenceQuestion(REAL_TAKES);
  console.log(
    `[REAL_TAKES] entropyBits=${question.entropy.entropyBits} ` +
      `normalizedEntropy=${question.entropy.normalizedEntropy} ` +
      `materialAxes=${JSON.stringify(question.entropy.materialAxes)} ` +
      `maxAxisDistance=${question.entropy.maxAxisDistance} reason=${question.entropy.reason}`,
  );
  assert.equal(question.asked, false);
  assert.ok(question.entropy.normalizedEntropy < 0.25, "真实双 take 正规化熵应低于 0.25");
  assert.deepEqual(question.entropy.materialAxes, [], "真实双 take 不应有实质差异轴");
});

test("2. 合成高熵双 take → 问，且正规化熵 ≥ 0.25", () => {
  const question = buildMusicPreferenceQuestion(HIGH_ENTROPY_TAKES);
  console.log(
    `[HIGH_ENTROPY_TAKES] entropyBits=${question.entropy.entropyBits} ` +
      `normalizedEntropy=${question.entropy.normalizedEntropy} ` +
      `materialAxes=${JSON.stringify(question.entropy.materialAxes)}`,
  );
  assert.equal(question.asked, true);
  assert.ok(question.entropy.normalizedEntropy >= 0.25, "高熵双 take 正规化熵应 ≥ 0.25");
});

test("3. 三个两两最大相异 take → maxEntropyBits = log2(3)，且熵不超上限", () => {
  const takes: MusicTakeFeature[] = [
    makeTake({
      url: "https://example.test/three-0.m4a",
      candidateIndex: 0,
      durationSeconds: 60,
      title: "甲",
      soundPrompt: "guzheng silk ambient",
      lyricsEcho: "床前明月光疑是地上霜",
    }),
    makeTake({
      url: "https://example.test/three-1.m4a",
      candidateIndex: 1,
      durationSeconds: 150,
      title: "乙",
      soundPrompt: "metallic harsh industrial",
      lyricsEcho: "abcdefghijklmnopqrstuvwxyz",
    }),
    makeTake({
      url: "https://example.test/three-2.m4a",
      candidateIndex: 2,
      durationSeconds: 300,
      title: "丙",
      soundPrompt: "warm acoustic folk harmonica",
      lyricsEcho: "1234567890",
    }),
  ];
  const entropy = evaluateTakeSetEntropy(takes);
  assert.ok(Math.abs(entropy.maxEntropyBits - Math.log2(3)) < 1e-9, "maxEntropyBits 应等于 log2(3)");
  assert.ok(entropy.entropyBits <= entropy.maxEntropyBits, "熵不得超过理论上限");
});

test("4. 两个完全相同的 take → 熵 0、不问", () => {
  const base: MusicTakeFeature = {
    url: "https://example.test/same-0.m4a",
    candidateIndex: 0,
    durationSeconds: 120,
    title: "一样",
    soundPrompt: "piano calm",
    lyricsEcho: "同样的歌词内容完全相同",
  };
  const identical: MusicTakeFeature[] = [
    base,
    { ...base, url: "https://example.test/same-1.m4a", candidateIndex: 1 },
  ];
  const entropy = evaluateTakeSetEntropy(identical);
  assert.equal(entropy.entropyBits, 0);
  assert.equal(entropy.normalizedEntropy, 0);
  assert.equal(buildMusicPreferenceQuestion(identical).asked, false);
});

test("5. 单一 take → 不问、suggestedIndex = 0", () => {
  const question = buildMusicPreferenceQuestion([REAL_TAKES[0]]);
  assert.equal(question.asked, false);
  assert.equal(question.suggestedIndex, 0);
  assert.equal(question.entropy.reason, "只有一个候选，无从比较");
});

test("6. 两条退路必定出现在 options 尾端", () => {
  const question = buildMusicPreferenceQuestion(REAL_TAKES);
  assert.equal(question.options.at(-2)!.label, question.fallbackLabels.none);
  assert.equal(question.options.at(-1)!.label, question.fallbackLabels.trustModel);
});

test("7. 选项总数（take 选项 + 2 条退路）≤ 4，且 optionTakeUrls 只含 take 选项", () => {
  const takes: MusicTakeFeature[] = Array.from({ length: 6 }, (_, i) =>
    makeTake({
      url: `https://example.test/six-${i}.m4a`,
      candidateIndex: i,
      durationSeconds: 40 + i * 30,
      title: `标题${i}`,
      soundPrompt: `style-${i} prompt-${i * 7} extra-${i * 13}`,
      lyricsEcho: `第${i}首歌词内容${"甲".repeat(i + 1)}`,
    }),
  );
  const question = buildMusicPreferenceQuestion(takes);
  assert.ok(question.options.length <= 4, "选项总数不得超过 4");
  assert.equal(Object.keys(question.optionTakeUrls).length, question.options.length - 2);
});

test("8. selectEntropyOptions 不会挑出那对近乎相同的候选", () => {
  const similarA = makeTake({
    url: "https://example.test/alike-a.m4a",
    candidateIndex: 0,
    durationSeconds: 120,
    title: "同",
    soundPrompt: "a b c",
    lyricsEcho: "一样的歌词内容完全相同",
  });
  const similarB = makeTake({
    url: "https://example.test/alike-b.m4a",
    candidateIndex: 1,
    durationSeconds: 120,
    title: "同",
    soundPrompt: "a b c",
    lyricsEcho: "一样的歌词内容完全相同",
  });
  const uniqueC = makeTake({
    url: "https://example.test/unique-c.m4a",
    candidateIndex: 2,
    durationSeconds: 60,
    title: "独甲",
    soundPrompt: "guzheng silk ambient",
    lyricsEcho: "床前明月光疑是地上霜",
  });
  const uniqueD = makeTake({
    url: "https://example.test/unique-d.m4a",
    candidateIndex: 3,
    durationSeconds: 300,
    title: "独乙",
    soundPrompt: "metallic harsh industrial",
    lyricsEcho: "abcdefghijklmnopqrstuvwxyz",
  });

  const selected = selectEntropyOptions([similarA, similarB, uniqueC, uniqueD], 2);
  assert.equal(selected.length, 2);
  assert.equal(
    selected.includes(0) && selected.includes(1),
    false,
    "选出的应是彼此最相异的，不含那对近乎相同者",
  );
});

test("9. isPreferenceSaturated 判定与样本数下限", () => {
  const nineToOne = saturationNormalizedEntropy([
    { label: "A", count: 9 },
    { label: "B", count: 1 },
  ]);
  const threeTwoTwo = saturationNormalizedEntropy([
    { label: "A", count: 3 },
    { label: "B", count: 2 },
    { label: "C", count: 2 },
  ]);
  console.log(
    `[isPreferenceSaturated] 9:1 normalized=${nineToOne.toFixed(6)} -> true; ` +
      `3:2:2 normalized=${threeTwoTwo.toFixed(6)} -> false`,
  );
  // 新分母 log2(2)=1、阈值 0.5：0.469 < 0.5 → true。
  assert.equal(isPreferenceSaturated([{ label: "A", count: 9 }, { label: "B", count: 1 }]), true);
  // 3:2:2 的正规化熵 ≈ 0.982（≥ 0.5）→ false。
  assert.equal(
    isPreferenceSaturated([{ label: "A", count: 3 }, { label: "B", count: 2 }, { label: "C", count: 2 }]),
    false,
  );
  assert.equal(isPreferenceSaturated([{ label: "A", count: 1 }, { label: "B", count: 1 }]), false);
  assert.equal(isPreferenceSaturated([{ label: "A", count: 1 }]), false);
});

test("10. 空阵列边界不抛错，asked = false", () => {
  const question = buildMusicPreferenceQuestion([]);
  assert.equal(question.asked, false);
  assert.equal(question.suggestedIndex, 0);
  assert.equal(question.entropy.entropyBits, 0);
  assert.equal(question.optionTakeUrls && Object.keys(question.optionTakeUrls).length, 0);
  assert.equal(question.options.length, 2);
  assert.deepEqual(question.entropy.materialAxes, []);
});

test("11. 偏好饱和时强制不问并沿用主候选", () => {
  const question = buildMusicPreferenceQuestion(HIGH_ENTROPY_TAKES, {
    preferenceHistory: [
      { label: "A", count: 9 },
      { label: "B", count: 1 },
    ],
  });
  assert.equal(question.asked, false);
  assert.equal(question.suggestedIndex, 0);
  assert.match(question.entropy.reason, /偏好已稳定/);
});

test("12. 高熵双 take 问时 suggestedIndex 指向被选中的 take", () => {
  const question = buildMusicPreferenceQuestion(HIGH_ENTROPY_TAKES);
  assert.equal(question.asked, true);
  assert.ok(question.suggestedIndex >= 0 && question.suggestedIndex < HIGH_ENTROPY_TAKES.length);
  assert.equal(question.options.at(-2)!.label, question.fallbackLabels.none);
  assert.equal(question.options.at(-1)!.label, question.fallbackLabels.trustModel);
});

test("13. v1/v2（metadata 全同、只差人声演唱窗口）→ 由逐轴实质差异放行", () => {
  const question = buildMusicPreferenceQuestion(V1V2_TAKES);
  console.log(
    `[V1V2] asked=${question.asked} normalizedEntropy=${question.entropy.normalizedEntropy} ` +
      `materialAxes=${JSON.stringify(question.entropy.materialAxes)} ` +
      `maxAxisDistance=${question.entropy.maxAxisDistance} reason=${question.entropy.reason}`,
  );
  assert.equal(question.asked, true);
  assert.ok(
    question.entropy.materialAxes.includes("vocalWindowSeconds"),
    "materialAxes 应含 vocalWindowSeconds",
  );
  // 证明是「逐轴实质差异」这条闸放行，不是熵这条。
  assert.ok(
    question.entropy.normalizedEntropy < 0.25,
    `v1/v2 归一化熵应低于 0.25，实际 ${question.entropy.normalizedEntropy}`,
  );
  // 人声演唱窗口相对差 14.1/128 ≈ 11%。
  assert.ok(
    Math.abs(question.entropy.maxAxisDistance - 14.1 / 128) < 1e-9,
    "maxAxisDistance 应等于 14.1/128",
  );
  assert.match(question.entropy.reason, /实质差异/);
  assert.match(question.entropy.reason, /人声演唱窗口/);
});

test("14. 真实双 take 维持不问（4.91/179.53 ≈ 2.7% < 5%）", () => {
  const question = buildMusicPreferenceQuestion(REAL_TAKES);
  console.log(
    `[REAL_TAKES] asked=${question.asked} normalizedEntropy=${question.entropy.normalizedEntropy} ` +
      `materialAxes=${JSON.stringify(question.entropy.materialAxes)} ` +
      `maxAxisDistance=${question.entropy.maxAxisDistance} reason=${question.entropy.reason}`,
  );
  assert.equal(question.asked, false);
  assert.deepEqual(question.entropy.materialAxes, [], "无 ASR 栏位且时长差 < 5% → 无实质差异轴");
  assert.ok(question.entropy.maxAxisDistance < 0.05, "最高轴距离应小于 0.05");
  assert.equal(question.entropy.reason, "各版本几乎一致，没有可比较的差异");
});

test("15. isPreferenceSaturated([{A,50},{B,50}]) → false（防回归）", () => {
  const history = [
    { label: "A", count: 50 },
    { label: "B", count: 50 },
  ];
  const normalized = saturationNormalizedEntropy(history);
  console.log(`[isPreferenceSaturated] 50:50 normalized=${normalized.toFixed(6)} -> false`);
  assert.equal(normalized, 1, "k=2 最大不确定时正规化熵应为 1");
  assert.equal(isPreferenceSaturated(history), false);
});

test("16. isPreferenceSaturated([{A,40},{B,1}]) → true", () => {
  const history = [
    { label: "A", count: 40 },
    { label: "B", count: 1 },
  ];
  const normalized = saturationNormalizedEntropy(history);
  console.log(`[isPreferenceSaturated] 40:1 normalized=${normalized.toFixed(6)} -> true`);
  assert.ok(normalized < 0.5, `40:1 正规化熵应 < 0.5，实际 ${normalized}`);
  assert.equal(isPreferenceSaturated(history), true);
});

test("17. 两个完全相同的 take → materialAxes 为空阵列", () => {
  const base: MusicTakeFeature = {
    url: "https://example.test/dup-0.m4a",
    candidateIndex: 0,
    durationSeconds: 120,
    title: "相同",
    soundPrompt: "piano calm",
    lyricsEcho: "完全相同的一首歌",
    vocalWindowSeconds: 100,
    anchorCoverage: 0.8,
    scriptMatchRatio: 0.9,
  };
  const entropy = evaluateTakeSetEntropy([
    base,
    { ...base, url: "https://example.test/dup-1.m4a", candidateIndex: 1 },
  ]);
  assert.deepEqual(entropy.materialAxes, []);
  assert.equal(entropy.maxAxisDistance, 0);
});

test("18. 9:1 与 3:2:2 在新分母下的实际正规化熵值", () => {
  // 9:1 → H = 0.468996 bit、分母 log2(2) = 1 → 0.468996 < 0.5 → true。
  const nineToOne = saturationNormalizedEntropy([
    { label: "A", count: 9 },
    { label: "B", count: 1 },
  ]);
  // 3:2:2 → H = 1.556657 bit、分母 log2(3) = 1.584963 → 0.982137 ≥ 0.5 → false。
  const threeTwoTwo = saturationNormalizedEntropy([
    { label: "A", count: 3 },
    { label: "B", count: 2 },
    { label: "C", count: 2 },
  ]);
  console.log(
    `[entropy-new-denominator] 9:1=${nineToOne.toFixed(6)} (H=0.468996/${Math.log2(2).toFixed(6)}) ` +
      `3:2:2=${threeTwoTwo.toFixed(6)} (H=1.556657/log2(3)=${Math.log2(3).toFixed(6)})`,
  );
  assert.ok(Math.abs(nineToOne - 0.468996) < 1e-5, `9:1 归一化熵应 ≈ 0.468996，实际 ${nineToOne}`);
  assert.ok(Math.abs(threeTwoTwo - 0.982137) < 1e-5, `3:2:2 归一化熵应 ≈ 0.982137，实际 ${threeTwoTwo}`);
  assert.equal(isPreferenceSaturated([{ label: "A", count: 9 }, { label: "B", count: 1 }]), true);
  assert.equal(
    isPreferenceSaturated([{ label: "A", count: 3 }, { label: "B", count: 2 }, { label: "C", count: 2 }]),
    false,
  );
});
