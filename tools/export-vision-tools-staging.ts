#!/usr/bin/env -S npx tsx
//
// vision_analyze 工具 VPS staging 稿机械导出器（beast-army R2，2026-09-10）。
//
// 范式同构 tools/export-music-tools-staging.ts（片AJ 改制的机械导出，根治手工漂移）：
// 读真源全文 → 拼接环境适配（注释头）→ 写 staging 目标档。
// 正文与真源逐行等价，白名单 diff 只有注释头一类（vision-tools.ts 零本地 import，
// 仅 node:fs/promises 内建模组，无需 import 改写）。
//
// staging 目标目录：落 staging/vision-tools/，VPS 同步落位：
//   staging/vision-tools/vision_tools.ts → /opt/eimu-harness/workspace/.opencode/lib/vision_impl.ts
// 薄入口 /opt/eimu-harness/workspace/.opencode/tools/vision_analyze.ts 为 VPS 侧
// 一次性接线稿（同 music_gen.ts 先例），不经本导出器。
//
// 用法（真源改动后必跑）：
//   npx tsx tools/export-vision-tools-staging.ts
//   npx tsx tools/export-vision-tools-staging.ts --check   # 只校验不写（CI/验收用）

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const TOOLS_SOURCE = join(root, "src/lib/vision-tools.ts");
const TARGET_DIR = join(root, "staging/vision-tools");
const TOOLS_TARGET = join(TARGET_DIR, "vision_tools.ts");
const CHECK = process.argv.includes("--check");

// ── 白名单 diff ①：注释头（落位说明 + 禁手改宣言）────────────────────────────

const TOOLS_HEADER = `/**
 * vision_analyze harness 工具 VPS staging 稿（beast-army R2→R2c，2026-09-10 机械导出）。
 *
 * 本档由 tools/export-vision-tools-staging.ts 从行为真源 src/lib/vision-tools.ts
 * 机械导出：真源全文逐行保留（工具定义/ok-fail/读图白名单/new-api 中控通路/
 * 错误铁律/60s 超时全在），零本地依赖（仅 node:fs/promises 内建模组），
 * 除本注释头外与真源逐行等价。
 * 禁止手改本档——改真源后跑 \`npx tsx tools/export-vision-tools-staging.ts\` 重导出。
 *
 * 落位：/opt/eimu-harness/workspace/.opencode/lib/vision_impl.ts
 * env：NEWAPI_API_KEY（Bearer 鉴权，VPS /opt/eimu-control-plane/.env.control-plane
 * 已有同名对，harness 侧同步注入）；NEWAPI_VISION_MODEL 可选覆盖（默认
 * gemini-3-flash）。通路唯一 = new-api 中控 {NEWAPI_BASE_URL}/chat/completions
 * （项目负责人铁律 vision-must-route-newapi-not-direct，R2c 起直连双通路已删）。
 * 薄入口：/opt/eimu-harness/workspace/.opencode/tools/vision_analyze.ts
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

// vision-tools.ts：零本地 import，verbatim（仅加注释头）。
mkdirSync(TARGET_DIR, { recursive: true });
exportFile(TOOLS_SOURCE, TOOLS_TARGET, TOOLS_HEADER, (src) => src);

if (!CHECK) {
  console.log("验收：npx tsx tools/export-vision-tools-staging.ts --check");
}
