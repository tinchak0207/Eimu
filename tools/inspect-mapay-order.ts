#!/usr/bin/env node
/**
 * C3 — read-only mPay incident forensics.
 *
 * For one mPay `out_trade_no` (e.g. IMGMU7UH9SFF9A21D) this prints the evidence
 * from all three places our side would record a fulfilled order:
 *   1. control plane  : mapay_credit (the direct-credit placeholder)
 *   2. new-api SQLite : redemptions where name = MP + last-18-of-order, + quota
 *   3. control plane  : account_ledger rows keyed `redemption:<out_trade_no>`
 *
 * STRICTLY READ-ONLY: only SELECTs, new-api opened with sqlite3 -readonly.
 *
 * Usage:
 *   npx tsx tools/inspect-mapay-order.ts IMGMU7UH9SFF9A21D
 *   npx tsx tools/inspect-mapay-order.ts --order IMGMU7UH9SFF9A21D
 *   npx tsx tools/inspect-mapay-order.ts IMGMU7UH9SFF9A21D --local
 */
import { mapayOrderRedemptionName } from "../src/lib/mapay-redemption";
import { QUOTA_PER_COIN } from "../src/lib/quota-constants";
import { defaultRemoteOptions, parsePipeRows, runWithSql, type RemoteOptions } from "./lib/remote";

const PG_CONTAINER = "image-control-postgres";
const PG_USER = "image_control";
const PG_DB = "image_control";
const NA_DB = "/opt/eimu-site/new-api-data/one-api.db";

const PG_SINK = `sudo -n docker exec -i ${PG_CONTAINER} psql -v ON_ERROR_STOP=1 -tA -F '|' -U ${PG_USER} -d ${PG_DB} -f -`;
const NA_SINK = `sudo -n sqlite3 -readonly -noheader -separator '|' ${NA_DB}`;

interface Plan {
  order: string;
  remote: RemoteOptions;
}

function parseArgs(argv: string[], cwd: string): Plan {
  let order = "";
  const remote = defaultRemoteOptions(cwd);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--order") order = argv[++i];
    else if (a === "--local") remote.local = true;
    else if (a === "--helper") remote.helper = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("usage: inspect-mapay-order.ts <out_trade_no> [--local] [--helper <path>]");
      process.exit(0);
    } else if (!order && !a.startsWith("-")) order = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!order) throw new Error("missing out_trade_no");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(order)) throw new Error(`invalid out_trade_no (expected [A-Za-z0-9_-]): ${JSON.stringify(order)}`);
  return { order, remote };
}

function section(title: string) {
  console.log("");
  console.log(`==== ${title} ====`);
}

function renderRows(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log("(0 rows)");
    return;
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows.length > 1) console.log(`-- row ${i + 1} --`);
    const cells = rows[i];
    for (let c = 0; c < headers.length; c++) console.log(`  ${headers[c].padEnd(16)} ${cells[c] ?? ""}`);
  }
}

function unixToIso(v: string | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toISOString();
}

function main() {
  const plan = parseArgs(process.argv.slice(2), process.cwd());
  const order = plan.order;
  const redemptionName = mapayOrderRedemptionName(order);

  console.log(`out_trade_no        ${order}`);
  console.log(`expected redemption ${redemptionName}  (MP + last 18 chars)`);
  console.log(`target              ${plan.remote.local ? "local" : "via " + plan.remote.helper}`);

  // 1. control plane: mapay_credit
  const q1 = `SELECT out_trade_no,user_id,plan_id,amount_quota,status,detail,created_at,updated_at FROM mapay_credit WHERE out_trade_no='${order}';`;
  const r1 = parsePipeRows(runWithSql(PG_SINK, q1, plan.remote));
  if (r1.code !== 0) throw new Error(`mapay_credit query failed: ${r1.stderr || r1.raw}`);
  section("1. control plane mapay_credit");
  renderRows(["out_trade_no", "user_id", "plan_id", "amount_quota", "status", "detail", "created_at", "updated_at"], r1.rows);

  // 3 (ordered as #2 here for readability): account_ledger redemption rows
  const q2 = `SELECT id,billing_user_id,entry_type,amount,source,source_ref,idempotency_ref,created_at FROM account_ledger WHERE idempotency_ref IN ('redemption:${order}','redemption:${order}:opening-offset') OR source_ref='redemption:${order}';`;
  const r2 = parsePipeRows(runWithSql(PG_SINK, q2, plan.remote));
  if (r2.code !== 0) throw new Error(`account_ledger query failed: ${r2.stderr || r2.raw}`);
  section("2. control plane account_ledger (redemption:<out_trade_no>)");
  renderRows(["id", "billing_user_id", "entry_type", "amount", "source", "source_ref", "idempotency_ref", "created_at"], r2.rows);

  // 3. new-api: redemptions
  const q3 = `SELECT id,user_id,name,status,quota,created_time,redeemed_time,used_user_id FROM redemptions WHERE name='${redemptionName}';`;
  const r3 = parsePipeRows(runWithSql(NA_SINK, q3, plan.remote));
  if (r3.code !== 0) throw new Error(`new-api redemptions query failed: ${r3.stderr || r3.raw}`);
  section("3. new-api redemptions (MP<last18>)");
  renderRows(["id", "user_id", "name", "status", "quota", "created_time", "redeemed_time", "used_user_id"], r3.rows);
  for (const row of r3.rows) {
    const created = unixToIso(row[5]);
    const redeemed = unixToIso(row[6]);
    console.log(`  -> created=${created || "-"} redeemed=${redeemed || "-"} quota=${row[4] ?? "-"} (=${row[4] ? Number(row[4]) / QUOTA_PER_COIN : "-"} coins)`);
  }

  // veredict
  const credit = r1.rows[0];
  const redemption = r3.rows[0];
  section("verdict");
  if (r1.rows.length === 0 && r2.rows.length === 0 && r3.rows.length === 0) {
    console.log("NOT FULFILLED: this out_trade_no is absent from mapay_credit, account_ledger and redemptions.");
    console.log("=> the payment never landed on our side (classic swallowed order).");
    return;
  }
  console.log("evidence present:");
  if (r1.rows.length > 0) console.log(`  mapay_credit: ${r1.rows.length} row(s), status=${credit[4]}`);
  if (r2.rows.length > 0) console.log(`  account_ledger: ${r2.rows.length} row(s)`);
  if (r3.rows.length > 0) console.log(`  redemptions: ${r3.rows.length} row(s), status=${redemption[3]}`);

  if (credit && redemption) {
    const expected = Number(credit[3]);
    const actual = Number(redemption[4]);
    console.log(
      actual === expected
        ? `quota check: MATCHES (${actual} == mapay_credit.amount_quota ${expected})`
        : `quota check: MISMATCH (redemption ${actual} vs mapay_credit.amount_quota ${expected})`,
    );
  } else if (redemption) {
    console.log(`quota check: no mapay_credit row to compare against; redemption quota=${redemption[4]} (=${Number(redemption[4]) / QUOTA_PER_COIN} coins)`);
  } else if (credit) {
    console.log(`quota check: no redemption named ${redemptionName}; the MP<order> code was never issued (mapay_credit.amount_quota=${credit[3]}, status=${credit[4]}).`);
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR: ${(err as Error).message}`);
  process.exit(1);
}