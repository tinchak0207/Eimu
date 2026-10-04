#!/usr/bin/env -S npx tsx
//
// music_gen 工具 VPS staging 稿机械导出器（MOE Wave1 片B，2026-09-08）。
//
// 范式同构 tools/export-blender-tools-staging.ts（片AJ 改制的机械导出，根治手工漂移）：
// 读真源全文 → 拼接环境适配（注释头 + 白名单 import 改写）→ 写 staging 目标档。
// 正文与真源逐行等价，白名单 diff 只有注释头与 import 行两类。
//
// 为什么导出多档：src/lib/music-tools.ts import src/lib/music-lyria.ts（Lyria client）、
// src/lib/music-flowmusic.ts（FlowMusic2API client）、src/lib/music-yue2.ts（YuE2 Modal client）
// 与 src/lib/music-prompt-director.ts（确定性规则层），全部零依赖（仅 node 内建 + fetch），
// VPS .opencode/lib 同目录落位即闭包完整。
//
// staging 目标目录：deploy-staging/ 本片禁碰（另一 agent 在改）→ 落 staging/music-tools/，
// VPS 同步落位（后续接线片执行，完整命令届时补进 deploy 计划）：
//   staging/music-tools/music_lyria.ts → /opt/agent-harness/workspace/.opencode/lib/music_lyria.ts
//   staging/music-tools/music_flowmusic.ts → /opt/agent-harness/workspace/.opencode/lib/music_flowmusic.ts
//   staging/music-tools/music_yue2.ts → /opt/agent-harness/workspace/.opencode/lib/music_yue2.ts
//   staging/music-tools/music_prompt_director.ts → /opt/agent-harness/workspace/.opencode/lib/music_prompt_director.ts
//   staging/music-tools/music_tools.ts → /opt/agent-harness/workspace/.opencode/lib/music-tools-impl.ts
//
// 用法（真源改动后必跑）：
//   npx tsx tools/export-music-tools-staging.ts
//   npx tsx tools/export-music-tools-staging.ts --check   # 只校验不写（CI/验收用）
//
// 部署树守门：--check 同时比对 deploy-staging/opencode-runtime/lib/；除部署档内
// `// <harness-only>` … `// </harness-only>` 界定的区块（登记于下方 DEPLOY_TARGETS）外必须等价，
// 否则非零退出——防止有人把 staging 导出物整档覆盖进部署树而静默删掉 harness-only 功能。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const FLOWMUSIC_SOURCE = join(root, "src/lib/music-flowmusic.ts");
const LYRIA_SOURCE = join(root, "src/lib/music-lyria.ts");
const YUE2_SOURCE = join(root, "src/lib/music-yue2.ts");
const DIRECTOR_SOURCE = join(root, "src/lib/music-prompt-director.ts");
const TOOLS_SOURCE = join(root, "src/lib/music-tools.ts");
const TARGET_DIR = join(root, "staging/music-tools");
const FLOWMUSIC_TARGET = join(TARGET_DIR, "music_flowmusic.ts");
const LYRIA_TARGET = join(TARGET_DIR, "music_lyria.ts");
const YUE2_TARGET = join(TARGET_DIR, "music_yue2.ts");
const DIRECTOR_TARGET = join(TARGET_DIR, "music_prompt_director.ts");
const TOOLS_TARGET = join(TARGET_DIR, "music_tools.ts");
const CHECK = process.argv.includes("--check");

// ── 白名单 diff ①：tools 真源 import "./music-lyria" → "./music_lyria"（VPS 落位档名惯例）──
const TOOLS_IMPORT_LINE = 'from "./music-lyria"';
const TOOLS_IMPORT_REPLACEMENT = 'from "./music_lyria"';

// ── 白名单 diff ①b：tools 真源 import "./music-flowmusic" → "./music_flowmusic"（同惯例，2026-09-09）──
const FLOWMUSIC_IMPORT_LINE = 'from "./music-flowmusic"';
const FLOWMUSIC_IMPORT_REPLACEMENT = 'from "./music_flowmusic"';

// ── 白名单 diff ①c：tools 真源 import "./music-prompt-director" → "./music_prompt_director"（同惯例，2026-09-12）──
const DIRECTOR_IMPORT_LINE = 'from "./music-prompt-director"';
const DIRECTOR_IMPORT_REPLACEMENT = 'from "./music_prompt_director"';

// ── 白名单 diff ①d：tools 真源 import "./music-yue2" → "./music_yue2"（同惯例，2026-09-19）──
const YUE2_IMPORT_LINE = 'from "./music-yue2"';
const YUE2_IMPORT_REPLACEMENT = 'from "./music_yue2"';

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

