// 画布节点 metadata 的**审计档**（2026-10-05 自 `node-metadata-fields.ts` 剥离）。
//
// 为什么独立：`node-metadata-fields.ts` 被 `src/lib/canvas/layout.ts` 与
// `src/hooks/canvas/canvas-chat-types.ts` import，整份资料会打进**客户端 bundle**；
// 而本档装的是内部审计资料——排除判定（verdict）、理由（reason）、证据（evidence 内含
// 档名:行号，例如某处已知缺陷位置）。这些属「我们没打算公开的内部信息」，绝不能进客户端。
//
// 纪律：**严禁**被任何 `src/components/`、`src/hooks/`、`'use client'` 链 import。
// 目前唯一消费端＝`node-metadata-fields.test.ts`（非打包）。

import {
  AGENT_CONTENT_TRUNCATE_KEEP,
  AGENT_CONTENT_TRUNCATE_TRIGGER,
  AGENT_PROMPT_TRUNCATE_KEEP,
  type DurableFieldSpec,
} from "./node-metadata-fields";

// ─────────────────────────────────────────── B：截断预算（有理由的清单）

/** 一条截断预算（供测试以行为断言验证宣告与实作一致）。 */
export interface AgentTruncationBudget {
  readonly key: string;
  /** 触发门槛；null ＝无条件截断到 keepChars。 */
  readonly triggerAt: number | null;
  readonly keepChars: number;
  readonly reason: string;
}

/**
 * B 的截断清单。**理由**：上行快照要过 `agent/sessions/[id]/canvas-state` 的 512KB 上限
 * （`route.ts:15`），base64/长文会顶爆；agent 读的是「画布状态」不是原文，
 * 需要全文时用工具读真值。
 */
export const AGENT_TRUNCATION_BUDGETS: readonly AgentTruncationBudget[] = [
  {
    key: "content",
    triggerAt: AGENT_CONTENT_TRUNCATE_TRIGGER,
    keepChars: AGENT_CONTENT_TRUNCATE_KEEP,
    reason: "content 可能是交付 URL 或长正文；超 240 字只留前 120 字＋省略号（agent 需要原图时走工具读）",
  },
  {
    key: "prompt",
    triggerAt: null,
    keepChars: AGENT_PROMPT_TRUNCATE_KEEP,
    reason: "prompt 无条件截 120 字（提示词全文对「画布状态」判读无增益，且可能夹带长文本）",
  },
];

// ─────────────────────────────────────────── B：显式排除清单（有理由）

/**
 * 排除理由的分类（机器可读，供报告与裁定）：
 *   · `intentional`     —— 刻意排除，有明确设计理由（如 SVG 级重料）。
 *   · `suspected-gap`   —— 有**被读的消费端**，B 不透传＝回旧会话/换装置还原后功能退化。
 *                          这是待暴君裁定的真缺口（本档只登记，不改 runtime 语义）。
 *   · `dormant`         —— A 放行但全库查无 metadata 读者；透传缺一暂无可观察后果。
 */
export type AgentExclusionVerdict = "intentional" | "suspected-gap" | "dormant";

/** 一条排除：为何这个耐久键刻意不进 agent 上行快照。 */
export interface AgentFieldExclusion {
  readonly key: string;
  readonly reason: string;
  readonly verdict: AgentExclusionVerdict;
  /** 消费端/判据证据（档案:行 或 grep 结论），供覆核。 */
  readonly evidence: string;
}

/**
 * A 放行、但 B **刻意不透传**的键。每一个都必须有理由（测试会读出来断言非空）。
 *
 * 排除清单**不得说谎**：列在这里的键若实际上被 B 透传（存活），契约测试会红
 * （`findStaleAgentExclusions`），所以不能靠「把键全列进排除」把破口洗白。
 */
