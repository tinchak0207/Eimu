import assert from "node:assert/strict";
import test from "node:test";

import type { GenerationSql } from "./database.ts";
import {
  MASTER_ARTIFACT_DEFAULT_LIMIT,
  MASTER_ARTIFACT_MAX_LIMIT,
  MASTER_ARTIFACT_METADATA_KEY,
  buildMasterArtifactMetadata,
  countMasterArtifacts,
  listMasterArtifacts,
  mapMasterArtifactRow,
  readMasterArtifactMetadata,
} from "./master-artifact-index.ts";

type Call = { sql: string; values: unknown[] };

/**
 * 刀 4 成片產物索引契約針：形狀（metadata 命名空間）、容錯（非成片列一律丟棄）、
 * 邊界（分頁 clamp / 空值不落鍵 / 指紋不合法不偽造）與查詢口徑（role、jsonb 存在性、
 * tenant/session/project 過濾）逐條鎖住。mock 依查詢內容分流，範式同
 * provider-reconciliation.test.ts 的 mockSql。
 */
function mockSql(routes: Array<{ match: string; rows: Record<string, unknown>[] }> = []) {
  const calls: Call[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    calls.push({ sql: text, values });
    for (const route of routes) {
      if (text.includes(route.match)) return route.rows;
    }
    return [];
  }) as unknown as GenerationSql;
  return { sql: tagged, calls };
}

/** 一條完整的成片 artifact 列（JOIN generation_job 後的形狀）。 */
function filmRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "art-film-1",
    job_id: "job-film-1",
    delivery_url: "https://store.example.test/agent/v1/timeline/final-1.mp4",
    object_key: "timeline/session-a/master_landscape_169.mp4",
    mime_type: "video/mp4",
    sha256: "a".repeat(64),
    byte_size: 18_580_000,
    created_at: new Date("2026-09-15T10:00:00.000Z"),
    metadata_json: {
      [MASTER_ARTIFACT_METADATA_KEY]: {
        exportFingerprint: "b".repeat(64),
        fingerprintVersion: 1,
        preset: "landscape_169",
        resolution: { width: 1920, height: 1080 },
        durationSec: 18.58,
        timelineVersion: 7,
        sessionId: "session-a",
        projectId: "project-1",
        coverUrl: "https://store.example.test/agent/v1/timeline/final-1_cover.jpg",
        source: "timeline_master",
        probe: { codec: "h264", width: 1920, height: 1080, durationSec: 18.58, sizeBytes: 18_580_000, verified: true, error: null },
      },
    },
    tenant_id: "biz:key-1",
    job_kind: "video_generate",
    model_id: "minimax-h3",
    ...overrides,
  };
}

// ───────────────────────── 寫入端契約：metadata 形狀

test("buildMasterArtifactMetadata：包成命名空間鍵，不與既有 metadata 頂層（endpointLabel/voice_code）搶鍵空間", () => {
  const metadata = buildMasterArtifactMetadata({
    exportFingerprint: "c".repeat(64),
    preset: "portrait_916",
    fingerprintVersion: 1,
    resolution: { width: 1080, height: 1920 },
    durationSec: 60.25,
    timelineVersion: 3,
    sessionId: "sess-x",
    projectId: "proj-y",
    coverUrl: "https://cdn/cover.jpg",
    source: "timeline_master",
  });
  assert.deepEqual(Object.keys(metadata), [MASTER_ARTIFACT_METADATA_KEY]);
  const film = metadata[MASTER_ARTIFACT_METADATA_KEY] as Record<string, unknown>;
  assert.equal(film.exportFingerprint, "c".repeat(64));
  assert.equal(film.preset, "portrait_916");
  assert.deepEqual(film.resolution, { width: 1080, height: 1920 });
  assert.equal(film.durationSec, 60.25);
  assert.equal(film.timelineVersion, 3);
  assert.equal(film.sessionId, "sess-x");
  assert.equal(film.projectId, "proj-y");
  // endpointLabel 不在此物件內（由 artifact-service 另併），成片鍵不吞它。
  assert.equal("endpointLabel" in metadata, false);
});

