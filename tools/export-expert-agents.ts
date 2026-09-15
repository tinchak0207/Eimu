#!/usr/bin/env -S npx tsx
//
// Expert Gateway 四產物機械導出器（R8 審計修復片 1，2026-09-10；
// contracts 第四產物 = 09-15 評測补课片 critic 裁定新增）。
//
// 為什麼需要它：R8 架構審計實錘（記憶 beast-harness-architecture-audit-r8-0910）——
// 能力斷路只落地 4/25（orchestrator 只關 blender×3+music_gen，21 個域工具仍開），
// 且 Expert 端零工具限制。本腳本把「手工編 opencode.json agent 工具表」換成機械導出：
// 真源 EXPERT_REGISTRY（src/lib/expert-registry.ts）→ 白名單欄位改寫 → 寫
// deploy-staging/expert-gateway/ 三產物。registry 改行後重跑即再生，根治手工漂移。
//
// 產物（opencode 1.18.14 agent 定義語義；tools:false = 該 agent 工具表物理移除，
// 未列 = 默認開；先例記憶 beast-gateway-tooltable-circuit-break-0908）：
//   opencode-agents.json  orchestrator（25 域工具全 false + question:true）
//                         + 7 個 Expert（全集 − 自己域工具，全部 false）
//   registry-digest.txt   HTML 註釋頭（R7 provenance 規範，注入端剝離）+
//                         buildExpertRegistryDigest() 逐字輸出
//   expert-ids.json       {"experts":[...registry 鍵序...]}（gateway 校驗 expert 欄用）
//   expert-delivery-contracts.json（09-15 評測补课片新增）
//                         {"<id>":{"requiredFields":[…],"qcSignatureRequired":bool},…}
//                         逐個從 EXPERT_REGISTRY 生成、零手抄——playbook 驗收
//                         對表與 critic 審核官的交付契約清單真源。
//
// 兩條 tools map 規則的差異與理由（2026-09-11 修補，片4 實彈暴露補集寫窄）：
//   orchestrator = 只斷「Expert 域工具」（registry toolIds 聯集，固定 25 個）。
//     刻意保留 image_generate / search_web / workflow_* 等「非 Expert 域工具」——
//     AGENTS.md 路由表對它們仍有效，orchestrator 需要它們直調（野獸 playbook 軍團）。
//   expert = 全集（--tools-file 清單 / fallback）減去「該 expert 自己的 toolIds」→ 全部 false。
//     舊規則「其他 6 行的 toolIds 聯集 → false」寫窄了：任何不屬於任何 Expert 的工具
//     （如 image_generate）不會被列進 false，等於 leakage —— 白名單只部分物理化，
//     editor 子代理仍能直調 image_generate 生成圖片（違反憲法第二條「域外工具不在你工具表」）。
//   builtin（bash/read/glob/grep/edit/write/question/task/webfetch/todowrite/websearch/
//     skill/apply_patch/invalid）不在工具檔清單內，天然不受影響，不列入 map。
//
// 用法：
//   npx tsx tools/export-expert-agents.ts                          # fallback 近似全集
//   npx tsx tools/export-expert-agents.ts --tools-file <path>      # VPS 工具清單（每行一個 id）
//   npx tsx tools/export-expert-agents.ts --check                  # 只校驗不寫（部署片驗漂移用）
//
// --tools-file 由部署片從 VPS `ls /opt/agent-harness/workspace/.opencode/tools/ | grep -v .bak`
// 生成；未傳參數時用 src/lib/harness-tool-registry.ts HARNESS_TOOL_ID_LIST + 4 個已知
// VPS 額外工具作為近似全集（僅用於交叉校驗 registry 引用與覆蓋統計，不進產物形狀），
// 並在 stdout 明確警告。導出機械可重跑：同輸入同輸出，無時間戳（digest 頭生成日期除外）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXPERT_REGISTRY } from "../src/lib/expert-registry";
import { buildExpertRegistryDigest } from "../src/lib/orchestrator-beast-frame";
import { HARNESS_TOOL_ID_LIST } from "../src/lib/harness-tool-registry";

const root = process.cwd();
const OUT_DIR = join(root, "deploy-staging", "expert-gateway");
const TARGETS = {
  agents: join(OUT_DIR, "opencode-agents.json"),
  digest: join(OUT_DIR, "registry-digest.txt"),
  ids: join(OUT_DIR, "expert-ids.json"),
  contracts: join(OUT_DIR, "expert-delivery-contracts.json"),
} as const;
const CHECK = process.argv.includes("--check");

