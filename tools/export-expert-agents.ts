#!/usr/bin/env -S npx tsx
//
// Expert Gateway 四产物机械导出器（R8 审计修复片 1，2026-09-10；
// contracts 第四产物 = 09-15 评测补课片 critic 裁定新增）。
//
// 为什么需要它：R8 架构审计实锤（记忆 beast-harness-architecture-audit-r8-0910）——
// 能力断路只落地 4/25（orchestrator 只关 blender×3+music_gen，21 个域工具仍开），
// 且 Expert 端零工具限制。本脚本把「手工编 opencode.json agent 工具表」换成机械导出：
// 真源 EXPERT_REGISTRY（src/lib/expert-registry.ts）→ 白名单栏位改写 → 写
// deploy-staging/expert-gateway/ 四产物（构建物，gitignore）。registry 改行后重跑即再生，
// 根治手工漂移。2026-10-06 引用修复片起：① registry-digest.txt / expert-ids.json /
// expert-delivery-contracts.json **三产物同时写**被 git 追踪的发布副本
// deploy-staging/gateway/expert/（gateway-release.sh 打包的是它），消除人手 cp 漏档/半截；
// ② digest 的 skillPath 从 6 条手工 map 改为一条规则（.opencode/ 前缀 + 嵌套 SKILL.md→RECIPE.md）；
// ③ 加 skillPath 存在性护栏（发布树 = deploy-staging/opencode-runtime/），registry 漂移当场炸。
//
// 2026-10-06 修正（四产物双写 → 三产物双写）：**opencode-agents.json 不双写**——只写构建目录
// deploy-staging/expert-gateway/，**禁止覆盖**被 git 追踪的 deploy-staging/gateway/expert/
// opencode-agents.json 的完整工具表。syncLyricistBindings 仅同步 lyricist prompt，不重建其他
// 声明与工具表。理由（实测，见 buildAgentsJson 上方长注释）：该档是**运行期消费的
// 宣告真源**，其内容＝environment-facts 对每个 agent 断言的【能力断路·物理事实】；生成器的
// 「全集 − 该 Expert 自有工具 → 全 false」补集规则在全集含共享基建工具时会**过度禁用**，
// 与人工调和过的物理闸 deploy-staging/opencode-runtime/opencode.json 不一致（重生成版每个
// Expert 多报 19 条假断言，含 read_image / local_files_authorize / character_card_* 等）。
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
//     是 video-director 域工具，协调者关闭；画布控制和只读报价保留。
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
import { VIDEO_DIRECTOR_PERSONA_PROMPT } from "../src/lib/video-director-persona";

import { EXPERT_REGISTRY } from "../src/lib/expert-registry";
import { buildExpertRegistryDigest } from "../src/lib/orchestrator-beast-frame";
import { HARNESS_TOOL_ID_LIST } from "../src/lib/harness-tool-registry";
import { LYRICIST_PERSONA_PROMPT, LYRICIST_LITERARY_ACCEPTANCE_DIRECTIVE } from "../src/lib/lyricist-persona";

const root = process.cwd();
/** 生成器主输出目录（gitignore，构建物）。 */
const OUT_DIR = join(root, "deploy-staging", "expert-gateway");
/** 被 git 追踪的发布副本：gateway-release.sh 由 `git archive <sha> deploy-staging/gateway`
 * 打包，网关运行时读的就是这份（expert/registry-digest.txt 等）。此前靠人手 cp，屡次漏档/
 * 半截（2026-10-06 实测 opencode-agents.json 两目录已漂移）——registry-digest.txt /
 * expert-ids.json / expert-delivery-contracts.json 三者统一写两份，消除「生成专家资产后
 * 手工同步」这一步（2026-10-06 引用修复片）。
 * **例外：opencode-agents.json 不写本目录**（禁止覆盖被追踪的人工调和真源）——见 PRODUCTS
 * 与 buildAgentsJson 上方长注释。 */
