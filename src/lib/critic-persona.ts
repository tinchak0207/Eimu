/**
 * 审核官 critic persona 契约真源（MOE 评测补课片，2026-09-15）。
 *
 * 裁定背景：评测实案（REPORT 见 eval-2026-op-theme/）实锤 Orchestrator 只能
 * 「自己验收」、全程 0 次 QC / 0 次驳回 → 补一只独立审核 Expert。审核官
 * 不产内容，只驳回：
 *   - 逐栏核对交付契约（tools/export-expert-agents.ts 导出的
 *     expert-delivery-contracts.json 与 registry critic 行 requiredFields
 *     同源）：缺栏即驳回，并写明缺哪一栏；
 *   - 杀手锏都要可复现（借鉴 eval-2026-op-theme/verdict-A-anatomy.md 的
 *     审查手法，学其方法不抄其内容）：凡交付物含数字必须附可复算算式
 *     （算式照抄可重跑），「看起来对」不收；
 *   - 跨档对表：交付物 A 引用交付物 B 的声称必须翻 B 端原文核实现场；
 *   - 证据分级：事实/推断/未证实分开记账，未证实不得升格为事实；
 *   - 输出四区块审核报告：verdict（通过/驳回重做）、issues（逐条驳回，
 *     每条写明缺什么栏、哪个算式错）、evidence（复算过程与指针）、
 *     qc（自检结论 + 签名）。
 *
 * 逐行镜像轮子真源 src/lib/screenwriter-persona.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：身份/工具白名单/SKILL 挂载/委托单入参+回传
 * 契约/回复 token 帽/组装唯一出口六段全部同构。白名单差异仅三处：
 *   ① 域常量换审核官版（CRITIC_PERSONA_ID="critic"、工具白名单只给
 *      search_web 一件——能力断路裁定：审核官只给 web 查证（核对外部
 *      事实），不给任何生成工具；search_web 在 VPS .opencode/tools/
 *      真源登记（tools/export-expert-agents.ts KNOWN_VPS_EXTRA_TOOLS 与
 *      记忆 beast-gateway-tooltable-circuit-break-0908 同源），不在本地
 *      harness-tool-registry 枚举——本地/VPS 工具面分裂现状，如实记录）；
 *   ② 委托单/回传契约 import 自 critic-delegate.ts（审核域独立 delegate 真源，
 *      09-15 翻正接线片换挂，取代先前的编剧域轮子 screenwriter-delegate 占位
 *      透传）：CRITIC_DELIVERABLES / composeCriticDelegation /
 *      collectCriticDeliverableFromToolResult / CriticDelegation·Result·ToolResult
 *      全部同源（registry critic 行 requiredFields 与本 persona re-export 引用同一
 *      数组，零第二份清单）；registry critic 行已于 09-15 翻正部署片删 provisioned
 *      键、与可路由兄弟逐栏同构（激活可路由），
 *      运行时零耦合，无 TDZ 环——persona 不 import registry、delegate 不 import
 *      registry/persona（registry → persona → delegate 单向依赖，记忆
 *      moe-reform-campaign-closure 施工雷同款）；
 *   ③ SKILL 挂载：skills/ 无审核域配方库，SKILL_PATHS 为空（skill 待补，
 *      expert-registry critic 激活行同源声明，digest 按实现惯例标「未配置」）。
 * 交互/组装逻辑一行不动：assembleCriticReply 六段同构（唯一出口、
 * 不新增校验、composeCriticDelegation 直接透传）。
 *
 * 为什么是「契约档」而非运行时：与 blender/music/screenwriter 版同构——persona
 * 的运行时真源（模型绑定、subagent 派遣 gateway/subagent.ts、agent prompt /
 * AGENTS.md）都在 VPS /opt/agent-harness，本地 repo 无 gateway 真源可改。
 * 本档钉死契约四要素并被委托单/回传两端 import。
 *
 * 隔离铁律：审核官回传只含交付物契约 + 交付摘要（四栏 payload +
 * critic_summary ≤500 token），过程（核对日志/审核草稿中间态/多轮
 * 痕迹）不出 subagent——对应 gateway subagent.ts 既有隔离语义（subagent.delta
 * 只透 text、summary 截 600 字、子会话用后即删），本档不新增通道。
 * 文案简体（记忆 agent-gateway-copy-rules）。
 */

import {
  CRITIC_DELIVERABLES,
  collectCriticDeliverableFromToolResult,
  composeCriticDelegation,
  type CriticDelegation,
  type CriticDelegationResult,
  type CriticToolResult,
} from "./critic-delegate";
import type { ExpertDeliverable } from "./expert-contract";

// ─────────────────────────────────────────── ① persona 身份与文案

/** persona 键名（gateway bindings / 设定 UI / 日志统一用此 id）。 */
export const CRITIC_PERSONA_ID = "critic" as const;

/** 展示名（简体文案；选单/卡片/日志统一取此值，与 registry critic 行 label 一致）。 */
export const CRITIC_PERSONA_LABEL = "审核官" as const;