export const AGENT_EXCLUDED_METADATA_FIELDS: readonly AgentFieldExclusion[] = [
  {
    key: "negativePrompt",
    reason: "介面宣告键，但全库查无 metadata 读者（生成入口读的是 request body.negative_prompt）",
    verdict: "dormant",
    evidence: "grep 'metadata?.negativePrompt' 零命中；src/app/api/canvas/generate/route.ts:136 读 body.negative_prompt",
  },
  {
    key: "quality",
    reason: "Config 卡「质量」行读它；不透传＝还原后 Config 卡少一行",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:584",
  },
  {
    key: "kind",
    reason: "Config 卡「类型」行读它；不透传＝还原后 Config 卡少一行",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:586",
  },
  {
    key: "source_image",
    reason: "Config 卡「参考图」行＋重生成带 sourceImage；不透传＝还原后 edit/upscale 节点丢失来源",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:587；src/components/canvas/embed/use-canvas-generation.ts:318",
  },
  {
    key: "errorDetails",
    reason: "失败人话渲染；不透传＝还原后错误节点只剩通用错误态",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:226（errorDetailsText）",
  },
  {
    key: "naturalWidth",
    reason: "重生成尺寸提示（与 naturalHeight 成对）；不透传＝还原后尺寸提示消失",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/embed/use-canvas-generation.ts:344-345",
  },
  {
    key: "naturalHeight",
    reason: "同 naturalWidth（成对使用）",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/embed/use-canvas-generation.ts:344-345",
  },
  {
    key: "cost_hint",
    reason: "生成卡「预估 N 币」徽章；不透传＝还原后预估花费消失",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/CanvasNodeView.tsx:240/503",
  },
  {
    key: "imageTaskId",
    reason: "canvas-event-settler 以 task_id 对帐落地；不透传＝还原后在飞节点无法被 SSE 结算（卡在 pending）",
    verdict: "suspected-gap",
    evidence: "src/hooks/canvas/canvas-event-settler.ts:120/131/148",
  },
  {
    key: "startedAt",
    reason: "介面宣告键，但全库查无 metadata.startedAt 读者（同名栏位散见于 tool registry/job repository，非节点 metadata）",
    verdict: "dormant",
    evidence: "grep 'metadata?.startedAt' 零命中",
  },
  {
    key: "progress",
    reason: "NodeBody 进度条＋批次聚合读它；不透传＝还原后在飞节点失去进度（暂态，重载即过）",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:218-219；src/lib/canvas/batch-utils.ts:59",
  },
  {
    key: "topViewSvg",
    reason: "SVG 级重料（可达 48KB×2）会顶爆 512KB 上行快照；agent 用 director 工具读工程真值、不读 SVG",
    verdict: "intentional",
    evidence: "canvas-chat-types.test.ts:14 已钉死；NodeBody.tsx:670 读者存在（靠 directorSessionId 拉 /director/state 补）",
  },
  {
    key: "cameraViewSvg",
    reason: "同 topViewSvg（成对的 SVG 级重料）",
    verdict: "intentional",
    evidence: "canvas-chat-types.test.ts:14 已钉死；NodeBody.tsx:671",
  },
];

/** 排除清单的键名（供测试列举）。 */
export const AGENT_EXCLUDED_METADATA_FIELD_KEYS: readonly string[] = AGENT_EXCLUDED_METADATA_FIELDS.map(
  (e) => e.key,
);

// ─────────────────────────────────────────── 契约检查器（供测试／CI 用）

/** 一个通道破口：耐久键既没被 B 透传、也没被显式排除（或排除条目无理由）。 */
export interface AgentChannelGap {
  readonly key: string;
  readonly reason: string;
}

/**
 * 找出「A 放行、B 却既不透传也不排除」的键。
 *
 * 这是本模组的存在理由：把「两份手工键集合要同步」从注释约定升级成**可执行判据**。
 * 参数全部可注入（测试用注入清单构造「新增键未同步」的案例，不必改源码）。
 */
export function findAgentChannelGaps(
  durable: readonly DurableFieldSpec[],
  transmittedKeys: readonly string[],
  exclusions: readonly AgentFieldExclusion[],
): AgentChannelGap[] {
  const transmitted = new Set(transmittedKeys);
  const excluded = new Map(exclusions.map((e) => [e.key, e]));
  const gaps: AgentChannelGap[] = [];
  for (const field of durable) {
    if (transmitted.has(field.key)) continue;
    const exclusion = excluded.get(field.key);
    if (!exclusion) {
      gaps.push({ key: field.key, reason: "耐久键未列入 agent 透传清单，且未列入显式排除清单（双白名单漏一端）" });
      continue;
    }
    if (!exclusion.reason.trim()) gaps.push({ key: field.key, reason: "排除清单条目没有理由（不许静默排除）" });
  }
  return gaps;
}

/**
 * 找出**说谎的排除条目**：已被 B 透传（实际存活）却仍列在排除清单，或根本不是耐久键。
 * 用途＝防止「把键全塞进排除清单」把 `findAgentChannelGaps` 洗白。
 */
export function findStaleAgentExclusions(
  durable: readonly DurableFieldSpec[],
  transmittedKeys: readonly string[],
  exclusions: readonly AgentFieldExclusion[],
): AgentFieldExclusion[] {
  const durableKeys = new Set(durable.map((f) => f.key));
  const transmitted = new Set(transmittedKeys);
  return exclusions.filter((e) => transmitted.has(e.key) || !durableKeys.has(e.key));
}