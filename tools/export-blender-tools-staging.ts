#!/usr/bin/env -S npx tsx
//
// deploy-staging/blender-gateway/blender_tools.ts 机械导出器（片 AJ，2026-09-06）。
//
// 为什么需要它：staging 稿是 VPS gateway 载入的工具真身（→ .opencode/lib/blender-tools-impl.ts），
// 此前靠手工与真源 src/lib/blender-tools.ts 同步，实际漂移过（T2 评测实锤：部署版缺
// makedirs，blender_render 首跑即死）。本脚本把「手工同步」换成机械导出：
// 读真源全文 → 拼接环境适配（注释头 + blender-asset-store import 换惰性桩）→
// 写 staging 目标档。白名单 diff 只有这两处，正文与真源逐行等价。
//
// 用法（真源改动后必跑，根治手工漂移）：
//   npx tsx tools/export-blender-tools-staging.ts
//   npx tsx tools/export-blender-tools-staging.ts --check   # 只校验不写（CI/验收用）
//
// 验收：导出后 staging 稿与真源 diff = 注释头 + 桩块两处；隔离 tsc
// （命令见同目录 PATCH-PLAN.md §1）须过。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const SOURCE = join(root, "src/lib/blender-tools.ts");
const TARGET = join(root, "deploy-staging/blender-gateway/blender_tools.ts");
const CHECK = process.argv.includes("--check");

const source = readFileSync(SOURCE, "utf8");

// ── 白名单 diff ①：真源 blender-asset-store import → 惰性桩 ─────────────────
// 理由：VPS .opencode/lib 无 blender-asset-store 依赖闭包（→ asset-pack-store →
// @/lib/blob-backend，bun 解析不到），且 opencode 工具 context 永不带 userId
// （片 AG2 契约：缺 userId = 不入库、不预查）→ 同名惰性桩中立化，真源函数体
// 零改动、桩永不触发，行为与「userId 缺省」分支逐字等价。
const IMPORT_LINE =
  'import { findTemplateByFingerprint, fingerprintScript, saveSceneAssets } from "./blender-asset-store"';
if (!source.includes(IMPORT_LINE)) {
  console.error(`EXPORT_FAIL：真源未找到预期 import 行（真源结构变了，先改本脚本白名单再导出）：\n  ${IMPORT_LINE}`);
  process.exit(1);
}

const STUB = `// ── 环境适配（staging 白名单唯一 diff：上行的 ./blender-asset-store import 由此桩块取代）──
// VPS .opencode/lib 无 blender-asset-store 依赖闭包（→ asset-pack-store → @/lib/blob-backend，
// bun 解析不到），且 opencode 工具 context 永不带 userId（片 AG2 契约：缺 userId = 不入库、
// 不预查）→ 以同名惰性桩中立化：真源函数体零改动、桩永不触发，行为与「userId 缺省」分支
// 逐字等价。桩形状同构 src/lib/blender-asset-store.ts 的返回类型（未命中/未入库语义）。
type FindTemplateResult =
  | { ok: true; template: { packId: string; itemTitle: string; fingerprint: string; sceneSummary?: string } }
  | { ok: false; code: "invalid_fingerprint" | "not_found"; hint: string }
async function findTemplateByFingerprint(_userId: number, _fingerprint: string): Promise<FindTemplateResult> {
  return { ok: false, code: "not_found", hint: "staging 稿未接资产库，指纹预查停用（真源行为=userId 缺省同义）。" }
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
  return { ok: false, code: "staging_stub", hint: "staging 稿未接资产库，产物入库停用（真源行为=userId 缺省同义）。" }
}`;

const body = source.replace(IMPORT_LINE, STUB);

// ── 白名单 diff ②：注释头（落位说明 + 禁手改宣言）────────────────────────────
const HEADER = `/**
 * blender_* 三工具 VPS staging 稿（片 AJ，2026-09-06 机械导出改制）。
 *
 * 本档由 tools/export-blender-tools-staging.ts 从行为真源 src/lib/blender-tools.ts
 * 机械导出：真源全文逐行保留（bpy 脚本模板/分块存活配方/makedirs/崩溃重试/ffmpeg
 * 合成/指纹接线/artifact_base_url 全在），除「环境适配」外与真源逐行等价。
 * 白名单 diff 仅两处：① 本注释头；② 真源 \`./blender-asset-store\` import → 桩块
 * （理由见桩块注释）。禁止手改本档——改真源后跑
 * \`npx tsx tools/export-blender-tools-staging.ts\` 重导出（根治 T2 部署漂移）。
 *
 * VPS 落位（完整命令见同目录 PATCH-PLAN.md）：
 *   本档整份                 → /opt/agent-harness/workspace/.opencode/lib/blender-tools-impl.ts
 *   blender_tools_adapter.ts → 同目录 blender-tools-adapter.ts
 *                              （wrapBlenderTool：BlenderToolDef 描述符 → opencode tool() 机械包装）
 *   三个 3 行 adapter        → .opencode/tools/blender_{exec,render,export_gltf}.ts
 *                              （export default wrapBlenderTool(blenderXxxTool)）
 *
 * 产物取回（片 AJ）：exec/render 成功 result 带 artifact_base_url，agent 用
 * \`\${artifact_base_url}?path=\${encodeURIComponent(artifact.path)}\` 经桥取回字节；
 * 沙箱不自持档案，禁止在沙箱 ls 等产物。错误铁律/简体文案规则同真源。
 */

`;

const output = HEADER + body;

if (CHECK) {
  const current = readFileSync(TARGET, "utf8");
  if (current === output) {
    console.log("EXPORT_CHECK_OK：staging 稿与机械导出产物 byte 等价");
    process.exit(0);
  }
  console.error("EXPORT_CHECK_FAIL：staging 稿与机械导出产物不一致（手工漂移或白名单变动），重跑不带 --check 的导出。");
  process.exit(1);
}

writeFileSync(TARGET, output);
console.log(`EXPORT_OK：${SOURCE} → ${TARGET}（${Buffer.byteLength(output)} bytes）`);
console.log("验收：npx tsx tools/export-blender-tools-staging.ts --check + 隔离 tsc（PATCH-PLAN §1）");
