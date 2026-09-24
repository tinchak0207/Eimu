// 創作嚮導 5 步可見模型（呈現層）＋ 步驟條行為測試（2026-09-24）。
//
// 釘死的事（每條都是真行為斷言，不是「檔案存在/字串在」的探針）：
//   1. 5 步**單向投影**到契約層 `CREATION_STEPS`（7 步未動）：逐項斷言投影回哪個契約步，
//      且回傳的是契約層的**同一個物件**（證明是投影，不是複製一份 7 步表）；
//      5 步的涵蓋區間無重疊、無縫鋪滿 1..7。
//   2. 契約當前步 → 步驟條逐格狀態（done/current/pending）：當前步隨狀態改變。
//   3. 點擊語義（決策 13/15）：已完成步回跳回報「該步與其後續」、全自動檔不可點、
//      資產圖/故事板點擊優先開審查面板。
//   4. 每步預估花費（決策 16）：單價由模型目錄即時算（不寫死），文本步**不編幣數**。
//   5. 步驟條 SSR：當前步標記、回跳鈕 aria-label、readOnly 下零按鈕。
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig jsx=preserve → classic runtime，SSR 渲染前補全局 React 桩
// （Scene3dPreview.test.ts / creation-flow-panel.test.ts 同款）。
(globalThis as unknown as Record<string, unknown>).React ??= React;

import { CREATION_STEPS, isValidCreationStep } from "./creation-flow-steps";
import { generationCoins } from "./generation-model-catalog";
import { DEFAULT_IMAGE_MODEL_ID, VEO_31_FAST_MODEL_ID } from "./image-model-ids.js";
import {
  WIZARD_STEPS,
  contractStepsForWizardStep,
  isValidWizardStep,
  resolveWizardStepAction,
  wizardProgress,
  wizardRerunPlan,
  wizardStepCoins,
  wizardStepCostLabel,
  wizardStepForContractStep,
  wizardStepMeta,
  wizardStepUnitCoins,
  type WizardStep,
} from "./wizard-steps";
import { CreationStepBar } from "@/components/canvas/embed/CreationFlowPanel";

function step(value: number): WizardStep {
  const meta = wizardStepMeta(value);
  assert.ok(meta, `第 ${value} 步必須存在`);
  return meta;
}

// ─────────────────────────── 1. 呈現層模型與投影（逐項）

test("5 步呈現模型＝行業語言，值域 1..5，契約層 7 步一個字沒動", () => {
  assert.deepEqual(
    WIZARD_STEPS.map((s) => s.label),
    ["上传剧本", "拆分剧本", "资产图", "故事板", "视频"],
  );
  assert.deepEqual(
    WIZARD_STEPS.map((s) => s.value),
    [1, 2, 3, 4, 5],
  );
  assert.equal(isValidWizardStep(5), true);
  for (const bad of [0, 6, -1, 1.5, "3", null, undefined, Number.NaN]) {
    assert.equal(isValidWizardStep(bad), false, `${String(bad)} 不是嚮導步值`);
    assert.equal(wizardStepMeta(bad), undefined);
  }
  // 契約層仍舊是 7 步（本片不得改它）
  assert.equal(CREATION_STEPS.length, 7);
  assert.equal(isValidCreationStep(7), true);
  assert.equal(isValidCreationStep(8), false);
});

test("投影逐項：每個嚮導步回它涵蓋的契約步（且是契約層的同一個物件）", () => {
  const expected: Record<number, number[]> = {
    1: [1], // 上傳劇本 ← 项目配置
    2: [2], // 拆分劇本 ← 剧本创作
    3: [3], // 資產圖   ← 素材准备
    4: [4], // 故事板   ← 分镜设计
    5: [5, 6, 7], // 視頻 ← 视频生成 / 音画同步 / 成品预览
  };
  for (const [wizard, contractValues] of Object.entries(expected)) {
    const projected = contractStepsForWizardStep(Number(wizard));
    assert.deepEqual(
      projected.map((s) => s.value),
      contractValues,
      `嚮導第 ${wizard} 步投影出的契約步值`,
    );
    assert.deepEqual(
      projected.map((s) => s.label),
      contractValues.map((v) => CREATION_STEPS[v - 1].label),
      "投影出的標籤必須就是契約層的標籤（呈現層不自帶第二份文案）",
    );
    // 同一物件：證明這條是投影而不是複製
    projected.forEach((s, i) => {
      assert.equal(s, CREATION_STEPS[contractValues[i] - 1], "投影必須回契約層的同一個實例");
    });
  }
  // 非法值投影為空，不吐幻影步
  for (const bad of [0, 6, "3", undefined, null]) {
    assert.deepEqual(contractStepsForWizardStep(bad), []);
  }
});

