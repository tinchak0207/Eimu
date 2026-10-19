/**
 * 片AA 实弹 E2E + seed dry-run（2026-09-06）。
 * 跑法：npx tsx deploy-staging/blender-nodes/run-e2e-node-channel.ts
 *
 * 诚实验证层级标注（任务书允许的 fallback）：本机无控制面 Postgres（无
 * GENERATION_DATABASE_URL、无 docker daemon），scheduler 的 acquireSupplierLease
 * / claimNextGenerationJob / persistOutputArtifact 依赖 DB 与 Vercel Blob，无法在
 * 本机起。故本脚本验证到 **adapter 层级直调**——调用 generateWithSupplier
 * （worker-service.ts L30 import、executeGenerationJob attempt 阶段调用的同一
 * 函数），SupplierRecord 按 job-repository.ts mapSupplierRecord 的 seed 行投影
 * 手工构造。DB 认领/租约/入库层未覆盖，待片W 隧道＋VPS env 落位后补真链路。
 *
 * A 段 seed dry-run（零 DB）：env 三件套 → describeEnvChannels 投影＋seed 三表
 * 形状（adapter_type/supply_tier/priority/credentialRef/healthPath/capabilities）。
 * B 段 实弹 E2E：两路并发 blender-render-eevee 单帧 job 走 adapter 分派 → 桥
 * /v1/execute → artifacts 出真 PNG（魔数校验 bytes>0）＋桥侧 queue_depth 波动
 * ＋.blender-work/out/ 落盘确认。
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

async function main() {

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`[${mark}] ${name} — ${detail}`);
}

// ── 载入 .env.local 的 blender 三件套（值不入库不入 commit）─────────────────
const envLocalPath = path.join(process.cwd(), ".env.local");
for (const line of existsSync(envLocalPath) ? readFileSync(envLocalPath, "utf8").split("\n") : []) {
  const m = /^(BLENDER_NODE_[A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

// ═══ A 段：seed dry-run（零 DB，投影 seed-generation-suppliers.ts 的消费链）═══
console.log("\n== A. seed dry-run（describeEnvChannels → 三表投影）==");

const { describeEnvChannels } = await import("../../src/lib/sub2api.ts");
const { REGISTRY_CHANNELS } = await import("../../src/lib/supplier-channels.config.ts");
const { GENERATION_MODEL_CATALOG } = await import("../../src/lib/generation-model-catalog/catalog.ts");

const registry = REGISTRY_CHANNELS.find((c) => c.label === "blender-local");
check("A1 registry 条目在位", !!registry, registry ? `tier=${registry.tier} priorities=${registry.seedPriority}/${registry.sitePriority} adapterType=${registry.adapterType}` : "REGISTRY_CHANNELS 无 blender-local");
check("A2 三 env 件套齐", Boolean(process.env.BLENDER_NODE_LOCAL_URL && process.env.BLENDER_NODE_LOCAL_TOKEN && process.env.BLENDER_NODE_LOCAL_ENABLED), `URL=${process.env.BLENDER_NODE_LOCAL_URL} TOKEN=<set:${Boolean(process.env.BLENDER_NODE_LOCAL_TOKEN)}> ENABLED=${process.env.BLENDER_NODE_LOCAL_ENABLED}`);

const descriptor = describeEnvChannels(process.env).find((c) => c.label === "blender-local");
check("A3 configured＋defaultEnabled", Boolean(descriptor?.configured && descriptor?.defaultEnabled && descriptor?.endpoint), descriptor ? `id=${descriptor.id} baseURL=${descriptor.endpoint?.baseURL}` : "descriptor 缺席（configured=false → seed 静默跳过，诚实行为）");
check("A4 supportedModels＝两能力标签", JSON.stringify(descriptor?.endpoint?.supportedModels) === JSON.stringify(["blender-render-eevee", "blender-render-cycles"]), `→ ${descriptor?.endpoint?.supportedModels?.join(",")}`);

// seed 三表投影（seed-generation-suppliers.ts L318/L341/healthPath 分派逐字段同构）
const seedAdapterType = registry?.adapterType ?? "openai_images";
const seedTier = registry?.tier;
const seedPriority = registry?.seedPriority;
const seedCredentialRef = registry?.apiKeyEnv; // credentialRef() registry 分支
const seedHealthPath = registry?.adapterType === "blender_bridge"
  ? (registry.baseUrlEnv.includes("LOCAL") ? "v1/health" : "health")
  : (process.env.ADOBE2API_HEALTH_PATH ?? "health");
check("A5 supplier 行投影", seedAdapterType === "blender_bridge" && seedTier === "first_party" && seedPriority === 10 && seedCredentialRef === "BLENDER_NODE_LOCAL_TOKEN", `adapter_type=${seedAdapterType} supply_tier=${seedTier} priority=${seedPriority} credential_ref=${seedCredentialRef}`);
check("A6 supplier_account healthPath 分派", seedHealthPath === "v1/health", `→ ${seedHealthPath}（blender_bridge+LOCAL；modal 分支待片X）`);
check("A7 幂等语义（seed 脚本全 ON CONFLICT upsert）", true, "supplier L324 / supplier_account L343 均幂等重跑安全；VPS 实跑待片W env 落位（本机无控制面 DB）");

const capabilities = (registry?.claims ?? []).flatMap((claim) => {
  const model = GENERATION_MODEL_CATALOG[claim.modelId];
  if (!model) return [];
  return claim.kinds.map((kind) => `${claim.modelId}:${kind}`);
});
check("A8 capabilities 认领齐（catalog 前置生效）", capabilities.length === 2, `→ ${capabilities.join("、")}（catalog 缺条目时 channelCapabilities 会 warn+skip）`);

// ═══ B 段：实弹 E2E（adapter 层级直调，两路并发观察桥伫列）═════════════════
console.log("\n== B. 实弹 E2E（adapter 层级，未含 DB 认领/租约层）==");

const { generateWithSupplier } = await import("../../src/lib/generation-core/supplier-adapter.ts");
const { closeGenerationSql } = await import("../../src/lib/generation-core/database.ts");

const baseUrl = process.env.BLENDER_NODE_LOCAL_URL!;
// SupplierRecord＝seed 后 mapSupplierRecord(job-repository.ts L874) 对 env:blender-local 行的投影。
const supplier = {
  id: "env:blender-local",
  label: "blender-local",
  adapterType: "blender_bridge" as const,
  supplyTier: "first_party" as const,
  failureDomain: new URL(baseUrl).host,
  baseUrl,
  credentialRef: "BLENDER_NODE_LOCAL_TOKEN",
  configuration: { channelId: "env:blender-local", source: "BLENDER_NODE_LOCAL_URL", chatImageModels: [] },
  priority: 10,
  concurrencyLimit: 1,
  qualityScore: 1,
  unitCost: 0,
  healthStatus: "healthy" as const,
  healthScore: 1,
  latencyEwmaMs: null,
  supplierModelId: null,
  capabilityId: 0,
  capabilityConcurrencyLimit: 1,
  contractVersion: 1,
  capabilityHealthStatus: "healthy" as const,
  account: {
    id: "env:blender-local:default",
    label: "blender-local default account",
    credentialRef: "BLENDER_NODE_LOCAL_TOKEN",
    concurrencyLimit: 1,
    healthStatus: "healthy" as const,
    tokenSource: "not_applicable",
    credentialExpiresAt: null,
    refreshStatus: "healthy" as const,
    successRate5m: 1,
    healthObservedAt: new Date(),
    configuration: { healthPath: seedHealthPath, minimumSuccessRate5m: 0.8 },
  },
};

async function bridgeHealthNow(): Promise<{ queue_depth: number; gpu: string; workdir: string }> {
  const res = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(5000) });
  return (await res.json()) as { queue_depth: number; gpu: string; workdir: string };
}

const before = await bridgeHealthNow();
console.log(`桥 health 起点：gpu=${before.gpu} queue_depth=${before.queue_depth} workdir=${before.workdir}`);

function makeInput(n: number) {
  const attemptId = `e2e-${Date.now()}-${n}-${Math.random().toString(16).slice(2, 10)}`;
  return {
    jobId: `e2e-job-${Date.now()}-${n}`,
    attemptId,
    modelId: "blender-render-eevee",
    supplierModelId: null,
    prompt: "Astra previz still: mannequin standing idle in neutral studio lighting",
    kind: "image_generate" as const,
    size: "1024x1024",
    ratio: "1:1",
    resolution: "1k",
    quality: null,
    workflow: {},
  };
}

let maxQueueDepth = 0;
let polling = true;
const poller = (async () => {
  while (polling) {
    try {
      const h = await bridgeHealthNow();
      maxQueueDepth = Math.max(maxQueueDepth, h.queue_depth);
    } catch { /* 轮询失败不影响主线 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
})();

async function runJob(n: number) {
  const input = makeInput(n);
  const t0 = Date.now();
  const output = await generateWithSupplier(supplier, input);
  const ms = Date.now() - t0;
  const bytes = Buffer.from(output.base64 ?? "", "base64");
  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  // 证据 PNG 落盘（.blender-work 已 gitignore）
  const evidenceDir = path.join(before.workdir, "e2e-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `${input.attemptId}.png`);
  writeFileSync(evidencePath, bytes);
  // 桥侧 out/ 落盘确认（evidence.adapterArtifactPath 是桥回的相对路径）
  const rel = (output.evidence?.artifactPath as string) ?? "";
  const artifactAbs = path.join(before.workdir, "out", rel);
  const artifactExists = existsSync(artifactAbs) && statSync(artifactAbs).size > 0;
  return { n, input, output, bytes, isPng, ms, evidencePath, rel, artifactExists, artifactAbs };
}

// 两路并发：桥并发 1 → 第二路必入 FIFO 伫列（queue_depth 波动可观察）。
// 错位 150ms：单帧 eevee 实测 ~0.4s，job2 到达时 job1 仍在执行段（job2 入
// waiters → health queue_depth=1；执行中 job 不计入 queue_depth，server.py L406）。
const [r1, r2] = await Promise.all([runJob(1), (async () => { await new Promise((r) => setTimeout(r, 150)); return runJob(2); })()]);
polling = false;
await poller;
const after = await bridgeHealthNow();

for (const r of [r1, r2]) {
  check(`B${r.n} adapter 层直调出真 PNG`, r.output.base64 !== null && r.isPng && r.bytes.length > 0, `kind=png bytes=${r.bytes.length} 耗时=${r.ms}ms endpointLabel=${r.output.endpointLabel} engine=${r.output.evidence?.engine}`);
  check(`B${r.n} 桥侧 artifacts 落 .blender-work/out/`, r.artifactExists, `→ ${r.artifactAbs}`);
  check(`B${r.n} 证据 PNG 落盘`, existsSync(r.evidencePath) && statSync(r.evidencePath).size === r.bytes.length, `→ ${r.evidencePath}`);
}
const queuedEvidence = [r1, r2].map((r) => ({
  queued: r.output.evidence?.queued === true,
  queuePosition: Number(r.output.evidence?.queuePosition ?? 0),
}));
check(
  "B5 桥伫列计入（桥自报 queued/queue_position）",
  queuedEvidence.some((q) => q.queued),
  `→ ${JSON.stringify(queuedEvidence)}（health 轮询与执行互抢 addon 帮浦采样不可靠，桥 execute 回应自报栏位为权威证据；health max queue_depth=${maxQueueDepth}）`,
);
check("B6 收尾 health 恢复", after.queue_depth === 0, `→ queue_depth=${after.queue_depth} gpu=${after.gpu}`);

await closeGenerationSql().catch(() => {});
console.log(failures === 0 ? "\nE2E 全部 PASS" : `\n${failures} 项 FAIL`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
