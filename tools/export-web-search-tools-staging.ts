#!/usr/bin/env -S npx tsx
//
// web_search 工具 VPS staging 稿機械導出器（beast 軍團 R1，2026-09-10）。
//
// 範式同構 tools/export-music-tools-staging.ts（MOE Wave1 片B 的機械導出）：
// 讀真源全文 → 拼接環境適配（注釋頭 + 白名單改寫）→ 寫 staging 目標檔。
// 正文與真源逐行等價，白名單 diff 只有注釋頭與 import 行兩類。
//
// 為什麼導出三檔：src/lib/web-search-tools.ts（真源，零依賴）在 VPS 落位
// lib/web_search_impl.ts；opencode 形狀包裝器逐行同構 VPS lib/music-tools-adapter.ts
// （白名單 diff 僅名稱/導入源，範本內嵌於本腳本）；tools/web_search.ts 薄入口
// 同構 tools/music_gen.ts 模式。
//
// staging 落位（VPS 同步落位命令見檔尾）：
//   staging/web-search-tools/web_search_impl.ts → /opt/agent-harness/workspace/.opencode/lib/web_search_impl.ts（純真源 verbatim）
//   staging/web-search-tools/search_web.ts      → /opt/agent-harness/workspace/.opencode/tools/search_web.ts（薄入口，註冊名=檔名）
//
// 命名域鐵律（2026-09-10 VPS 八輪對照實錘）：opencode 1.18.14 保留 websearch/web_search
// 工具命名域，自訂工具檔名撞名即被物理移除（ws_probe HAVE / web_search NOT_HAVE，
// 同檔內容僅檔名不同）；薄入口內聯 wrap 構形（同 R2 vision_analyze.ts）為已驗證可載入形。
//
// 用法（真源改動後必跑）：
//   npx tsx tools/export-web-search-tools-staging.ts
//   npx tsx tools/export-web-search-tools-staging.ts --check   # 只校驗不寫（CI/驗收用）

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const SOURCE = join(root, "src/lib/web-search-tools.ts");
const TARGET_DIR = join(root, "staging/web-search-tools");
const IMPL_TARGET = join(TARGET_DIR, "web_search_impl.ts");
const ADAPTER_TARGET = join(TARGET_DIR, "web_search_tools_adapter.ts");
const THIN_TARGET = join(TARGET_DIR, "search_web.ts");
const CHECK = process.argv.includes("--check");

// ── 白名單 diff ①：注釋頭（落位說明 + 禁手改宣言）────────────────────────────

const IMPL_HEADER = `/**
 * web_search harness 工具 VPS staging 稿（beast 軍團 R1，2026-09-10 機械導出）。
 *
 * 本檔由 tools/export-web-search-tools-staging.ts 從行為真源 src/lib/web-search-tools.ts
 * 機械導出：真源全文逐行保留（工具定義/ok-fail/Tavily 通路/錯誤鐵律/超時全在），
 * 零依賴、無 import，除本注釋頭外與真源逐行等價。
 * 禁止手改本檔——改真源後跑 \`npx tsx tools/export-web-search-tools-staging.ts\` 重導出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/web_search_impl.ts
 * env：TAVILY_API_KEY（Tavily Search API 鑑權，寫 /opt/agent-harness/.env 與
 *      .env.opencode 雙檔）。
 */

`;

const ADAPTER_HEADER = `/**
 * web_search 工具 opencode 形狀機械包裝器（beast 軍團 R1，2026-09-10）。
 *
 * 形狀輪子 = lib/music-tools-adapter.ts 的 wrapMusicTool（逐行同構，白名單
 * diff 僅：名稱/導入源兩處；WebToolContext 契約含 sessionId 透傳欄，與
 * MusicToolContext 同口徑，會話資產落盤本工具暫未用到、欄位機械保留）。
 * 行為真源 = lib/web_search_impl.ts（staging/web-search-tools/web_search_impl.ts 落位稿，
 * 描述符形狀 WebToolDef，描述符 → schema 映射純機械翻譯零二次維護面）。
 */

`;

const THIN_HEADER = `/**
 * web_search 薄入口（beast 軍團 R1，2026-09-10；同構 tools/music_gen.ts 模式）。
 */

`;

// ── 白名單 diff ②：薄入口內聯 wrap（同構 R2 vision_analyze.ts 已驗證構形，2026-09-10）──
// 實錘：opencode 1.18.14 對「@opencode-ai/plugin import 放在 lib 二層檔」的工具
// （music_gen/blender 三件/web_search 兩輪試驗）不掛載工具表；唯一實證可載入的新工具
// 構形 = 薄入口內直接 import tool() 並內聯 wrap、lib 檔純零依賴 verbatim（vision_analyze
// HAVE 實錘）。故薄入口帶內聯 wrap，impl 回歸純真源。

const THIN_TEMPLATE = `import { tool } from "@opencode-ai/plugin/tool"
import { webSearchTool, type WebToolDef, type WebToolContext } from "../lib/web_search_impl"

/**
 * wrap：描述符 WebToolDef → opencode schema 純機械翻譯（逐行同構
 * lib/music-tools-adapter.ts 的 wrapMusicTool，白名單 diff 僅名稱；
 * WebToolContext 契約含 sessionId 透傳欄，與 MusicToolContext 同口徑）。
 * 禁止手改行為——改真源後重導出並重新落位 web_search_impl.ts 與本檔。
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
      console.log(`EXPORT_CHECK_OK：${targetPath} 與機械導出產物 byte 等價`);
      return;
    }
    console.error(`EXPORT_CHECK_FAIL：${targetPath} 與機械導出產物不一致（手工漂移或範本變動），重跑不帶 --check 的導出。`);
    process.exit(1);
  }
  writeFileSync(targetPath, output);
  console.log(`EXPORT_OK：→ ${targetPath}（${Buffer.byteLength(output)} bytes）`);
}

mkdirSync(TARGET_DIR, { recursive: true });

// web-search-tools.ts：零 import，verbatim（僅加注釋頭；純真源，wrap 內聯在薄入口）。
writeFile(IMPL_TARGET, IMPL_HEADER + readFileSync(SOURCE, "utf8") + "\n");

// 薄入口：範本常量 + 注釋頭。
writeFile(THIN_TARGET, THIN_HEADER + THIN_TEMPLATE);

if (!CHECK) {
  console.log("驗收：npx tsx tools/export-web-search-tools-staging.ts --check");
  console.log("VPS 落位（scp 後 sudo install 落位）：");
  console.log("  staging/web-search-tools/web_search_impl.ts → /opt/agent-harness/workspace/.opencode/lib/web_search_impl.ts（純真源 verbatim）");
  console.log("  staging/web-search-tools/search_web.ts → /opt/agent-harness/workspace/.opencode/tools/search_web.ts（薄入口，註冊名=檔名 search_web）");
}
