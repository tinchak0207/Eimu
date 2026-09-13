#!/usr/bin/env -S npx tsx
//
// vision_analyze 工具 VPS staging 稿機械導出器（beast-army R2，2026-09-10）。
//
// 範式同構 tools/export-music-tools-staging.ts（片AJ 改制的機械導出，根治手工漂移）：
// 讀真源全文 → 拼接環境適配（注釋頭）→ 寫 staging 目標檔。
// 正文與真源逐行等價，白名單 diff 只有注釋頭一類（vision-tools.ts 零本地 import，
// 僅 node:fs/promises 內建模組，無需 import 改寫）。
//
// staging 目標目錄：落 staging/vision-tools/，VPS 同步落位：
//   staging/vision-tools/vision_tools.ts → /opt/agent-harness/workspace/.opencode/lib/vision_impl.ts
// 薄入口 /opt/agent-harness/workspace/.opencode/tools/vision_analyze.ts 為 VPS 側
// 一次性接線稿（同 music_gen.ts 先例），不經本導出器。
//
// 用法（真源改動後必跑）：
//   npx tsx tools/export-vision-tools-staging.ts
//   npx tsx tools/export-vision-tools-staging.ts --check   # 只校驗不寫（CI/驗收用）

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const TOOLS_SOURCE = join(root, "src/lib/vision-tools.ts");
const TARGET_DIR = join(root, "staging/vision-tools");
const TOOLS_TARGET = join(TARGET_DIR, "vision_tools.ts");
const CHECK = process.argv.includes("--check");

// ── 白名單 diff ①：注釋頭（落位說明 + 禁手改宣言）────────────────────────────

const TOOLS_HEADER = `/**
 * vision_analyze harness 工具 VPS staging 稿（beast-army R2→R2c，2026-09-10 機械導出）。
 *
 * 本檔由 tools/export-vision-tools-staging.ts 從行為真源 src/lib/vision-tools.ts
 * 機械導出：真源全文逐行保留（工具定義/ok-fail/讀圖白名單/new-api 中控通路/
 * 錯誤鐵律/60s 超時全在），零本地依賴（僅 node:fs/promises 內建模組），
 * 除本注釋頭外與真源逐行等價。
 * 禁止手改本檔——改真源後跑 \`npx tsx tools/export-vision-tools-staging.ts\` 重導出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/vision_impl.ts
 * env：NEWAPI_API_KEY（Bearer 鑑權，VPS /opt/image-control-plane/.env.control-plane
 * 已有同名對，harness 側同步注入）；NEWAPI_VISION_MODEL 可選覆蓋（默認
 * gemini-3-flash）。通路唯一 = new-api 中控 {NEWAPI_BASE_URL}/chat/completions
 * （暴君鐵律 vision-must-route-newapi-not-direct，R2c 起直連雙通路已刪）。
 * 薄入口：/opt/agent-harness/workspace/.opencode/tools/vision_analyze.ts
 */

`;

function exportFile(sourcePath: string, targetPath: string, header: string, transform: (src: string) => string): void {
  const source = readFileSync(sourcePath, "utf8");
  const output = header + transform(source);
  if (CHECK) {
    const current = readFileSync(targetPath, "utf8");
    if (current === output) {
      console.log(`EXPORT_CHECK_OK：${targetPath} 與機械導出產物 byte 等價`);
      return;
    }
    console.error(`EXPORT_CHECK_FAIL：${targetPath} 與機械導出產物不一致（手工漂移或白名單變動），重跑不帶 --check 的導出。`);
    process.exit(1);
  }
  writeFileSync(targetPath, output);
  console.log(`EXPORT_OK：${sourcePath} → ${targetPath}（${Buffer.byteLength(output)} bytes）`);
}

// vision-tools.ts：零本地 import，verbatim（僅加注釋頭）。
mkdirSync(TARGET_DIR, { recursive: true });
exportFile(TOOLS_SOURCE, TOOLS_TARGET, TOOLS_HEADER, (src) => src);

if (!CHECK) {
  console.log("驗收：npx tsx tools/export-vision-tools-staging.ts --check");
}
