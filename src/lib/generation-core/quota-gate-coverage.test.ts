import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * R4（W5）繞過預檢的守門測試 —— **這是變更探針，不是行為 oracle**。
 *
 * 本檔用 source-scan 斷言「所有建立 generation job 的入口，要嘛經過 `enforceQuotaGate`，
 * 要嘛走明文允許的清單（有實際收費路徑）」。它能量到的只有「原始碼裡有沒有出現某個
 * 符號/呼叫」，量不到「那個呼叫真的被執行、且真的回 402」。
 *
 * ⇒ 依 repo 驗證鐵律（源碼字串斷言只算變更探針），**真正「不花錢」的證明是提交一筆
 * 餘額不足的請求得到 402 `insufficient_balance`**，那條另見帳本 E2E（本輪未跑，屬未驗證）。
 * 本檔的價值只有一個：**新的 job 建立入口一旦沒接閘門又不在白名單，CI 立刻紅燈**。
 *
 * 現況盤點（2026-10-04）：真正接 `enforceQuotaGate` 的只有 4 個對外生成路由；
 * 其餘 6 個入口（`batches`／`upscale`／`generation-jobs`／`storyboard-voiceover`／
 * `sku/run-service`／`canary-service`，即下方 `RESERVE_PATH_ALLOWLIST` 六條）走 legacy
 * reserve / sync-charge（有實際扣費），不是「免錢通道」，
 * 但確實**不經過 precheck**——這條差異記在回報，不在本檔假裝不存在。
 */

const root = process.cwd();

/** 生成 job 建立的兩個函式名：一條是提交漏斗，一條是底層建單。 */
const CREATE_CALL = /(submitGenerationCommand|createGenerationJob)\s*\(/;

/** 定義/漏斗檔案：不是入口，跳過（它們本身呼叫不算繞過）。 */
const DEFINITION_FILES = new Set([
  "src/lib/generation-core/command-service.ts",
  "src/lib/generation-core/job-repository.ts",
]);

/** 真的經過 enforceQuotaGate 的入口（清單由現場掃描得出；少一個就要修閘門，不是修清單）。 */
const GATED_FILES = [
  "src/app/api/v1/images/generations/route.ts",
  "src/app/api/v1/images/edits/route.ts",
  "src/app/api/v1/videos/generations/route.ts",
  "src/app/api/v1/tts/generations/route.ts",
];

/**
 * 未接 precheck、但有明文收費路徑的入口。白名單必須同時通過 `CHARGE_INDICATOR`，
 * 否則白名單會腐化成「什麼都不做也能過」的後門。
 */
const RESERVE_PATH_ALLOWLIST: Record<string, string> = {
  "src/app/api/v1/batches/route.ts": "batch plan.billingAmount 逐項走 legacy reserve",
  "src/app/api/v1/upscale/route.ts": "reserveSyncCharge 先收費，submit 用 billingAmount=0 防雙扣",
  "src/app/api/generation-jobs/route.ts": "authenticateImageUser(requiredQuota) + billingAmount=requiredCoins*QUOTA_PER_COIN",
  "src/app/api/canvas/storyboard-voiceover/route.ts": "billingAmount=ttsQuotaForChars 走 legacy reserve",
  "src/lib/sku/run-service.ts": "逐鏡 plan.billingAmount 走 legacy reserve",
  "src/lib/generation-core/canary-service.ts": "canary 內部煙霧（billingAmount=0，非客戶流量）",
};

/** 一條入口至少要能指出它的收費依據，白名單才算數。 */
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
