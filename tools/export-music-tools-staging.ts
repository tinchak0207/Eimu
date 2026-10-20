#!/usr/bin/env -S npx tsx
//
// music_gen 工具家族 VPS staging 稿机械导出器（MOE Wave1 片B，2026-09-08；
// 2026-10-20 升级为「真源模组集合 → 目标模组集合」机械复制）。
//
// 范式同构 tools/export-blender-tools-staging.ts（机械导出，根治手工漂移）：
// 读真源每个模组全文 → 拼接环境适配（注释头 + 白名单 import 改写）→ 写目标模组。
// 正文与真源逐行等价，白名单 diff 只有注释头与 import 行两类。
//
// 为什么导出多档：src/lib/music-tools.ts import src/lib/music-lyria.ts（Lyria client）、
// src/lib/music-flowmusic.ts（FlowMusic2API client）、src/lib/music-yue2.ts（YuE2 Modal client）
// 与 src/lib/music-prompt-director.ts（确定性规则层），全部零依赖（仅 node 内建 + fetch），
// VPS .opencode/lib 同目录落位即闭包完整。2026-10-20 起 music-tools 已拆成同名子目录
// 模组集合，真源与目标以「barrel + 子模组」形状逐档对应导出；music-prompt-director
// 例外——部署侧是旧版真源，与 src 有历史行为差异，登记为 preserve 不再从 src 重生成。
//
// staging 目标目录：deploy-staging/ 本片禁碰（另一 agent 在改）→ 落 staging/music-tools/，
// 部署树（deploy-staging/opencode-runtime/lib/）由本脚本同步写出：
//   staging/music-tools/music_lyria.ts → /opt/agent-harness/workspace/.opencode/lib/music_lyria.ts
//   staging/music-tools/music_flowmusic.ts → /opt/agent-harness/workspace/.opencode/lib/music_flowmusic.ts
//   staging/music-tools/music_yue2.ts → /opt/agent-harness/workspace/.opencode/lib/music_yue2.ts
//   staging/music-tools/music_prompt_director*.ts → /opt/.../lib/music_prompt_director*.ts
//     （preserve：不由本脚本重生成，见下）
//   staging/music-tools/music_tools*.ts → /opt/.../lib/music-tools-impl.ts（线上补丁变体，见下）
//
// 线上补丁保留（2026-10-20 用户裁定，勿回退）：部署树里 music_flowmusic.ts / music_yue2.ts /
// music-tools-impl.ts 带有**src 没有的线上补丁**（FlowMusic 错误分类 classifyFlowMusicFailure／
// FlowMusicServiceError、YuE2 瞬时重试 isYue2TransientFailure／yue2TransientCode、9 段
// harness-only 代码），另有 music_prompt_director.ts 及其拆分子模组停留在旧版部署稿。
//
// music-prompt-director 为什么 preserve（2026-10-20 用户裁定，勿改回 sync）：部署侧
// staging/music-tools/music_prompt_director.ts 与 deploy-staging/opencode-runtime/lib/
// music_prompt_director.ts 是**旧版部署副本**，与真源 src/lib/music-prompt-director.ts
// 存在历史行为差异——真源新增 BARE_SECTION_LABEL_PATTERN 分层权重、MIN_KEEP_RATIO
// 保护、droppedCompressed 精确计算等逻辑。上一轮按 src 重生成这两档＝改动生产行为，
// 违反无损要求（已回退）。故本脚本对这两档只登记、不写盘、--check 不判漂移，
// 待产品裁定后再同步。两档现为同构的 barrel + 子模组（defs / pipeline），手写维护。
//
// 因此本脚本按 family mode 处理：
//   - sync：可无损从真源推导 → 写 staging 与部署树，--check 逐档比对。
//   - preserve：目标含未回灌 src 的线上补丁／旧版差异 → 不写、不判失败，只提示（继续保留）。
//   - known-drift：基线已知漂移（music_flowmusic.ts）→ 不写；--check 如实报失败，
//     保持「既有漂移集合 = 仅 music_flowmusic.ts 一处」。
//
// 用法（真源改动后必跑）：
//   npx tsx tools/export-music-tools-staging.ts
//   npx tsx tools/export-music-tools-staging.ts --check   # 只校验不写（CI/验收用）
//
// 部署树守门：--check 同时比对 deploy-staging/opencode-runtime/lib/；除部署档内
// `// <harness-only>` … `// </harness-only>` 界定的区块（登记于 DEPLOY_TARGETS）外必须等价，
// 否则非零退出——防止有人把 staging 导出物整档覆盖进部署树而静默删掉 harness-only 功能。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const STAGING_DIR = join(root, "staging/music-tools");
const DEPLOY_LIB = join(root, "deploy-staging/opencode-runtime/lib");
const CHECK = process.argv.includes("--check");