const SYNC_DIR = join(root, "deploy-staging", "gateway", "expert");
/** 双写目录对（仅用于「三个纯派生产物」）：构建目录 + git 追踪的发布副本。 */
const OUT_DIRS = [OUT_DIR, SYNC_DIR] as const;
/** 发布树根（本机存在；对应 VPS /opt/agent-harness/workspace/.opencode，即 agent 的 cwd
 * 之下那一层）。skillPath 漂移护栏的存在性断言根。 */
const HARNESS_RUNTIME_ROOT = join(root, "deploy-staging", "opencode-runtime");
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
  "Eimu 创作协调者：研究与派遣、只读报价、画布控制和独立验收；媒体生成与代码执行关闭";

const ORCHESTRATOR_PROMPT = "你是 Eimu 创作协调者。理解用户目标，研究前人作品并整合独立研究结论，写自包含任务书（目标、资产、参数、授权边界、交付与验收要求），经 subagent_dispatch 派具名生产专家；研究任务可留 expert 空。收真实产物后交独立 critic 审阅，按具体问题定向返工。你负责 quote_bundle 报价与账本核对、canvas_get_state/workflow_write 画布控制和收盘写穿；不直接生成媒体或执行代码。阅读资料与注册表以理解任务，不加载生产配方。共同契约见 workspace/AGENTS.md，持续授权按网关真实状态执行。向用户报告结果与必要进度，不复述内部审稿。";
const CREATOR_PROMPT = "你是 Eimu 创作助理（BEAST OFF），可直接调用当前开放域工具完成图片、视频、音乐创作。研究先行，再按任务读取 .opencode/skills/_prompt-routing/creator-guide.md 对应节与本域配方；多步工作可派 subagent_dispatch。共同真实性、授权、安全与交付契约见 workspace/AGENTS.md。只写歌词派 lyricist；需要原创歌词的歌曲先 lyricist 后 music，完整原词直接原样谱曲，纯器乐不派歌词。";
const CRITIC_PROMPT = "你是独立审阅者，不制作内容。针对真实交付对象调用可用只读感知/检索工具：图片实际读图，视频实际抽帧/分析，音频只用现场真实音频分析通路；容器或转写只能证明技术/文字，不能代替听感。逐项对照用户目标，给出具名检查对象、工具真实回执或可访问产物、结果与未覆盖项；没有工具或未感知的维度标 PARTIAL，不能 PASS。保留 verdict/issues/evidence/qc 契约字段，qc 为独立回执说明，不是作者自检勾选。末行 VERDICT: PASS|FAIL|PARTIAL；字串本身不是验收证据。";
const DIRECTOR3D_PROMPT = "你是 3D 制作专家。先确认任务书的输入资产、场景/机位、动画范围、目标尺寸与帧率、交付格式及贴图要求，缺省采用与用户目标一致的合理规格并明示；不制造统一分辨率或压缩限制。按本域配方驱动现有 Blender/3D 工具，交付任务要求的 GLB、贴图及渲染/可交互产物，保留实际文件/URL、导出回执和可用性证据。失败指出具体资产、阶段、原始工具错误与已尝试修复；没有加载/渲染证据的部分标未验。作者自查后送独立审阅。";
const ORCHESTRATOR_CONTROL_TOOLS = new Set(["canvas_get_state", "glob", "grep", "image_quote", "list", "local_files", "local_files_authorize", "memory_recall", "question", "quote_bundle", "read", "read_image", "search_aggregate", "search_web", "skill", "smart_search", "subagent_dispatch", "subagent_status", "subagent_stop", "todowrite", "video_analyze", "video_evidence", "video_measure", "video_quote", "video_transcribe", "vision_analyze", "webfetch", "websearch", "workflow_history", "workflow_rollback", "workflow_write"]);
const CRITIC_READ_TOOLS = new Set(["glob", "grep", "list", "read", "read_image", "search_web", "video_analyze", "video_evidence", "video_measure", "video_transcribe", "vision_analyze", "webfetch", "websearch"]);

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
  "（buildExpertRegistryDigest 逐字输出，全部 skillPath 经本脚本统一规则映射为 workspace 根相对形：前缀 .opencode/，嵌套 SKILL.md→RECIPE.md；由 tools/export-expert-agents.ts 机械生成）。" +
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
 * 与同一份部署的 opencode.json 直接矛盾。
 * Blender 三工具自 2026-10-18 起是共享工具（全席位可直调），不再按 Expert 域断路。 */
