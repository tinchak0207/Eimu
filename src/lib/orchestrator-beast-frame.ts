/**
 * Orchestrator 派工协议注入（MOE 改革 Wave1-C 后半，2026-09-08）。
 *
 * 职能：野兽模式（beast_mode）ON 时，把「Orchestrator 派遣手册」＋ Expert
 * 注册表摘要组装成主 agent（Orchestrator / 导演）的 system prompt 附加帧；
 * OFF 时返回原文一个字不多（零回归）。Orchestrator 从「全能工匠」变「导演」：
 * 定位目标、写 spec、派遣、收结果、验收，本体不内联动手。
 *
 * 注入范式（跟随现场，不发明）：与 Wave1-A 宪法注入同构——
 * src/lib/blender-director-persona.ts composeDirectorDelegationPrompt 的
 * node:fs readFileSync + import.meta.url 相对定位 + readBeastMode 闸门 +
 * 档不可读时结构化报错（拒绝裸奔注入，诚实铁律）。本仓 prompt 注入的唯一
 * 既有范式就是它（DIRECTOR_EXPERT_CONSTITUTION_PATH 注释明言「内容由
 * readFileSync 在组装 prompt 时读取」），故 playbook 走同款 fs 读取而非
 * inline 常量，单一真源 =
 * deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md。
 * 与 persona 的唯一差异：fs 改静态 import（本档经 expert-registry →
 * blender-tools 链本就 server-only，动态 import 在 tsx CJS 本地测试运行时
 * 解构不稳；VPS bun ESM 两态皆通）。
 *
 * 消费方：VPS /opt/agent-harness/gateway（Orchestrator 主 prompt 组装真源，
 * 本地 repo 无活码，记忆片J）在组装 system prompt 时调 buildOrchestratorFrame；
 * 本档先在本地交付契约 + 测试钉死形状，VPS 落位走后续部署片。
 */

import { loadBundledOrchestratorPlaybook } from "./expert-gateway-assets";
import { EXPERT_REGISTRY, readBeastMode, type ExpertDef } from "./expert-registry";
import { estimateTokens } from "./blender-delegate";

/** playbook 单一真源（repo 相对路径，声明部署来源位置；内容经静态 import 的
 *  src/lib/expert-gateway-assets.json 镜像读取——Vercel 拿不到 deploy-staging/）。 */
export const ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH =
  "deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md" as const;

/**
 * 配方库栏空值如实标记（R4 修复片，2026-09-11）：skillPaths 为空 = 该域尚无
 * 配方库可载。禁止填任何猜测/近似路径（引用不存在档案 = 幻影档事故铁律）。
 */
export const EXPERT_LINE_SKILL_PATHS_UNCONFIGURED = "未配置" as const;

/** 交付契约 qcSignature 栏文案（布林 → 人话；true 才视为已交付）。 */
export const EXPERT_LINE_QC_REQUIRED = "必需" as const;
export const EXPERT_LINE_QC_OPTIONAL = "可选" as const;

/** requiredFields 为空时如实标记（禁止编造栏位名）。 */
export const EXPERT_LINE_NO_REQUIRED_FIELDS = "无" as const;

/**
 * Expert 注册表摘要：每个 Expert 一行 id/label/taskTypes/toolIds +
 * 配方库（skillPaths）+ 交付契约（requiredFields + qcSignatureRequired），
 * provisioned 行标「未启用」（野兽模式 ON 也不可路由，routeExpert 不返回）。
 * 由 EXPERT_REGISTRY 动态生成，零手抄——registry 加行摘要自动跟进。
 *
 * R4（2026-09-11）扩充理由：Orchestrator 写派遣 spec 时手册第一节要求它写
 * 「验收标准」，但验收标准的唯一来源（deliverableContract）与「进 Expert 即载
 * 配方库」（skillPaths）先前都不进 prompt → 无从得知。两栏照 registry 现值逐字
 * 输出，skillPaths 空数组照实写「未配置」（零编造）。
 */