test("buildMasterArtifactMetadata：空值欄位不落鍵（不寫 null），缺欄與「本來沒有」不可混淆", () => {
  const metadata = buildMasterArtifactMetadata({
    exportFingerprint: "d".repeat(64),
    preset: "cinema_239",
    sessionId: "   ",
    projectId: null,
    coverUrl: undefined,
    durationSec: Number.NaN,
  });
  const film = metadata[MASTER_ARTIFACT_METADATA_KEY] as Record<string, unknown>;
  assert.deepEqual(Object.keys(film).sort(), ["exportFingerprint", "preset"]);
});

test("buildMasterArtifactMetadata：probe 摘要用導出側欄位名（duration_sec/size/probe_error）直譯，verified 由 error 推斷", () => {
  const ok = buildMasterArtifactMetadata({
    exportFingerprint: "e".repeat(64),
    preset: "landscape_169",
    probe: { codec: "h264", width: 1920, height: 1080, duration_sec: 18.58, size: 18_580_000, probe_error: null },
  });
  const okProbe = (ok[MASTER_ARTIFACT_METADATA_KEY] as Record<string, unknown>).probe as Record<string, unknown>;
  assert.equal(okProbe.verified, true);
  assert.equal(okProbe.error, null);
  assert.equal(okProbe.durationSec, 18.58);
  assert.equal(okProbe.sizeBytes, 18_580_000);

  const bad = buildMasterArtifactMetadata({
    exportFingerprint: "f".repeat(64),
    preset: "landscape_169",
    probe: { codec: "h264", width: 1920, height: 1080, duration_sec: 3.2, size: 900, probe_error: "duration 3.200s outside 18.580±0.800s" },
  });
  const badProbe = (bad[MASTER_ARTIFACT_METADATA_KEY] as Record<string, unknown>).probe as Record<string, unknown>;
  assert.equal(badProbe.verified, false);
  assert.match(String(badProbe.error), /outside/);
});

test("buildMasterArtifactMetadata：缺 exportFingerprint 或 preset 直接拋（不落半形索引行）", () => {
  assert.throws(() => buildMasterArtifactMetadata({ exportFingerprint: "", preset: "landscape_169" }), TypeError);
  assert.throws(() => buildMasterArtifactMetadata({ exportFingerprint: "a".repeat(64), preset: "  " }), TypeError);
});

// ───────────────────────── 讀取端契約：容錯解析