// ── 白名单 diff ②：注释头（落位说明 + 禁手改宣言）────────────────────────────

const LYRIA_HEADER = `/**
 * Lyria client VPS staging 稿（MOE Wave1 片B，2026-09-08 机械导出）。
 *
 * 本档由 tools/export-music-tools-staging.ts 从行为真源 src/lib/music-lyria.ts
 * 机械导出：真源全文逐行保留（端点/鉴权/prompt 组装/错误铁律/超时全在），
 * 零依赖、无 import，除本注释头外与真源逐行等价。
 * 禁止手改本档——改真源后跑 \`npx tsx tools/export-music-tools-staging.ts\` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_lyria.ts
 * env：GEMINI_STUDIO_API_KEY（generativelanguage lyria-3.5 generateContent，带人声整歌，付费）；
 *      GEMINI_API_KEY（无 studio key 时退回 Vertex lyria-002 :predict，纯器乐 30s，degraded）。
 */

`;

const FLOWMUSIC_HEADER = `/**
 * FlowMusic2API client VPS staging 稿（死线3 music_gen 通路换血，2026-09-09 机械导出）。
 *
 * 本档由 tools/export-music-tools-staging.ts 从行为真源 src/lib/music-flowmusic.ts
 * 机械导出：真源全文逐行保留（端点/鉴权/clips 解析/下载/错误铁律/超时全在），
 * 零依赖、无 import，除本注释头外与真源逐行等价。
 * 禁止手改本档——改真源后跑 \`npx tsx tools/export-music-tools-staging.ts\` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_flowmusic.ts
 * env：FLOWMUSIC2API_URL（服务地址，缺省禁用本通路）、FLOWMUSIC2API_KEY（Bearer）。
 */

`;

const YUE2_HEADER = `/**
 * YuE2 client VPS staging 稿（music_gen 第三通路，2026-09-19 机械导出）。
 *
 * 本档由 tools/export-music-tools-staging.ts 从行为真源 src/lib/music-yue2.ts
 * 机械导出：真源全文逐行保留（端点/鉴权/HMAC 签名/契约栏位/错误铁律/600s 超时全在），
 * 零依赖、无 import，除本注释头外与真源逐行等价。
 * 禁止手改本档——改真源后跑 \`npx tsx tools/export-music-tools-staging.ts\` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_yue2.ts
 * env：YUE2_MODAL_ENDPOINT（服务地址，缺省禁用本通路）、YUE2_HMAC_SECRET（HMAC 签名密钥）。
 */

`;

const DIRECTOR_HEADER = `/**
 * Music Prompt Director VPS staging 稿（确定性规则层，2026-09-12 机械导出）。
 *
 * 本档由 tools/export-music-tools-staging.ts 从行为真源 src/lib/music-prompt-director.ts
 * 机械导出：真源全文逐行保留（六层侦测/anti-slop/伪标签剥除/mood 修剪/通路硬规则/
 * 补层/长度上限全在），除本注释头与模组 import 行外与真源逐行等价。
 * 禁止手改本档——改真源后跑 \`npx tsx tools/export-music-tools-staging.ts\` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_prompt_director.ts
 * env：无（纯函数，零依赖零副作用）。
 */

`;

