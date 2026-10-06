#!/usr/bin/env -S npx tsx
//
// Expert Gateway 四产物机械导出器（R8 审计修复片 1，2026-09-10；
// contracts 第四产物 = 09-15 评测补课片 critic 裁定新增）。
//
// 为什么需要它：R8 架构审计实锤（记忆 beast-harness-architecture-audit-r8-0910）——
// 能力断路只落地 4/25（orchestrator 只关 blender×3+music_gen，21 个域工具仍开），
// 且 Expert 端零工具限制。本脚本把「手工编 opencode.json agent 工具表」换成机械导出：
// 真源 EXPERT_REGISTRY（src/lib/expert-registry.ts）→ 白名单栏位改写 → 写
// deploy-staging/expert-gateway/ 三产物。registry 改行后重跑即再生，根治手工漂移。
//
// 产物（opencode 1.18.14 agent 定义语义；tools:false = 该 agent 工具表物理移除，
// 未列 = 默认开；先例记忆 beast-gateway-tooltable-circuit-break-0908）：
//   opencode-agents.json  orchestrator（25 域工具全 false + question:true）
//                         + 7 个 Expert（全集 − 自己域工具，全部 false）
//   registry-digest.txt   HTML 注释头（R7 provenance 规范，注入端剥离）+
//                         buildExpertRegistryDigest() 逐字输出
//   expert-ids.json       {"experts":[...registry 键序...]}（gateway 校验 expert 栏用）
//   expert-delivery-contracts.json（09-15 评测补课片新增）
//                         {"<id>":{"requiredFields":[…],"qcSignatureRequired":bool},…}
//                         逐个从 EXPERT_REGISTRY 生成、零手抄——playbook 验收
//                         对表与 critic 审核官的交付契约清单真源。
//
// 两条 tools map 规则的差异与理由（2026-09-11 修补，片4 实弹暴露补集写窄）：
//   orchestrator = 只断「Expert 域工具」（registry toolIds 联集）。
//     刻意保留 search_web / workflow_* 等「非 Expert 域工具」——AGENTS.md 路由表
//     对它们仍有效，orchestrator 需要它们直调（野兽 playbook 军团）；image_generate
//     虽已并入 video-director 域（art-style 接线），orchestrator 仍经
//     ORCHESTRATOR_KEPT_DOMAIN_TOOLS 例外保持默认开。
//   expert = 全集（--tools-file 清单 / fallback）减去「该 expert 自己的 toolIds」→ 全部 false。
//     旧规则「其他 6 行的 toolIds 联集 → false」写窄了：任何不属于任何 Expert 的工具
//     （如 image_generate）不会被列进 false，等于 leakage —— 白名单只部分物理化，
//     editor 子代理仍能直调 image_generate 生成图片（违反宪法第二条「域外工具不在你工具表」）。
//   builtin（bash/read/glob/grep/edit/write/question/task/webfetch/todowrite/websearch/
//     skill/apply_patch/invalid）不在工具档清单内，天然不受影响，不列入 map。
// 第三条（2026-09-21 e2e 事故修补；2026-10-04 local_files 并入）：workflow_start /
//   workflow_update_node / workflow_status 是「共享工作流操作工具」＝生产线基础设施，
//   不是任何 Expert 的域工具。事故实锤：jev-gate 向被 Jev 判为制作类的 Expert 任务书
//   注入硬规则「第一个动作＝呼叫 workflow_start」，但本导出器的补集规则把这三个对
//   全部 Expert 显式 false（＝物理禁用），screenwriter 子代理回报「工具白名单未提供
//   workflow_start，任务 FAILED」——系统指令叫子代理调一个被系统物理禁用的工具。
//   修法＝SHARED_TOOLS 共享工具豁免集：全部 Expert 默认开（不列进 false）。
//   orchestrator 侧只对子集 ORCHESTRATOR_DISABLED_SHARED_TOOLS（workflow_* 三个）显式
//   false（野兽帧 beastTemplateFact 声明「你没有 workflow_* 工具」必须是物理事实）；
//   local_files 2026-10-04 并入 SHARED_TOOLS 但不在禁用子集——部署 opencode.json 对
//   orchestrator/editor/video-director/director3d 皆 local_files:true，两边不得矛盾。
//
// 用法：
//   npx tsx tools/export-expert-agents.ts                          # fallback 近似全集
//   npx tsx tools/export-expert-agents.ts --tools-file <path>      # VPS 工具清单（每行一个 id）
//   npx tsx tools/export-expert-agents.ts --check                  # 只校验不写（部署片验漂移用）
//
// --tools-file 由部署片从 VPS `ls /opt/agent-harness/workspace/.opencode/tools/ | grep -v .bak`
// 生成；未传参数时用 src/lib/harness-tool-registry.ts HARNESS_TOOL_ID_LIST + 4 个已知
// VPS 额外工具作为近似全集（仅用于交叉校验 registry 引用与覆盖统计，不进产物形状），
// 并在 stdout 明确警告。导出机械可重跑：同输入同输出，无时间戳（digest 头生成日期除外）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXPERT_REGISTRY } from "../src/lib/expert-registry";
import { buildExpertRegistryDigest } from "../src/lib/orchestrator-beast-frame";
import { HARNESS_TOOL_ID_LIST } from "../src/lib/harness-tool-registry";