const TOOLS_HEADER = `/**
 * music_gen harness 工具 VPS staging 稿（MOE Wave1 片B，2026-09-08 机械导出）。
 *
 * 本档由 tools/export-music-tools-staging.ts 从行为真源 src/lib/music-tools.ts
 * 机械导出：真源全文逐行保留（工具定义/ok-fail/resolveKey/ffprobe 时长/上传通路
 * 全在），除「环境适配」外与真源逐行等价。
 * 白名单 diff 仅五处：① 本注释头；②③④⑤ 真源 \`from "./music-lyria"\` → \`from "./music_lyria"\`、
 * \`from "./music-flowmusic"\` → \`from "./music_flowmusic"\`、
 * \`from "./music-prompt-director"\` → \`from "./music_prompt_director"\` 与
 * \`from "./music-yue2"\` → \`from "./music_yue2"\`（同目录落位档名惯例）。
 * 禁止手改本档——改真源后跑 \`npx tsx tools/export-music-tools-staging.ts\` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music-tools-impl.ts
 * env：GATEWAY_URL（默认 http://127.0.0.1:8081）、HARNESS_API_KEY（fallback）、
 *      GEMINI_STUDIO_API_KEY（lyria-3.5 generateContent 主 key，音频落盘经 gateway 会话上传存储）、
 *      GEMINI_API_KEY（Vertex lyria-002 降级）、FLOWMUSIC_ADMIN_USER／FLOWMUSIC_ADMIN_PASSWORD
 *      （FlowMusic 真鉴权探针 /api/tokens/1/refresh-credits 用；缺失时探针降级为 unreachable 提示）。
 */

`;

function exportFile(sourcePath: string, targetPath: string, header: string, transform: (src: string) => string): void {
  const source = readFileSync(sourcePath, "utf8");
  const output = header + transform(source);
  if (CHECK) {
    const current = readFileSync(targetPath, "utf8");
    if (current === output) {
      console.log(`EXPORT_CHECK_OK：${targetPath} 与机械导出产物 byte 等价`);
      return;
    }
    console.error(`EXPORT_CHECK_FAIL：${targetPath} 与机械导出产物不一致（手工漂移或白名单变动），重跑不带 --check 的导出。`);
    process.exit(1);
  }
  writeFileSync(targetPath, output);
  console.log(`EXPORT_OK：${sourcePath} → ${targetPath}（${Buffer.byteLength(output)} bytes）`);
}

// ── 白名单 diff ③：注释头──────────────────────────────────────────────────────

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

const DIRECTOR_HEADER = `/**
 * Music Prompt Director VPS staging 稿（确定性规则层，2026-09-12 机械导出）。
 *
 * 本档由 tools/export-music-tools-staging.ts 从行为真源 src/lib/music-prompt-director.ts
 * 机械导出：真源全文逐行保留（六层侦测/anti-slop/伪标签剥除/mood 修剪/通路硬规则/
 * 补层/长度上限全在），零依赖、无 import，除本注释头外与真源逐行等价。
 * 禁止手改本档——改真源后跑 \`npx tsx tools/export-music-tools-staging.ts\` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_prompt_director.ts
 * env：无（纯函数，零依赖零副作用）。
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

mkdirSync(TARGET_DIR, { recursive: true });

// music-flowmusic.ts：零 import，verbatim（仅加注释头）。
exportFile(FLOWMUSIC_SOURCE, FLOWMUSIC_TARGET, FLOWMUSIC_HEADER, (src) => src);

// music-lyria.ts：零 import，verbatim（仅加注释头）。
exportFile(LYRIA_SOURCE, LYRIA_TARGET, LYRIA_HEADER, (src) => src);

// music-yue2.ts：零 import，verbatim（仅加注释头）；tools 的第三通路 client。
exportFile(YUE2_SOURCE, YUE2_TARGET, YUE2_HEADER, (src) => src);

// music-prompt-director.ts：零 import，verbatim（仅加注释头）；tools 的规则层依赖。
exportFile(DIRECTOR_SOURCE, DIRECTOR_TARGET, DIRECTOR_HEADER, (src) => src);

// music-tools.ts：白名单正文 diff = 四条 import 行改写（逐字替换，其余原样）。
exportFile(TOOLS_SOURCE, TOOLS_TARGET, TOOLS_HEADER, (src) => {
  for (const [line, replacement] of [
    [TOOLS_IMPORT_LINE, TOOLS_IMPORT_REPLACEMENT],
    [FLOWMUSIC_IMPORT_LINE, FLOWMUSIC_IMPORT_REPLACEMENT],
    [DIRECTOR_IMPORT_LINE, DIRECTOR_IMPORT_REPLACEMENT],
    [YUE2_IMPORT_LINE, YUE2_IMPORT_REPLACEMENT],
  ] as const) {
    if (!src.includes(line)) {
      console.error(`EXPORT_FAIL：tools 真源未找到预期 import（真源结构变了，先改本脚本白名单再导出）：\n  ${line}`);
      process.exit(1);
    }
    src = src.replace(line, replacement);
  }
  return src;
});

if (!CHECK) {
  console.log("验收：npx tsx tools/export-music-tools-staging.ts --check");
}

// ── 部署树漂移守门（2026-10-04 片 U2）────────────────────────────────────────
//
// 为什么需要：staging/music-tools/* 只是机械导出物（本脚本产物），deploy-staging/
// opencode-runtime/lib/ 才是部署真源。有人照本档文件头把 staging 导出物 cp 进
// deploy-staging/... 时，会静默删掉部署树的 harness-only 功能（music-tools-impl.ts 的
// source_audio 工作区路径解析依赖 harness-only 模组 ./sandbox，真源无从导出）。
// 故在此加守门：导出物与部署树对应档必须等价，唯一允许的例外＝部署档内以
// `// <harness-only>` … `// </harness-only>` 界定、且在此登记数量的区块；例外区块失踪
// （＝整档被覆盖）同样视为漂移。例外之外的任何改行/多行/少行 → 非零退出并印出。

