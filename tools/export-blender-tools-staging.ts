#!/usr/bin/env -S npx tsx
//
// deploy-staging/blender-gateway/blender_tools.ts 機械導出器（片 AJ，2026-09-06）。
//
// 為什麼需要它：staging 稿是 VPS gateway 載入的工具真身（→ .opencode/lib/blender-tools-impl.ts），
// 此前靠手工與真源 src/lib/blender-tools.ts 同步，實際漂移過（T2 評測實錘：部署版缺
// makedirs，blender_render 首跑即死）。本腳本把「手工同步」換成機械導出：
// 讀真源全文 → 拼接環境適配（注釋頭 + blender-asset-store import 換惰性樁）→
// 寫 staging 目標檔。白名單 diff 只有這兩處，正文與真源逐行等價。
//
// 用法（真源改動後必跑，根治手工漂移）：
//   npx tsx tools/export-blender-tools-staging.ts
//   npx tsx tools/export-blender-tools-staging.ts --check   # 只校驗不寫（CI/驗收用）
//
// 驗收：導出後 staging 稿與真源 diff = 注釋頭 + 樁塊兩處；隔離 tsc
// （命令見同目錄 PATCH-PLAN.md §1）須過。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const SOURCE = join(root, "src/lib/blender-tools.ts");
const TARGET = join(root, "deploy-staging/blender-gateway/blender_tools.ts");
const CHECK = process.argv.includes("--check");

const source = readFileSync(SOURCE, "utf8");

// ── 白名單 diff ①：真源 blender-asset-store import → 惰性樁 ─────────────────
// 理由：VPS .opencode/lib 無 blender-asset-store 依賴閉包（→ asset-pack-store →
// @/lib/blob-backend，bun 解析不到），且 opencode 工具 context 永不帶 userId
// （片 AG2 契約：缺 userId = 不入庫、不預查）→ 同名惰性樁中立化，真源函數體
// 零改動、樁永不觸發，行為與「userId 缺省」分支逐字等價。
const IMPORT_LINE =
  'import { findTemplateByFingerprint, fingerprintScript, saveSceneAssets } from "./blender-asset-store"';
if (!source.includes(IMPORT_LINE)) {
  console.error(`EXPORT_FAIL：真源未找到預期 import 行（真源結構變了，先改本腳本白名單再導出）：\n  ${IMPORT_LINE}`);
  process.exit(1);
}

const STUB = `// ── 環境適配（staging 白名單唯一 diff：上行的 ./blender-asset-store import 由此樁塊取代）──
// VPS .opencode/lib 無 blender-asset-store 依賴閉包（→ asset-pack-store → @/lib/blob-backend，
// bun 解析不到），且 opencode 工具 context 永不帶 userId（片 AG2 契約：缺 userId = 不入庫、
// 不預查）→ 以同名惰性樁中立化：真源函數體零改動、樁永不觸發，行為與「userId 缺省」分支
// 逐字等價。樁形狀同構 src/lib/blender-asset-store.ts 的返回類型（未命中/未入庫語義）。
type FindTemplateResult =
  | { ok: true; template: { packId: string; itemTitle: string; fingerprint: string; sceneSummary?: string } }
  | { ok: false; code: "invalid_fingerprint" | "not_found"; hint: string }
async function findTemplateByFingerprint(_userId: number, _fingerprint: string): Promise<FindTemplateResult> {
  return { ok: false, code: "not_found", hint: "staging 稿未接資產庫，指紋預查停用（真源行為=userId 缺省同義）。" }
}
function fingerprintScript(_script: string): string {
  return ""
}
type SceneAssetSaveResult =
  | { ok: true; items: Array<{ id: string }>; deduped: number }
  | { ok: false; code: string; hint: string }
interface SceneAssetSaveOptions {
  script?: string
  scene_summary?: string
}
async function saveSceneAssets(
  _userId: number,
  _artifacts: readonly BlenderArtifact[],
  _opts: SceneAssetSaveOptions = {},
): Promise<SceneAssetSaveResult> {
  return { ok: false, code: "staging_stub", hint: "staging 稿未接資產庫，產物入庫停用（真源行為=userId 缺省同義）。" }
}`;

const body = source.replace(IMPORT_LINE, STUB);

// ── 白名單 diff ②：注釋頭（落位說明 + 禁手改宣言）────────────────────────────
const HEADER = `/**
 * blender_* 三工具 VPS staging 稿（片 AJ，2026-09-06 機械導出改制）。
 *
 * 本檔由 tools/export-blender-tools-staging.ts 從行為真源 src/lib/blender-tools.ts
 * 機械導出：真源全文逐行保留（bpy 腳本模板/分塊存活配方/makedirs/崩潰重試/ffmpeg
 * 合成/指紋接線/artifact_base_url 全在），除「環境適配」外與真源逐行等價。
 * 白名單 diff 僅兩處：① 本注釋頭；② 真源 \`./blender-asset-store\` import → 樁塊
 * （理由見樁塊注釋）。禁止手改本檔——改真源後跑
 * \`npx tsx tools/export-blender-tools-staging.ts\` 重導出（根治 T2 部署漂移）。
 *
 * VPS 落位（完整命令見同目錄 PATCH-PLAN.md）：
 *   本檔整份                 → /opt/agent-harness/workspace/.opencode/lib/blender-tools-impl.ts
 *   blender_tools_adapter.ts → 同目錄 blender-tools-adapter.ts
 *                              （wrapBlenderTool：BlenderToolDef 描述符 → opencode tool() 機械包裝）
 *   三個 3 行 adapter        → .opencode/tools/blender_{exec,render,export_gltf}.ts
 *                              （export default wrapBlenderTool(blenderXxxTool)）
 *
 * 產物取回（片 AJ）：exec/render 成功 result 帶 artifact_base_url，agent 用
 * \`\${artifact_base_url}?path=\${encodeURIComponent(artifact.path)}\` 經橋取回字節；
 * 沙箱不自持檔案，禁止在沙箱 ls 等產物。錯誤鐵律/簡體文案規則同真源。
 */

`;

const output = HEADER + body;

if (CHECK) {
  const current = readFileSync(TARGET, "utf8");
  if (current === output) {
    console.log("EXPORT_CHECK_OK：staging 稿與機械導出產物 byte 等價");
    process.exit(0);
  }
  console.error("EXPORT_CHECK_FAIL：staging 稿與機械導出產物不一致（手工漂移或白名單變動），重跑不帶 --check 的導出。");
  process.exit(1);
}

writeFileSync(TARGET, output);
console.log(`EXPORT_OK：${SOURCE} → ${TARGET}（${Buffer.byteLength(output)} bytes）`);
console.log("驗收：npx tsx tools/export-blender-tools-staging.ts --check + 隔離 tsc（PATCH-PLAN §1）");