const root = process.cwd();
const OUT_DIR = join(root, "deploy-staging", "expert-gateway");
const TARGETS = {
  agents: join(OUT_DIR, "opencode-agents.json"),
  digest: join(OUT_DIR, "registry-digest.txt"),
  ids: join(OUT_DIR, "expert-ids.json"),
  contracts: join(OUT_DIR, "expert-delivery-contracts.json"),
} as const;
const CHECK = process.argv.includes("--check");

// ── 工具全集来源（--tools-file > fallback 近似全集）──────────────────────────

/** 已知 VPS .opencode/tools/ 有、而本地 HARNESS_TOOL_ID_LIST 未登记的工具（2026-09-10）。 */
const KNOWN_VPS_EXTRA_TOOLS = [
  "search_web",
  "vision_analyze",
  "subagent_status",
  "director_manage_group",
] as const;

function parseToolsFileArg(): string | undefined {
  const i = process.argv.indexOf("--tools-file");
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) {
    console.error("EXPORT_FAIL：--tools-file 需要一个档案路径参数。");
    process.exit(1);
  }
  return value;
}

function dedupePreserveOrder(ids: readonly string[]): string[] {
  const seen: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed && !seen.includes(trimmed)) seen.push(trimmed);
  }
  return seen;
}

function loadUniverse(): { tools: string[]; source: "tools-file" | "fallback" } {
  const fileArg = parseToolsFileArg();
  if (fileArg) {
    if (!existsSync(fileArg)) {
      console.error(`EXPORT_FAIL：--tools-file 档案不存在：${fileArg}`);
      process.exit(1);
    }
    const lines = readFileSync(fileArg, "utf8").split(/\r?\n/);
    return { tools: dedupePreserveOrder(lines), source: "tools-file" };
  }
  return {
    tools: dedupePreserveOrder([...HARNESS_TOOL_ID_LIST, ...KNOWN_VPS_EXTRA_TOOLS]),
    source: "fallback",
  };
}

// ── 产物组装（真源常量 import，零手抄）───────────────────────────────────────

/** orchestrator 现行描述原文（VPS opencode.json agent.orchestrator，09-08 断路先例）。 */
const ORCHESTRATOR_DESCRIPTION =
  "MOE Orchestrator（野兽模式主会话）：域工具已断路，只能 subagent_dispatch 派发 Expert";

/** Expert 描述后缀（R8 修复片 1 裁定文案）。 */
const EXPERT_DESCRIPTION_SUFFIX = "（Expert：仅经 subagent_dispatch expert 栏路由）";

/** digest 头（R7 provenance 规范：HTML 注释，注入端 stripProvenanceHeader 剥离）。
 * 生成日期＝跑本导出器当天（2026-10-06：由硬编 "2026-09-11" 改为动态取当日）——
 * 硬编会让档头日期与内容永久不符且重跑不刷新；取当日即「重跑即刷新」。
 * 选当日而非 git HEAD commit date 的理由：档头语义本就是「生成日期」，且本档要在无 git 的
 * 部署机上也能跑（不引入 VCS 依赖）；代价是 --check 隔日会因日期滚动报警，故 --check 应在同日
 * 重生成后跑（本档沿用「registry 改行后须重生成上传」的既有纪律）。 */