const TOOLS_HEADER = `/**
 * music_gen harness 工具 VPS staging 稿（MOE Wave1 片B，2026-09-08 机械导出）。
 *
 * 本档由 tools/export-music-tools-staging.ts 从行为真源 src/lib/music-tools.ts
 * 机械导出：真源全文逐行保留（工具定义/ok-fail/resolveKey/ffprobe 时长/上传通路
 * 全在），除「环境适配」外与真源逐行等价。
 * 白名单 diff 仅注释头与同目录落位档名（\`music-lyria\` → \`music_lyria\` 等）。
 * 禁止手改本档——改真源后跑 \`npx tsx tools/export-music-tools-staging.ts\` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music-tools-impl.ts
 * env：GATEWAY_URL（默认 http://127.0.0.1:8081）、HARNESS_API_KEY（fallback）、
 *      GEMINI_STUDIO_API_KEY（lyria-3.5 generateContent 主 key，音频落盘经 gateway 会话上传存储）、
 *      GEMINI_API_KEY（Vertex lyria-002 降级）、FLOWMUSIC_ADMIN_USER／FLOWMUSIC_ADMIN_PASSWORD
 *      （FlowMusic 真鉴权探针 /api/tokens/1/refresh-credits 用；缺失时探针降级为 unreachable 提示）。
 */

`;

/** 子模组的机械导出头（禁止手改说明 + 真源路径）。 */
function submoduleHeader(sourceRel: string): string {
  return `/**
 * 机械导出档（禁止手改）：由 tools/export-music-tools-staging.ts 从
 * ${sourceRel} 生成。改真源后跑 \`npx tsx tools/export-music-tools-staging.ts\` 重导出。
 */

`;
}

// ── 真源模组 ↔ 目标模组映射 ───────────────────────────────────────────────────

/** 单档映射：真源 → staging 目标（→ 部署树对应档）。 */
type ModuleSpec = {
  /** 真源相对仓库根的路径（只用于回报与子模组注释头）。 */
  sourceRel: string;
  staged: string;
  /** 部署树对应档；缺省＝部署树无此档（仅 staging 使用）。 */
  deployed?: string;
  /** 注释头（barrel 用完整头，子模组用 submoduleHeader）。 */
  header: string;
  /** 白名单 import 改写（逐字替换）。 */
  rewrites: ReadonlyArray<readonly [string, string]>;
};

/**
 * family mode：
 *  - sync：可无损从真源推导，写 staging 与部署树，--check 逐档比对。
 *  - preserve：目标含未回灌 src 的线上补丁，不写不判失败（保留现状）。
 *  - known-drift：基线已知漂移，不写；--check 如实报失败（保持漂移集合不变）。
 */
type FamilyMode = "sync" | "preserve" | "known-drift";

type Family = {
  name: string;
  mode: FamilyMode;
  note?: string;
  modules: ModuleSpec[];
};

// ── 白名单 diff ①：真源 import → 同目录落位档名（VPS 平铺惯例）──────────────
// music-prompt-director 为 preserve，以下改写只用于构造 --check 的期望文本（不写盘）；
// 目标档实际是旧版拆分稿的 hand-maintained defs / pipeline 子模组。
const DIRECTOR_REWRITES = [
  ['from "./music-prompt-director/rules-core"', 'from "./music_prompt_director_defs"'],
  ['from "./music-prompt-director/rules-transform"', 'from "./music_prompt_director_pipeline"'],
  ['from "./rules-core"', 'from "./music_prompt_director_defs"'],
  ['from "./rules-transform"', 'from "./music_prompt_director_pipeline"'],
] as const;

