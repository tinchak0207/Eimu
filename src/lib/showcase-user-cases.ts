import type { HistoryEntry } from "./history-types";
import type { ShowcaseCase, ShowcaseRecipe } from "./showcase-cases";
import { extractPromptSection } from "./workflow-recall";

/**
 * ⚠️ 已裁定禁止能力的残留（DO NOT WIRE UP）—— 这不是「未完成的待接功能」。
 *
 * 铁律：不接受任何自定义用户发布内容（项目负责人裁定，2026-10-01 重申）。
 * 「用户把配方发布成案例、放上公开面」属于该类内容，已被明确裁定不做；
 * 本文件只是历史残留下的数据层实现，保留原因仅为了方便日后追溯，
 * 不代表它应该被接线、也不代表有任何排期。
 *
 * 真实状态：
 *   - 生产零调用者（仅被本文件的 .test.ts 与 AgentTemplateCarousel 的一句注释提到）；
 *   - 数据只落本机 localStorage（键见 STORAGE_KEY），没有服务端、没有端点、没有审核流。
 *
 * 若未来有人要「把用户内容放上公开面」，禁止直接接续本文件的 read/publish：
 * 必须先回去问项目负责人，取得明确授权后才谈设计；在此之前不得为它补服务端、
 * 端点、公开列表或审核状态机。
 *
 * ── 以下为历史实现说明（背景参考，非使用指引）──
 * 用户投稿案例（2026-08-25 配方资产总线：showcase 案例双向化）。
 *
 * showcase 官方数据是静态 TS 文件，这里先做数据层扩展点 + 最小可用发布路径：
 * 历史里的配方一键发布为「用户投稿」案例，存 localStorage（键见 STORAGE_KEY），
 * 首页案例环读取后与官方案例合并展示。无审核流 —— 案例只在发布者自己的
 * 浏览器里可见，后续接服务端审核时只需替换 read/publish 两个函数的实现。
 */

export interface ShowcaseUserCase extends ShowcaseCase {
  source: "community";
  publishedAt: number;
}

export type PublishUserCaseResult =
  | { ok: true; alreadyPublished: boolean }
  | { ok: false; reason: string };

const STORAGE_KEY = "emu.showcase.user-cases.v1";
/** 本地存储上限：localStorage 容量有限，配方元数据优先，超限丢最旧的。 */
const MAX_USER_CASES = 12;
/** 与工作站 WORKFLOW_SCHEMA_VERSION 保持一致（避免值导入把客户端依赖带进 node --test）。 */
const RECIPE_SCHEMA_VERSION = 2;

/** 用户案例的兜底视觉：没有可公网访问的成片 URL 时，用渐变占位。 */
const USER_GRADIENTS: Array<{ gradient: string; glow: string }> = [
  { gradient: "from-[#E8F0F2] via-[#B8C9D4] to-[#7E97A8]", glow: "#7E97A8" },
  { gradient: "from-[#F3E9DC] via-[#C9A87C] to-[#8E6E4B]", glow: "#B08D5F" },
  { gradient: "from-[#EDE7F6] via-[#B39DDB] to-[#673AB7]", glow: "#8E6FC8" },
  { gradient: "from-[#E0F2F1] via-[#80CBC4] to-[#00796B]", glow: "#3D9B90" },
];

function pickVisual(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return USER_GRADIENTS[hash % USER_GRADIENTS.length];
}

