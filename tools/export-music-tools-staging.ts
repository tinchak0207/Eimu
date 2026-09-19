#!/usr/bin/env -S npx tsx
//
// music_gen 工具 VPS staging 稿機械導出器（MOE Wave1 片B，2026-09-08）。
//
// 範式同構 tools/export-blender-tools-staging.ts（片AJ 改制的機械導出，根治手工漂移）：
// 讀真源全文 → 拼接環境適配（注釋頭 + 白名單 import 改寫）→ 寫 staging 目標檔。
// 正文與真源逐行等價，白名單 diff 只有注釋頭與 import 行兩類。
//
// 為什麼導出多檔：src/lib/music-tools.ts import src/lib/music-lyria.ts（Lyria client）、
// src/lib/music-flowmusic.ts（FlowMusic2API client）、src/lib/music-yue2.ts（YuE2 Modal client）
// 與 src/lib/music-prompt-director.ts（確定性規則層），全部零依賴（僅 node 內建 + fetch），
// VPS .opencode/lib 同目錄落位即閉包完整。
//
// staging 目標目錄：deploy-staging/ 本片禁碰（另一 agent 在改）→ 落 staging/music-tools/，
// VPS 同步落位（後續接線片執行，完整命令屆時補進 deploy 計劃）：
//   staging/music-tools/music_lyria.ts → /opt/agent-harness/workspace/.opencode/lib/music_lyria.ts
//   staging/music-tools/music_flowmusic.ts → /opt/agent-harness/workspace/.opencode/lib/music_flowmusic.ts
//   staging/music-tools/music_yue2.ts → /opt/agent-harness/workspace/.opencode/lib/music_yue2.ts
//   staging/music-tools/music_prompt_director.ts → /opt/agent-harness/workspace/.opencode/lib/music_prompt_director.ts
//   staging/music-tools/music_tools.ts → /opt/agent-harness/workspace/.opencode/lib/music-tools-impl.ts
//
// 用法（真源改動後必跑）：
//   npx tsx tools/export-music-tools-staging.ts
//   npx tsx tools/export-music-tools-staging.ts --check   # 只校驗不寫（CI/驗收用）

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

// ── 白名單 diff ①：tools 真源 import "./music-lyria" → "./music_lyria"（VPS 落位檔名慣例）──
const TOOLS_IMPORT_LINE = 'from "./music-lyria"';
const TOOLS_IMPORT_REPLACEMENT = 'from "./music_lyria"';

// ── 白名單 diff ①b：tools 真源 import "./music-flowmusic" → "./music_flowmusic"（同慣例，2026-09-09）──
const FLOWMUSIC_IMPORT_LINE = 'from "./music-flowmusic"';
const FLOWMUSIC_IMPORT_REPLACEMENT = 'from "./music_flowmusic"';

// ── 白名單 diff ①c：tools 真源 import "./music-prompt-director" → "./music_prompt_director"（同慣例，2026-09-12）──
const DIRECTOR_IMPORT_LINE = 'from "./music-prompt-director"';
const DIRECTOR_IMPORT_REPLACEMENT = 'from "./music_prompt_director"';

// ── 白名單 diff ①d：tools 真源 import "./music-yue2" → "./music_yue2"（同慣例，2026-09-19）──
const YUE2_IMPORT_LINE = 'from "./music-yue2"';
const YUE2_IMPORT_REPLACEMENT = 'from "./music_yue2"';

// ── 白名單 diff ②：注釋頭（落位說明 + 禁手改宣言）────────────────────────────

const LYRIA_HEADER = `/**
 * Lyria client VPS staging 稿（MOE Wave1 片B，2026-09-08 機械導出）。
 *
 * 本檔由 tools/export-music-tools-staging.ts 從行為真源 src/lib/music-lyria.ts
 * 機械導出：真源全文逐行保留（端點/鑑權/prompt 組裝/錯誤鐵律/超時全在），
 * 零依賴、無 import，除本注釋頭外與真源逐行等價。
 * 禁止手改本檔——改真源後跑 \`npx tsx tools/export-music-tools-staging.ts\` 重導出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_lyria.ts
 * env：GEMINI_API_KEY（x-goog-api-key 鑑權，付費額度）。
 */

`;