const TOOLS_REWRITES = [
  ['from "./music-lyria"', 'from "./music_lyria"'],
  ['from "./music-flowmusic"', 'from "./music_flowmusic"'],
  ['from "./music-prompt-director"', 'from "./music_prompt_director"'],
  ['from "./music-yue2"', 'from "./music_yue2"'],
  ['from "./music-take-entropy"', 'from "./music_take_entropy"'],
  ['from "./harness-tool-ids"', 'from "./harness_tool_ids"'],
  ['from "../music-lyria"', 'from "./music_lyria"'],
  ['from "../music-flowmusic"', 'from "./music_flowmusic"'],
  ['from "../music-prompt-director"', 'from "./music_prompt_director"'],
  ['from "../music-yue2"', 'from "./music_yue2"'],
  ['from "../music-take-entropy"', 'from "./music_take_entropy"'],
  ['from "../harness-tool-ids"', 'from "./harness_tool_ids"'],
  ['from "./music-tools/core"', 'from "./music_tools_core"'],
  ['from "./music-tools/gen"', 'from "./music_tools_gen"'],
  ['from "./core"', 'from "./music_tools_core"'],
] as const;

const FAMILIES: readonly Family[] = [
  {
    name: "music-flowmusic",
    mode: "known-drift",
    note: "基线已知漂移（部署树带 src 没有的 FlowMusic 错误分类补丁），按任务要求保留、不修",
    modules: [
      {
        sourceRel: "src/lib/music-flowmusic.ts",
        staged: join(STAGING_DIR, "music_flowmusic.ts"),
        deployed: join(DEPLOY_LIB, "music_flowmusic.ts"),
        header: FLOWMUSIC_HEADER,
        rewrites: [],
      },
    ],
  },
  {
    name: "music-lyria",
    mode: "sync",
    modules: [
      {
        sourceRel: "src/lib/music-lyria.ts",
        staged: join(STAGING_DIR, "music_lyria.ts"),
        deployed: join(DEPLOY_LIB, "music_lyria.ts"),
        header: LYRIA_HEADER,
        rewrites: [],
      },
    ],
  },
  {
    name: "music-yue2",
    mode: "preserve",
    note: "部署树带 src 没有的 YuE2 瞬时分类补丁（isYue2TransientFailure／yue2TransientCode），保留",
    modules: [
      {
        sourceRel: "src/lib/music-yue2.ts",
        staged: join(STAGING_DIR, "music_yue2.ts"),
        deployed: join(DEPLOY_LIB, "music_yue2.ts"),
        header: YUE2_HEADER,
        rewrites: [],
      },
    ],
  },
  {
    name: "music-prompt-director",
    mode: "preserve",
    note:
      "部署侧为旧版部署副本，与真源有历史差异（真源新增 BARE_SECTION_LABEL_PATTERN 分层权重、" +
      "MIN_KEEP_RATIO 保护、droppedCompressed 精确计算），暂不从 src 重生成；" +
      "两档已回退到 HEAD 并机械拆为 barrel + defs / pipeline 子模组，待产品裁定后再同步",
    modules: [
      {
        sourceRel: "src/lib/music-prompt-director.ts",
        staged: join(STAGING_DIR, "music_prompt_director.ts"),
        deployed: join(DEPLOY_LIB, "music_prompt_director.ts"),
        header: DIRECTOR_HEADER,
        rewrites: DIRECTOR_REWRITES,
      },
    ],
  },
  {
    name: "music-tools",
    mode: "preserve",
    note:
      "部署树 music-tools-impl.ts 带 9 段 harness-only 与线上补丁，src 尚未回灌；" +
      "待补丁回灌后再切 sync（届时需把 harness-only 区块按锚点落进对应子模组）",
    modules: [
      {
        sourceRel: "src/lib/music-tools.ts",
        staged: join(STAGING_DIR, "music_tools.ts"),
        deployed: join(DEPLOY_LIB, "music-tools-impl.ts"),
        header: TOOLS_HEADER,
        rewrites: TOOLS_REWRITES,
      },
      {
        sourceRel: "src/lib/music-tools/core.ts",
        staged: join(STAGING_DIR, "music_tools_core.ts"),
        header: submoduleHeader("src/lib/music-tools/core.ts"),
        rewrites: TOOLS_REWRITES,
      },
      {
        sourceRel: "src/lib/music-tools/gen.ts",
        staged: join(STAGING_DIR, "music_tools_gen.ts"),
        header: submoduleHeader("src/lib/music-tools/gen.ts"),
        rewrites: TOOLS_REWRITES,
      },
    ],
  },
];