/** 从历史记录构造发布案例的配方快照：字段与工作站 buildProvenanceConfig 同构。 */
export function buildRecipeFromHistoryEntry(entry: HistoryEntry): ShowcaseRecipe {
  const workflow = entry.workflow;
  const modelId = entry.modelId ?? entry.results.find((result) => result.modelId)?.modelId;
  const prompt = extractPromptSection(entry.prompt);
  const recipe: ShowcaseRecipe = {
    schemaVersion: workflow?.schemaVersion ?? RECIPE_SCHEMA_VERSION,
    prompt,
    ...(workflow?.contextPrompt ? { contextPrompt: workflow.contextPrompt } : {}),
    ...(workflow?.negativePrompt ? { negativePrompt: workflow.negativePrompt } : {}),
    ...(workflow?.workflowPreset ? { workflowPreset: workflow.workflowPreset } : {}),
    ...(workflow?.workflowPresetLabel ? { workflowPresetLabel: workflow.workflowPresetLabel } : {}),
    ...(workflow?.promptHint ? { promptHint: workflow.promptHint } : {}),
    ...(workflow?.negativeHint ? { negativeHint: workflow.negativeHint } : {}),
    ...(workflow?.productionIntent ? { productionIntent: workflow.productionIntent } : {}),
    ...(workflow?.imageSizes?.length ? { imageSizes: workflow.imageSizes } : {}),
    ...(workflow?.imageSize && !workflow.imageSizes?.length ? { imageSize: workflow.imageSize } : {}),
    ...(workflow?.styleTemplate ? { styleTemplate: workflow.styleTemplate } : {}),
    ...(workflow?.qualityProfile ? { qualityProfile: workflow.qualityProfile } : {}),
    ...(workflow?.seedHint ? { seedHint: workflow.seedHint } : {}),
    ...(workflow?.regionalPrompts?.length ? { regionalPrompts: workflow.regionalPrompts } : {}),
    ...(workflow?.referenceImages?.length ? { referenceImages: workflow.referenceImages } : {}),
    ...(workflow?.copies ? { copies: workflow.copies } : {}),
    ...(workflow?.concurrency ? { concurrency: workflow.concurrency } : {}),
    ...(modelId ? { modelId } : {}),
  };
  return recipe;
}

/** 历史记录 → 用户投稿案例。只取可公网访问的成片 URL；base64 太大不落 localStorage。 */
export function buildUserShowcaseCase(entry: HistoryEntry): ShowcaseUserCase {
  const recipe = buildRecipeFromHistoryEntry(entry);
  const modelId = recipe.modelId;
  const imageUrl = entry.results.find((result) => result.imageUrl)?.imageUrl ?? undefined;
  const visual = pickVisual(entry.id);
  const title =
    entry.workflow?.workflowPresetLabel
    ?? (recipe.prompt ? recipe.prompt.slice(0, 18) : "我的配方");
  return {
    id: "user-" + entry.id,
    title,
    category: "用户投稿",
    // 配方快照已携带全部真实参数；style 只服务「带入生成器」的普通模式路径。
    style: "none",
    prompt: recipe.prompt ?? entry.prompt.trim(),
    resultNote: modelId ? "发布自个人历史 · " + modelId : "发布自个人历史 · 用户投稿配方",
    gradient: visual.gradient,
    ...(imageUrl ? { image: imageUrl } : {}),
    glow: visual.glow,
    source: "community",
    recipe,
    publishedAt: Date.now(),
  };
}

/** 官方案例在前、用户投稿在后，拼成案例环的完整数据。 */
export function mergeShowcaseCases(base: ShowcaseCase[], user: ShowcaseUserCase[]): ShowcaseCase[] {
  return [...base, ...user];
}

function parseStoredCases(raw: string | null): ShowcaseUserCase[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.prompt !== "string") return [];
      if (record.source !== "community") return [];
      return [{ ...(record as unknown as ShowcaseUserCase), source: "community" }];
    });
  } catch {
    return [];
  }
}

export function readUserShowcaseCases(storage?: Storage | null): ShowcaseUserCase[] {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!store) return [];
  return parseStoredCases(store.getItem(STORAGE_KEY));
}

/** 把一条历史发布为案例（幂等：同一历史重复发布返回 alreadyPublished）。 */
export function publishUserShowcaseCase(
  entry: HistoryEntry,
  storage?: Storage | null,
): PublishUserCaseResult {
  if (!entry.prompt.trim() && !entry.workflow) {
    return { ok: false, reason: "这条历史没有可发布的配方。" };
  }
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!store) return { ok: false, reason: "当前环境无法保存案例。" };

  const userCase = buildUserShowcaseCase(entry);
  const existing = readUserShowcaseCases(store);
  if (existing.some((item) => item.id === userCase.id)) {
    return { ok: true, alreadyPublished: true };
  }
  // 新的在前、超限丢最旧。
  const next = [userCase, ...existing].slice(0, MAX_USER_CASES);
  store.setItem(STORAGE_KEY, JSON.stringify(next));
  return { ok: true, alreadyPublished: false };
}
