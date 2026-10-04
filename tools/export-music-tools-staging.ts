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
//
// 部署樹守門：--check 同時比對 deploy-staging/opencode-runtime/lib/；除部署檔內
// `// <harness-only>` … `// </harness-only>` 界定的區塊（登記於下方 DEPLOY_TARGETS）外必須等價，
// 否則非零退出——防止有人把 staging 導出物整檔覆蓋進部署樹而靜默刪掉 harness-only 功能。

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
 * env：GEMINI_STUDIO_API_KEY（generativelanguage lyria-3.5 generateContent，帶人聲整歌，付費）；
 *      GEMINI_API_KEY（無 studio key 時退回 Vertex lyria-002 :predict，純器樂 30s，degraded）。
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
 *      GEMINI_STUDIO_API_KEY（lyria-3.5 generateContent 主 key，音頻落盤經 gateway 會話上傳存儲）、
 *      GEMINI_API_KEY（Vertex lyria-002 降級）、FLOWMUSIC_ADMIN_USER／FLOWMUSIC_ADMIN_PASSWORD
 *      （FlowMusic 真鑑權探針 /api/tokens/1/refresh-credits 用；缺失時探針降級為 unreachable 提示）。
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

// ── 部署樹漂移守門（2026-10-04 片 U2）────────────────────────────────────────
//
// 為什麼需要：staging/music-tools/* 只是機械導出物（本腳本產物），deploy-staging/
// opencode-runtime/lib/ 才是部署真源。有人照本檔文件頭把 staging 導出物 cp 進
// deploy-staging/... 時，會靜默刪掉部署樹的 harness-only 功能（music-tools-impl.ts 的
// source_audio 工作區路徑解析依賴 harness-only 模組 ./sandbox，真源無從導出）。
// 故在此加守門：導出物與部署樹對應檔必須等價，唯一允許的例外＝部署檔內以
// `// <harness-only>` … `// </harness-only>` 界定、且在此登記數量的區塊；例外區塊失蹤
// （＝整檔被覆蓋）同樣視為漂移。例外之外的任何改行/多行/少行 → 非零退出並印出。

const DEPLOY_LIB = join(root, "deploy-staging/opencode-runtime/lib");
const HARNESS_OPEN = "// <harness-only>";
const HARNESS_CLOSE = "// </harness-only>";

type DeployTarget = {
  /** staging 導出物（＝本腳本產物；--check 已保證其與導出結果 byte 等價）。 */
  exported: string;
  /** 部署樹對應檔。 */
  deployed: string;
  /** 允許的 harness-only 例外區塊數；0＝必須與導出物 byte 等價（verbatim 導出）。 */
  harnessOnlyRegions: number;
};

const DEPLOY_TARGETS: readonly DeployTarget[] = [
  { exported: FLOWMUSIC_TARGET, deployed: join(DEPLOY_LIB, "music_flowmusic.ts"), harnessOnlyRegions: 0 },
  { exported: LYRIA_TARGET, deployed: join(DEPLOY_LIB, "music_lyria.ts"), harnessOnlyRegions: 0 },
  { exported: YUE2_TARGET, deployed: join(DEPLOY_LIB, "music_yue2.ts"), harnessOnlyRegions: 0 },
  { exported: DIRECTOR_TARGET, deployed: join(DEPLOY_LIB, "music_prompt_director.ts"), harnessOnlyRegions: 0 },
  // music-tools-impl.ts：7 段 harness-only 例外（注釋頭、take-entropy import 改寫、
  // source_audio 路徑解析區塊、工具/參數描述、呼叫端解析區塊、audioBase64 傳參）。
  { exported: TOOLS_TARGET, deployed: join(DEPLOY_LIB, "music-tools-impl.ts"), harnessOnlyRegions: 7 },
];

/** 掃出部署檔的 harness-only 例外行（含 marker 行本身），並驗證 marker 成對。 */
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

/** 行級 LCS diff：回傳兩側不匹配的連續區塊（hunk），用於逐塊判漂移。 */
function diffHunks(a: string[], b: string[]): Array<{ aFrom: number; aTo: number; bFrom: number; bTo: number }> {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w); // dp[i][j] = a[i..] 與 b[j..] 的 LCS 長度
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
      failures.push(`${t.deployed} 不存在（部署樹缺檔；導出物 ${t.exported} 未落位）`);
      continue;
    }

    let targetFailed = false;
    const exportedLines = exportedText.split("\n");
    const deployedLines = deployedText.split("\n");
    const { exempt, regions, balanced } = scanHarnessOnly(deployedLines);

    if (!balanced) {
      failures.push(`${t.deployed} harness-only marker 不成對（<harness-only> 與 </harness-only> 數量/嵌套錯誤）`);
      targetFailed = true;
    }
    if (regions !== t.harnessOnlyRegions) {
      failures.push(
        `${t.deployed} harness-only 例外區塊數不符：宣告 ${t.harnessOnlyRegions}、實際 ${regions}` +
          (regions < t.harnessOnlyRegions
            ? "（例外區塊失蹤＝疑似被 staging 導出物整檔覆蓋，harness-only 功能已被刪）"
            : "（多出未登記的例外，請更新本腳本 DEPLOY_TARGETS）"),
      );
      targetFailed = true;
    }

    const bad = diffHunks(exportedLines, deployedLines).filter((h) => {
      if (h.bTo > h.bFrom) {
        // 部署樹多出/改動的非空行：必須整段落在已宣告的例外區塊內（空行無行為，容忍）。
        for (let k = h.bFrom; k < h.bTo; k++) {
          if (!exempt[k] && deployedLines[k].trim() !== "") return true;
        }
        return false;
      }
      // 純刪除（部署樹掉了導出物的內容）：全空行，或緊鄰已宣告例外時放行。
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
        console.error(`  · ${t.deployed} 未宣告漂移（部署樹第 ${h.bFrom + 1}-${h.bTo} 行）：`);
        for (let k = h.bFrom; k < h.bTo; k++) console.error(`      + ${deployedLines[k] ?? ""}`);
        for (let k = h.aFrom; k < h.aTo; k++) console.error(`      - ${exportedLines[k] ?? ""}`);
      }
      failures.push(`${t.deployed} 出現 ${bad.length} 處未宣告漂移`);
    }

    if (!targetFailed) {
      console.log(
        t.harnessOnlyRegions === 0
          ? `DEPLOY_DRIFT_OK：${t.deployed} 與導出物 byte 等價`
          : `DEPLOY_DRIFT_OK：${t.deployed} 與導出物等價（僅 ${regions} 個已宣告 harness-only 區塊例外）`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(
      "\nDEPLOY_DRIFT_FAIL：部署樹與機械導出物不一致——疑似有人直接把 staging/music-tools/* 覆蓋到 " +
        "deploy-staging/opencode-runtime/lib/（會刪掉 harness-only 功能，例如 music-tools-impl.ts 的 " +
        "source_audio 工作區路徑解析）。請只改真源後重導出，或把新例外用 `// <harness-only>` … " +
        "`// </harness-only>` 界定並登記到本腳本 DEPLOY_TARGETS。",
    );
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

checkDeployedDrift();