const DIGEST_PROVENANCE_HEADER =
  "<!-- 由 src/lib/expert-registry.ts EXPERT_REGISTRY 现值生成" +
  "（buildExpertRegistryDigest 逐字输出，nested 已改名路径经 HARNESS_SKILL_PATH_MAP 映射为 harness 真路径；由 tools/export-expert-agents.ts 机械生成）。" +
  `生成日期 ${new Date().toISOString().slice(0, 10)}（registry 改行后须重生成上传）。 -->`;

/** 域工具全集 = 全部 Expert toolIds 去重联集（registry 插入序）。 */
const DOMAIN_TOOLS: string[] = dedupePreserveOrder(
  Object.values(EXPERT_REGISTRY).flatMap((expert) => [...expert.toolIds]),
);

/** 共享工具豁免集（2026-09-21 e2e 实锤；2026-10-04 加入 local_files）：不属任何 Expert
 * 域工具，全部 Expert 默认开（不列进 false）。子集 ORCHESTRATOR_DISABLED_SHARED_TOOLS
 * 才是 orchestrator 侧必须物理禁用的（野兽帧声明「你没有 workflow_* 工具」必须是物理事实）。
 * local_files 加入的理由：部署 opencode.json 对 orchestrator/editor/video-director/director3d
 * 皆显式 local_files:true；它不属任何 Expert 域工具，若落入「域外工具全 false」规则就会被
 * 写成 false，使 editor/video-director/director3d 的提示词宣告「local_files 已被移除」，
 * 与同一份部署的 opencode.json 直接矛盾。 */
const SHARED_TOOLS = new Set(["workflow_start", "workflow_update_node", "workflow_status", "local_files"])

/** SHARED_TOOLS 中 orchestrator 亦须显式禁用的子集：野兽帧 beastTemplateFact 声明
 * 「你没有 workflow_* 工具」，必须是物理事实。local_files 不在此列——opencode.json 对
 * orchestrator 显式 local_files:true，必须保持默认开（不得被断路）。 */
const ORCHESTRATOR_DISABLED_SHARED_TOOLS = new Set(["workflow_start", "workflow_update_node", "workflow_status"])

/** orchestrator 保留的「Expert 域工具」例外（2026-10-01 art-style 接线回归修复）：
 * image_generate 原为无归属工具（orchestrator 默认开、设计刻意保留直调生图）；
 * 并入 video-director 域以接通 art_style 模板后进入 DOMAIN_TOOLS 联集，orchestrator
 * 的「域工具全 false」规则会连带把它物理禁用。修法＝显式豁免（与
 * ORCHESTRATOR_DISABLED_SHARED_TOOLS 反向对偶：那组 Expert 开/orchestrator 关，
 * 这组 Expert 开/orchestrator 也开）。 */
const ORCHESTRATOR_KEPT_DOMAIN_TOOLS = new Set(["image_generate"]);