test("投影是分割：5 步涵蓋區間無重疊、無縫鋪滿契約值 1..7（順序單調）", () => {
  let cursor = 1;
  for (const s of WIZARD_STEPS) {
    assert.equal(s.contractFrom, cursor, `${s.label} 的起點必須緊接上一步`);
    assert.ok(s.contractTo >= s.contractFrom, `${s.label} 的區間不得倒置`);
    cursor = s.contractTo + 1;
  }
  assert.equal(cursor, CREATION_STEPS.length + 1, "5 步必須剛剛鋪滿契約層 1..7");
  // 反投影：每個契約值恰好落在一格裡，且 round-trip 回自己
  for (const contract of CREATION_STEPS) {
    const owner = wizardStepForContractStep(contract.value);
    assert.ok(owner, `契約第 ${contract.value} 步必須有主`);
    assert.ok(
      owner.contractFrom <= contract.value && contract.value <= owner.contractTo,
      "反投影回的嚮導步必須真的涵蓋該契約值",
    );
    assert.ok(
      contractStepsForWizardStep(owner.value).includes(contract),
      "契約步必須在它主人的投影集合裡（兩方向必互為反函數）",
    );
  }
  for (const bad of [0, 8, 2.5, "4", undefined]) {
    assert.equal(wizardStepForContractStep(bad), undefined, `${String(bad)} 不該有主人`);
  }
});

// ─────────────────────────── 2. 當前步隨狀態改變

test("wizardProgress：契約當前步 → 逐格 done/current/pending（當前步隨狀態移動）", () => {
  const shape = (contract: unknown) =>
    wizardProgress(contract).map((entry) => `${entry.step.key}:${entry.state}`);
  assert.deepEqual(shape(1), [
    "upload-script:current",
    "split-script:pending",
    "assets:pending",
    "shots:pending",
    "video:pending",
  ]);
  assert.deepEqual(shape(2), [
    "upload-script:done",
    "split-script:current",
    "assets:pending",
    "shots:pending",
    "video:pending",
  ]);
  assert.deepEqual(shape(3), [
    "upload-script:done",
    "split-script:done",
    "assets:current",
    "shots:pending",
    "video:pending",
  ]);
  assert.deepEqual(shape(4), [
    "upload-script:done",
    "split-script:done",
    "assets:done",
    "shots:current",
    "video:pending",
  ]);
  // 契約末步（音画同步 6 / 成品预览 7）都投到嚮導末步「視頻」，且前面四步全 done
  for (const contract of [5, 6, 7]) {
    assert.deepEqual(shape(contract), [
      "upload-script:done",
      "split-script:done",
      "assets:done",
      "shots:done",
      "video:current",
    ], `契約第 ${contract} 步`);
  }
  // 不知道進度時不捏造當前步
  for (const unknown of [undefined, 0, 8, 2.5, null, "4"]) {
    assert.deepEqual(
      shape(unknown),
      WIZARD_STEPS.map((s) => `${s.key}:pending`),
      `${String(unknown)}：契約值未知 → 全部待辦`,
    );
  }
  assert.equal(wizardProgress(4).length, 5);
});

// ─────────────────────────── 3. 點擊語義（決策 13/15 + 面板入口）

test("回跳計畫：回報「該步與其後續」，並附契約側值域（只重跑後續，不動前置步）", () => {
  const plan = wizardRerunPlan(3);
  assert.ok(plan);
  assert.equal(plan.target.key, "assets");
  assert.deepEqual(plan.rerun.map((s) => s.label), ["资产图", "故事板", "视频"]);
  assert.deepEqual(plan.rerunContractSteps.map((s) => s.value), [3, 4, 5, 6, 7]);
  assert.deepEqual(
    plan.rerunContractSteps.map((s) => s.value),
    plan.rerun.flatMap((s) => contractStepsForWizardStep(s.value).map((c) => c.value)),
    "契約側回報必須與呈現側一致（呼叫端不必自己再投影一次）",
  );
  const first = wizardRerunPlan(1);
  assert.ok(first);
  assert.deepEqual(first.rerun.map((s) => s.value), [1, 2, 3, 4, 5]);
  const last = wizardRerunPlan(5);
  assert.ok(last);
  assert.deepEqual(last.rerun.map((s) => s.value), [5]);
  assert.deepEqual(last.rerunContractSteps.map((s) => s.value), [5, 6, 7]);
  assert.equal(wizardRerunPlan(6), undefined);
  assert.equal(wizardRerunPlan(undefined), undefined);
});

