#!/usr/bin/env node
/**
 * C2 — apply db/migrations/*.sql to the control-plane Postgres.
 *
 * Reuses the exact bookkeeping contract of the existing runner
 * (tools/migrate-generation-db.ts): the `generation_schema_migration` table,
 * name = filename, checksum = sha256 hex of the file bytes. There is only one
 * migration ledger; this tool must never invent a second one.
 *
 * SQL travels to the VPS as base64 so quoting can never break:
 *   echo <b64> | base64 -d | sudo -n docker exec -i image-control-postgres \
 *     psql -v ON_ERROR_STOP=1 -U image_control -d image_control -f -
 *
 * Usage:
 *   npx tsx tools/apply-migrations.ts --dry-run
 *   npx tsx tools/apply-migrations.ts --dry-run --file 037_mapay_order_intake.sql
 *   npx tsx tools/apply-migrations.ts                      # APPLIES (writes)
 *   npx tsx tools/apply-migrations.ts --file 037_mapay_order_intake.sql
 *   npx tsx tools/apply-migrations.ts --local              # already on the VPS
 *
 * `--dry-run` performs zero writes; every other mode writes.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultRemoteOptions, parsePipeRows, runWithSql, type RemoteOptions } from "./lib/remote";

const PG_CONTAINER = "image-control-postgres";
const PG_USER = "image_control";
const PG_DB = "image_control";
const TABLE = "generation_schema_migration";

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);`;

const SINK = `sudo -n docker exec -i ${PG_CONTAINER} psql -v ON_ERROR_STOP=1 -tA -F '|' -U ${PG_USER} -d ${PG_DB} -f -`;

interface Plan {
  dryRun: boolean;
  file?: string;
  dir: string;
  remote: RemoteOptions;
}

interface Migration {
  name: string;
  body: string;
  checksum: string;
}

function parseArgs(argv: string[], cwd: string): Plan {
  const plan: Plan = { dryRun: false, dir: path.join(cwd, "db", "migrations"), remote: defaultRemoteOptions(cwd) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") plan.dryRun = true;
    else if (a === "--file") plan.file = argv[++i];
    else if (a === "--dir") plan.dir = path.resolve(cwd, argv[++i]);
    else if (a === "--local") plan.remote.local = true;
    else if (a === "--helper") plan.remote.helper = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("usage: apply-migrations.ts [--dry-run] [--file <name>] [--dir <path>] [--local] [--helper <path>]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return plan;
}

function sortKey(name: string): [number, string] {
  const m = name.match(/^(\d+)_/);
  return [m ? Number(m[1]) : Number.MAX_SAFE_INTEGER, name];
}

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

async function loadMigrations(dir: string, only?: string): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql"));
  let selected = names;
  if (only) {
    if (!names.includes(only)) die(`--file ${only} not found in ${dir} (only *.sql files are eligible; *.sql.pending is intentionally excluded)`);
    selected = [only];
  }
  selected.sort((a, b) => {
    const [na, sa] = sortKey(a);
    const [nb, sb] = sortKey(b);
    return na - nb || sa.localeCompare(sb);
  });
  const out: Migration[] = [];
  for (const name of selected) {
    const body = await readFile(path.join(dir, name), "utf8");
    out.push({ name, body, checksum: createHash("sha256").update(body).digest("hex") });
  }
  return out;
}

/** Read-only: returns name -> checksum for already-applied migrations. */
function readApplied(remote: RemoteOptions): Map<string, string> {
  const probe = runWithSql(
    SINK,
    `SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_name='${TABLE}';`,
    remote,
  );
  if (probe.code !== 0) die(`cannot probe ${TABLE}: ${probe.stderr || probe.stdout}`);
  const exists = probe.stdout.trim() === "1";
  if (!exists) return new Map();

  const rows = parsePipeRows(runWithSql(SINK, `SELECT name, checksum FROM ${TABLE};`, remote));
  if (rows.code !== 0) die(`cannot read ${TABLE}: ${rows.stderr || rows.raw}`);
  const map = new Map<string, string>();
  for (const r of rows.rows) if (r.length >= 2) map.set(r[0], r[1]);
  return map;
}

function ensureTable(remote: RemoteOptions): void {
  const res = runWithSql(SINK, TABLE_DDL, remote);
  if (res.code !== 0) die(`cannot create/verify ${TABLE}: ${res.stderr || res.stdout}`);
}

function applyOne(m: Migration, remote: RemoteOptions): void {
  const payload = [
    "BEGIN;",
    m.body,
    `INSERT INTO ${TABLE} (name, checksum) VALUES ('${m.name}', '${m.checksum}') ON CONFLICT (name) DO NOTHING;`,
    "COMMIT;",
  ].join("\n");
  const res = runWithSql(SINK, payload, remote);
  if (res.code !== 0) {
    die(`migration ${m.name} FAILED (aborted, nothing after this file was applied):\n${res.stderr || res.stdout}`);
  }
}

async function main() {
  const cwd = process.cwd();
  const plan = parseArgs(process.argv.slice(2), cwd);
  const migrations = await loadMigrations(plan.dir, plan.file);
  if (migrations.length === 0) die(`no migrations found in ${plan.dir}`);

  const applied = readApplied(plan.remote);

  const pending: Migration[] = [];
  const changed: Migration[] = [];
  const ok: Migration[] = [];
  for (const m of migrations) {
    const prev = applied.get(m.name);
    if (prev === undefined) pending.push(m);
    else if (prev !== m.checksum) changed.push(m);
    else ok.push(m);
  }

  console.log(`target     ${plan.remote.local ? "local" : "via " + plan.remote.helper} -> ${PG_CONTAINER} (${PG_USER}@${PG_DB})`);
  console.log(`mode       ${plan.dryRun ? "DRY-RUN (no writes)" : "APPLY (writes)"}`);
  console.log(`migrations ${migrations.length} selected from ${plan.dir}`);
  console.log("");
  for (const m of migrations) {
    const prev = applied.get(m.name);
    const state = prev === undefined ? "PENDING" : prev !== m.checksum ? "CHANGED" : "applied";
    console.log(`${state.padEnd(8)} ${m.name}`);
  }
  console.log("");
  console.log(`summary    applied=${ok.length} pending=${pending.length} changed=${changed.length}`);

  if (changed.length > 0) {
    console.error("");
    console.error("FAIL: these already-applied migrations have a different checksum on disk (edit in place is forbidden):");
    for (const m of changed) console.error(`  ${m.name}: db=${applied.get(m.name)} disk=${m.checksum}`);
    process.exit(1);
  }

  if (plan.dryRun) {
    console.log("");
    console.log(`DRY-RUN complete: ${pending.length} migration(s) would be applied, 0 writes performed.`);
    process.exit(0);
  }

  ensureTable(plan.remote);

  if (pending.length === 0) {
    console.log("");
    console.log("nothing to apply; database is up to date.");
    process.exit(0);
  }

  console.log("");
  for (const m of pending) {
    applyOne(m, plan.remote);
    console.log(`applied    ${m.name}  sha256=${m.checksum.slice(0, 12)}…`);
  }
  console.log("");
  console.log(`done: applied ${pending.length} migration(s).`);
}

main().catch((err) => die((err as Error).message));