function buildAgentsJson(universeTools: readonly string[]): string {
  // tools map 只写 false 项（opencode 语义：未列 = 默认开）；键序 = 来源清单插入序，确定性输出。
  const toolsFalse = (ids: readonly string[]): Record<string, boolean> => {
    const map: Record<string, boolean> = {};
    for (const id of ids) map[id] = false;
    return map;
  };

  const agents: Record<string, unknown> = {};
  // orchestrator 在前：25 域工具全 false + question true（主会话保留提问内建）。
  // 注意：orchestrator 只断 Expert 域工具，非 Expert 域工具（search_web / workflow_* 等）保持默认开；
  // 例外①＝ORCHESTRATOR_DISABLED_SHARED_TOOLS 显式 false（2026-09-21：野兽帧 beastTemplateFact
  // 声明「你没有 workflow_* 工具」必须是物理事实，模板骨架由 Expert 建立；local_files 不在
  // 此列，orchestrator 保持默认开——opencode.json 对它显式 true）。
  // 例外②＝ORCHESTRATOR_KEPT_DOMAIN_TOOLS 反向豁免（2026-10-01：image_generate 虽并入
  // video-director 域，orchestrator 仍刻意保留直调生图，不得被域工具全 false 规则连带禁用）。
  agents["orchestrator"] = {
    mode: "all",
    description: ORCHESTRATOR_DESCRIPTION,
    tools: {
      ...toolsFalse(DOMAIN_TOOLS.filter((id) => !ORCHESTRATOR_KEPT_DOMAIN_TOOLS.has(id))),
      ...toolsFalse([...ORCHESTRATOR_DISABLED_SHARED_TOOLS]),
      question: true,
    },
  };
  // 其后按 registry 插入序：每个 Expert false 掉「全集 − 自己域工具 − 共享工具」
  // （含不属于任何 Expert 的工具，如 image_generate）。
  for (const expert of Object.values(EXPERT_REGISTRY)) {
    const own = new Set(expert.toolIds);
    const foreign = universeTools.filter((id) => !own.has(id) && !SHARED_TOOLS.has(id));
    agents[expert.id] = {
      mode: "all",
      description: `${expert.description}${EXPERT_DESCRIPTION_SUFFIX}`,
      tools: toolsFalse(foreign),
    };
  }
  return `${JSON.stringify(agents, null, 2)}\n`;
}

/**
 * Harness 路径映射（2026-10-04 引用修复片）：registry 的 skillPaths 是 **repo 根树**
 * 相对路径——EDITOR_PERSONA_SKILL_PATHS 由 editor-timeline-activation.test.ts 对
 * process.cwd() 做 fs 存在性断言 ⇒ 语义就是 repo 根树，常量不得改（改了 = 对 repo
 * 根树的合法引用失真）。但同一份 EXPERT_REGISTRY 亦被烘焙成 VPS harness 执行时读取的
 * 静态 digest（gateway plan-gw.ts / messages-gw.ts readFileSync），而 harness 树
 * `.opencode/skills/**` 已把 nested SKILL.md 收敛改名为 RECIPE.md（一级 20 个 SKILL.md
 * 保留）。因此 digest 生成时把「harness 树里已被改名的 nested 路径」逐条映射成真实
 * harness 路径；一级 skills/editor/SKILL.md 与其它未改名域路径不动。
 * 明确表（key = registry 现值，value = harness 真实路径；非字串模糊替换）——新增
 * harness 改名时同步补一行，勿用 sed/正则自动生成。
 */
const HARNESS_SKILL_PATH_MAP: Readonly<Record<string, string>> = {
  "skills/editor/assembly/SKILL.md": ".opencode/skills/editor/assembly/RECIPE.md",
  "skills/editor/audio-first/SKILL.md": ".opencode/skills/editor/audio-first/RECIPE.md",
  "skills/editor/rhythm/SKILL.md": ".opencode/skills/editor/rhythm/RECIPE.md",
  "skills/editor/look/SKILL.md": ".opencode/skills/editor/look/RECIPE.md",
  "skills/editor/mix/SKILL.md": ".opencode/skills/editor/mix/RECIPE.md",
  "skills/editor/qc-master/SKILL.md": ".opencode/skills/editor/qc-master/RECIPE.md",
};

/** 把 buildExpertRegistryDigest() 输出的 repo 路径逐条换成 harness 真实路径。
 * 只替换表中的完整路径 token（精确匹配，不做前缀/正则模糊替换）；表外路径原样。 */
function applyHarnessSkillPathMap(digest: string): string {
  let out = digest;
  for (const [repoPath, harnessPath] of Object.entries(HARNESS_SKILL_PATH_MAP)) {
    out = out.split(repoPath).join(harnessPath);
  }
  return out;
}

function buildDigestTxt(): string {
  // 无档尾换行：剥头（stripProvenanceHeader 只 trimStart）后与 buildExpertRegistryDigest()
  // 输出逐字 byte 相等（唯 nested 已改名路径经 HARNESS_SKILL_PATH_MAP 映射为 harness 真路径），
  // 注入帧零多余空白。
  return `${DIGEST_PROVENANCE_HEADER}\n${applyHarnessSkillPathMap(buildExpertRegistryDigest())}`;
}

