#!/usr/bin/env node
/**
 * C1 — deployment freshness gate.
 *
 * Compares the git commit currently served by the Vercel **production alias**
 * against the local `git rev-parse HEAD`. A stale alias is exactly how the
 * 2026-09-19 fix never reached production while the incident kept happening.
 *
 * Read-only. Never prints the Vercel token.
 *
 * Usage:
 *   XDG_DATA_HOME=/home/lenovo/Desktop/image-app/.vercel-cli-data \
 *     npx tsx tools/check-deploy-freshness.ts
 *   ... --alias eimu.dev          # check one alias only
 *   ... --json                    # machine-readable result
 *
 * Exit codes: 0 = alias commit == HEAD, 1 = mismatch, 2 = could not determine.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const API = "https://api.vercel.com";
const REPO_ROOT = process.cwd();

interface AliasRecord {
  alias: string;
  deploymentId: string;
}

interface Plan {
  alias?: string;
  json: boolean;
  head?: string;
}

function parseArgs(argv: string[]): Plan {
  const plan: Plan = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--alias") plan.alias = argv[++i];
    else if (a === "--head") plan.head = argv[++i];
    else if (a === "--json") plan.json = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: check-deploy-freshness.ts [--alias <domain>] [--head <sha>] [--json]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return plan;
}

function fail(message: string, code = 2): never {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

function readProjectId(): string {
  const file = path.join(REPO_ROOT, ".vercel", "project.json");
  if (!existsSync(file)) fail(`missing ${file}`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { projectId?: string };
  if (!parsed.projectId) fail(`${file} has no projectId`);
  return parsed.projectId;
}

/** Locate the Vercel CLI credentials without ever echoing the token. */
function readToken(): string {
  const candidates: string[] = [];
  if (process.env.XDG_DATA_HOME) candidates.push(path.join(process.env.XDG_DATA_HOME, "com.vercel.cli", "auth.json"));
  candidates.push(path.join(REPO_ROOT, ".vercel-cli-data", "com.vercel.cli", "auth.json"));
  if (process.env.HOME) candidates.push(path.join(process.env.HOME, ".local", "share", "com.vercel.cli", "auth.json"));
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const parsed = JSON.parse(readFileSync(c, "utf8")) as { token?: string };
      if (parsed.token) return parsed.token;
    } catch {
      /* try next candidate */
    }
  }
  fail(
    "no Vercel token found. Point XDG_DATA_HOME at the repo's .vercel-cli-data, " +
      "e.g. XDG_DATA_HOME=/home/lenovo/Desktop/image-app/.vercel-cli-data",
  );
}

async function api<T>(token: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json()) as T & { error?: { message?: string; code?: string } };
  if (!res.ok) {
    const msg = body?.error?.message ?? res.statusText;
    throw new Error(`GET ${url} -> HTTP ${res.status}: ${msg}`);
  }
  return body;
}

function isCustomDomain(alias: string): boolean {
  if (alias.endsWith(".vercel.app")) return false;
  if (alias.includes(".git-")) return false;
  return true;
}

function localHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function isDirty(): boolean {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  return (r.stdout ?? "").trim().length > 0;
}

function short(sha: string | undefined | null, n = 8): string {
  return sha ? sha.slice(0, n) : "(none)";
}

async function main() {
  const plan = parseArgs(process.argv.slice(2));
  const token = readToken();
  const projectId = readProjectId();
  const head = plan.head ?? localHead();

  const aliasUrl = `${API}/v4/aliases?projectId=${encodeURIComponent(projectId)}&limit=100`;
  const aliasesResp = await api<{ aliases?: { alias: string; deploymentId?: string }[] }>(token, aliasUrl);
  let aliases: AliasRecord[] = (aliasesResp.aliases ?? [])
    .filter((a) => a.deploymentId && isCustomDomain(a.alias))
    .map((a) => ({ alias: a.alias, deploymentId: a.deploymentId as string }));

  if (plan.alias) aliases = aliases.filter((a) => a.alias === plan.alias);
  aliases = aliases.filter((a, i, arr) => arr.findIndex((b) => b.alias === a.alias) === i);

  if (aliases.length === 0) {
    fail(
      `no production alias resolved (tried ${aliasUrl}${plan.alias ? `, --alias ${plan.alias}` : ""}). ` +
        "This is not a pass: refreshness is UNKNOWN.",
    );
  }

  const results: {
    alias: string;
    deploymentId: string;
    commit: string | null;
    match: boolean;
    detail: string;
  }[] = [];

  for (const a of aliases) {
    const depUrl = `${API}/v13/deployments/${encodeURIComponent(a.deploymentId)}`;
    try {
      const dep = await api<{ meta?: Record<string, string> }>(token, depUrl);
      const commit = dep.meta?.gitCommitSha ?? null;
      const match = commit ? commit.toLowerCase() === head.toLowerCase() || commit.startsWith(head) || head.startsWith(commit) : false;
      results.push({
        alias: a.alias,
        deploymentId: a.deploymentId,
        commit,
        match,
        detail: commit ? "meta.gitCommitSha" : `no commit in ${depUrl}`,
      });
    } catch (err) {
      results.push({
        alias: a.alias,
        deploymentId: a.deploymentId,
        commit: null,
        match: false,
        detail: `failed ${depUrl}: ${(err as Error).message}`,
      });
    }
  }

  const unknown = results.filter((r) => r.commit === null);
  const mismatches = results.filter((r) => r.commit !== null && !r.match);
  const dirty = isDirty();

  if (plan.json) {
    console.log(
      JSON.stringify(
        { head, dirty, results, ok: mismatches.length === 0 && unknown.length === 0 },
        null,
        2,
      ),
    );
  } else {
    console.log(`local HEAD        ${head}`);
    console.log(`working tree      ${dirty ? "DIRTY (uncommitted changes are not deployed)" : "clean"}`);
    console.log("");
    for (const r of results) {
      const verdict = r.commit === null ? "UNKNOWN" : r.match ? "FRESH" : "STALE";
      console.log(`${verdict.padEnd(8)} ${r.alias}  ${r.deploymentId}  commit=${short(r.commit)}  (${r.detail})`);
    }
    console.log("");
    if (unknown.length > 0) {
      console.log(`FAIL: ${unknown.length} alias(es) had no resolvable commit -> freshness UNKNOWN, not a pass.`);
    }
    if (mismatches.length > 0) {
      console.log(`FAIL: production alias commit != local HEAD for ${mismatches.length} alias(es).`);
      console.log(`      local HEAD = ${head}`);
      for (const m of mismatches) console.log(`      ${m.alias}: ${m.commit}`);
    }
    if (mismatches.length === 0 && unknown.length === 0) {
      console.log(`OK: production alias(es) serve local HEAD ${short(head)}.`);
    }
  }

  if (unknown.length > 0) process.exit(2);
  if (mismatches.length > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => fail((err as Error).message));