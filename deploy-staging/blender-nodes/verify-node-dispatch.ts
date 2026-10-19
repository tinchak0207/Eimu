/**
 * 派发判定纯函数本地验证（片Y，2026-09-06）。
 * 跑法：npx tsx deploy-staging/blender-nodes/verify-node-dispatch.ts
 * 验什么：rankNodeCandidates（= scheduler.ts L68-78 ORDER BY 的同构投影）
 * 对三节点梯队产出研究片 V 预期的路由次序；registry 稿逐字段对照真源形状。
 */
import { rankNodeCandidates, acquireNode, tierRank, BLENDER_NODE_REGISTRY_DRAFT, type NodeCandidate } from "./blender-node-channel.ts";

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`[${mark}] ${name} — ${detail}`);
}

// ── case 1：全闲 → local（first_party）必胜，modal 次之（tier 第一排序键）
const allIdle: NodeCandidate[] = [
  { id: "blender-local",  tier: "first_party",  priority: 10, healthStatus: "healthy", cooldownUntil: null, healthScore: 1, qualityScore: 1, capabilityHealthScore: 1, activeLeases: 0, concurrencyLimit: 1, latencyEwmaMs: null, unitCost: 0, lastSelectedAt: null },
  { id: "blender-modal",  tier: "managed_pool", priority: 20, healthStatus: "healthy", cooldownUntil: null, healthScore: 1, qualityScore: 1, capabilityHealthScore: 1, activeLeases: 0, concurrencyLimit: 2, latencyEwmaMs: null, unitCost: 0.5, lastSelectedAt: null },
  { id: "blender-cnb",    tier: "relay",        priority: 30, healthStatus: "healthy", cooldownUntil: null, healthScore: 1, qualityScore: 1, capabilityHealthScore: 1, activeLeases: 0, concurrencyLimit: 1, latencyEwmaMs: null, unitCost: 2, lastSelectedAt: null },
];
const r1 = acquireNode(allIdle);
check("case1 全闲梯队次序", r1?.id === "blender-local" && rankNodeCandidates(allIdle).map((c) => c.id).join(",") === "blender-local,blender-modal,blender-cnb", `→ ${rankNodeCandidates(allIdle).map((c) => c.id).join(" → ")}`);

// ── case 2：本机 lease 占满（并发 1 被占）→ modal 接手
// （scheduler L61-66 WHERE lease < concurrency_limit 硬排除，不进候选集）
const localBusy: NodeCandidate[] = allIdle.map((c) =>
  c.id === "blender-local" ? { ...c, activeLeases: c.concurrencyLimit } : c,
);
const r2 = acquireNode(localBusy)?.id;
check("case2 本机占线 modal 接手", r2 === "blender-modal", `→ 胜出 ${r2}（WHERE 层硬排除本机，等价于「本机最快优先→Modal 额度池」梯队语义）`);

// ── case 3：本机不可达，健康轮询写 disabled＋短冷却 → modal 胜出
// （scheduler L37-45：disabled 与 cooldown_until 未过期者硬排除）
const localDown: NodeCandidate[] = allIdle.map((c) =>
  c.id === "blender-local" ? { ...c, healthStatus: "disabled", cooldownUntil: Date.now() + 60_000 } : c,
);
const r3 = acquireNode(localDown)?.id;
check("case3 本机 disabled＋冷却 modal 胜出", r3 === "blender-modal", `→ 胜出 ${r3}（refreshBlenderNodeHealth 对不可达节点写 disabled/cooldown 的语义闭环）`);

// ── case 3b（诚实语义锤）：本机仅 degraded → 仍胜 modal healthy。
// degraded 是排序内软惩罚（L71 CASE），压不过 tier——跨档让位必须走
// disabled/cooldown（case 3），这是既有栏位行为，非本稿发明。
const localDegraded: NodeCandidate[] = allIdle.map((c) =>
  c.id === "blender-local" ? { ...c, healthStatus: "degraded", healthScore: 0.4 } : c,
);
const r3b = acquireNode(localDegraded)?.id;
check("case3b degraded 压不过 tier", r3b === "blender-local", `→ 胜出 ${r3b}（健康轮询须将 gpu:cpu 标 degraded 仅供排序，真正让位靠占线/冷却——NODES-PLAN §3.3 表据此校正）`);

// ── case 4：同 tier 平手 → priority 决序（yyds 13 排 hub 12 之后的既有实锤语义）
const sameTier: NodeCandidate[] = [
  { id: "late",  tier: "managed_pool", priority: 13, healthStatus: "healthy", healthScore: 1, qualityScore: 1, capabilityHealthScore: 1, activeLeases: 0, concurrencyLimit: 1, latencyEwmaMs: null, unitCost: 1, lastSelectedAt: null },
  { id: "early", tier: "managed_pool", priority: 12, healthStatus: "healthy", healthScore: 1, qualityScore: 1, capabilityHealthScore: 1, activeLeases: 0, concurrencyLimit: 1, latencyEwmaMs: null, unitCost: 1, lastSelectedAt: null },
];
check("case4 同 tier priority 决序", rankNodeCandidates(sameTier)[0].id === "early", "→ priority 12 胜 13（记忆 supplier-tier-sorting 实锤语义）");

// ── case 5：tier 压倒 priority（供应商种错 tier，priority 再小也翻不了）
check("case5 tier 压倒 priority", tierRank("relay") > tierRank("first_party"), "→ relay(2) > first_party(0)：yyds 误种 relay 整队被绕过的实锤（scheduler L68-70）");

// ── case 6：registry 稿逐字段对照 RegistryChannel 真源形状
const requiredKeys = ["label", "baseUrlEnv", "apiKeyEnv", "enabledEnv", "tier", "seedPriority", "sitePriority", "chatImageModels", "adapterType", "claims"] as const;
for (const node of BLENDER_NODE_REGISTRY_DRAFT) {
  const missing = requiredKeys.filter((k) => !(k in node));
  check(`case6 ${node.label} 字段齐全`, missing.length === 0, missing.length ? `缺 ${missing.join(",")}` : `10/10 字段与 supplier-channels.config.ts L17-28 RegistryChannel 同构（adapterType 为扩展 enum 值）`);
  const claimOk = node.claims.every((c) => "modelId" in c && "supplierModelId" in c && "kinds" in c && c.kinds.length > 0);
  check(`case6 ${node.label} claims 形状`, claimOk, "→ RegistryChannelClaim 三字段齐（L11-15），kinds 沿用 image_generate");
}

// ── case 7：两节点 claims 完全一致（capability 候选集＝两节点，路由全靠 tier/health/负载）
const [local, modal] = BLENDER_NODE_REGISTRY_DRAFT;
const sameClaims = JSON.stringify(local.claims) === JSON.stringify(modal.claims);
check("case7 两节点 claims 一致", sameClaims, "→ eevee/cycles 两 modelId 均被两节点认领；无 per-model 反序（NODES-PLAN §3.1 裁定，1-2 节点下 lease＋health 已等效片V 意图）");

console.log(failures === 0 ? "\n全部 PASS" : `\n${failures} 项 FAIL`);
process.exit(failures === 0 ? 0 : 1);