const DEPLOY_LIB = join(root, "deploy-staging/opencode-runtime/lib");
const HARNESS_OPEN = "// <harness-only>";
const HARNESS_CLOSE = "// </harness-only>";

type DeployTarget = {
  /** staging 导出物（＝本脚本产物；--check 已保证其与导出结果 byte 等价）。 */
  exported: string;
  /** 部署树对应档。 */
  deployed: string;
  /** 允许的 harness-only 例外区块数；0＝必须与导出物 byte 等价（verbatim 导出）。 */
  harnessOnlyRegions: number;
};

const DEPLOY_TARGETS: readonly DeployTarget[] = [
  { exported: FLOWMUSIC_TARGET, deployed: join(DEPLOY_LIB, "music_flowmusic.ts"), harnessOnlyRegions: 0 },
  { exported: LYRIA_TARGET, deployed: join(DEPLOY_LIB, "music_lyria.ts"), harnessOnlyRegions: 0 },
  { exported: YUE2_TARGET, deployed: join(DEPLOY_LIB, "music_yue2.ts"), harnessOnlyRegions: 0 },
  { exported: DIRECTOR_TARGET, deployed: join(DEPLOY_LIB, "music_prompt_director.ts"), harnessOnlyRegions: 0 },
  // music-tools-impl.ts：7 段 harness-only 例外（注释头、take-entropy import 改写、
  // source_audio 路径解析区块、工具/参数描述、呼叫端解析区块、audioBase64 传参）。
  { exported: TOOLS_TARGET, deployed: join(DEPLOY_LIB, "music-tools-impl.ts"), harnessOnlyRegions: 7 },
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
  const failures: string[] = [];

  for (const t of DEPLOY_TARGETS) {
    const exportedText = readFileSync(t.exported, "utf8");
    let deployedText: string;
    try {
      deployedText = readFileSync(t.deployed, "utf8");
    } catch {
      failures.push(`${t.deployed} 不存在（部署树缺档；导出物 ${t.exported} 未落位）`);
      continue;
    }

    let targetFailed = false;
    const exportedLines = exportedText.split("\n");
    const deployedLines = deployedText.split("\n");
    const { exempt, regions, balanced } = scanHarnessOnly(deployedLines);

    if (!balanced) {
      failures.push(`${t.deployed} harness-only marker 不成对（<harness-only> 与 </harness-only> 数量/嵌套错误）`);
      targetFailed = true;
    }
    if (regions !== t.harnessOnlyRegions) {
      failures.push(
        `${t.deployed} harness-only 例外区块数不符：宣告 ${t.harnessOnlyRegions}、实际 ${regions}` +
          (regions < t.harnessOnlyRegions
            ? "（例外区块失踪＝疑似被 staging 导出物整档覆盖，harness-only 功能已被删）"
            : "（多出未登记的例外，请更新本脚本 DEPLOY_TARGETS）"),
      );
      targetFailed = true;
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
      targetFailed = true;
      for (const h of bad) {
        console.error(`  · ${t.deployed} 未宣告漂移（部署树第 ${h.bFrom + 1}-${h.bTo} 行）：`);
        for (let k = h.bFrom; k < h.bTo; k++) console.error(`      + ${deployedLines[k] ?? ""}`);
        for (let k = h.aFrom; k < h.aTo; k++) console.error(`      - ${exportedLines[k] ?? ""}`);
      }
      failures.push(`${t.deployed} 出现 ${bad.length} 处未宣告漂移`);
    }

    if (!targetFailed) {
      console.log(
        t.harnessOnlyRegions === 0
          ? `DEPLOY_DRIFT_OK：${t.deployed} 与导出物 byte 等价`
          : `DEPLOY_DRIFT_OK：${t.deployed} 与导出物等价（仅 ${regions} 个已宣告 harness-only 区块例外）`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(
      "\nDEPLOY_DRIFT_FAIL：部署树与机械导出物不一致——疑似有人直接把 staging/music-tools/* 覆盖到 " +
        "deploy-staging/opencode-runtime/lib/（会删掉 harness-only 功能，例如 music-tools-impl.ts 的 " +
        "source_audio 工作区路径解析）。请只改真源后重导出，或把新例外用 `// <harness-only>` … " +
        "`// </harness-only>` 界定并登记到本脚本 DEPLOY_TARGETS。",
    );
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

checkDeployedDrift();