// ── 导出核心 ─────────────────────────────────────────────────────────────────

const MAX_TARGET_LINES = 1000;
const failures: string[] = [];
const preserved: string[] = [];

function countLines(text: string): number {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** 应用白名单 import 改写，并断言所有相对 import 已落成平铺目标档名。 */
function transformImports(source: string, spec: ModuleSpec, sourceRel: string): string {
  let src = source;
  for (const [line, replacement] of spec.rewrites) {
    src = src.split(line).join(replacement);
  }
  // 守门：相对 import 必须已是平铺的 `./<underscore_name>`（防止真源结构变了却静默漏改）。
  for (const match of src.matchAll(/\bfrom\s+"(\.[^"]*)"/g)) {
    const specifier = match[1];
    if (!/^\.\/[A-Za-z0-9_]+$/.test(specifier)) {
      throw new Error(
        `真源 ${sourceRel} 的相对 import 未被白名单覆盖：${specifier}。` +
          "真源结构变了，先补 FAMILIES 的 rewrites 再导出。",
      );
    }
  }
  return src;
}

function buildExpected(spec: ModuleSpec): string {
  const source = readFileSync(join(root, spec.sourceRel), "utf8");
  return spec.header + transformImports(source, spec, spec.sourceRel);
}

function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    console.log(`EXPORT_SAME：${path} 已是机械导出产物（无改动）`);
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`EXPORT_OK：${path}（${Buffer.byteLength(content)} bytes）`);
  return true;
}

function reportFile(spec: ModuleSpec, content: string, actual?: string | null): void {
  const shown = actual ?? content;
  console.log(`  · ${spec.staged}：${countLines(shown)} 行`);
}

for (const family of FAMILIES) {
  console.log(`\n[${family.name}] mode=${family.mode}${family.note ? ` — ${family.note}` : ""}`);
  for (const spec of family.modules) {
    const expected = buildExpected(spec);
    if (family.mode === "sync" && countLines(expected) >= MAX_TARGET_LINES) {
      failures.push(`${spec.staged} 生成后 ${countLines(expected)} 行，超过 ${MAX_TARGET_LINES} 行上限`);
    }
    if (CHECK) {
      const actual = existsSync(spec.staged) ? readFileSync(spec.staged, "utf8") : null;
      if (actual === expected) {
        console.log(`EXPORT_CHECK_OK：${spec.staged} 与机械导出产物 byte 等价`);
        reportFile(spec, expected, actual);
        continue;
      }
      const detail = `${spec.staged} 与机械导出产物不一致（手工漂移或白名单变动）`;
      if (family.mode === "sync") {
        failures.push(`EXPORT_CHECK_FAIL：${detail}，重跑不带 --check 的导出。`);
        console.error(`EXPORT_CHECK_FAIL：${detail}，重跑不带 --check 的导出。`);
      } else if (family.mode === "known-drift") {
        failures.push(`EXPORT_KNOWN_DRIFT：${detail}（既有已知漂移，按任务要求保留）。`);
        console.error(`EXPORT_KNOWN_DRIFT：${detail}（既有已知漂移，按任务要求保留）。`);
      } else if (actual === null) {
        const note = `${spec.staged} 尚未生成（目标与真源存在已登记差异，本次不生成；预期 ${countLines(expected)} 行）`;
        preserved.push(`EXPORT_PRESERVE：${note}`);
        console.log(`EXPORT_PRESERVE：${note}`);
      } else {
        preserved.push(`EXPORT_PRESERVE：${detail}（目标与真源存在已登记差异，按裁定保留；原因见 family note）。`);
        console.log(`EXPORT_PRESERVE：${detail}（目标与真源存在已登记差异，按裁定保留；原因见 family note）。`);
      }
      reportFile(spec, expected, actual);
      continue;
    }
    if (family.mode === "sync") {
      writeIfChanged(spec.staged, expected);
      if (spec.deployed) writeIfChanged(spec.deployed, expected);
      reportFile(spec, expected);
    } else {
      const state = family.mode === "known-drift" ? "既有漂移保留" : "已登记差异保留";
      if (existsSync(spec.staged)) {
        console.log(`EXPORT_PRESERVE：${spec.staged} 未写入（${state}，见本档头说明）。`);
        reportFile(spec, expected, readFileSync(spec.staged, "utf8"));
      } else {
        console.log(`EXPORT_PRESERVE：${spec.staged} 未生成（${state}；预期 ${countLines(expected)} 行）。`);
      }
    }
  }
}

