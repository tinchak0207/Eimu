/**
 * 創作嚮導 5 步可見模型（**呈現層**）。
 *
 * ── 契約層 vs 呈現層：單向投影，不是兩套真源 ──────────────────────────────
 * 契約層 = `./creation-flow-steps.ts` 的 `CREATION_STEPS`（7 步；AID `CreationStepEnum`
 * 逐字映射，`value` 1..7 與 `aid_comic_episode.current_step` 同值域）。**本檔不修改、
 * 不取代它**：那是 `CanvasProject.currentStep` 的合法值域判據，被 `use-canvas-chat.ts:44`、
 * `canvas/creation-flow-panel.ts:15`、`canvas/layout.ts:12`、`canvas/project-store.ts:8`
 * 消費，改動＝契約值域破裂。
 * 呈現層 = 本檔 `WIZARD_STEPS`（5 步，行業語言：上傳劇本／拆分劇本／資產圖／故事板／視頻）。
 *
 * 兩層關係是**單向投影**（與 repo 既有 `aid-enums → 本站映射` 同構）：
 *   - `WIZARD_STEPS[i].contractFrom..contractTo` 無重疊、無縫鋪滿 1..7；
 *     `contractStepsForWizardStep`（呈現→契約）與 `wizardStepForContractStep`（契約→呈現，
 *     供步驟條高亮）是同一條投影的兩個方向，逐項有測試釘死；
 *   - 反向不成立：契約層不得由呈現層推導。契約值域來自上游 AID，呈現層只是它的
 *     粗粒度視圖 —— 呈現層少一個分組時契約層不受影響（新增第 8 種嚮導步不該改契約）。
 *
 * 投影粒度（為何這樣分）：AID 契約的第 4 條「音画同步」與第 5 條「成品预览」是產出
 * 視頻之後的收尾環節，行業用戶的粗粒度語言把「視頻生成→配音→成片」統稱作「視頻」，
 * 因此 5 步的末步涵蓋契約值 5..7。第 1 步（上傳劇本）涵蓋契約值 1（项目配置）：
 * 在本站，作品/劇集配置與劇本上傳是同一段「把劇本交進來」的工序。
 *
 * 本檔為純常數 + 純函數（唯一外部依賴＝模型目錄的即時定價，見下），無副作用。
 */

import { creationStepMeta, type CreationStep } from "./creation-flow-steps";
import { generationCoins, generationModel } from "./generation-model-catalog";
import { DEFAULT_IMAGE_MODEL_ID, VEO_31_FAST_MODEL_ID } from "./image-model-ids.js";

/** 嚮導步值（呈現層值域，1..5）。與契約層 `CREATION_STEPS[].value`（1..7）**不同值域**。 */
export type WizardStepValue = 1 | 2 | 3 | 4 | 5;

export type WizardStepKey = "upload-script" | "split-script" | "assets" | "shots" | "video";

/** 步驟條可開啟的審查面板目標（決策 10/24：資產審查面板與分鏡審查面板）。 */
export type WizardReviewTarget = "assets" | "shots";

/**
 * 該步的預估花費口徑（決策 16：看得見但不攔）。
 * 單價一律由模型目錄**即時**算（`generationCoins`，管理員改價後立刻反映），
 * 不寫死幣數 —— 倉庫既有模式見 `src/components/history/RerunDialog.tsx:9`。
 */
export interface WizardStepCostBasis {
  /** text ＝ 文本環節（按用量計費，不走圖/視頻費率表）。 */
  readonly kind: "text" | "image" | "video";
  /** 圖/視頻步的報價模型。 */
  readonly modelId?: string;
  /** 生成次數：圖＝張數、視頻＝鏡數。 */
  readonly quantity?: number;
  /** 視頻：每鏡秒數；缺省＝該模型目錄的默認時長。 */
  readonly durationSeconds?: number;
}

export interface WizardStep {
  readonly value: WizardStepValue;
  readonly key: WizardStepKey;
  readonly label: string;
  /** 該步在契約層涵蓋的起始值（含）。 */
  readonly contractFrom: number;
  /** 該步在契約層涵蓋的結束值（含）。 */
  readonly contractTo: number;
  /** 該步可開啟的審查面板（僅資產圖／故事板有）。 */
  readonly review?: WizardReviewTarget;
  readonly cost: WizardStepCostBasis;
}

/**
 * 5 步可見模型（順序即工序順序）。
 * 數量口徑為**默認估算假設**（資產圖 6 張＝主演資產視圖 + 場景/道具變體；故事板 12 鏡；
 * 視頻 12 鏡）。標籤一律把假設的數量印出來，讓「看得見」不是一個無來源的數字。
 */
