// 站内 TTS 逐字计费的**真行为断言**（非源码字串断言）。
//
// 两层：
//  ① 纯函式：字数 → 币 → 帐本 quota，线性、非 0、真 0 字仍短路。
//  ② 零成本路径：真跑逐镜配音的 dryRun 报价（`planStoryboardVoiceoverDryRun`，
//     结构上不呼叫任何 TTS client），证明「估算口径 × QUOTA_PER_COIN」＝帐本金额
//     `ttsQuotaForChars(totalChars)`，即报价与扣费同一把尺。
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeStoryboardShot } from "@/lib/storyboard-contract";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import {
  CanvasNodeType,
  type CanvasNode,
  type CanvasProject,
} from "@/lib/canvas/types";
import { planStoryboardVoiceoverDryRun } from "@/lib/canvas/storyboard-voiceover";
import {
  TTS_COINS_PER_CHAR,
  ttsCoinsForChars,
  ttsQuotaForChars,
} from "./tts-pricing";

test("费率＝0.001 币/字，100 字 → 0.1 币 → 50,000 quota（暴君 2026-10-01 口径）", () => {
  assert.equal(TTS_COINS_PER_CHAR, 0.001);
  assert.equal(ttsCoinsForChars(100), 0.1);
  assert.equal(ttsQuotaForChars(100), 50_000);
  // 1 字＝500 quota（0.001 币 × QUOTA_PER_COIN）——整数无舍入残差。
  assert.equal(ttsQuotaForChars(1), 500);
  assert.equal(ttsQuotaForChars(1), TTS_COINS_PER_CHAR * QUOTA_PER_COIN);
});

test("billingAmount 随字数线性变化且非 0", () => {
  const samples = [1, 7, 50, 100, 250, 999, 5000];
  for (const chars of samples) {
    const quota = ttsQuotaForChars(chars);
    assert.ok(quota > 0, `chars=${chars} 应 > 0`);
    assert.equal(quota, chars * 500);
  }
  // 线性：f(2n) === 2·f(n)，f(a+b) === f(a)+f(b)。
  assert.equal(ttsQuotaForChars(200), 2 * ttsQuotaForChars(100));
  assert.equal(ttsQuotaForChars(100 + 250), ttsQuotaForChars(100) + ttsQuotaForChars(250));
});

test("真 0 字仍短路（0 额唯一合法成因）；非有限值／负数归 0", () => {
  assert.equal(ttsQuotaForChars(0), 0);
  assert.equal(ttsCoinsForChars(0), 0);
  assert.equal(ttsQuotaForChars(-5), 0);
  assert.equal(ttsQuotaForChars(Number.NaN), 0);
  assert.equal(ttsQuotaForChars(Number.POSITIVE_INFINITY), 0);
});

// ── 零成本真路径：dryRun 报价 → 帐本金额同源 ─────────────────────────────

const NARRATION = "第 一 镜 的 旁 白 台 词"; // 固定字数，逐镜相同

function narrationNode(shotNumber: string): CanvasNode {
  const storyboardShot = normalizeStoryboardShot({ shotNumber, dialogue: "" });
  const metadata: Record<string, unknown> = {};
  if (storyboardShot) metadata.storyboardShot = storyboardShot;
  metadata.narration = NARRATION;
  return {
    id: `node-${shotNumber}`,
    type: CanvasNodeType.Image,
    title: `镜 ${shotNumber}`,
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: metadata as CanvasNode["metadata"],
  };
}

function project(shotCount: number): Pick<CanvasProject, "nodes" | "episodes" | "scriptType" | "narrationVoice"> {
  const nodes = Array.from({ length: shotCount }, (_, i) => narrationNode(`00${i + 1}`));
  return { nodes };
}

test("dryRun（零生成呼叫）报价 × QUOTA_PER_COIN ＝ ttsQuotaForChars(totalChars)，且非 0", () => {
  const plan = planStoryboardVoiceoverDryRun(project(3));
  assert.equal(plan.refused, undefined);
  assert.equal(plan.lines.length, 3);
  assert.equal(plan.totalChars, 3 * NARRATION.length);
  assert.ok(plan.totalChars > 0);
  // 逐行字数＝送去合成的文本长度（收费维度真源）。
  assert.equal(plan.totalChars, plan.lines.reduce((sum, line) => sum + line.chars, 0));
  // 报价口径与帐本扣费同源（同一颗费率）。
  assert.equal(plan.estimatedCoins, plan.totalChars * TTS_COINS_PER_CHAR);
  assert.equal(Math.round(plan.estimatedCoins * QUOTA_PER_COIN), ttsQuotaForChars(plan.totalChars));
  assert.ok(ttsQuotaForChars(plan.totalChars) > 0);
});

test("dryRun 停手对照：真 0 行（无台词）→ totalChars=0 → 金额 0（短路仍成立）", () => {
  const empty: Pick<CanvasProject, "nodes" | "episodes" | "scriptType" | "narrationVoice"> = { nodes: [] };
  const plan = planStoryboardVoiceoverDryRun(empty);
  assert.equal(plan.totalChars, 0);
  assert.equal(plan.estimatedCoins, 0);
  assert.equal(ttsQuotaForChars(0), 0);
});
