#!/usr/bin/env npx tsx
/**
 * refresh-channel-bias.ts —— 渠道 bias 刷新（2026-10-12）。
 *
 * 一句话：把一个「已经修好、但平台还按修复前的旧证据判死」的渠道/模型，从
 * 三类负面判定里放出来——不必干等 24-72 小时自然过期，也不必人工改 DB。
 *
 * 平台对渠道的负面判定有且只有三层（都能在这里刷新）：
 *   L1 调度态：supplier / supplier_account 的 health_status=cooldown|degraded、
 *              cooldown_until、failure_count、5 分钟窗口计数器 + supplier_health_event。
 *   L2 证据层：generation_job 近 72h 终态 → 断路器 open（model-availability-gate）。
 *   L3 交付统计层：routing events 近 24h → last_24h 零交付闸（agent 的模型选型
 *              disprovenRecently ＋ 网关 M4 override_zero_delivery）与「渠道欠费」信号。
 * L2/L3 用「重置水位」（channel_bias_reset 表）解决：水位之前的旧证据不再计入判定，
 * 历史证据本身保留在库里可反查；L1 直接复位调度态（那是状态，不是证据）。
 *
 * **不解决的一件事**：网关 M4「近 24h 影片零交付」闸。它不是偏误，是「在没有任何
 * 真实交付证据时花钱要先取得用户同意」的使用者护栏——只有一次真实交付能把它打开。
 * 刷新完 bias 之后，第一条真实成片就是它的解锁钥匙（见 docs/runbooks/bias-refresh.md）。
 *
 * 用法（在控制面容器内跑；密钥/DSN 不出容器）：
 *   # 诊断：列出所有视频模型当前背着哪些负面判定（只读）
 *   sudo docker exec -w /app image-control-worker npx tsx tools/refresh-channel-bias.ts --diagnose
 *   # 刷新（默认 dry-run，只打印将要做的写操作）
 *   sudo docker exec -w /app image-control-worker npx tsx tools/refresh-channel-bias.ts \
 *     --model minimax-h3 --reason "适配器严格 JSON body 修复 + 上游实测 200 出片 54s" --actor tinchak0207
 *   # 真正落地（写入水位 + 复位调度态 + 清理窗口内健康事件）
 *   ... --apply
 *
 * 约束：写入必须带 --reason 与 --actor（谁在何时、凭什么判断渠道已修好）；不复位
 * enabled（关停是人的决定，不是偏误）；不复位 health_status='disabled' 的供应商。
 */

import { closeGenerationSql, getGenerationSql } from "../src/lib/generation-core/database";
import {
  applyModelBiasReset,
  readBiasResetWatermarks,
  resetBiasResetCache,
} from "../src/lib/bias-reset";
import { listRoutingEvents, summarizeRecentModelStats } from "../src/lib/routing-telemetry";
import { summarizeChannelBalance } from "../src/lib/routing-balance-signal";
import { generationCoins, modelPriceLabel } from "../src/lib/generation-model-catalog/pricing";
import type { OutputResolution } from "../src/lib/generation-model-catalog/types";
import { __resetModelBreakerStateForTests, readUnavailableModels } from "../src/lib/generation-core/model-availability-gate";

const DEFAULT_WINDOW_HOURS = 72;

interface Options {
  models: string[];
  suppliers: string[];
  reason: string;
  actor: string;
  apply: boolean;
  diagnose: boolean;
  windowHours: number;
  keepHealthEvents: boolean;
  includeDisabled: boolean;
  consentSeconds: number;
  consentResolution: string;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = {
    models: [],
    suppliers: [],
    reason: "",
    actor: process.env.USER ?? "unknown",
    apply: false,
    diagnose: false,
    windowHours: DEFAULT_WINDOW_HOURS,
    keepHealthEvents: false,
    includeDisabled: false,
    consentSeconds: 4,
    consentResolution: "720p",
  };
  const csv = (value: string): string[] => value.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 需要一个值`);
      i += 1;
      return value;
    };
    if (arg === "--model" || arg === "--models") opts.models.push(...csv(next()));
    else if (arg === "--supplier" || arg === "--label" || arg === "--suppliers") opts.suppliers.push(...csv(next()));
    else if (arg === "--reason") opts.reason = next();
    else if (arg === "--actor") opts.actor = next();
    else if (arg === "--apply") opts.apply = true;
    else if (arg === "--dry-run") opts.apply = false;
    else if (arg === "--diagnose") opts.diagnose = true;
    else if (arg === "--window-hours") opts.windowHours = Number(next());
    else if (arg === "--keep-health-events") opts.keepHealthEvents = true;
    else if (arg === "--include-disabled") opts.includeDisabled = true;
    else if (arg === "--consent-seconds") opts.consentSeconds = Number(next());
    else if (arg === "--consent-resolution") opts.consentResolution = next();
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isFinite(opts.windowHours) || opts.windowHours <= 0) throw new Error("--window-hours 必须是正数");
  if (opts.models.length === 0 && opts.suppliers.length === 0) opts.diagnose = true;
  return opts;
}

const USAGE = `refresh-channel-bias.ts —— 渠道 bias 刷新（详见 docs/runbooks/bias-refresh.md）

