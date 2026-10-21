#!/usr/bin/env -S npx tsx
//
// web_search 工具 VPS staging 稿机械导出器（beast 军团 R1，2026-09-10）。
//
// 范式同构 tools/export-music-tools-staging.ts（MOE Wave1 片B 的机械导出）：
// 读真源全文 → 拼接环境适配（注释头 + 白名单改写）→ 写 staging 目标档。
// 正文与真源逐行等价，白名单 diff 只有注释头与 import 行两类。
//
// 为什么导出三档：src/lib/web-search-tools.ts（真源，零依赖）在 VPS 落位
// lib/web_search_impl.ts；opencode 形状包装器逐行同构 VPS lib/music-tools-adapter.ts
// （白名单 diff 仅名称/导入源，范本内嵌于本脚本）；tools/web_search.ts 薄入口
// 同构 tools/music_gen.ts 模式。
//
// staging 落位（VPS 同步落位命令见档尾）：
//   staging/web-search-tools/web_search_impl.ts → /opt/agent-harness/workspace/.opencode/lib/web_search_impl.ts（纯真源 verbatim）
//   staging/web-search-tools/search_web.ts      → /opt/agent-harness/workspace/.opencode/tools/search_web.ts（薄入口，注册名=档名）
//
// 命名域铁律（2026-09-10 VPS 八轮对照实锤）：opencode 1.18.14 保留 websearch/web_search
// 工具命名域，自订工具档名撞名即被物理移除（ws_probe HAVE / web_search NOT_HAVE，
// 同档内容仅档名不同）；薄入口内联 wrap 构形（同 R2 vision_analyze.ts）为已验证可载入形。
//
// 用法（真源改动后必跑）：
//   npx tsx tools/export-web-search-tools-staging.ts
//   npx tsx tools/export-web-search-tools-staging.ts --check   # 只校验不写（CI/验收用）

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const SOURCE = join(root, "src/lib/web-search-tools.ts");
const TARGET_DIR = join(root, "staging/web-search-tools");
const IMPL_TARGET = join(TARGET_DIR, "web_search_impl.ts");
const ADAPTER_TARGET = join(TARGET_DIR, "web_search_tools_adapter.ts");
const THIN_TARGET = join(TARGET_DIR, "search_web.ts");
const CHECK = process.argv.includes("--check");

// ── 白名单 diff ①：注释头（落位说明 + 禁手改宣言）────────────────────────────

const IMPL_HEADER = `/**
 * web_search harness 工具 VPS staging 稿（beast 军团 R1，2026-09-10 机械导出）。
 *
 * 本档由 tools/export-web-search-tools-staging.ts 从行为真源 src/lib/web-search-tools.ts
 * 机械导出：真源全文逐行保留（工具定义/ok-fail/Tavily 通路/错误铁律/超时全在），
 * 零依赖、无 import，除本注释头外与真源逐行等价。
 * 禁止手改本档——改真源后跑 \`npx tsx tools/export-web-search-tools-staging.ts\` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/web_search_impl.ts
 * env：TAVILY_API_KEY（Tavily Search API 鉴权，写 /opt/agent-harness/.env 与
 *      .env.opencode 双档）。
 */

`;

const ADAPTER_HEADER = `/**
 * web_search 工具 opencode 形状机械包装器（beast 军团 R1，2026-09-10）。
 *
 * 形状轮子 = lib/music-tools-adapter.ts 的 wrapMusicTool（逐行同构，白名单
 * diff 仅：名称/导入源两处；WebToolContext 契约含 sessionId 透传栏，与
 * MusicToolContext 同口径，会话资产落盘本工具暂未用到、栏位机械保留）。
 * 行为真源 = lib/web_search_impl.ts（staging/web-search-tools/web_search_impl.ts 落位稿，
 * 描述符形状 WebToolDef，描述符 → schema 映射纯机械翻译零二次维护面）。
 */

`;

const THIN_HEADER = `/**
 * web_search 薄入口（beast 军团 R1，2026-09-10；同构 tools/music_gen.ts 模式）。
 */

`;

// ── 白名单 diff ②：薄入口内联 wrap（同构 R2 vision_analyze.ts 已验证构形，2026-09-10）──
// 实锤：opencode 1.18.14 对「@opencode-ai/plugin import 放在 lib 二层档」的工具
// （music_gen/blender 三件/web_search 两轮试验）不挂载工具表；唯一实证可载入的新工具
// 构形 = 薄入口内直接 import tool() 并内联 wrap、lib 档纯零依赖 verbatim（vision_analyze
// HAVE 实锤）。故薄入口带内联 wrap，impl 回归纯真源。

const THIN_TEMPLATE = `import { tool } from "@opencode-ai/plugin/tool"
import { webSearchTool, type WebToolDef, type WebToolContext } from "../lib/web_search_impl"

/**
 * wrap：描述符 WebToolDef → opencode schema 纯机械翻译（逐行同构
 * lib/music-tools-adapter.ts 的 wrapMusicTool，白名单 diff 仅名称；
 * WebToolContext 契约含 sessionId 透传栏，与 MusicToolContext 同口径）。
 * 禁止手改行为——改真源后重导出并重新落位 web_search_impl.ts 与本档。
 */
function wrapWebTool(def: WebToolDef) {
  return tool({
    description: def.description,
    args: Object.fromEntries(
      Object.entries(def.args).map(([name, spec]) => {
        let s: ReturnType<typeof tool.schema.string>
        if (spec.type === "string") {
          s = ("enum" in spec && spec.enum ? tool.schema.enum([...spec.enum]) : tool.schema.string()) as never
        } else if (spec.type === "number") {
          s = tool.schema.number() as never
        } else {
          s = tool.schema.boolean() as never
        }
        if (!spec.required) s = s.optional() as never
        return [name, s.describe(spec.description)]
      }),
    ),
    async execute(args: Record<string, unknown>, context: WebToolContext) {
      return def.execute(args, { ...context, sessionId: context.sessionID })
    },
  })
}

export default wrapWebTool(webSearchTool)
`;

function writeFile(targetPath: string, output: string): void {
  if (CHECK) {
    const current = readFileSync(targetPath, "utf8");
    if (current === output) {
      console.log(`EXPORT_CHECK_OK：${targetPath} 与机械导出产物 byte 等价`);
      return;
    }
    console.error(`EXPORT_CHECK_FAIL：${targetPath} 与机械导出产物不一致（手工漂移或范本变动），重跑不带 --check 的导出。`);
    process.exit(1);
  }
  writeFileSync(targetPath, output);
  console.log(`EXPORT_OK：→ ${targetPath}（${Buffer.byteLength(output)} bytes）`);
}

mkdirSync(TARGET_DIR, { recursive: true });

// web-search-tools.ts：零 import，verbatim（仅加注释头；纯真源，wrap 内联在薄入口）。
writeFile(IMPL_TARGET, IMPL_HEADER + readFileSync(SOURCE, "utf8") + "\n");

// 薄入口：范本常量 + 注释头。
writeFile(THIN_TARGET, THIN_HEADER + THIN_TEMPLATE);

if (!CHECK) {
  console.log("验收：npx tsx tools/export-web-search-tools-staging.ts --check");
  console.log("VPS 落位（scp 后 sudo install 落位）：");
  console.log("  staging/web-search-tools/web_search_impl.ts → /opt/agent-harness/workspace/.opencode/lib/web_search_impl.ts（纯真源 verbatim）");
  console.log("  staging/web-search-tools/search_web.ts → /opt/agent-harness/workspace/.opencode/tools/search_web.ts（薄入口，注册名=档名 search_web）");
}
