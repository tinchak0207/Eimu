/**
 * 派發判定純函數本地驗證（片Y，2026-09-06）。
 * 跑法：npx tsx deploy-staging/blender-nodes/verify-node-dispatch.ts
 * 驗什麼：rankNodeCandidates（= scheduler.ts L68-78 ORDER BY 的同構投影）
 * 對三節點梯隊產出研究片 V 預期的路由次序；registry 稿逐字段對照真源形狀。
 */
import { rankNodeCandidates, acquireNode, tierRank, BLENDER_NODE_REGISTRY_DRAFT, type NodeCandidate } from "./blender-node-channel.ts";

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`[${mark}] ${name} — ${detail}`);
}

// ── case 1：全閒 → local（first_party）必勝，modal 次之（tier 第一排序鍵）
const allIdle: NodeCandidate[] = [
  { id: "blender-local",  tier: "first_party",  priority: 10, healthStatus: "healthy", cooldownUntil: null, healthScore: 1, qualityScore: 1, capabilityHealthScore: 1, activeLeases: 0, concurrencyLimit: 1, latencyEwmaMs: null, unitCost: 0, lastSelectedAt: null },
  { id: "blender-modal",  tier: "managed_pool", priority: 20, healthStatus: "healthy", cooldownUntil: null, healthScore: 1, qualityScore: 1, capabilityHealthScore: 1, activeLeases: 0, concurrencyLimit: 2, latencyEwmaMs: null, unitCost: 0.5, lastSelectedAt: null },
  { id: "blender-cnb",    tier: "relay",        priority: 30, healthStatus: "healthy", cooldownUntil: null, healthScore: 1, qualityScore: 1, capabilityHealthScore: 1, activeLeases: 0, concurrencyLimit: 1, latencyEwmaMs: null, unitCost: 2, lastSelectedAt: null },
];
const r1 = acquireNode(allIdle);
check("case1 全閒梯隊次序", r1?.id === "blender-local" && rankNodeCandidates(allIdle).map((c) => c.id).join(",") === "blender-local,blender-modal,blender-cnb", `→ ${rankNodeCandidates(allIdle).map((c) => c.id).join(" → ")}`);

// ── case 2：本機 lease 佔滿（併發 1 被佔）→ modal 接手
// （scheduler L61-66 WHERE lease < concurrency_limit 硬排除，不進候選集）
const localBusy: NodeCandidate[] = allIdle.map((c) =>
  c.id === "blender-local" ? { ...c, activeLeases: c.concurrencyLimit } : c,
);
const r2 = acquireNode(localBusy)?.id;
check("case2 本機佔線 modal 接手", r2 === "blender-modal", `→ 勝出 ${r2}（WHERE 層硬排除本機，等價於「本機最快優先→Modal 額度池」梯隊語義）`);

// ── case 3：本機不可達，健康輪詢寫 disabled＋短冷卻 → modal 勝出
// （scheduler L37-45：disabled 與 cooldown_until 未過期者硬排除）
const localDown: NodeCandidate[] = allIdle.map((c) =>
  c.id === "blender-local" ? { ...c, healthStatus: "disabled", cooldownUntil: Date.now() + 60_000 } : c,
);
const r3 = acquireNode(localDown)?.id;
check("case3 本機 disabled＋冷卻 modal 勝出", r3 === "blender-modal", `→ 勝出 ${r3}（refreshBlenderNodeHealth 對不可達節點寫 disabled/cooldown 的語義閉環）`);

// ── case 3b（誠實語義錘）：本機僅 degraded → 仍勝 modal healthy。
// degraded 是排序內軟懲罰（L71 CASE），壓不過 tier——跨檔讓位必須走
// disabled/cooldown（case 3），這是既有欄位行為，非本稿發明。
const localDegraded: NodeCandidate[] = allIdle.map((c) =>
  c.id === "blender-local" ? { ...c, healthStatus: "degraded", healthScore: 0.4 } : c,
);
const r3b = acquireNode(localDegraded)?.id;
check("case3b degraded 壓不過 tier", r3b === "blender-local", `→ 勝出 ${r3b}（健康輪詢須將 gpu:cpu 標 degraded 僅供排序，真正讓位靠佔線/冷卻——NODES-PLAN §3.3 表據此校正）`);

// ── case 4：同 tier 平手 → priority 決序（yyds 13 排 hub 12 之後的既有實錘語義）
const sameTier: NodeCandidate[] = [
  { id: "late",  tier: "managed_pool", priority: 13, healthStatus: "healthy", healthScore: 1, qualityScore: 1, capabilityHealthScore: 1, activeLeases: 0, concurrencyLimit: 1, latencyEwmaMs: null, unitCost: 1, lastSelectedAt: null },
  { id: "early", tier: "managed_pool", priority: 12, healthStatus: "healthy", healthScore: 1, qualityScore: 1, capabilityHealthScore: 1, activeLeases: 0, concurrencyLimit: 1, latencyEwmaMs: null, unitCost: 1, lastSelectedAt: null },
];
check("case4 同 tier priority 決序", rankNodeCandidates(sameTier)[0].id === "early", "→ priority 12 勝 13（記憶 supplier-tier-sorting 實錘語義）");

// ── case 5：tier 壓倒 priority（供應商種錯 tier，priority 再小也翻不了）
check("case5 tier 壓倒 priority", tierRank("relay") > tierRank("first_party"), "→ relay(2) > first_party(0)：yyds 誤種 relay 整隊被繞過的實錘（scheduler L68-70）");

// ── case 6：registry 稿逐字段對照 RegistryChannel 真源形狀
const requiredKeys = ["label", "baseUrlEnv", "apiKeyEnv", "enabledEnv", "tier", "seedPriority", "sitePriority", "chatImageModels", "adapterType", "claims"] as const;
for (const node of BLENDER_NODE_REGISTRY_DRAFT) {
  const missing = requiredKeys.filter((k) => !(k in node));
  check(`case6 ${node.label} 字段齊全`, missing.length === 0, missing.length ? `缺 ${missing.join(",")}` : `10/10 字段與 supplier-channels.config.ts L17-28 RegistryChannel 同構（adapterType 為擴展 enum 值）`);
  const claimOk = node.claims.every((c) => "modelId" in c && "supplierModelId" in c && "kinds" in c && c.kinds.length > 0);
  check(`case6 ${node.label} claims 形狀`, claimOk, "→ RegistryChannelClaim 三字段齊（L11-15），kinds 沿用 image_generate");
}

// ── case 7：兩節點 claims 完全一致（capability 候選集＝兩節點，路由全靠 tier/health/負載）
const [local, modal] = BLENDER_NODE_REGISTRY_DRAFT;
const sameClaims = JSON.stringify(local.claims) === JSON.stringify(modal.claims);
check("case7 兩節點 claims 一致", sameClaims, "→ eevee/cycles 兩 modelId 均被兩節點認領；無 per-model 反序（NODES-PLAN §3.1 裁定，1-2 節點下 lease＋health 已等效片V 意圖）");

console.log(failures === 0 ? "\n全部 PASS" : `\n${failures} 項 FAIL`);
process.exit(failures === 0 ? 0 : 1);