const SHARED_TOOLS = new Set(["workflow_start", "workflow_update_node", "workflow_status", "local_files", "image_get_result", "image_result_download", "video_result_fetch", "blender_exec", "blender_render", "blender_export_gltf"])

/** SHARED_TOOLS 中 orchestrator 亦须显式禁用的子集：野兽帧 beastTemplateFact 声明
 * 「你没有 workflow_* 工具」，必须是物理事实。local_files 不在此列——opencode.json 对
 * orchestrator 显式 local_files:true，必须保持默认开（不得被断路）。 */
const ORCHESTRATOR_DISABLED_SHARED_TOOLS = new Set(["workflow_start", "workflow_update_node", "workflow_status"])

/** orchestrator 额外物理禁用的内建工具（2026-10-06 收编：b637b681 提示词审计时直接手改
 * gateway/expert/opencode-agents.json 加了 "task": false，但未回写本生成器 ⇒ 生成器与发布副本
 * 漂移、--check 永红。此处收编为生成器的显式常量，使机械导出能复现该裁剪）。
 * task = opencode 通用子代理工具；对 orchestrator 关闭——派工唯一通路是 subagent_dispatch。
 * builtin 不在工具档清单内（universe 不含），须显式列进 map 才会物理禁用；否则默认开。
 * environment-facts 从本档 map 推导 orchestrator 的【能力断路·物理事实】，缺此行 = 宣告面少一件。 */
const ORCHESTRATOR_DISABLED_BUILTIN_TOOLS = new Set(["apply_patch", "bash", "edit", "lsp", "multiedit", "patch", "run_py", "task", "write"])

/** No production-domain exemptions for the coordinator; read/control capabilities are explicitly listed above. */
const ORCHESTRATOR_KEPT_DOMAIN_TOOLS = new Set<string>();

/**
 * opencode-agents.json —— **不双写、禁止盲目覆盖发布副本**（2026-10-06 修正）。
 *
 * 为什么不能直接写 deploy-staging/gateway/expert/opencode-agents.json：
 *  1. 它是**运行期消费的宣告真源**：deploy-staging/gateway/environment-facts.ts:195 读它，
 *     :531 / :559 把结果直接注入每个 agent 的提示：「【能力断路·物理事实】真源
 *     expert/opencode-agents.json 已物理移除以下 N 个工具，直接调用会失败：…」。
 *     故这份档的内容＝**每轮对模型断言的事实**，不是可随手重生成的派生物。
 *  2. 被追踪的那版与物理闸 deploy-staging/opencode-runtime/opencode.json **一致**，而本生成器
 *     的补集规则输出**不一致**。实测（物理 false 数 / HEAD 生成 false 数 / 本生成器 fallback
 *     输出 false 数）：
 *       agent          | 物理  | HEAD  | 生成器 | HEAD 多报 | 生成器 多报
 *       director3d     |  95   |  91   |  110   |    0      |   19
 *       music          |  97   |  93   |  112   |    0      |   19
 *       video-director |  95   |  85   |  104   |    0      |   19
 *       editor         |  88   |  84   |  103   |    0      |   19
 *       screenwriter   |  92   |  88   |  107   |    0      |   19
 *       motion-director|  95   |  91   |  110   |    0      |   19
 *       web3d-director |  97   |  93   |  112   |    0      |   19
 *       critic         | 104   |  94   |  113   |    0      |   19
 *     即 HEAD 版**没有任何一条**是物理为开却宣告为关；生成器版每个 Expert 多出 **19 条**这种
 *     假断言——多出来的含 `read_image`、`local_files_authorize`、`character_card_list/save`
 *     等共享基建工具。整个产品是图像/视频生成，把 `read_image` 对全部 Expert 宣告为「已物理
 *     移除」显然是错的。改用 VPS 真实工具清单（118 个，`ls .opencode/tools/`）重导仍多报 19 条。
 *  3. 根因：本生成器的补集规则（全集 − 该 Expert 自有工具 → 全 false）在**全集含共享基建工具**
 *     时会过度禁用；而 opencode-runtime/opencode.json 是**人工调过**的、含 SHARED_TOOLS 豁免的
 *     物理真源。故补集规则的输出**不可直接当这个档的真源**（不是「换准确全集」能解的问题，
 *     是规则本身不适用于这份档）。
 *
 * 结论：本生成器只把 opencode-agents.json 写进构建目录 OUT_DIR（供部署片对照/取用）；
 * 被追踪的 gateway/expert/opencode-agents.json 是人工调和真源，**保持 HEAD 不动**，如需变更
 * 必须人工对照 opencode-runtime/opencode.json 逐键调和后手改。
 */