test("readMasterArtifactMetadata：合法記錄往返一致（指紋正規化為小寫）", () => {
  const parsed = readMasterArtifactMetadata({
    [MASTER_ARTIFACT_METADATA_KEY]: {
      exportFingerprint: "ABCDEF".repeat(8),
      preset: "landscape_169",
      resolution: { width: 1920, height: 1080 },
      durationSec: 18.58,
      timelineVersion: 7,
      sessionId: "session-a",
      probe: { codec: "h264", width: 1920, height: 1080, durationSec: 18.58, sizeBytes: 100, verified: true, error: null },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.exportFingerprint, "abcdef".repeat(8));
  assert.equal(parsed.preset, "landscape_169");
  assert.deepEqual(parsed.resolution, { width: 1920, height: 1080 });
  assert.equal(parsed.probe?.verified, true);
});

test("readMasterArtifactMetadata：非成片記錄（缺鍵／缺指紋／缺 preset／型別不對）一律回 null", () => {
  assert.equal(readMasterArtifactMetadata(null), null);
  assert.equal(readMasterArtifactMetadata("not-json"), null);
  assert.equal(readMasterArtifactMetadata([]), null);
  // 一般 TTS/圖片產物：只有 endpointLabel/voice_code → 不是成片
  assert.equal(readMasterArtifactMetadata({ endpointLabel: "newapi", voice_code: "zh-CN-X" }), null);
  // 有鍵但缺必要欄位
  assert.equal(readMasterArtifactMetadata({ [MASTER_ARTIFACT_METADATA_KEY]: { preset: "landscape_169" } }), null);
  assert.equal(readMasterArtifactMetadata({ [MASTER_ARTIFACT_METADATA_KEY]: { exportFingerprint: "a".repeat(64) } }), null);
  assert.equal(readMasterArtifactMetadata({ [MASTER_ARTIFACT_METADATA_KEY]: "string" }), null);
});

test("mapMasterArtifactRow：成片列 → 索引列；非成片列回 null（drop 不整份作廢）", () => {
  const mapped = mapMasterArtifactRow(filmRow());
  assert.ok(mapped);
  assert.equal(mapped.artifactId, "art-film-1");
  assert.equal(mapped.jobId, "job-film-1");
  assert.equal(mapped.tenantId, "biz:key-1");
  assert.equal(mapped.exportFingerprint, "b".repeat(64));
  assert.equal(mapped.preset, "landscape_169");
  assert.deepEqual(mapped.resolution, { width: 1920, height: 1080 });
  assert.equal(mapped.durationSec, 18.58);
  assert.equal(mapped.timelineVersion, 7);
  assert.equal(mapped.sessionId, "session-a");
  assert.equal(mapped.jobKind, "video_generate");
  assert.equal(mapped.modelId, "minimax-h3");
  assert.equal(mapped.probe?.verified, true);
  assert.equal(mapped.createdAt.toISOString(), "2026-09-15T10:00:00.000Z");

  // 一般產物（TTS 音頻）在同一查詢結果裡 → 丟棄該列，不影響其餘列
  const tts = mapMasterArtifactRow({ ...filmRow({ id: "art-tts" }), metadata_json: { endpointLabel: "tts", voice_code: "zh-CN-X" } });
  assert.equal(tts, null);
});

test("mapMasterArtifactRow：metadata_json 為字串（驅動回吐 jsonb 為 text）仍能解析", () => {
  const row = filmRow();
  const stringified = { ...row, metadata_json: JSON.stringify(row.metadata_json) };
  const mapped = mapMasterArtifactRow(stringified);
  assert.ok(mapped);
  assert.equal(mapped.preset, "landscape_169");
});

test("mapMasterArtifactRow：probe 未過（有 error）仍留紀錄，verified=false——不把未過 probe 的成片冒充合格", () => {
  const row = filmRow();
  (row.metadata_json as Record<string, Record<string, unknown>>)[MASTER_ARTIFACT_METADATA_KEY].probe = {
    codec: "h264",
    width: 1920,
    height: 1080,
    durationSec: 3.2,
    sizeBytes: 900,
    verified: false,
    error: "container mismatch",
  };
  const mapped = mapMasterArtifactRow(row);
  assert.ok(mapped);
  assert.equal(mapped.probe?.verified, false);
  assert.equal(mapped.probe?.error, "container mismatch");
});

// ───────────────────────── 查詢層：口徑與邊界

test("listMasterArtifacts：只認 role='output' + metadata 帶成片鍵（jsonb_exists），tenant 過濾走 generation_job", async () => {
  const { sql, calls } = mockSql([{ match: "FROM artifact", rows: [filmRow()] }]);
  const records = await listMasterArtifacts({ tenantId: "biz:key-1" }, sql);
  assert.equal(records.length, 1);
  const call = calls[0];
  assert.ok(call.sql.includes("FROM artifact"));
  assert.ok(call.sql.includes("JOIN generation_job ON generation_job.id = artifact.job_id"));
  assert.ok(call.sql.includes("jsonb_exists(artifact.metadata_json"), "成片存在性判準必須是 jsonb 鍵存在");
  assert.ok(call.sql.includes("ORDER BY artifact.created_at DESC"));
  // 佔位符按模板出現順序落參：role / metadata 鍵 / tenant / 分頁。逐個查證而非鎖死陣列長度
  // （同一鍵在 WHERE 中重複出現會多佔位，屬實作細節）。
  assert.equal(call.values[0], "output");
  assert.ok(call.values.includes(MASTER_ARTIFACT_METADATA_KEY));
  assert.ok(call.values.includes("biz:key-1"));
  assert.deepEqual(call.values.slice(-2), [MASTER_ARTIFACT_DEFAULT_LIMIT, 0]);
});

test("listMasterArtifacts：session_id / project_id 走產物自身 metadata，不是 job.workflow_json", async () => {
  const { sql, calls } = mockSql([{ match: "FROM artifact", rows: [] }]);
  await listMasterArtifacts({ tenantId: "biz:key-1", sessionId: "session-a", projectId: "project-1" }, sql);
  const call = calls[0];
  assert.ok(call.sql.includes("->> 'sessionId' = "));
  assert.ok(call.sql.includes("->> 'projectId' = "));
  assert.equal(call.sql.includes("workflow_json"), false, "不得靠 workflow_json 過濾（該欄對成片無契約保證）");
  assert.equal(call.values[0], "output");
  assert.ok(call.values.includes(MASTER_ARTIFACT_METADATA_KEY));
  assert.ok(call.values.includes("biz:key-1"));
  assert.ok(call.values.includes("session-a"));
  assert.ok(call.values.includes("project-1"));
});

test("listMasterArtifacts：分頁 clamp——超上限截到 100、非法值回預設、offset 不得為負", async () => {
  const { sql, calls } = mockSql([{ match: "FROM artifact", rows: [] }]);
  await listMasterArtifacts({ limit: 9999, offset: -5 }, sql);
  assert.deepEqual(calls[0].values.slice(-2), [MASTER_ARTIFACT_MAX_LIMIT, 0]);

  const second = mockSql([{ match: "FROM artifact", rows: [] }]);
  await listMasterArtifacts({ limit: Number.NaN, offset: Number.NaN }, second.sql);
  assert.deepEqual(second.calls[0].values.slice(-2), [MASTER_ARTIFACT_DEFAULT_LIMIT, 0]);
});

test("listMasterArtifacts：查詢命中但 metadata 形狀不合法的列被丟棄（回傳數可少於列數）", async () => {
  const rows = [filmRow(), { ...filmRow({ id: "art-img" }), metadata_json: { endpointLabel: "newapi" } }];
  const { sql } = mockSql([{ match: "FROM artifact", rows }]);
  const records = await listMasterArtifacts({}, sql);
  assert.deepEqual(records.map((r) => r.artifactId), ["art-film-1"]);
});

test("countMasterArtifacts：與 listMasterArtifacts 同一套 WHERE 口徑", async () => {
  const { sql, calls } = mockSql([{ match: "count(*) AS count", rows: [{ count: "3" }] }]);
  const count = await countMasterArtifacts({ tenantId: "biz:key-1", sessionId: "session-a" }, sql);
  assert.equal(count, 3);
  const call = calls[0];
  assert.ok(call.sql.includes("count(*) AS count"));
  assert.ok(call.sql.includes("jsonb_exists(artifact.metadata_json"));
  assert.ok(call.sql.includes("->> 'sessionId' = "));
  assert.equal(call.values[0], "output");
  assert.ok(call.values.includes(MASTER_ARTIFACT_METADATA_KEY));
  assert.ok(call.values.includes("biz:key-1"));
  assert.ok(call.values.includes("session-a"));
});

test("countMasterArtifacts：驅動回傳髒值（null/非數）視為 0，不偽造數字", async () => {
  const { sql } = mockSql([{ match: "count(*) AS count", rows: [{ count: null }] }]);
  assert.equal(await countMasterArtifacts({}, sql), 0);
});