  --diagnose                     只读：列出各视频模型当前背着的负面判定
  --model <id[,id]>              要刷新的公开模型（如 minimax-h3）
  --supplier <label|id[,...]>    要刷新的渠道（如 miaowuai / env:miaowuai）
  --reason "<修好了什么，凭什么>"  必填（写入台账，供审计）
  --actor <who>                  谁在刷新（默认 $USER）
  --window-hours <n>             清理健康事件的时间窗（默认 72）
  --keep-health-events           保留窗口内 supplier_health_event（只复位调度态）
  --include-disabled             连 health_status='disabled' 的供应商一起复位（默认跳过）
  --consent-seconds <n>          授权原话里的时长（默认 4＝最省的解锁形态）
  --consent-resolution <r>       授权原话里的档位（默认 720p）
  --apply / --dry-run            默认 dry-run：只打印将做的写操作 + 待粘贴的授权原话`;

type Sql = ReturnType<typeof getGenerationSql>;

interface SupplierRow {
  id: string;
  label: string;
  enabled: boolean;
  health_status: string;
  cooldown_until: string | Date | null;
  failure_count: number;
}

/** 把 --supplier 的 label 或 id 归一成 supplier.id。 */
async function resolveSuppliers(sql: Sql, inputs: readonly string[]): Promise<SupplierRow[]> {
  const all = await sql<SupplierRow[]>`
    SELECT id, label, enabled, health_status, cooldown_until, failure_count FROM supplier ORDER BY label
  `;
  const wanted: SupplierRow[] = [];
  for (const input of inputs) {
    const hit = all.filter((row) => row.id === input || row.label === input || row.id === `env:${input}`);
    if (hit.length === 0) throw new Error(`找不到渠道：${input}（可用：${all.map((r) => r.label).join(", ")}）`);
    wanted.push(...hit);
  }
  return [...new Map(wanted.map((row) => [row.id, row])).values()];
}

/** 模型 → 当前承接它的渠道（用于「刷新某模型 = 顺便刷新它的渠道」）。 */
async function suppliersForModels(sql: Sql, models: readonly string[]): Promise<SupplierRow[]> {
  if (models.length === 0) return [];
  return sql<SupplierRow[]>`
    SELECT DISTINCT supplier.id, supplier.label, supplier.enabled, supplier.health_status,
           supplier.cooldown_until, supplier.failure_count
    FROM supplier_capability capability
    JOIN supplier ON supplier.id = capability.supplier_id
    WHERE capability.is_current AND capability.public_model_id IN ${sql(models)}
    ORDER BY supplier.label
  `;
}

/** 诊断：每个视频模型当前背着哪些负面判定（三层各看一遍，只读）。 */
async function diagnose(sql: Sql): Promise<void> {
  const rows = await sql<{ public_model_id: string; suppliers: string; healths: string }[]>`
    SELECT capability.public_model_id,
           string_agg(DISTINCT capability.supplier_id, ', ') AS suppliers,
           string_agg(DISTINCT capability.supplier_id || ':' || capability.health_status, ', ') AS healths
    FROM supplier_capability capability
    WHERE capability.is_current AND capability.kind = 'video_generate'
    GROUP BY capability.public_model_id
    ORDER BY capability.public_model_id
  `;
  const watermarks = await readBiasResetWatermarks(sql);
  const events = await listRoutingEvents(200).catch(() => []);
  const stats = summarizeRecentModelStats(applyModelBiasReset(events, watermarks), Date.now());
  const statsByModel = new Map(stats.map((s) => [s.modelId, s]));
  const balance = summarizeChannelBalance(applyModelBiasReset(events, watermarks));
  __resetModelBreakerStateForTests();
  const unavailable = await readUnavailableModels(sql);

  console.log(`视频模型 bias 诊断（水位：model ${watermarks.modelResets.size} 条 / supplier ${watermarks.supplierResets.size} 条）`);
  for (const row of rows) {
    const stat = statsByModel.get(row.public_model_id);
    const last24h = stat ? `jobs=${stat.jobs} delivered=${stat.delivered} rate=${stat.success_rate.toFixed(2)}` : "无样本";
    const breaker = unavailable.get(row.public_model_id) ?? "closed";
    const zeroDelivery = stat && stat.jobs >= 3 && stat.delivered === 0 ? "★近24h零交付（agent 已排除）" : "";
    const arrears = balance.get(row.public_model_id)?.status === "exhausted" ? "★欠费信号" : "";
    const reset = watermarks.modelResets.get(row.public_model_id);
    console.log(
      `\n  ${row.public_model_id}\n` +
        `    渠道: ${row.suppliers}\n` +
        `    能力健康: ${row.healths}\n` +
        `    24h: ${last24h} ${zeroDelivery}${arrears}\n` +
        `    断路器: ${breaker}\n` +
        `    水位: ${reset ? new Date(reset).toISOString() : "未刷新"}`,
    );
  }
  console.log("\n诊断口径：24h 来自 routing events（routing-telemetry），断路器来自 generation_job 72h，");
  console.log("健康态来自 supplier/supplier_account。★ = 该模型当前被此判据判死。");
}

function printSupplierState(title: string, rows: readonly (SupplierRow & { accounts?: string })[]): void {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log("  （无）");
    return;
  }
  for (const row of rows) {
    const cooldown = row.cooldown_until ? ` cooldown_until=${String(row.cooldown_until)}` : "";
    const accounts = row.accounts ? ` 账户[${row.accounts}]` : "";
    console.log(`  ${row.id} enabled=${row.enabled} health=${row.health_status} failures=${row.failure_count}${cooldown}${accounts}`);
  }
}

async function accountSummary(sql: Sql, supplierIds: readonly string[]): Promise<Map<string, string>> {
  if (supplierIds.length === 0) return new Map();
  const rows = await sql<{ supplier_id: string; health_status: string; enabled: boolean; success_rate_5m: number; attempts_5m: number }[]>`
    SELECT supplier_id, health_status, enabled, success_rate_5m, attempts_5m FROM supplier_account
    WHERE supplier_id IN ${sql(supplierIds)}
    ORDER BY supplier_id
  `;
  const bySupplier = new Map<string, string[]>();
  for (const row of rows) {
    const list = bySupplier.get(row.supplier_id) ?? [];
    list.push(`${row.health_status}${row.enabled ? "" : "/disabled"} 5m=${row.attempts_5m}单 rate=${row.success_rate_5m}`);
    bySupplier.set(row.supplier_id, list);
  }
  return new Map([...bySupplier].map(([id, list]) => [id, list.join(" | ")]));
}

/**
 * 授权原话（最后一块拼图）：bias 刷新只清掉「旧证据造成的偏误」，清不掉 M4
 * 「近 24h 无交付证据 → 花钱前先取得用户同意」这条护栏。护栏的唯一钥匙是**用户
 * 的明确授权原话**——agent 不能替用户说，所以这里把可粘贴的授权文本连价格一起生成，
 * 让「刷新 bias → 用户一句话 → 真出片 → 闸门自然打开」成为一条可复用的流程。
 */
function printConsentPrompt(opts: Options, supplierLabels: readonly string[]): void {
  if (opts.models.length === 0) return;
  const resolution = opts.consentResolution as OutputResolution;
  const seconds = opts.consentSeconds;
  console.log("\n授权原话（贴给 agent；agent 须以 override_zero_delivery=true + override_reason=该句原文 调 workflow_generate）");
  console.log("────────────────────────────────────────────────────────────");
  for (const id of opts.models) {
    const coins = generationCoins(id, { resolution, durationSeconds: seconds });
    const perSecond = modelPriceLabel(id, { resolution, durationSeconds: 1 });
    const channel = supplierLabels.length > 0 ? supplierLabels.join("/") : "平台默认渠道";
    // 价目阶梯：让授权者一眼看到「解锁这一单」的最低成本与推荐档位。
    const ladder = [4, 5, 10, 15]
      .map((s) => `${s}s=${generationCoins(id, { resolution, durationSeconds: s })}`)
      .join(" · ");
    console.log(
      `我是账号所有者，明确授权本次影片生成：模型 ${id}（渠道 ${channel}），${seconds} 秒 / ${resolution} / 16:9，` +
        `站内价 ${coins} 币（${perSecond}）。我知道平台侧「近 24 小时影片零交付」（无交付证据），也接受这次可能不出片。` +
        `照跑，${coins} 币我认，亏了不怪你。`,
    );
    console.log(`  ↳ 同上口径的价目阶梯（${resolution}）：${ladder} 币`);
  }
  console.log("────────────────────────────────────────────────────────────");
  console.log("把上面那段原文作为 override_reason 传进去，不要改写、不要替用户解释；授权只对这一次呼叫有效。");
  console.log("出片交付后，last_24h.delivered>0，M4 闸门自动打开，之后无需再授权。");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const sql = getGenerationSql();

  if (opts.diagnose) {
    await diagnose(sql);
    return;
  }
  if (!opts.reason.trim()) throw new Error("--reason 必填：写清楚『修好了什么、凭什么判断渠道已修好』（写入台账供审计）");

  // 目标解析：显式 --supplier 只刷该渠道的调度态；只给 --model 时，顺手刷它当前的承接渠道。
  const fromModels = await suppliersForModels(sql, opts.models);
  const explicit = await resolveSuppliers(sql, opts.suppliers);
  const supplierRows = [...new Map([...fromModels, ...explicit].map((row) => [row.id, row])).values()];
  const healthTargets = explicit.length > 0 ? explicit : fromModels;
  const skippedDisabled = healthTargets.filter((row) => !opts.includeDisabled && row.health_status === "disabled");
  const writable = healthTargets.filter((row) => opts.includeDisabled || row.health_status !== "disabled");

  const models = [...new Set(opts.models)];
  // 模型存在性提示：渠道尚未 seed / 拼错名字时，水位会写在空气上。
  for (const id of models) {
    const rows = await sql<{ supplier_id: string }[]>`
      SELECT supplier_id FROM supplier_capability WHERE is_current AND public_model_id = ${id} LIMIT 1
    `;
    if (rows.length === 0) console.log(`⚠ 模型 ${id} 当前无任何 is_current 能力行（核对拼写，或渠道尚未 seed）`);
  }

  const beforeAccounts = await accountSummary(sql, writable.map((row) => row.id));
  printSupplierState(
    "刷新前 · 调度态（L1）",
    writable.map((row) => ({ ...row, accounts: beforeAccounts.get(row.id) })),
  );
  if (skippedDisabled.length > 0) {
    console.log(`  （跳过 health_status='disabled'：${skippedDisabled.map((r) => r.id).join(", ")}——关停是人的决定，不是偏误；要一起复位加 --include-disabled）`);
  }

  const healthEventCounts = await sql<{ supplier_id: string; n: number }[]>`
    SELECT supplier_id, count(*)::int AS n FROM supplier_health_event
    WHERE observed_at > now() - make_interval(hours => ${opts.windowHours})
    GROUP BY supplier_id ORDER BY supplier_id
  `;
  const purgedEvents = healthEventCounts.filter((row) => writable.some((s) => s.id === row.supplier_id));
  const modelJobCounts = await sql<{ model_id: string; n: number }[]>`
    SELECT model_id, count(*)::int AS n FROM generation_job
    WHERE kind = 'video_generate' AND created_at > now() - make_interval(hours => ${opts.windowHours})
      AND model_id IN ${sql(models.length > 0 ? models : ["<none>"])}
    GROUP BY model_id ORDER BY model_id
  `.catch(() => [] as { model_id: string; n: number }[]);

  console.log("\n刷新计划（写操作）");
  console.log(`  1) 复位调度态：${writable.length} 个 supplier + 其 enabled 账户 → health_status='healthy', cooldown_until=NULL, failure_count=0（5 分钟窗口计数器归零）`);
  console.log(`  2) 清理健康事件：${opts.keepHealthEvents ? "跳过（--keep-health-events）" : `${purgedEvents.reduce((sum, row) => sum + row.n, 0)} 条近 ${opts.windowHours}h 的 supplier_health_event`}`);
  console.log(`  3) 写水位：model × ${models.length}${models.length ? `（${models.join(", ")}）` : ""} + supplier × ${writable.length}`);
  if (modelJobCounts.length > 0) {
    console.log(`  （水位覆盖的 ${opts.windowHours}h 内 generation_job 旧样本：${modelJobCounts.map((r) => `${r.model_id}=${r.n}`).join(", ")}）`);
  }
  console.log(`\n  台账：actor=${opts.actor} reason="${opts.reason}"`);

  printConsentPrompt(opts, [...new Set(writable.map((row) => row.label))]);

  if (!opts.apply) {
    console.log("\nDRY-RUN：未写入任何数据。确认无误后加 --apply。");
    return;
  }

  await sql.begin(async (tx) => {
    const ids = writable.map((row) => row.id);
    if (ids.length > 0) {
      await tx`
        UPDATE supplier
        SET health_status = 'healthy', cooldown_until = NULL, failure_count = 0, updated_at = now()
        WHERE id IN ${tx(ids)}
      `;
      await tx`
        UPDATE supplier_account
        SET health_status = 'healthy', cooldown_until = NULL,
            attempts_5m = 0, successes_5m = 0, success_rate_5m = 1, updated_at = now()
        WHERE supplier_id IN ${tx(ids)} AND enabled
      `;
      if (!opts.keepHealthEvents) {
        await tx`
          DELETE FROM supplier_health_event
          WHERE supplier_id IN ${tx(ids)} AND observed_at > now() - make_interval(hours => ${opts.windowHours})
        `;
      }
    }
    const targetsList: Array<{ scope: string; target: string }> = [
      ...models.map((id) => ({ scope: "model", target: id })),
      ...writable.map((row) => ({ scope: "supplier", target: row.id })),
    ];
    for (const { scope, target } of targetsList) {
      await tx`
        INSERT INTO channel_bias_reset (scope, target, reset_at, reason, actor)
        VALUES (${scope}, ${target}, now(), ${opts.reason}, ${opts.actor})
        ON CONFLICT (scope, target)
        DO UPDATE SET reset_at = now(), reason = EXCLUDED.reason, actor = EXCLUDED.actor, updated_at = now()
      `;
    }
  });

  resetBiasResetCache();
  __resetModelBreakerStateForTests();

  const afterAccounts = await accountSummary(sql, writable.map((row) => row.id));
  const after = await sql<SupplierRow[]>`
    SELECT id, label, enabled, health_status, cooldown_until, failure_count FROM supplier
    WHERE id IN ${sql(writable.length > 0 ? writable.map((r) => r.id) : ["<none>"])}
    ORDER BY label
  `.catch(() => [] as SupplierRow[]);
  printSupplierState("刷新后 · 调度态（L1）", after.map((row) => ({ ...row, accounts: afterAccounts.get(row.id) })));

  // 判据复核：平台现在会怎么判（同 /v1/model-status 的口径）。
  const watermarks = await readBiasResetWatermarks(sql);
  const events = await listRoutingEvents(200).catch(() => []);
  const filtered = applyModelBiasReset(events, watermarks);
  const stats = summarizeRecentModelStats(filtered, Date.now());
  const balance = summarizeChannelBalance(filtered);
  const unavailable = await readUnavailableModels(sql);
  console.log("\n刷新后 · 判据复核（平台现在如何判这几个模型）");
  for (const id of models) {
    const stat = stats.find((s) => s.modelId === id);
    const last24h = stat ? `jobs=${stat.jobs} delivered=${stat.delivered}` : "无样本（旧证据已不计入）";
    const breaker = unavailable.get(id) ?? "closed";
    const arrears = balance.get(id)?.status === "exhausted" ? "欠费信号仍在（有水位之后的新欠费）" : "无欠费信号";
    console.log(`  ${id}: 24h ${last24h} · 断路器 ${breaker} · ${arrears}`);
  }
  console.log("\n注意：网关 M4「近 24h 影片零交付」闸不受本工具影响——它不是偏误，是花钱前的使用者护栏；");
  console.log("      无交付证据时仍需用户明确同意，第一条真实成片交付后自动打开。");
}

main()
  .catch((error) => {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeGenerationSql());