function buildAgentsJson(universeTools: readonly string[]): string {
  // tools map 只写 false 项（opencode 语义：未列 = 默认开）；键序 = 来源清单插入序，确定性输出。
  const toolsFalse = (ids: readonly string[]): Record<string, boolean> => {
    const map: Record<string, boolean> = {};
    for (const id of ids) map[id] = false;
    return map;
  };

  const agents: Record<string, unknown> = {};
  // Positive control allowlist: research/read-only quotes/canvas remain; all other custom tools are denied.
  agents["orchestrator"] = {
    mode: "all",
    description: ORCHESTRATOR_DESCRIPTION,
    prompt: ORCHESTRATOR_PROMPT,
    tools: {
      ...toolsFalse(DOMAIN_TOOLS.filter((id) => !ORCHESTRATOR_KEPT_DOMAIN_TOOLS.has(id))),
      ...toolsFalse([...ORCHESTRATOR_DISABLED_SHARED_TOOLS]),
      ...toolsFalse([...ORCHESTRATOR_DISABLED_BUILTIN_TOOLS]),
      ...toolsFalse(universeTools.filter((id) => !ORCHESTRATOR_CONTROL_TOOLS.has(id))),
      ...Object.fromEntries([...ORCHESTRATOR_CONTROL_TOOLS].map((id) => [id, true])),
    },
  };
  agents["creator"] = { mode: "all", description: "Eimu 默认创作助理（BEAST OFF）：开放域创作", prompt: CREATOR_PROMPT, tools: { task: false } };
  // 其后按 registry 插入序：每个 Expert false 掉「全集 − 自己域工具 − 共享工具」
  // （含不属于任何 Expert 的工具，如 image_generate）。
  for (const expert of Object.values(EXPERT_REGISTRY)) {
    const own = new Set(expert.toolIds);
    const foreign = universeTools.filter((id) => !own.has(id) && !SHARED_TOOLS.has(id));
    agents[expert.id] = {
      mode: "all",
      description: `${expert.description}${EXPERT_DESCRIPTION_SUFFIX}`,
      ...(expert.id === "lyricist" ? { prompt: LYRICIST_PERSONA_PROMPT } : expert.id === "video-director" ? { prompt: VIDEO_DIRECTOR_PERSONA_PROMPT } : expert.id === "critic" ? { prompt: CRITIC_PROMPT } : ["director3d", "web3d-director"].includes(expert.id) ? { prompt: DIRECTOR3D_PROMPT } : {}),
      tools: {
        ...toolsFalse(foreign),
        // 关键帧和风格工具属于 video-director；显式 true 才能覆盖配置深合并残留的旧 false。
        ...(expert.id === "video-director" ? { image_generate: true, image_get_result: true, image_result_download: true, video_result_fetch: true, style_dna_extract: true, style_aligned_batch: true } : {}),
        ...(expert.id === "critic" ? { ...toolsFalse([...ORCHESTRATOR_DISABLED_BUILTIN_TOOLS]), ...Object.fromEntries([...CRITIC_READ_TOOLS].map((id) => [id, true])) } : {}),
      },
    };
  }
  return `${JSON.stringify(agents, null, 2)}\n`;
}

