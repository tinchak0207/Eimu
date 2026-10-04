// G4 生产端测试（2026-09-17）：真 PGlite + 全套真 migration（含 018）+ 真服务函式。
//
// 覆盖三件事：
//   1. migration 018 的 SQL 本身（kind/source 词表扩展在真 Postgres 上可执行、旧值仍合法）
//   2. ingestMasterExport 的正向链：job(kind='film_export', status='succeeded') +
//      artifact(role='output', metadata_json.masterExport) 落库，栏位实值（sha256/byte_size）
//   3. 诚实语义：栏位缺失逐栏回报（不补假值）；幂等重放 job 不重复、artifact 不重复插；
//      probe 缺失时尺寸落 NULL 而非 0 冒充
//
// PGlite（WASM Postgres，migration 与生产 image-control-postgres 同源）**不是 repo 依赖**：
// 装了它（或 NODE_PATH 指向有它的 node_modules）就跑全量；没有时 SQL 整合段逐测 skip，
// validate 纯函式段照跑——skip 是诚实声明「这段需要 PG」，不是通过。
//   NODE_PATH=<含 @electric-sql/pglite 的 node_modules> npx --yes tsx --test <本档>

import test, { before } from "node:test";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ingestMasterExport, validateMasterIngestPayload } from "./master-ingest-service";

// tsx 的 CJS 变换下 import.meta.dirname 不存在；照 aid-enums.test 的 import.meta.url 惯例。
const REPO = new URL("../../..", import.meta.url).pathname;

// 动态解析：包不存在时走 catch（静态 import 会让整档炸掉）。走 createRequire（CJS 解析，
// 认 NODE_PATH——tsx 的 ESM import() 不认 NODE_PATH，实测会把「有 NODE_PATH」误判成缺席）。
// 型别断言是刻意的——PGlite 不是 repo 依赖，TS 端不解析它。
const PGLITE_PKG = "@electric-sql/pglite";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pg: { exec: (sql: string) => Promise<unknown>; query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> } | null = null;

// 服务经 encryptGenerationPrompt 读 process.env（不像 crypto.test 显式传 env），
// before 设、after 清，不让测试密钥漏进同进程的其他测试档。
const TEST_PROMPT_KEY = Buffer.alloc(32, 7).toString("base64");