export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    value: 1,
    key: "upload-script",
    label: "上传剧本",
    contractFrom: 1,
    contractTo: 1,
    cost: { kind: "text" },
  },
  {
    value: 2,
    key: "split-script",
    label: "拆分剧本",
    contractFrom: 2,
    contractTo: 2,
    cost: { kind: "text" },
  },
  {
    value: 3,
    key: "assets",
    label: "资产图",
    contractFrom: 3,
    contractTo: 3,
    review: "assets",
    cost: { kind: "image", modelId: DEFAULT_IMAGE_MODEL_ID, quantity: 6 },
  },
  {
    value: 4,
    key: "shots",
    label: "故事板",
    contractFrom: 4,
    contractTo: 4,
    review: "shots",
    cost: { kind: "image", modelId: DEFAULT_IMAGE_MODEL_ID, quantity: 12 },
  },
  {
    value: 5,
    key: "video",
    label: "视频",
    contractFrom: 5,
    contractTo: 7,
    cost: { kind: "video", modelId: VEO_31_FAST_MODEL_ID, quantity: 12, durationSeconds: 5 },
  },
] as const;

/** 嚮導步值合法判據（呈現層值域 1..5 整數）。 */
export function isValidWizardStep(value: unknown): value is WizardStepValue {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= WIZARD_STEPS.length;
}

/** 嚮導步值 → 步驟元資料；非法值回 undefined。 */
export function wizardStepMeta(value: unknown): WizardStep | undefined {
  return isValidWizardStep(value) ? WIZARD_STEPS[value - 1] : undefined;
}

/**
 * 呈現 → 契約投影：該嚮導步涵蓋的契約步（逐項解析 `CREATION_STEPS`）。
 * 涵蓋區間外的契約值（未來 AID 擴值域）不會被靜默吸收 —— `creationStepMeta` 回 undefined
 * 即剔除，呼叫端看到的是「投影少了幾步」而不是「投影到幻影步」。
 */
export function contractStepsForWizardStep(value: unknown): readonly CreationStep[] {
  const step = wizardStepMeta(value);
  if (!step) return [];
  const out: CreationStep[] = [];
  for (let contract = step.contractFrom; contract <= step.contractTo; contract += 1) {
    const meta = creationStepMeta(contract);
    if (meta) out.push(meta);
  }
  return out;
}

/** 契約 → 呈現投影（步驟條高亮用）：契約值落在哪個嚮導步；值域外回 undefined。 */
export function wizardStepForContractStep(value: unknown): WizardStep | undefined {
  const meta = creationStepMeta(value);
  if (!meta) return undefined;
  return WIZARD_STEPS.find((step) => meta.value >= step.contractFrom && meta.value <= step.contractTo);
}

export type WizardStepState = "done" | "current" | "pending";

export interface WizardStepProgress {
  readonly step: WizardStep;
  readonly state: WizardStepState;
}

/**
 * 契約當前步 → 步驟條逐格狀態（決策 13：兩檔都顯示；全自動檔只讀進度看它一格格跑完）。
 * 契約值未知（undefined／值域外）→ 全部 `pending`：不知道進度時不捏造一個「當前步」。
 */
export function wizardProgress(contractStep: unknown): readonly WizardStepProgress[] {
  const current = wizardStepForContractStep(contractStep);
  if (!current) return WIZARD_STEPS.map((step) => ({ step, state: "pending" as const }));
  return WIZARD_STEPS.map((step) => ({
    step,
    state: step.contractTo < current.contractFrom ? "done" : step.contractFrom > current.contractFrom ? "pending" : "current",
  }));
}

export interface WizardRerunPlan {
  /** 被點回的步驟。 */
  readonly target: WizardStep;
  /** 要重跑的步驟＝該步與其後續（決策 15：只重跑後續，不回退已完成的前置步）。 */
  readonly rerun: readonly WizardStep[];
  /** 要重跑的契約步值域（同一條投影的契約側視圖，呼叫端不必自己再投影一次）。 */
  readonly rerunContractSteps: readonly CreationStep[];
}

/** 回跳計畫（決策 15）：點已完成步 → 回報「要重跑該步與其後續」；值域外回 undefined。 */
export function wizardRerunPlan(value: unknown): WizardRerunPlan | undefined {
  const target = wizardStepMeta(value);
  if (!target) return undefined;
  const rerun = WIZARD_STEPS.filter((step) => step.value >= target.value);
  return {
    target,
    rerun,
    rerunContractSteps: rerun.flatMap((step) => contractStepsForWizardStep(step.value)),
  };
}