export function buildExpertLine(expert: ExpertDef): string {
  const provisioned = expert.provisioned ? "（未启用）" : "";
  const skillPaths =
    expert.skillPaths.length > 0
      ? expert.skillPaths.join(", ")
      : EXPERT_LINE_SKILL_PATHS_UNCONFIGURED;
  const requiredFields =
    expert.deliverableContract.requiredFields.length > 0
      ? expert.deliverableContract.requiredFields.join(", ")
      : EXPERT_LINE_NO_REQUIRED_FIELDS;
  const qcSignature = expert.deliverableContract.qcSignatureRequired
    ? EXPERT_LINE_QC_REQUIRED
    : EXPERT_LINE_QC_OPTIONAL;
  return (
    `- ${expert.id}（${expert.label}）${provisioned}` +
    `：任务类型 ${expert.taskTypes.join(" / ")}；工具 ${expert.toolIds.join(", ")}` +
    `；配方库 ${skillPaths}；交付契约 ${requiredFields}（qcSignature：${qcSignature}）`
  );
}

/**
 * 剥离档头开发者元数据（R7，2026-09-10）：playbook 顶部 HTML 注释（version/
 * source/gate 声明）是给维护者看的，原样进 prompt 是毒——实锤模型思维链
 * 「That's gated on BEAST_MODE=ON. There's no explicit indication BEAST_MODE=ON」
 * → 合理怀疑 gate 未满足 → 走保守路径。注入前剥离，当前状态声明由本函数
 * 动态生成（不进档案）。VPS gateway index.ts/subagent.ts 注入点同款逻辑。
 */
export function stripProvenanceHeader(text: string): string {
  return text.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trimStart();
}

/** 野兽模式当前状态声明（R7）：告知模型 gate 已满足，堵死保守路径藉口。 */
export const BEAST_MODE_STATE_LINE =
  "【野兽模式：已启用】以下派遣手册与 Expert 注册表由系统注入，这是当前系统的真实状态：BEAST_MODE 现在就是 ON，以下全部条款立即生效，无需质疑、无需再确认任何 gate 条件。";

export function buildExpertRegistryDigest(): string {
  const lines = Object.values(EXPERT_REGISTRY).map(buildExpertLine);
  return ["Expert 注册表（能力断路真源；域外工具不存在于该 Expert 的工具表）：", ...lines].join("\n");
}

/**
 * 组装 Orchestrator 主 prompt 帧。
 *
 * - OFF / settings 脏数据（readBeastMode === false）：返回 { frame: basePrompt,
 *   injected: false }——basePrompt 原样透传，一个字不多（零回归断言锚）。
 * - ON 且 playbook 可读：返回 { frame: playbook + 注册表摘要 + basePrompt,
 *   injected: true }（派工协议在主 prompt 头部，其后接原文，格式同宪法注入
 *   `head\n\n---\n\nbody` 范式）。
 * - ON 但 playbook 档不可读/空档：返回 ok:false 结构化报错（拒绝裸奔——
 *   派工协议缺席时把全能工匠 prompt 原样放行 = 假 ON，诚实铁律禁止）。
 */
export async function buildOrchestratorFrame(
  basePrompt: string,
  settings?: unknown,
): Promise<
  | { ok: true; frame: string; injected: boolean; estimated_tokens: number }
  | { ok: false; code: string; hint: string }
> {
  if (!readBeastMode(settings)) {
    return { ok: true, frame: basePrompt, injected: false, estimated_tokens: estimateTokens(basePrompt) };
  }

  // 野兽模式 ON：读静态 import 的 bundle 镜像（Vercel 拿不到 deploy-staging/，
  // 见 src/lib/expert-gateway-assets.ts 档头；死因留痕进 hint，不进 log——secret
  // 卫生铁律）。空资产抛错由下 catch 转 playbook_unavailable。
  let playbook: string | undefined;
  let playbookError: string | undefined;
  try {
    const raw = loadBundledOrchestratorPlaybook();
    if (raw.trim() !== "") playbook = raw;
  } catch (err) {
    playbookError = err instanceof Error ? err.message : String(err);
  }
  if (playbook === undefined) {
    return {
      ok: false,
      code: "playbook_unavailable",
      hint: `野兽模式已开但派遣手册不可读（${ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH}${playbookError ? `：${playbookError}` : "：档案为空"}）：拒绝裸奔主 prompt，请修复 playbook 部署或暂时关闭 beast_mode。`,
    };
  }

  const frame = `${BEAST_MODE_STATE_LINE}\n\n${stripProvenanceHeader(playbook).trimEnd()}\n\n${buildExpertRegistryDigest()}\n\n---\n\n${basePrompt}`;
  return { ok: true, frame, injected: true, estimated_tokens: estimateTokens(frame) };
}