test("點擊語義：全自動檔（readOnly）零可點；已完成步回跳；資產圖/故事板優先開審查面板", () => {
  const assets = step(3);
  const shots = step(4);
  const upload = step(1);

  // 全自動檔：一格都不可點（決策 13：只讀進度）
  for (const s of WIZARD_STEPS) {
    for (const state of ["done", "current", "pending"] as const) {
      assert.equal(
        resolveWizardStepAction(s, state, { readOnly: true, canReview: true, canRewind: true }),
        undefined,
        `${s.label}/${state} 在全自動檔下不得可點`,
      );
    }
  }

  // 審查步：只要有 onOpenReview 就可開面板（決策 10：主入口綁步驟條）
  assert.deepEqual(resolveWizardStepAction(assets, "current", { canReview: true, canRewind: true }), {
    kind: "review",
    target: "assets",
  });
  assert.deepEqual(resolveWizardStepAction(shots, "pending", { canReview: true, canRewind: true }), {
    kind: "review",
    target: "shots",
  });
  // 兩個入口都給時，審查優先於回跳（資產圖的改動入口就是面板本身）
  assert.equal(resolveWizardStepAction(assets, "done", { canReview: true, canRewind: true })?.kind, "review");

  // 非審查步：已完成 → 回跳（決策 15）
  const rewind = resolveWizardStepAction(upload, "done", { canRewind: true });
  assert.equal(rewind?.kind, "rewind");
  assert.deepEqual(rewind && rewind.kind === "rewind" ? rewind.plan.rerun.map((s) => s.value) : [], [1, 2, 3, 4, 5]);
  // 當前步／未來步不可回跳（回跳只對已完成步開放）
  assert.equal(resolveWizardStepAction(upload, "current", { canRewind: true }), undefined);
  assert.equal(resolveWizardStepAction(upload, "pending", { canRewind: true }), undefined);
  // 呼叫端沒接 handler → 不得回一個「點了沒反應」的動作
  assert.equal(resolveWizardStepAction(upload, "done", { canRewind: false }), undefined);
  assert.equal(resolveWizardStepAction(upload, "done", {}), undefined);
  assert.equal(resolveWizardStepAction(assets, "current", { canReview: false, canRewind: false }), undefined);
});

// ─────────────────────────── 4. 每步預估花費（決策 16）

test("預估花費：單價走模型目錄即時價（不寫死幣數），總額＝單價 × 次數", () => {
  const assets = step(3);
  const unit = generationCoins(DEFAULT_IMAGE_MODEL_ID); // oracle＝計費側同一條目錄價
  assert.ok(unit > 0, "默認圖片模型必須有價");
  assert.equal(wizardStepUnitCoins(assets), unit, "單價必須等於目錄即時價（管理員改價即反映）");
  assert.equal(wizardStepCoins(assets), Math.round(unit * 6 * 100) / 100);
  // 線性：覆寫張數 → 總額按比例走（不是一個寫死的常數）
  assert.equal(wizardStepCoins(assets, { quantity: 3 }), Math.round(unit * 3 * 100) / 100);
  assert.equal(wizardStepCostLabel(assets, { quantity: 3 }), `约 ${Math.round(unit * 3 * 100) / 100} 币 · 3 张`);

  // 視頻步：單價＝每秒價 × 單鏡秒數，總額再乘鏡數（時長/鏡數兩個口徑都可見）
  const video = step(5);
  const perShot = generationCoins(VEO_31_FAST_MODEL_ID, { durationSeconds: 5 });
  assert.ok(perShot > 0, "默認視頻模型必須有價");
  assert.equal(wizardStepUnitCoins(video), perShot);
  assert.equal(wizardStepCoins(video), Math.round(perShot * 12 * 100) / 100);
  assert.match(wizardStepCostLabel(video), /币 · 12 镜 × 5s$/);

  // 非法次數不產生負數/NaN 報價
  for (const bad of [0, -3, 1.5, Number.NaN]) {
    assert.equal(wizardStepCoins(assets, { quantity: bad }), 0, `quantity=${String(bad)}`);
    assert.equal(wizardStepCostLabel(assets, { quantity: bad }), "价格待定");
  }
  // 未知模型不報價（generationCoins 對未知 id 的兜底 1 幣是扣費用的，不能當展示價）
  assert.equal(wizardStepUnitCoins(assets, { modelId: "no-such-model" }), 0);
  assert.equal(wizardStepCostLabel(assets, { modelId: "no-such-model" }), "价格待定");
});