// ── 工具全集來源（--tools-file > fallback 近似全集）──────────────────────────

/** 已知 VPS .opencode/tools/ 有、而本地 HARNESS_TOOL_ID_LIST 未登記的工具（2026-09-10）。 */
const KNOWN_VPS_EXTRA_TOOLS = [
  "search_web",
  "vision_analyze",
  "subagent_status",
  "director_manage_group",
] as const;

function parseToolsFileArg(): string | undefined {
  const i = process.argv.indexOf("--tools-file");
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) {
    console.error("EXPORT_FAIL：--tools-file 需要一個檔案路徑參數。");
    process.exit(1);
  }
  return value;
}

function dedupePreserveOrder(ids: readonly string[]): string[] {
  const seen: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed && !seen.includes(trimmed)) seen.push(trimmed);
  }
  return seen;
}

function loadUniverse(): { tools: string[]; source: "tools-file" | "fallback" } {
  const fileArg = parseToolsFileArg();
  if (fileArg) {
    if (!existsSync(fileArg)) {
      console.error(`EXPORT_FAIL：--tools-file 檔案不存在：${fileArg}`);
      process.exit(1);
    }
    const lines = readFileSync(fileArg, "utf8").split(/\r?\n/);
    return { tools: dedupePreserveOrder(lines), source: "tools-file" };
  }
  return {
    tools: dedupePreserveOrder([...HARNESS_TOOL_ID_LIST, ...KNOWN_VPS_EXTRA_TOOLS]),
    source: "fallback",
  };
}

// ── 產物組裝（真源常量 import，零手抄）───────────────────────────────────────

/** orchestrator 現行描述原文（VPS opencode.json agent.orchestrator，09-08 斷路先例）。 */
const ORCHESTRATOR_DESCRIPTION =
  "MOE Orchestrator（野獸模式主會話）：域工具已斷路，只能 subagent_dispatch 派發 Expert";

/** Expert 描述後綴（R8 修復片 1 裁定文案）。 */
const EXPERT_DESCRIPTION_SUFFIX = "（Expert：僅經 subagent_dispatch expert 欄路由）";

/** digest 頭（R7 provenance 規範：HTML 註釋，注入端 stripProvenanceHeader 剝離）。 */
const DIGEST_PROVENANCE_HEADER =
  "<!-- 由 src/lib/expert-registry.ts EXPERT_REGISTRY 現值生成" +
  "（buildExpertRegistryDigest 逐字輸出；由 tools/export-expert-agents.ts 機械生成）。" +
  "生成日期 2026-09-11（R4：摘要行擴充配方库 + 交付契约，registry 改行後須重生成上傳）。 -->";

/** 域工具全集 = 全部 Expert toolIds 去重聯集（registry 插入序）。 */
const DOMAIN_TOOLS: string[] = dedupePreserveOrder(
  Object.values(EXPERT_REGISTRY).flatMap((expert) => [...expert.toolIds]),
);

function buildAgentsJson(universeTools: readonly string[]): string {
  // tools map 只寫 false 項（opencode 語義：未列 = 默認開）；鍵序 = 來源清單插入序，確定性輸出。
  const toolsFalse = (ids: readonly string[]): Record<string, boolean> => {
    const map: Record<string, boolean> = {};
    for (const id of ids) map[id] = false;
    return map;
  };

  const agents: Record<string, unknown> = {};
  // orchestrator 在前：25 域工具全 false + question true（主會話保留提問內建）。
  // 注意：orchestrator 只斷 Expert 域工具，非 Expert 域工具（image_generate 等）保持默認開。
  agents["orchestrator"] = {
    mode: "all",
    description: ORCHESTRATOR_DESCRIPTION,
    tools: { ...toolsFalse(DOMAIN_TOOLS), question: true },
  };
  // 其後按 registry 插入序：每個 Expert false 掉「全集 − 自己域工具」
  // （含不屬於任何 Expert 的工具，如 image_generate）。
  for (const expert of Object.values(EXPERT_REGISTRY)) {
    const own = new Set(expert.toolIds);
    const foreign = universeTools.filter((id) => !own.has(id));
    agents[expert.id] = {
      mode: "all",
      description: `${expert.description}${EXPERT_DESCRIPTION_SUFFIX}`,
      tools: toolsFalse(foreign),
    };
  }
  return `${JSON.stringify(agents, null, 2)}\n`;
}