/**
 * 步驟條單格的點擊語義（決策 13/15 + 面板入口決策 10）。
 * 抽成純函數的理由：這是「點下去會發生什麼」的全部規則，不該埋在 JSX 的分支裡
 * —— 元件只負責把結果派給 `onOpenReview` / `onRewind`。
 */
export type WizardStepAction =
  | { readonly kind: "review"; readonly target: WizardReviewTarget }
  | { readonly kind: "rewind"; readonly plan: WizardRerunPlan };

export interface WizardStepActionContext {
  /** 全自動檔＝只讀進度（決策 13），任何格子都不可點。 */
  readonly readOnly?: boolean;
  /** 呼叫端是否真的提供了 `onOpenReview`（沒提供＝點了沒反應，就不該是可點的鈕）。 */
  readonly canReview?: boolean;
  /** 呼叫端是否真的提供了 `onRewind`。 */
  readonly canRewind?: boolean;
}

/** 該格的點擊語義；不可點時回 undefined。 */
export function resolveWizardStepAction(
  step: WizardStep,
  state: WizardStepState,
  context: WizardStepActionContext = {},
): WizardStepAction | undefined {
  if (context.readOnly) return undefined;
  // 審查步優先：資產圖／故事板的改動入口就是面板（逐張重生成/替換/上傳，決策 3）。
  if (step.review && context.canReview) return { kind: "review", target: step.review };
  if (state === "done" && context.canRewind) {
    const plan = wizardRerunPlan(step.value);
    if (plan) return { kind: "rewind", plan };
  }
  return undefined;
}

export interface WizardStepCostOptions {
  /** 覆寫生成次數（圖＝張數 / 視頻＝鏡數）。 */
  readonly quantity?: number;
  /** 覆寫報價模型（例如劇集自選的資產模型）。 */
  readonly modelId?: string;
}

/** 該步的生成次數（含覆寫）。text 步回 0。 */
export function wizardStepUnitCount(step: WizardStep, options: WizardStepCostOptions = {}): number {
  if (step.cost.kind === "text") return 0;
  const quantity = options.quantity ?? step.cost.quantity ?? 0;
  return Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
}

/** 該步的單價（圖＝币/張、視頻＝币/鏡）；text 步與未知模型回 0。走目錄即時價，不寫死。 */
export function wizardStepUnitCoins(step: WizardStep, options: WizardStepCostOptions = {}): number {
  if (step.cost.kind === "text") return 0;
  const modelId = options.modelId ?? step.cost.modelId;
  if (!modelId) return 0;
  const model = generationModel(modelId);
  // 未知模型**不報價**：`generationCoins` 對未知 id 會回 1（那是給後端扣費的兜底），
  // 拿它當「預估花費」展示等於編一個幣數出來 —— 寧可顯示「价格待定」。
  if (!model) return 0;
  if (step.cost.kind === "video") {
    const duration = step.cost.durationSeconds ?? model.defaultDuration ?? 1;
    return generationCoins(modelId, { durationSeconds: duration });
  }
  return generationCoins(modelId);
}

/** 該步預估花費總額（單價 × 次數）。 */
export function wizardStepCoins(step: WizardStep, options: WizardStepCostOptions = {}): number {
  const unit = wizardStepUnitCoins(step, options);
  const count = wizardStepUnitCount(step, options);
  if (unit <= 0 || count <= 0) return 0;
  return roundCoins(unit * count);
}

/** 幣數顯示：去掉浮點尾巴（0.1+0.2 這類），不補零。 */
function roundCoins(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 該步的預估花費標籤（決策 16）。
 * text 步**不給幣數**：文本環節走 token 計費，這裡編一個幣數就是灌水。
 */
export function wizardStepCostLabel(step: WizardStep, options: WizardStepCostOptions = {}): string {
  if (step.cost.kind === "text") return "按用量计费";
  const coins = wizardStepCoins(step, options);
  const count = wizardStepUnitCount(step, options);
  if (coins <= 0 || count <= 0) return "价格待定";
  if (step.cost.kind === "video") {
    const modelId = options.modelId ?? step.cost.modelId;
    const seconds = step.cost.durationSeconds ?? (modelId ? generationModel(modelId)?.defaultDuration : undefined) ?? 1;
    return `约 ${coins} 币 · ${count} 镜 × ${seconds}s`;
  }
  return `约 ${coins} 币 · ${count} 张`;
}