const TOOLS_HEADER = `/**
 * music_gen harness 工具 VPS staging 稿（MOE Wave1 片B，2026-09-08 機械導出）。
 *
 * 本檔由 tools/export-music-tools-staging.ts 從行為真源 src/lib/music-tools.ts
 * 機械導出：真源全文逐行保留（工具定義/ok-fail/resolveKey/ffprobe 時長/上傳通路
 * 全在），除「環境適配」外與真源逐行等價。
 * 白名單 diff 僅五處：① 本注釋頭；②③④⑤ 真源 \`from "./music-lyria"\` → \`from "./music_lyria"\`、
 * \`from "./music-flowmusic"\` → \`from "./music_flowmusic"\`、
 * \`from "./music-prompt-director"\` → \`from "./music_prompt_director"\` 與
 * \`from "./music-yue2"\` → \`from "./music_yue2"\`（同目錄落位檔名慣例）。
 * 禁止手改本檔——改真源後跑 \`npx tsx tools/export-music-tools-staging.ts\` 重導出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music-tools-impl.ts
 * env：GATEWAY_URL（默認 http://127.0.0.1:8081）、HARNESS_API_KEY（fallback）、
 *      GEMINI_API_KEY（Lyria 鑑權，音頻落盤經 gateway 會話上傳存儲）。
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

// ── 白名單 diff ③：注釋頭──────────────────────────────────────────────────────

const FLOWMUSIC_HEADER = `/**
 * FlowMusic2API client VPS staging 稿（死線3 music_gen 通路換血，2026-09-09 機械導出）。
 *
 * 本檔由 tools/export-music-tools-staging.ts 從行為真源 src/lib/music-flowmusic.ts
 * 機械導出：真源全文逐行保留（端點/鑑權/clips 解析/下載/錯誤鐵律/超時全在），
 * 零依賴、無 import，除本注釋頭外與真源逐行等價。
 * 禁止手改本檔——改真源後跑 \`npx tsx tools/export-music-tools-staging.ts\` 重導出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_flowmusic.ts
 * env：FLOWMUSIC2API_URL（服務地址，缺省禁用本通路）、FLOWMUSIC2API_KEY（Bearer）。
 */

`;

const DIRECTOR_HEADER = `/**
 * Music Prompt Director VPS staging 稿（確定性規則層，2026-09-12 機械導出）。
 *
 * 本檔由 tools/export-music-tools-staging.ts 從行為真源 src/lib/music-prompt-director.ts
 * 機械導出：真源全文逐行保留（六層偵測/anti-slop/偽標籤剝除/mood 修剪/通路硬規則/
 * 補層/長度上限全在），零依賴、無 import，除本注釋頭外與真源逐行等價。
 * 禁止手改本檔——改真源後跑 \`npx tsx tools/export-music-tools-staging.ts\` 重導出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_prompt_director.ts
 * env：無（純函數，零依賴零副作用）。
 */

`;

const YUE2_HEADER = `/**
 * YuE2 client VPS staging 稿（music_gen 第三通路，2026-09-19 機械導出）。
 *
 * 本檔由 tools/export-music-tools-staging.ts 從行為真源 src/lib/music-yue2.ts
 * 機械導出：真源全文逐行保留（端點/鑑權/HMAC 簽名/契約欄位/錯誤鐵律/600s 超時全在），
 * 零依賴、無 import，除本注釋頭外與真源逐行等價。
 * 禁止手改本檔——改真源後跑 \`npx tsx tools/export-music-tools-staging.ts\` 重導出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_yue2.ts
 * env：YUE2_MODAL_ENDPOINT（服務地址，缺省禁用本通路）、YUE2_HMAC_SECRET（HMAC 簽名密鑰）。
 */

`;

mkdirSync(TARGET_DIR, { recursive: true });

// music-flowmusic.ts：零 import，verbatim（僅加注釋頭）。
exportFile(FLOWMUSIC_SOURCE, FLOWMUSIC_TARGET, FLOWMUSIC_HEADER, (src) => src);

// music-lyria.ts：零 import，verbatim（僅加注釋頭）。
exportFile(LYRIA_SOURCE, LYRIA_TARGET, LYRIA_HEADER, (src) => src);

// music-yue2.ts：零 import，verbatim（僅加注釋頭）；tools 的第三通路 client。
exportFile(YUE2_SOURCE, YUE2_TARGET, YUE2_HEADER, (src) => src);

// music-prompt-director.ts：零 import，verbatim（僅加注釋頭）；tools 的規則層依賴。
exportFile(DIRECTOR_SOURCE, DIRECTOR_TARGET, DIRECTOR_HEADER, (src) => src);

// music-tools.ts：白名單正文 diff = 四條 import 行改寫（逐字替換，其餘原樣）。
exportFile(TOOLS_SOURCE, TOOLS_TARGET, TOOLS_HEADER, (src) => {
  for (const [line, replacement] of [
    [TOOLS_IMPORT_LINE, TOOLS_IMPORT_REPLACEMENT],
    [FLOWMUSIC_IMPORT_LINE, FLOWMUSIC_IMPORT_REPLACEMENT],
    [DIRECTOR_IMPORT_LINE, DIRECTOR_IMPORT_REPLACEMENT],
    [YUE2_IMPORT_LINE, YUE2_IMPORT_REPLACEMENT],
  ] as const) {
    if (!src.includes(line)) {
      console.error(`EXPORT_FAIL：tools 真源未找到預期 import（真源結構變了，先改本腳本白名單再導出）：\n  ${line}`);
      process.exit(1);
    }
    src = src.replace(line, replacement);
  }
  return src;
});

if (!CHECK) {
  console.log("驗收：npx tsx tools/export-music-tools-staging.ts --check");
}