if (!CHECK) {
  console.log("\n验收：npx tsx tools/export-music-tools-staging.ts --check");
}

// ── 部署树漂移守门（2026-10-04 片 U2；2026-10-20 适配模组集合）──────────────
//
// 为什么需要：staging/music-tools/* 只是机械导出物（本脚本产物），deploy-staging/
// opencode-runtime/lib/ 才是部署真源。有人照本档文件头把 staging 导出物 cp 进
// deploy-staging/... 时，会静默删掉部署树的 harness-only 功能（music-tools-impl.ts 的
// source_audio 工作区路径解析依赖 harness-only 模组 ./sandbox，真源无从导出）。
// 故在此加守门：导出物与部署树对应档必须等价，唯一允许的例外＝部署档内以
// `// <harness-only>` … `// </harness-only>` 界定、且在此登记数量的区块；例外区块失踪
// （＝整档被覆盖）同样视为漂移。例外之外的任何改行/多行/少行 → 非零退出并印出。

const HARNESS_OPEN = "// <harness-only>";
const HARNESS_CLOSE = "// </harness-only>";

type DeployTarget = {
  /** staging 导出物（＝本脚本产物；--check 已保证其与导出结果 byte 等价）。 */
  exported: string;
  /** 部署树对应档。 */
  deployed: string;
  /** 允许的 harness-only 例外区块数；0＝必须与导出物 byte 等价（verbatim 导出）。 */
  harnessOnlyRegions: number;
  /**
   * 例外区块之外的正文差异：fail＝视为事故；preserve＝线上补丁未回灌 staging，按用户裁定保留。
   * 无论哪种模式，harness-only marker 成对数/区块数不符一律 fail（防整档覆盖）。
   */
  contentDrift: "fail" | "preserve";
  /**
   * 部署档已机械拆为 barrel + 子模组（2026-10-20）时的子模组档名（相对 DEPLOY_LIB）。
   * 声明后：harness-only 例外区块跨整组扫描、总数仍须等于 harnessOnlyRegions；
   * 正文 LCS 比对对拆分形态无意义（preserve 模式下本来只登记不判失败），故跳过。
   */
  splitModules?: readonly string[];
};

