import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * R4（W5）绕过预检的守门测试 —— **这是变更探针，不是行为 oracle**。
 *
 * 本档用 source-scan 断言「所有建立 generation job 的入口，要嘛经过 `enforceQuotaGate`，
 * 要嘛走明文允许的清单（有实际收费路径）」。它能量到的只有「原始码里有没有出现某个
 * 符号/呼叫」，量不到「那个呼叫真的被执行、且真的回 402」。
 *
 * ⇒ 依 repo 验证铁律（源码字串断言只算变更探针），**真正「不花钱」的证明是提交一笔
 * 余额不足的请求得到 402 `insufficient_balance`**，那条另见帐本 E2E（本轮未跑，属未验证）。
 * 本档的价值只有一个：**新的 job 建立入口一旦没接闸门又不在白名单，CI 立刻红灯**。
 *
 * 现况盘点（2026-10-04）：真正接 `enforceQuotaGate` 的只有 4 个对外生成路由；
 * 其余 6 个入口（`batches`／`upscale`／`generation-jobs`／`storyboard-voiceover`／
 * `sku/run-service`／`canary-service`，即下方 `RESERVE_PATH_ALLOWLIST` 六条）走 legacy
 * reserve / sync-charge（有实际扣费），不是「免钱通道」，
 * 但确实**不经过 precheck**——这条差异记在回报，不在本档假装不存在。
 */

const root = process.cwd();

/** 生成 job 建立的两个函式名：一条是提交漏斗，一条是底层建单。 */
const CREATE_CALL = /(submitGenerationCommand|createGenerationJob)\s*\(/;

/** 定义/漏斗档案：不是入口，跳过（它们本身呼叫不算绕过）。 */
const DEFINITION_FILES = new Set([
  "src/lib/generation-core/command-service.ts",
  "src/lib/generation-core/job-repository.ts",
  // <1000 行重构：createGenerationJob 实体拆到 job-repository/write.ts，仍是定义不是入口。
  "src/lib/generation-core/job-repository/write.ts",
]);

/** 真的经过 enforceQuotaGate 的入口（清单由现场扫描得出；少一个就要修闸门，不是修清单）。 */
const GATED_FILES = [
  "src/app/api/v1/images/generations/route.ts",
  "src/app/api/v1/images/edits/route.ts",
  "src/app/api/v1/videos/generations/route.ts",
  "src/app/api/v1/tts/generations/route.ts",
];

/**
 * 未接 precheck、但有明文收费路径的入口。白名单必须同时通过 `CHARGE_INDICATOR`，
 * 否则白名单会腐化成「什么都不做也能过」的后门。
 */
const RESERVE_PATH_ALLOWLIST: Record<string, string> = {
  "src/app/api/v1/batches/route.ts": "batch plan.billingAmount 逐项走 legacy reserve",
  "src/app/api/v1/upscale/route.ts": "reserveSyncCharge 先收费，submit 用 billingAmount=0 防双扣",
  "src/app/api/generation-jobs/route.ts": "authenticateImageUser(requiredQuota) + billingAmount=requiredCoins*QUOTA_PER_COIN",
  "src/app/api/canvas/storyboard-voiceover/route.ts": "billingAmount=ttsQuotaForChars 走 legacy reserve",
  "src/lib/sku/run-service.ts": "逐镜 plan.billingAmount 走 legacy reserve",
  "src/lib/generation-core/canary-service.ts": "canary 内部烟雾（billingAmount=0，非客户流量）",
};

/** 一条入口至少要能指出它的收费依据，白名单才算数。 */
const CHARGE_INDICATOR = /billingAmount|reserveSyncCharge|authenticateImageUser|billing_operation|reserve/;
const GATE_INDICATOR = /enforceQuotaGate\s*\(/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function rel(full: string): string {
  return relative(root, full).split(sep).join("/");
}

const sources = new Map<string, string>();
for (const full of walk(join(root, "src"))) {
  sources.set(rel(full), stripComments(readFileSync(full, "utf8")));
}

const entrypoints = [...sources.entries()]
  .filter(([file, source]) => !DEFINITION_FILES.has(file) && CREATE_CALL.test(source))
  .map(([file]) => file)
  .sort();

test("job-creation inventory is non-empty and every entrypoint is gated or explicitly allowlisted", () => {
  assert.ok(entrypoints.length > 0, "scan found no job-creation entrypoints (scan is broken)");
  const unexplained = entrypoints.filter(
    (file) => !GATED_FILES.includes(file) && RESERVE_PATH_ALLOWLIST[file] === undefined,
  );
  assert.deepEqual(
    unexplained,
    [],
    `new job-creation entrypoint without enforceQuotaGate and not allowlisted:\n${unexplained.join("\n")}`,
  );
});

test("every GATED_FILES entry still exists and still calls the precheck", () => {
  for (const file of GATED_FILES) {
    const source = sources.get(file);
    assert.ok(source, `gated entrypoint missing from tree: ${file}`);
    assert.ok(CREATE_CALL.test(source!), `${file} no longer creates a job — update this guard`);
    assert.ok(GATE_INDICATOR.test(source!), `${file} lost its enforceQuotaGate call`);
    assert.ok(entrypoints.includes(file), `${file} is no longer detected as an entrypoint`);
  }
});

test("every allowlisted entry points at a real charge path (no silent free lane)", () => {
  for (const [file, reason] of Object.entries(RESERVE_PATH_ALLOWLIST)) {
    const source = sources.get(file);
    assert.ok(source, `allowlisted file missing from tree: ${file}`);
    assert.ok(
      CHARGE_INDICATOR.test(source!),
      `allowlisted ${file} (${reason}) has no discernible charge path — remove it or gate it`,
    );
    assert.ok(
      entrypoints.includes(file),
      `${file} is allowlisted but no longer creates a job — prune the allowlist`,
    );
  }
});

test("gated and allowlisted sets are disjoint (an entrypoint is one or the other)", () => {
  for (const file of GATED_FILES) {
    assert.equal(RESERVE_PATH_ALLOWLIST[file], undefined, `${file} must not be both gated and allowlisted`);
  }
});