function buildDigestTxt(): string {
  // 無檔尾換行：剝頭（stripProvenanceHeader 只 trimStart）後與 buildExpertRegistryDigest()
  // 輸出逐字 byte 相等，注入幀零多餘空白。
  return `${DIGEST_PROVENANCE_HEADER}\n${buildExpertRegistryDigest()}`;
}

function buildExpertIdsJson(): string {
  return `${JSON.stringify({ experts: Object.keys(EXPERT_REGISTRY) }, null, 2)}\n`;
}

/**
 * 交付契約清單（09-15 評測补课片新增）：{"<id>":{"requiredFields":[…],
 * "qcSignatureRequired":bool},…}，逐個從 EXPERT_REGISTRY 生成、零手抄，
 * 鍵序 = registry 插入序（確定性輸出）。playbook 第二節驗收對表與
 * critic 審核官逐欄核驗的清單真源。
 */
function buildDeliveryContractsJson(): string {
  const contracts: Record<string, { requiredFields: string[]; qcSignatureRequired: boolean }> = {};
  for (const expert of Object.values(EXPERT_REGISTRY)) {
    contracts[expert.id] = {
      requiredFields: [...expert.deliverableContract.requiredFields],
      qcSignatureRequired: expert.deliverableContract.qcSignatureRequired,
    };
  }
  return `${JSON.stringify(contracts, null, 2)}\n`;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const PRODUCTS: Array<[string, (universeTools: readonly string[]) => string]> = [
  [TARGETS.agents, buildAgentsJson],
  [(TARGETS.digest), () => buildDigestTxt()],
  [(TARGETS.ids), () => buildExpertIdsJson()],
  [(TARGETS.contracts), () => buildDeliveryContractsJson()],
];

function main(): void {
  const universe = loadUniverse();

  if (universe.source === "fallback") {
    console.warn(
      "EXPORT_WARN：未傳 --tools-file，使用近似工具全集" +
        `（HARNESS_TOOL_ID_LIST ${HARNESS_TOOL_ID_LIST.length} 個 + 已知 VPS 額外 ${KNOWN_VPS_EXTRA_TOOLS.length} 個）。` +
        "近似全集，部署時應用 --tools-file 重導（部署片從 VPS ls .opencode/tools/ 生成清單）。",
    );
  }

  // 交叉校驗：registry 引用的域工具必須存在於工具全集（漂移偵測，僅警告不阻導出）。
  const universeSet = new Set(universe.tools);
  const missing = DOMAIN_TOOLS.filter((id) => !universeSet.has(id));
  if (missing.length > 0) {
    console.warn(
      `EXPORT_WARN：${universe.source === "fallback" ? "近似全集" : "VPS 工具清單"}中缺少 registry 引用的域工具（registry 與工具面漂移，先對帳再部署）：${missing.join(", ")}`,
    );
  }
  const unowned = universe.tools.filter((id) => !DOMAIN_TOOLS.includes(id)).length;

  if (CHECK) {
    const mismatches: string[] = [];
    for (const [target, build] of PRODUCTS) {
      if (!existsSync(target)) {
        mismatches.push(`${target}（產物缺失）`);
        continue;
      }
      if (readFileSync(target, "utf8") !== build(universe.tools)) mismatches.push(target);
    }
    if (mismatches.length > 0) {
      console.error(
        `EXPORT_CHECK_FAIL：staging 產物與機械導出產物不一致（手工漂移或真源變動）：\n  ${mismatches.join("\n  ")}\n  重跑不帶 --check 的導出再生。`,
      );
      process.exit(1);
    }
      console.log(
        `EXPORT_CHECK_OK：四產物與機械導出 byte 等價（域工具 ${DOMAIN_TOOLS.length} / 全集 ${universe.tools.length}，未歸屬 Expert 的全集工具 ${unowned} 個保持默認開）`,
      );
    process.exit(0);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const [target, build] of PRODUCTS) {
    const output = build(universe.tools);
    writeFileSync(target, output);
    console.log(`EXPORT_OK：${target}（${Buffer.byteLength(output)} bytes）`);
  }
  console.log(
    `導出依據：域工具 ${DOMAIN_TOOLS.length} 個（registry 聯集）/ 工具全集 ${universe.tools.length} 個（${universe.source}）/ registry ${Object.keys(EXPERT_REGISTRY).length} 行。`,
  );
}

main();