const DEPLOY_TARGETS: readonly DeployTarget[] = [
  { exported: join(STAGING_DIR, "music_flowmusic.ts"), deployed: join(DEPLOY_LIB, "music_flowmusic.ts"), harnessOnlyRegions: 0, contentDrift: "fail" },
  { exported: join(STAGING_DIR, "music_lyria.ts"), deployed: join(DEPLOY_LIB, "music_lyria.ts"), harnessOnlyRegions: 0, contentDrift: "fail" },
  { exported: join(STAGING_DIR, "music_yue2.ts"), deployed: join(DEPLOY_LIB, "music_yue2.ts"), harnessOnlyRegions: 0, contentDrift: "fail" },
  { exported: join(STAGING_DIR, "music_prompt_director.ts"), deployed: join(DEPLOY_LIB, "music_prompt_director.ts"), harnessOnlyRegions: 0, contentDrift: "fail" },
  // music-tools-impl.ts：9 段 harness-only 例外（注释头、take-entropy＋platformFetch import
  // 改写、source_audio 路径解析＋musicChargeReceiptFields 扣费区块、工具描述、source_audio
  // 参数描述、呼叫端 ref 生成解析区块、audioBase64 传参、上传失败早返回扣费、成功回执扣费）。
  // 2026-10-10「音乐 1 币/次」新增后两段（上传失败早返回扣费、成功回执扣费），7 → 9。
  // 2026-10-20 无损重构：部署档已按顶层声明边界机械拆为 barrel + 5 个子模组（每档 <1000 行），
  // 9 段例外区块随所属声明散落在 barrel（注释头）／tool（6 段）／source-audio（1 段），
  // 故按整组扫描总数，正文 LCS 比对跳过。
  {
    exported: join(STAGING_DIR, "music_tools.ts"),
    deployed: join(DEPLOY_LIB, "music-tools-impl.ts"),
    harnessOnlyRegions: 9,
    contentDrift: "preserve",
    splitModules: [
      "music-tools-impl-core.ts",
      "music-tools-impl-source-audio.ts",
      "music-tools-impl-audio.ts",
      "music-tools-impl-probe.ts",
      "music-tools-impl-tool.ts",
    ],
  },
];

/** 扫出部署档的 harness-only 例外行（含 marker 行本身），并验证 marker 成对。 */
function scanHarnessOnly(lines: string[]): { exempt: boolean[]; regions: number; balanced: boolean } {
  const exempt = new Array<boolean>(lines.length).fill(false);
  let inside = false;
  let regions = 0;
  let balanced = true;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === HARNESS_OPEN) {
      if (inside) balanced = false;
      inside = true;
      exempt[i] = true;
      regions += 1;
      continue;
    }
    if (t === HARNESS_CLOSE) {
      if (!inside) balanced = false;
      inside = false;
      exempt[i] = true;
      continue;
    }
    exempt[i] = inside;
  }
  if (inside) balanced = false;
  return { exempt, regions, balanced };
}

/** 行级 LCS diff：回传两侧不匹配的连续区块（hunk），用于逐块判漂移。 */
function diffHunks(a: string[], b: string[]): Array<{ aFrom: number; aTo: number; bFrom: number; bTo: number }> {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w); // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w;
    const next = (i + 1) * w;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j] ? dp[next + j + 1] + 1 : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }
  const hunks: Array<{ aFrom: number; aTo: number; bFrom: number; bTo: number }> = [];
  let i = 0;
  let j = 0;
  let cur: { aFrom: number; aTo: number; bFrom: number; bTo: number } | null = null;
  const flush = (): void => {
    if (cur) {
      cur.aTo = i;
      cur.bTo = j;
      hunks.push(cur);
      cur = null;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i += 1;
      j += 1;
      continue;
    }
    if (!cur) cur = { aFrom: i, aTo: i, bFrom: j, bTo: j };
    if (j >= m) i += 1;
    else if (i >= n) j += 1;
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i += 1;
    else j += 1;
  }
  flush();
  return hunks;
}