function buildExpertIdsJson(): string {
  return `${JSON.stringify({ experts: Object.keys(EXPERT_REGISTRY) }, null, 2)}\n`;
}

/**
 * 交付契约清单（09-15 评测补课片新增）：{"<id>":{"requiredFields":[…],
 * "qcSignatureRequired":bool},…}，逐个从 EXPERT_REGISTRY 生成、零手抄，
 * 键序 = registry 插入序（确定性输出）。playbook 第二节验收对表与
 * critic 审核官逐栏核验的清单真源。
 */
function buildDeliveryContractsJson(): string {
  const contracts: Record<string, { requiredFields: string[]; qcSignatureRequired: boolean }> = {};
  for (const expert of Object.values(EXPERT_REGISTRY)) {
    contracts[expert.id] = {
      requiredFields: [...expert.deliverableContract.requiredFields],
      qcSignatureRequired: expert.deliverableContract.qcSignatureRequired,
    };
  }
  return `${JSON.stringify(contracts, null, 2)}\n`;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const PRODUCTS: Array<[string, (universeTools: readonly string[]) => string]> = [
  [TARGETS.agents, buildAgentsJson],
  [(TARGETS.digest), () => buildDigestTxt()],
  [(TARGETS.ids), () => buildExpertIdsJson()],
  [(TARGETS.contracts), () => buildDeliveryContractsJson()],
];

function main(): void {
  const universe = loadUniverse();

  if (universe.source === "fallback") {
    console.warn(
      "EXPORT_WARN：未传 --tools-file，使用近似工具全集" +
        `（HARNESS_TOOL_ID_LIST ${HARNESS_TOOL_ID_LIST.length} 个 + 已知 VPS 额外 ${KNOWN_VPS_EXTRA_TOOLS.length} 个）。` +
        "近似全集，部署时应用 --tools-file 重导（部署片从 VPS ls .opencode/tools/ 生成清单）。",
    );
  }

  // 交叉校验：registry 引用的域工具必须存在于工具全集（漂移侦测，仅警告不阻导出）。
  const universeSet = new Set(universe.tools);
  const missing = DOMAIN_TOOLS.filter((id) => !universeSet.has(id));
  if (missing.length > 0) {
    console.warn(
      `EXPORT_WARN：${universe.source === "fallback" ? "近似全集" : "VPS 工具清单"}中缺少 registry 引用的域工具（registry 与工具面漂移，先对帐再部署）：${missing.join(", ")}`,
    );
  }
  const unowned = universe.tools.filter((id) => !DOMAIN_TOOLS.includes(id)).length;

  if (CHECK) {
    const mismatches: string[] = [];
    for (const [target, build] of PRODUCTS) {
      if (!existsSync(target)) {
        mismatches.push(`${target}（产物缺失）`);
        continue;
      }
      if (readFileSync(target, "utf8") !== build(universe.tools)) mismatches.push(target);
    }
    if (mismatches.length > 0) {
      console.error(
        `EXPORT_CHECK_FAIL：staging 产物与机械导出产物不一致（手工漂移或真源变动）：\n  ${mismatches.join("\n  ")}\n  重跑不带 --check 的导出再生。`,
      );
      process.exit(1);
    }
      console.log(
        `EXPORT_CHECK_OK：四产物与机械导出 byte 等价（域工具 ${DOMAIN_TOOLS.length} / 全集 ${universe.tools.length}，未归属 Expert 的全集工具 ${unowned} 个保持默认开）`,
      );
    process.exit(0);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const [target, build] of PRODUCTS) {
    const output = build(universe.tools);
    writeFileSync(target, output);
    console.log(`EXPORT_OK：${target}（${Buffer.byteLength(output)} bytes）`);
  }
  console.log(
    `导出依据：域工具 ${DOMAIN_TOOLS.length} 个（registry 联集）/ 工具全集 ${universe.tools.length} 个（${universe.source}）/ registry ${Object.keys(EXPERT_REGISTRY).length} 行。`,
  );
}

main();
