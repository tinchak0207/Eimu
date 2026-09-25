// G4 生產端測試（2026-09-17）：真 PGlite + 全套真 migration（含 018）+ 真服務函式。
//
// 覆蓋三件事：
//   1. migration 018 的 SQL 本身（kind/source 詞表擴展在真 Postgres 上可執行、舊值仍合法）
//   2. ingestMasterExport 的正向鏈：job(kind='film_export', status='succeeded') +
//      artifact(role='output', metadata_json.masterExport) 落庫，欄位實值（sha256/byte_size）
//   3. 誠實語義：欄位缺失逐欄回報（不補假值）；冪等重放 job 不重複、artifact 不重複插；
//      probe 缺失時尺寸落 NULL 而非 0 冒充
//
// PGlite（WASM Postgres，migration 與生產 image-control-postgres 同源）**不是 repo 依賴**：
// 裝了它（或 NODE_PATH 指向有它的 node_modules）就跑全量；沒有時 SQL 整合段逐測 skip，
// validate 純函式段照跑——skip 是誠實聲明「這段需要 PG」，不是通過。
//   NODE_PATH=<含 @electric-sql/pglite 的 node_modules> npx --yes tsx --test <本檔>

import test, { before } from "node:test";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ingestMasterExport, validateMasterIngestPayload } from "./master-ingest-service";

// tsx 的 CJS 變換下 import.meta.dirname 不存在；照 aid-enums.test 的 import.meta.url 慣例。
const REPO = new URL("../../..", import.meta.url).pathname;

// 動態解析：包不存在時走 catch（靜態 import 會讓整檔炸掉）。走 createRequire（CJS 解析，
// 認 NODE_PATH——tsx 的 ESM import() 不認 NODE_PATH，實測會把「有 NODE_PATH」誤判成缺席）。
// 型別斷言是刻意的——PGlite 不是 repo 依賴，TS 端不解析它。
const PGLITE_PKG = "@electric-sql/pglite";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pg: { exec: (sql: string) => Promise<unknown>; query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> } | null = null;

// 服務經 encryptGenerationPrompt 讀 process.env（不像 crypto.test 顯式傳 env），
// before 設、after 清，不讓測試密鑰漏進同進程的其他測試檔。
const TEST_PROMPT_KEY = Buffer.alloc(32, 7).toString("base64");

before(async () => {
  process.env.GENERATION_PROMPT_ENCRYPTION_KEY = TEST_PROMPT_KEY;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(PGLITE_PKG) as { PGlite: new () => { exec: (s: string) => Promise<unknown>; query: (s: string, v?: unknown[]) => Promise<{ rows: never[] }> } };
    pg = new mod.PGlite();
  } catch {
    return; // PGlite 未安裝 → SQL 段逐測 skip
  }
  for (const f of readdirSync(path.join(REPO, "db/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    const sqlText = readFileSync(path.join(REPO, "db/migrations", f), "utf8");
    try {
      await pg.exec(sqlText);
    } catch (e) {
      // IF NOT EXISTS 類重跑噪音可略；018 若炸會在斷言處現形
      if (!String((e as Error).message).includes("already exists")) throw e;
    }
  }
  // 詞表擴展的實證 fixture：018 後 film_export + agent source 必須能直接落 job
  await pg.query(
    `INSERT INTO generation_job (id, tenant_id, source, request_hash, kind, model_id, prompt_ciphertext, deadline_at, status)
     VALUES ('g4-mig-job', 'web:22', 'agent', 'h0', 'film_export', 'timeline_master', 'ct', now(), 'succeeded')`,
  );
});

/** SQL 整合段的守衛：PGlite 缺席時 skip（誠實聲明，非靜默通過）。 */
function skipWithoutPg(t: { skip: (m?: string) => void }): boolean {
  if (!pg) {
    t.skip("PGlite 未安裝（SQL 整合段需要它；跑法見檔頭）");
    return true;
  }
  return false;
}

// postgres.js 形狀 shim（tagged template → $n → PGlite）；begin 直呼同一 tag（本服務的事務用法）。
function makeSql() {
  const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
    const res = await pg.query(text, values as never[]);
    return res.rows;
  };
  (tagged as unknown as { begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin = async (fn) => fn(tagged);
  // postgres.js 的 json() 助手：序列化成 JSON 字串，綁進 jsonb 欄由 PG 自動收斂（shim 同語義）
  (tagged as unknown as { json: (v: unknown) => string }).json = (v: unknown) => JSON.stringify(v ?? null);
  return tagged as never;
}

const sql = makeSql();

/** 真實流量必經 validate（snake→駝映射在這裡），測試同樣不得繞過。 */
function payloadOf(input: unknown) {
  const v = validateMasterIngestPayload(input);
  assert.ok(v.ok, "fixture 應通過 validate");
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

test("migration 018：film_export + agent source 可落 job（詞表擴展在真 PG 生效）", async (t) => {
  if (skipWithoutPg(t)) return;
  const row = await pg.query(
    `SELECT kind, source FROM generation_job WHERE id = 'g4-mig-job'`,
  );
  assert.equal(row.rows.length, 1, "before() 階段插入的 film_export job 應已存在");
  const j = row.rows[0] as { kind: string; source: string };
  assert.equal(j.kind, "film_export");
  assert.equal(j.source, "agent");
});

test("validate：全欄合法通過；逐欄缺失/非法回報欄位名（不補假值）", () => {
  const ok = validateMasterIngestPayload(VALID);
  assert.ok(ok.ok);
  const bad = validateMasterIngestPayload({
    ...VALID,
    session_id: "",
    tenant_id: "biz:xyz", // 刻意不收（寫得進、讀不到的 namespace 是地雷）
    fingerprint: "短",
    sha256: undefined,
    mime_type: "video/webm",
    byte_size: 0,
    delivery_url: "http://insecure.example/x.mp4",
    probe: { width: "寬不是數字" },
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    for (const f of ["session_id", "tenant_id", "fingerprint", "sha256", "mime_type", "byte_size", "delivery_url", "probe"]) {
      assert.ok(bad.fields.includes(f), `缺欄位回報：${f}`);
    }
  }
});

test("正向鏈：job + artifact 落庫，metadata.masterExport 實值（probe/指紋/來源）", async (t) => {
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

test("冪等重放：同會話同指紋 → job 不重複、artifact 不重複插", async (t) => {
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

test("probe 缺失：width/height 落 NULL（禁 0 冒充實測值），durationSec 落 NULL", async (t) => {
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
  // 刀 4 寫入端口徑：缺值 = 鍵省略（buildMasterArtifactMetadata 只在實測值存在時寫鍵），
  // 不是顯式 null——讀取端 readMasterArtifactMetadata 同樣按「鍵在不在」判讀。
  assert.equal(a.metadata_json.masterExport.resolution, undefined);
  assert.equal(a.metadata_json.masterExport.durationSec, undefined);
});

test("probe_error：如實進 metadata（normalizeProbe 口徑：verified:false + error 原文）", async (t) => {
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