function checkDeployedDrift(): void {
  for (const t of DEPLOY_TARGETS) {
    const exportedText = readFileSync(t.exported, "utf8");
    const extraModules = t.splitModules ?? [];
    const split = extraModules.length > 0;
    const deployedPaths = [t.deployed, ...extraModules.map((name) => join(DEPLOY_LIB, name))];
    const deployedTexts: string[] = [];
    let missing = false;
    for (const deployedPath of deployedPaths) {
      try {
        deployedTexts.push(readFileSync(deployedPath, "utf8"));
      } catch {
        failures.push(
          split
            ? `${deployedPath} 不存在（部署树缺档；导出物 ${t.exported} 未落位或拆分子模组缺失）`
            : `${t.deployed} 不存在（部署树缺档；导出物 ${t.exported} 未落位）`,
        );
        missing = true;
      }
    }
    if (missing) continue;

    let targetFailed = false;
    const exportedLines = exportedText.split("\n");
    const scans = deployedTexts.map((text) => scanHarnessOnly(text.split("\n")));
    const deployedLines = deployedTexts[0].split("\n");
    const { exempt, regions } = scans[0];
    const totalRegions = scans.reduce((sum, scan) => sum + scan.regions, 0);

    if (!scans.every((scan) => scan.balanced)) {
      failures.push(`${t.deployed} harness-only marker 不成对（<harness-only> 与 </harness-only> 数量/嵌套错误）`);
      targetFailed = true;
    }
    if (totalRegions !== t.harnessOnlyRegions) {
      failures.push(
        `${t.deployed} harness-only 例外区块数不符：宣告 ${t.harnessOnlyRegions}、实际 ${totalRegions}` +
          (totalRegions < t.harnessOnlyRegions
            ? "（例外区块失踪＝疑似被 staging 导出物整档覆盖，harness-only 功能已被删）"
            : "（多出未登记的例外，请更新本脚本 DEPLOY_TARGETS）"),
      );
      targetFailed = true;
    }

    if (split) {
      if (!targetFailed) {
        console.log(
          `DEPLOY_DRIFT_OK：${t.deployed} 已拆为 ${deployedPaths.length} 档，` +
            `${totalRegions} 个已宣告 harness-only 区块全数在册（拆分形态跳过正文 LCS 比对）`,
        );
      }
      continue;
    }

    const bad = diffHunks(exportedLines, deployedLines).filter((h) => {
      if (h.bTo > h.bFrom) {
        // 部署树多出/改动的非空行：必须整段落在已宣告的例外区块内（空行无行为，容忍）。
        for (let k = h.bFrom; k < h.bTo; k++) {
          if (!exempt[k] && deployedLines[k].trim() !== "") return true;
        }
        return false;
      }
      // 纯删除（部署树掉了导出物的内容）：全空行，或紧邻已宣告例外时放行。
      let allBlank = true;
      for (let k = h.aFrom; k < h.aTo; k++) {
        if (exportedLines[k].trim() !== "") {
          allBlank = false;
          break;
        }
      }
      if (allBlank) return false;
      return !(exempt[h.bFrom] === true || (h.bFrom > 0 && exempt[h.bFrom - 1] === true));
    });

    if (bad.length > 0) {
      for (const h of bad) {
        console.error(`  · ${t.deployed} 未宣告漂移（部署树第 ${h.bFrom + 1}-${h.bTo} 行）：`);
        for (let k = h.bFrom; k < h.bTo; k++) console.error(`      + ${deployedLines[k] ?? ""}`);
        for (let k = h.aFrom; k < h.aTo; k++) console.error(`      - ${exportedLines[k] ?? ""}`);
      }
      if (t.contentDrift === "fail") {
        targetFailed = true;
        failures.push(`${t.deployed} 出现 ${bad.length} 处未宣告漂移`);
      } else {
        preserved.push(
          `DEPLOY_DRIFT_PRESERVE：${t.deployed} 有 ${bad.length} 处非 harness-only 内容差异` +
            "（线上补丁未回灌 staging，按用户 2026-10-20 裁定保留，不视为失败）",
        );
      }
    }

    if (!targetFailed) {
      console.log(
        t.harnessOnlyRegions === 0
          ? `DEPLOY_DRIFT_OK：${t.deployed} 与导出物 byte 等价`
          : `DEPLOY_DRIFT_OK：${t.deployed} 与导出物等价（仅 ${regions} 个已宣告 harness-only 区块例外）`,
      );
    }
  }
}

checkDeployedDrift();

if (preserved.length > 0) {
  console.log(`\n保留已登记差异 ${preserved.length} 处（用户 2026-10-20 裁定，不视为失败）：`);
  for (const p of preserved) console.log(`  - ${p}`);
}

if (failures.length > 0) {
  const tag = CHECK ? "EXPORT_CHECK_FAIL" : "EXPORT_FAIL";
  console.error(`\n${tag}：机械导出校验失败（${failures.length} 项）。`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(CHECK ? "\nEXPORT_CHECK：通过" : "\nEXPORT：完成（幂等：内容未变则不写盘）");