/** agent 的工作目录是 workspace 根（生产 session `directory=/opt/agent-harness/workspace`），
 * 技能树实际在 workspace/.opencode/skills/ 下——故任何注入给 agent 的座标都必须以此为前缀。 */
const WORKSPACE_ROOT_PREFIX = ".opencode/";

/**
 * registry 的 skillPaths 是 **repo 根树**命名（`skills/<域>/SKILL.md`，由
 * editor-persona 的 fs 存在性断言钉死、常量不得改）。进 harness digest 前统一施**一条规则**
 * 映射成 workspace 根相对形（2026-10-06 引用修复片：取代旧的 6 条手工 HARNESS_SKILL_PATH_MAP）：
 *   ① 统一加 `.opencode/` 前缀（agent 的 cwd = workspace 根）；
 *   ② 嵌套 `SKILL.md`（`skills/<域>/<子…>/SKILL.md`）改名 `RECIPE.md`；顶层
 *      `skills/<域>/SKILL.md` 保留 `SKILL.md`。
 *      （真树实测 deploy-staging/opencode-runtime/skills/：depth-2 的 SKILL.md 共 20 个全保留，
 *       更深层 SKILL.md 数量 0、全部是 RECIPE.md 共 151 个。）
 * 目录引用（`skills/motion-design/`、`skills/music-director/files/`）只加前缀，不改名。
 * 前缀幂等：已带 `.opencode/` 的输入原样保留。
 */
function toWorkspaceRelSkillPath(repoPath: string): string {
  const segs = repoPath.split("/");
  if (segs.length > 3 && segs[segs.length - 1] === "SKILL.md") {
    segs[segs.length - 1] = "RECIPE.md";
  }
  const renamed = segs.join("/");
  return renamed.startsWith(WORKSPACE_ROOT_PREFIX) ? renamed : `${WORKSPACE_ROOT_PREFIX}${renamed}`;
}

/** digest 正文里 `skills/…` 只出现在「配方库」栏（toolIds/taskTypes 皆非路径），
 * 逐 token 按规则映射即可；结束符排除逗号/分号/括弧/空白，避免吞掉相邻栏。 */
const SKILL_PATH_TOKEN = /skills\/[^\s,；、）)]+/g;

/** 把 buildExpertRegistryDigest() 输出里的每条 registry skillPath token 换成 workspace 根相对形。 */
function applyWorkspaceRelSkillPaths(digest: string): string {
  return digest.replace(SKILL_PATH_TOKEN, (token) => toWorkspaceRelSkillPath(token));
}

/** 全部输出 skillPath（去重保序，供漂移护栏逐条断言）。 */
function collectOutputSkillPaths(): string[] {
  return dedupePreserveOrder(
    Object.values(EXPERT_REGISTRY).flatMap((expert) =>
      [...expert.skillPaths].map(toWorkspaceRelSkillPath),
    ),
  );
}

/**
 * 漂移护栏（2026-10-06 引用修复片，本片重点＝打生成源）：生成时对每条输出 skillPath 做
 * fs 存在性断言，根取发布树 deploy-staging/opencode-runtime/（＝生产 .opencode 树，本机在）。
 * registry 一漂移、注入的座标就会指空，过去静默生成——现在当场炸：
 *   - 缺失 + `--check`：EXPORT_CHECK_FAIL 并 exit 1；
 *   - 缺失 + 正常模式：EXPORT_WARN 并列出缺失清单（不中断写盘，供人对照修 registry/发布树）；
 *   - 发布树不存在（fresh clone / 未检出该目录）：降级为 WARN（degraded），不崩。
 */
