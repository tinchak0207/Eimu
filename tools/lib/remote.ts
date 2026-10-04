import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Shared VPS read/exec plumbing for the ops tools in tools/.
 *
 * The control plane (Postgres `image-control-postgres`) and new-api (SQLite
 * `/opt/imagesite/new-api-data/one-api.db`) only exist on the Tencent VPS.
 * These helpers ship SQL over the SSH-over-443 tunnel as base64 so no quoting
 * or escaping ever survives into the remote shell.
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RemoteOptions {
  /** Run the pipeline on this host (i.e. you are already on the VPS) instead of tunnelling. */
  local: boolean;
  /** Repo root used to resolve the tunnel helper; defaults to process.cwd(). */
  repoRoot: string;
  /** Tunnel helper path relative to repoRoot. */
  helper: string;
}

export const DEFAULT_HELPER = ".dsh-ssh/exec-443.js";
const MAX_BUFFER = 64 * 1024 * 1024;

export function defaultRemoteOptions(cwd = process.cwd()): RemoteOptions {
  return { local: false, repoRoot: cwd, helper: DEFAULT_HELPER };
}

/** base64 keeps the SQL free of shell metacharacters end-to-end. */
export function b64(input: string): string {
  return Buffer.from(input, "utf8").toString("base64");
}

/**
 * Run `<echo b64 | base64 -d | sink>` where `sink` is the command that consumes
 * the SQL on stdin, e.g.
 *   sudo -n docker exec -i image-control-postgres psql -v ON_ERROR_STOP=1 \
 *     -U image_control -d image_control -f -
 *   sudo -n sqlite3 -readonly -header -column /opt/imagesite/new-api-data/one-api.db
 */
export function runWithSql(sink: string, sql: string, opts: RemoteOptions): ExecResult {
  const pipeline = `echo ${b64(sql)} | base64 -d | ${sink}`;
  if (opts.local) {
    const r = spawnSync("bash", ["-c", pipeline], { encoding: "utf8", maxBuffer: MAX_BUFFER });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  const helper = path.resolve(opts.repoRoot, opts.helper);
  const r = spawnSync("node", [helper, pipeline], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    cwd: opts.repoRoot,
  });
  if (r.error) {
    return { code: 1, stdout: "", stderr: `failed to launch tunnel helper ${helper}: ${r.error.message}` };
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export interface ParsedRows {
  code: number;
  rows: string[][];
  raw: string;
  stderr: string;
}

/**
 * Machine-readable variant: `-tA -F '|'` emits one row per line with `|`
 * separators and no header. Field values never contain `|` (names are
 * filenames, checksums are hex).
 */
export function parsePipeRows(result: ExecResult): ParsedRows {
  const lines = result.stdout
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  return {
    code: result.code,
    raw: result.stdout,
    stderr: result.stderr,
    rows: lines.map((l) => l.split("|")),
  };
}