test("預估花費：文本步不編幣數（按用量計費），不冒充一口價", () => {
  for (const value of [1, 2]) {
    const s = step(value);
    assert.equal(s.cost.kind, "text");
    assert.equal(wizardStepUnitCoins(s), 0);
    assert.equal(wizardStepCoins(s), 0);
    assert.equal(wizardStepCostLabel(s), "按用量计费");
    assert.doesNotMatch(wizardStepCostLabel(s), /币/, "文本環節走 token 計費，不得印一個假的幣數");
  }
});

// ─────────────────────────── 5. 步驟條 SSR

test("步驟條 SSR：5 步全印、當前步標記隨狀態移動、花費可見、審查入口標示", () => {
  const html = renderToStaticMarkup(createElement(CreationStepBar, { contractStep: 4, onRewind: () => {} }));
  for (const label of ["上传剧本", "拆分剧本", "资产图", "故事板", "视频"]) {
    assert.match(html, new RegExp(label), `${label} 必須印出`);
  }
  assert.match(html, />故事板<span[^>]*>· 进行中/, "當前步（契約 4＝故事板）必須被標成進行中");
  assert.doesNotMatch(html, />资产图<span[^>]*>· 进行中/, "非當前步不得標成進行中");
  assert.match(html, /按用量计费/, "文本步按用量計費");
  assert.match(html, /约 [\d.]+ 币 · 6 张/, "資產圖步顯示預估花費與張數口徑");
  assert.match(html, /约 [\d.]+ 币 · 12 镜 × 5s/, "視頻步顯示鏡數 × 秒數口徑");
  assert.match(html, /审查/, "資產圖/故事板要標出可進審查面板");

  const moved = renderToStaticMarkup(createElement(CreationStepBar, { contractStep: 3, onRewind: () => {} }));
  assert.match(moved, />资产图<span[^>]*>· 进行中/, "契約 3 → 當前步移到資產圖");
  assert.doesNotMatch(moved, />故事板<span[^>]*>· 进行中/);
  assert.doesNotMatch(moved, /· 进行中[\s\S]*· 进行中/, "同一個步驟條只能有一個當前步");
});

test("步驟條 SSR：回跳鈕帶「要重跑該步與其後續」，readOnly 下零按鈕", () => {
  const html = renderToStaticMarkup(
    createElement(CreationStepBar, { contractStep: 4, onRewind: () => {} }),
  );
  assert.match(
    html,
    /aria-label="回跳重跑：资产图、故事板、视频"/,
    "點已完成步回報要重跑該步與其後續（決策 15）",
  );
  assert.match(html, /aria-label="回跳重跑：上传剧本、拆分剧本、资产图、故事板、视频"/);
  assert.doesNotMatch(html, /storyboardShot|artifact/, "步驟條不碰節點 metadata");

  // 接了 onOpenReview：資產圖/故事板變成開面板的鈕
  const reviewable = renderToStaticMarkup(
    createElement(CreationStepBar, { contractStep: 4, onOpenReview: () => {}, onRewind: () => {} }),
  );
  assert.match(reviewable, /aria-label="打开资产图审查面板"/);
  assert.match(reviewable, /aria-label="打开故事板审查面板"/);

  // 全自動檔：只讀進度 → 一格按鈕都不渲染（決策 13：不新增任何阻塞）
  const readOnly = renderToStaticMarkup(
    createElement(CreationStepBar, { contractStep: 4, onOpenReview: () => {}, onRewind: () => {}, readOnly: true }),
  );
  assert.doesNotMatch(readOnly, /<button/, "readOnly 下不得有任何可點鈕");
  assert.match(readOnly, />故事板<span[^>]*>· 进行中/, "但進度照樣看得到");
});