before(async () => {
  process.env.GENERATION_PROMPT_ENCRYPTION_KEY = TEST_PROMPT_KEY;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(PGLITE_PKG) as { PGlite: new () => { exec: (s: string) => Promise<unknown>; query: (s: string, v?: unknown[]) => Promise<{ rows: never[] }> } };
    pg = new mod.PGlite();
  } catch {
    return; // PGlite 未安装 → SQL 段逐测 skip
  }
  for (const f of readdirSync(path.join(REPO, "db/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    const sqlText = readFileSync(path.join(REPO, "db/migrations", f), "utf8");
    try {
      await pg.exec(sqlText);
    } catch (e) {
      // IF NOT EXISTS 类重跑噪音可略；018 若炸会在断言处现形
      if (!String((e as Error).message).includes("already exists")) throw e;
    }
  }
  // 词表扩展的实证 fixture：018 后 film_export + agent source 必须能直接落 job
  await pg.query(
    `INSERT INTO generation_job (id, tenant_id, source, request_hash, kind, model_id, prompt_ciphertext, deadline_at, status)
     VALUES ('g4-mig-job', 'web:22', 'agent', 'h0', 'film_export', 'timeline_master', 'ct', now(), 'succeeded')`,
  );
});

/** SQL 整合段的守卫：PGlite 缺席时 skip（诚实声明，非静默通过）。 */
function skipWithoutPg(t: { skip: (m?: string) => void }): boolean {
  if (!pg) {
    t.skip("PGlite 未安装（SQL 整合段需要它；跑法见档头）");
    return true;
  }
  return false;
}

// postgres.js 形状 shim（tagged template → $n → PGlite）；begin 直呼同一 tag（本服务的事务用法）。
function makeSql() {
  const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
    const res = await pg.query(text, values as never[]);
    return res.rows;
  };
  (tagged as unknown as { begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin = async (fn) => fn(tagged);
  // postgres.js 的 json() 助手：序列化成 JSON 字串，绑进 jsonb 栏由 PG 自动收敛（shim 同语义）
  (tagged as unknown as { json: (v: unknown) => string }).json = (v: unknown) => JSON.stringify(v ?? null);
  return tagged as never;
}

const sql = makeSql();

/** 真实流量必经 validate（snake→驼映射在这里），测试同样不得绕过。 */
function payloadOf(input: unknown) {
  const v = validateMasterIngestPayload(input);
  assert.ok(v.ok, "fixture 应通过 validate");
  return v.ok ? v.value : (v as never);
}

const VALID = {
  session_id: "sess-g4-test",
  tenant_id: "web:22",
  preset: "landscape_169",
  fingerprint: "a".repeat(64),
  fingerprint_version: 1,
  timeline_version: 3,
  aspect: "16:9",
  delivery_url: "https://store.tinchak0207.xyz/agent/v1/masters/sess-g4-test/master_landscape_169.mp4",
  cover_url: "https://store.tinchak0207.xyz/agent/v1/masters/sess-g4-test/master_landscape_169_cover.jpg",
  sha256: "b".repeat(64),
  mime_type: "video/mp4",
  byte_size: 1_048_576,
  project_id: null,
  probe: { codec: "h264", width: 1920, height: 1080, duration_sec: 12.345, size: 1_048_576, probe_error: null },
};

test("migration 018：film_export + agent source 可落 job（词表扩展在真 PG 生效）", async (t) => {
  if (skipWithoutPg(t)) return;
  const row = await pg.query(
    `SELECT kind, source FROM generation_job WHERE id = 'g4-mig-job'`,
  );
  assert.equal(row.rows.length, 1, "before() 阶段插入的 film_export job 应已存在");
  const j = row.rows[0] as { kind: string; source: string };
  assert.equal(j.kind, "film_export");
  assert.equal(j.source, "agent");
});

test("validate：全栏合法通过；逐栏缺失/非法回报栏位名（不补假值）", () => {
  const ok = validateMasterIngestPayload(VALID);
  assert.ok(ok.ok);
  const bad = validateMasterIngestPayload({
    ...VALID,
    session_id: "",
    tenant_id: "biz:xyz", // 刻意不收（写得进、读不到的 namespace 是地雷）
    fingerprint: "短",
    sha256: undefined,
    mime_type: "video/webm",
    byte_size: 0,
    delivery_url: "http://insecure.example/x.mp4",
    probe: { width: "宽不是数字" },
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    for (const f of ["session_id", "tenant_id", "fingerprint", "sha256", "mime_type", "byte_size", "delivery_url", "probe"]) {
      assert.ok(bad.fields.includes(f), `缺栏位回报：${f}`);
    }
  }
});

test("正向链：job + artifact 落库，metadata.masterExport 实值（probe/指纹/来源）", async (t) => {
  if (skipWithoutPg(t)) return;
  const r = await ingestMasterExport(payloadOf(VALID), sql);
  assert.equal(r.jobDeduped, false);
  assert.equal(r.artifactInserted, true);

  const job = await pg.query(
    `SELECT kind, source, status, model_id, ratio, tenant_id, billing_amount, completed_count
     FROM generation_job WHERE id = $1`,
    [r.jobId],
  );
  const j = job.rows[0] as Record<string, unknown>;
  assert.equal(j.kind, "film_export");
  assert.equal(j.source, "agent");
  assert.equal(j.status, "succeeded");
  assert.equal(j.model_id, "timeline_master");
  assert.equal(j.ratio, "16:9");
  assert.equal(j.tenant_id, "web:22");
  assert.equal(j.billing_amount, 0);
  assert.equal(j.completed_count, 1);

  const art = await pg.query(
    `SELECT a.sha256, a.byte_size, a.mime_type, a.delivery_url, a.width, a.height, a.metadata_json
     FROM artifact a WHERE a.id = $1`,
    [r.artifactId],
  );
  const a = (art.rows[0] as Record<string, unknown>) ?? {};
  assert.equal(a.sha256, VALID.sha256);
  assert.equal(a.byte_size, VALID.byte_size);
  assert.equal(a.mime_type, "video/mp4");
  assert.equal(a.delivery_url, VALID.delivery_url);
  assert.equal(a.width, 1920);
  assert.equal(a.height, 1080);
  const meta = (
    a.metadata_json as {
      masterExport?: {
        exportFingerprint?: string;
        preset?: string;
        sessionId?: string;
        source?: string;
        probe?: { durationSec?: number; verified?: boolean } | null;
      };
    }
  ).masterExport;
  assert.equal(meta?.exportFingerprint, VALID.fingerprint);
  assert.equal(meta?.preset, "landscape_169");
  assert.equal(meta?.sessionId, "sess-g4-test");
  assert.equal(meta?.source, "timeline_master");
  assert.equal(meta?.probe?.durationSec, 12.345);
  assert.equal(meta?.probe?.verified, true);
});

test("幂等重放：同会话同指纹 → job 不重复、artifact 不重复插", async (t) => {
  if (skipWithoutPg(t)) return;
  const r1 = await ingestMasterExport(payloadOf(VALID), sql);
  assert.equal(r1.jobDeduped, true);
  assert.equal(r1.artifactInserted, false);
  const counts = await pg.query(
    `SELECT (SELECT count(*) FROM generation_job WHERE idempotency_key = $1) AS jobs,
            (SELECT count(*) FROM artifact WHERE job_id = $2 AND role = 'output') AS arts`,
    [`film_export:${VALID.session_id}:${VALID.fingerprint}`, r1.jobId],
  );
  const c = counts.rows[0] as { jobs: string; arts: string };
  assert.equal(Number(c.jobs), 1);
  assert.equal(Number(c.arts), 1);
});

test("probe 缺失：width/height 落 NULL（禁 0 冒充实测值），durationSec 落 NULL", async (t) => {
  if (skipWithoutPg(t)) return;
  const r = await ingestMasterExport(payloadOf({ ...VALID, session_id: "sess-g4-noprobe", probe: null }), sql);
  const art = await pg.query(`SELECT width, height, metadata_json FROM artifact WHERE id = $1`, [r.artifactId]);
  const a = art.rows[0] as {
    width: unknown;
    height: unknown;
    metadata_json: { masterExport: { resolution: unknown; durationSec: unknown } };
  };
  assert.equal(a.width, null);
  assert.equal(a.height, null);
  // 刀 4 写入端口径：缺值 = 键省略（buildMasterArtifactMetadata 只在实测值存在时写键），
  // 不是显式 null——读取端 readMasterArtifactMetadata 同样按「键在不在」判读。
  assert.equal(a.metadata_json.masterExport.resolution, undefined);
  assert.equal(a.metadata_json.masterExport.durationSec, undefined);
});

test("probe_error：如实进 metadata（normalizeProbe 口径：verified:false + error 原文）", async (t) => {
  if (skipWithoutPg(t)) return;
  const r = await ingestMasterExport(
    payloadOf({ ...VALID, session_id: "sess-g4-probeerr", probe: { ...VALID.probe, probe_error: "ffprobe timed out" } }),
    sql,
  );
  const art = await pg.query(`SELECT metadata_json FROM artifact WHERE id = $1`, [r.artifactId]);
  const probe = (art.rows[0] as { metadata_json: { masterExport: { probe: { verified: boolean; error: string | null } | null } } }).metadata_json.masterExport.probe;
  assert.equal(probe?.verified, false);
  assert.equal(probe?.error, "ffprobe timed out");
});