/** persona 一句话定位（设定页/选单描述用，与 registry critic 行 description 一致）。 */
export const CRITIC_PERSONA_DESCRIPTION =
  "独立审核与质量闸：不产内容只驳回，逐栏核对交付契约并索要可复算算式证据，输出 verdict/issues/evidence/qc 四区块审核报告。" as const;

// ─────────────────────────────────────────── ② 工具白名单

/**
 * 审核官可调用的工具白名单（2026-09-15 能力断路裁定钉死；禁给全工具面——
 * 审核官不产内容，不需要画图/跑 Blender/渲染视频，任何生成工具都不给）。
 *
 * 只给 search_web 一件 web 查证工具（核对交付物外部事实声称用；id 真源在
 * VPS .opencode/tools/，见档头 ①；registry critic 激活行 toolIds import 本
 * 常量，零复制——与 screenwriter 版同款方向）。
 */
export const CRITIC_PERSONA_TOOL_IDS = ["search_web"] as const;

export type CriticPersonaToolId = (typeof CRITIC_PERSONA_TOOL_IDS)[number];

// ─────────────────────────────────────────── ③ SKILL 挂载引用

/**
 * SKILL 挂载点：skills/ 无审核域配方库（无域目录），SKILL_PATHS 为空数组
 * （skill 待补；与 expert-registry critic 激活行 skillPaths: [] 同源，
 * digest 按实现「未配置」惯例输出）。
 */
export const CRITIC_PERSONA_SKILL_PATHS: readonly string[] = [];

// ─────────────────────────────────────────── ④ 委托单 + 回传契约（import，零重定义）

/**
 * 委托单入参契约 = critic-delegate.ts composeCriticDelegation 的
 * schema。类型全 import（CriticDelegation / CriticDelegationResult），
 * 此处零重定义。
 */
export type { CriticDelegation, CriticDelegationResult };

/** 审核域工具回执契约（critic-delegate.ts 原型 import）。 */
export type { CriticToolResult };

/** 委托单回传（隔离铁律形）：交付物契约 + 交付摘要，≤500 token。 */
export type CriticDelegationReply =
  | {
      ok: true;
      /** 交付物契约（expert-contract.ts 契约形：审核四栏 payload + QC 签名）。 */
      deliverable: ExpertDeliverable;
      /** 交付摘要（≤500 token，隔离铁律：过程不出 subagent）。 */
      critic_summary: string;
    }
  | { ok: false; code: string; hint: string };

/** 回传摘要 token 帽（隔离铁律钉死值，与 blender/music/screenwriter 版同构）。 */
export const CRITIC_REPLY_SUMMARY_TOKEN_CAP = 500 as const;

/**
 * 审核官回传组装（唯一出口）：审核域工具回执 → 交付物契约 →
 * ExpertDeliverable。两端函数均 import 自 critic-delegate.ts（审核域独立真源，
 * 见档头 ②），本档只做序列（不新增校验、不改契约形状）。
 */
export function assembleCriticReply(
  result: CriticToolResult,
  ctx: Parameters<typeof collectCriticDeliverableFromToolResult>[1],
): CriticDelegationReply {
  const assembled = collectCriticDeliverableFromToolResult(result, ctx);
  if (!assembled.ok) {
    return { ok: false, code: assembled.code, hint: assembled.hint };
  }
  return {
    ok: true,
    deliverable: assembled.deliverable,
    critic_summary: criticSummaryFromDeliverable(assembled.deliverable, ctx),
  };
}

/**
 * 交付摘要组装（≤500 token 帽内的确定性拼接；只述结果与证据，不含过程）。
 */
function criticSummaryFromDeliverable(d: ExpertDeliverable, ctx: Parameters<typeof collectCriticDeliverableFromToolResult>[1]): string {
  const p = d.payload as {
    verdict?: string;
    issues?: string[];
    evidence?: string[];
  };
  const issueCount = Array.isArray(p.issues) ? p.issues.length : 0;
  const evidenceCount = Array.isArray(p.evidence) ? p.evidence.length : 0;
  return [
    `审核交付：verdict=${p.verdict ?? "（见交付物）"}；驳回 ${issueCount} 条、复算证据 ${evidenceCount} 项（四区块明细见交付物）`,
    `审核产物指针：${d.evidence.artifactPath ?? d.evidence.url ?? "（见交付物 evidence）"}`,
    `派工：${ctx.contract.intent}`,
  ].join("；");
}

/**
 * 主脑 → 审核官委托单构造（唯一入口）：直接透传 composeCriticDelegation
 * （import 审核域轮子真源，零包装逻辑）。persona 层不做第二套校验。
 */
export const composeCriticPersonaDelegation = composeCriticDelegation;

/** 交付字段白名单 re-export（critic-delegate.ts import 透传一行不动；与 registry critic 行 requiredFields 同一数组引用，零第二份清单）。 */
export { CRITIC_DELIVERABLES };