function verifySkillPathExistence(): {
  ok: boolean;
  missing: string[];
  degraded: boolean;
  reason?: string;
} {
  const paths = collectOutputSkillPaths();
  if (!existsSync(HARNESS_RUNTIME_ROOT)) {
    return {
      ok: true,
      missing: [],
      degraded: true,
      reason: `发布树 ${HARNESS_RUNTIME_ROOT} 不存在（fresh clone 或未检出），无法做存在性断言`,
    };
  }
  const missing = paths.filter((p) => {
    const rel = p.startsWith(WORKSPACE_ROOT_PREFIX)
      ? p.slice(WORKSPACE_ROOT_PREFIX.length)
      : p;
    return !existsSync(join(HARNESS_RUNTIME_ROOT, rel));
  });
  return { ok: missing.length === 0, missing, degraded: false };
}

function buildDigestTxt(): string {
  // 无档尾换行：剥头（stripProvenanceHeader 只 trimStart）后与 buildExpertRegistryDigest()
  // 输出逐字 byte 相等（唯 skillPath 经规则映射为 workspace 根相对形），注入帧零多余空白。
  return `${DIGEST_PROVENANCE_HEADER}\n${applyWorkspaceRelSkillPaths(buildExpertRegistryDigest())}`;
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

const AGENTS_JSON = "opencode-agents.json";
/** 双写产物（两个目录各一份、须逐字节等价）：纯派生、被 git 追踪且运行期读，无人工调和成分。
 * opencode-agents.json **不在其列**（只写构建目录 OUT_DIR，理由见 buildAgentsJson 上方长注释）。 */
const DOUBLE_WRITE_FILES = [
  "registry-digest.txt",
  "expert-ids.json",
  "expert-delivery-contracts.json",
] as const;

/** 产物定义：文件名 → 构建函式 + 写入目录集。dirs = [OUT_DIR] 者不双写。 */
interface Product {
  file: string;
  build: (universeTools: readonly string[]) => string;
  dirs: readonly string[];
}

const PRODUCTS: Product[] = [
  { file: AGENTS_JSON, build: buildAgentsJson, dirs: [OUT_DIR] },
  { file: "registry-digest.txt", build: () => buildDigestTxt(), dirs: OUT_DIRS },
  { file: "expert-ids.json", build: () => buildExpertIdsJson(), dirs: OUT_DIRS },
  { file: "expert-delivery-contracts.json", build: () => buildDeliveryContractsJson(), dirs: OUT_DIRS },
];

/** 只同步歌词域绑定；保留人工调和的全部工具表与其他 Expert 声明。 */
function syncLyricistBindings(): string[] {
  const mismatches: string[] = [];
  const sync = (path: string, expected: string): void => {
    if (readFileSync(path, "utf8") === expected) return;
    if (CHECK) mismatches.push(path);
    else {
      writeFileSync(path, expected);
      console.log(`EXPORT_OK：${path}（歌词域绑定）`);
    }
  };
  // 文学公式只活在 lyricist/fang-wenshan 技能。这里只替换已误贴进 music 提示词的旧长段，
  // 不再把同一段盖进每个 agent，也不再盖进 orchestrator 派遣手册。
  const replaceHandoff = (text: string): string => text.replace(
    /【歌词(?:文学接收与谱曲交接|交接)】[^\n]*/g,
    LYRICIST_LITERARY_ACCEPTANCE_DIRECTIVE,
  );
  const runtimePath = join(HARNESS_RUNTIME_ROOT, "opencode.json");
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  if (!runtime.agent?.lyricist) throw new Error("EXPORT_FAIL：缺少 lyricist 运行期声明，禁止自动重建工具表");
  const currentPrompt: string = runtime.agent.lyricist.prompt;
  const roleStart = currentPrompt.indexOf("【你的角色：歌词专家");
  const basePrompt = roleStart < 0 ? currentPrompt.split("\n\n")[0] : currentPrompt.slice(0, roleStart).trimEnd();
  runtime.agent.lyricist.prompt = `${basePrompt}\n\n【你的角色：歌词专家】${LYRICIST_PERSONA_PROMPT}`;
  if (typeof runtime.agent.music?.prompt === "string") {
    runtime.agent.music.prompt = replaceHandoff(runtime.agent.music.prompt);
  }
  sync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
  const declarationPath = join(SYNC_DIR, AGENTS_JSON);
  const declarations = JSON.parse(readFileSync(declarationPath, "utf8"));
  if (!declarations.lyricist) throw new Error("EXPORT_FAIL：缺少 lyricist 能力声明，禁止覆盖其他 Expert");
  declarations.lyricist.prompt = LYRICIST_PERSONA_PROMPT;
  sync(declarationPath, `${JSON.stringify(declarations, null, 2)}\n`);
  const musicSkillPath = join(HARNESS_RUNTIME_ROOT, "skills", "music-director", "SKILL.md");
  const musicSkill = readFileSync(musicSkillPath, "utf8");
  if (musicSkill.includes("【歌词文学接收与谱曲交接】") || musicSkill.includes("【歌词交接】")) {
    sync(musicSkillPath, replaceHandoff(musicSkill));
  }
  const playbookPath = join(SYNC_DIR, "orchestrator-dispatch-playbook.md");
  const playbook = readFileSync(playbookPath, "utf8").replace(
    /【歌词文学接收与谱曲交接】[^\n]*\n?/g,
    "",
  );
  sync(playbookPath, playbook);
  const assetsPath = join(root, "src", "lib", "expert-gateway-assets.json");
  const assets = JSON.parse(readFileSync(assetsPath, "utf8"));
  assets.orchestrator_dispatch_playbook = playbook;
  sync(assetsPath, `${JSON.stringify(assets, null, 2)}\n`);
  return mismatches;
}

/** 只同步视频导演短入口及已登记风格工具；保留模型、其他工具及其他角色。 */
function syncVideoDirectorBindings(): string[] {
  const mismatches: string[] = [];
  for (const path of [join(HARNESS_RUNTIME_ROOT, "opencode.json"), join(SYNC_DIR, AGENTS_JSON)]) {
    const config = JSON.parse(readFileSync(path, "utf8"));
    const role = (config.agent ?? config)["video-director"];
    if (!role) throw new Error(`EXPORT_FAIL：${path} 缺少 video-director，不自动重建角色`);
    for (const entry of Object.values(config.agent ?? config) as any[]) {
      if (!entry || typeof entry !== "object") continue;
      entry.tools ??= {};
      for (const id of ["image_get_result", "image_result_download", "video_result_fetch"]) entry.tools[id] = true;
    }
    role.prompt = VIDEO_DIRECTOR_PERSONA_PROMPT;
    role.tools ??= {};
    role.tools.image_get_result = true;
    role.tools.image_result_download = true;
    role.tools.video_result_fetch = true;
    role.tools.style_dna_extract = true;
    role.tools.style_aligned_batch = true;
    const expected = `${JSON.stringify(config, null, 2)}\n`;
    if (readFileSync(path, "utf8") === expected) continue;
    if (CHECK) mismatches.push(path);
    else {
      writeFileSync(path, expected);
      console.log(`EXPORT_OK：${path}（仅视频导演 prompt、风格与共享产物回收工具绑定）`);
    }
  }
  return mismatches;
}

function main(): void {
  const universe = loadUniverse();

  if (universe.source === "fallback") {
    console.warn(
      "EXPORT_WARN：未传 --tools-file，使用近似工具全集" +
        `（HARNESS_TOOL_ID_LIST ${HARNESS_TOOL_ID_LIST.length} 个 + 已知 VPS 额外 ${KNOWN_VPS_EXTRA_TOOLS.length} 个）。` +
        "近似全集，部署时应用 --tools-file 重导（部署片从 VPS ls .opencode/tools/ 生成清单）。",
    );
  }

  // 漂移护栏（本片重点）：skillPath 存在性断言——注册表一漂移、注入座标就指空。
  const guard = verifySkillPathExistence();
  if (guard.degraded) {
    console.warn(`EXPORT_WARN：skillPath 漂移护栏降级——${guard.reason}；跳过存在性断言。`);
  } else if (!guard.ok) {
    const list = guard.missing.map((p) => `  - ${p}`).join("\n");
    if (CHECK) {
      console.error(
        `EXPORT_CHECK_FAIL：registry skillPath 在发布树 ${HARNESS_RUNTIME_ROOT} 下不存在（注入的指路座标会指空）：\n${list}\n  请修 registry 现值或发布树，再重跑。`,
      );
      process.exit(1);
    }
    console.warn(
      `EXPORT_WARN：下列 registry skillPath 在发布树 ${HARNESS_RUNTIME_ROOT} 下不存在（agent 会指空座标，请修 registry 或发布树）：\n${list}`,
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
    const mismatches: string[] = [...syncLyricistBindings(), ...syncVideoDirectorBindings()];
    for (const product of PRODUCTS) {
      const expected = product.build(universe.tools);
      for (const dir of product.dirs) {
        const target = join(dir, product.file);
        if (!existsSync(target)) {
          mismatches.push(`${target}（产物缺失）`);
          continue;
        }
        if (readFileSync(target, "utf8") !== expected) mismatches.push(target);
      }
    }
    if (mismatches.length > 0) {
      console.error(
        `EXPORT_CHECK_FAIL：产物与机械导出不一致（手工漂移或真源变动）：\n  ${mismatches.join("\n  ")}\n  重跑不带 --check 的导出再生。`,
      );
      process.exit(1);
    }
    console.log(
      `EXPORT_CHECK_OK：双写产物（${DOUBLE_WRITE_FILES.join(" / ")}）在 expert-gateway 与 gateway/expert 两份与机械导出 byte 等价（域工具 ${DOMAIN_TOOLS.length} / 全集 ${universe.tools.length}，未归属 Expert 的全集工具 ${unowned} 个保持默认开）`,
    );
    console.log(
      `EXPORT_NOTE：${AGENTS_JSON} 完整工具表只写构建目录 ${join(OUT_DIR, AGENTS_JSON)}（该副本已按机械导出比对）；被追踪的 ${join(SYNC_DIR, AGENTS_JSON)} 保留人工调和工具表，只校验 lyricist prompt 与歌词域镜像，禁止整表覆盖。`,
    );
    process.exit(0);
  }

  // 正常模式：声明 opencode-agents.json 的双写范围（防未来有人再把 SYNC_DIR 写回去）。
  console.warn(
    `EXPORT_WARN：${AGENTS_JSON} 只写构建目录 ${join(OUT_DIR, AGENTS_JSON)}；被 git 追踪的 ` +
      `${join(SYNC_DIR, AGENTS_JSON)} 是与物理 deploy-staging/opencode-runtime/opencode.json 调和过的` +
      "人工真源，**禁止盲目覆盖**（生成器的补集规则会过度禁用共享基建工具——read_image / local_files_authorize / " +
      "character_card_* 等，并给每个 Expert 多报 19 条假断言）。",
  );

  for (const product of PRODUCTS) {
    const output = product.build(universe.tools);
    for (const dir of product.dirs) {
      mkdirSync(dir, { recursive: true });
      const target = join(dir, product.file);
      writeFileSync(target, output);
      console.log(`EXPORT_OK：${target}（${Buffer.byteLength(output)} bytes）`);
    }
  }
  syncLyricistBindings();
  syncVideoDirectorBindings();
  console.log(
    `导出依据：域工具 ${DOMAIN_TOOLS.length} 个（registry 联集）/ 工具全集 ${universe.tools.length} 个（${universe.source}）/ registry ${Object.keys(EXPERT_REGISTRY).length} 行；skillPath 护栏 ${guard.degraded ? "降级" : guard.ok ? "PASS" : "WARN"}。`,
  );
}

main();
