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
 * 刀 4 成片产物索引契约针：形状（metadata 命名空间）、容错（非成片列一律丢弃）、
 * 边界（分页 clamp / 空值不落键 / 指纹不合法不伪造）与查询口径（role、jsonb 存在性、
 * tenant/session/project 过滤）逐条锁住。mock 依查询内容分流，范式同
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

/** 一条完整的成片 artifact 列（JOIN generation_job 后的形状）。 */
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

// ───────────────────────── 写入端契约：metadata 形状

test("buildMasterArtifactMetadata：包成命名空间键，不与既有 metadata 顶层（endpointLabel/voice_code）抢键空间", () => {
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
  // endpointLabel 不在此物件内（由 artifact-service 另并），成片键不吞它。
  assert.equal("endpointLabel" in metadata, false);
});

test("buildMasterArtifactMetadata：空值栏位不落键（不写 null），缺栏与「本来没有」不可混淆", () => {
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

test("buildMasterArtifactMetadata：probe 摘要用导出侧栏位名（duration_sec/size/probe_error）直译，verified 由 error 推断", () => {
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

test("buildMasterArtifactMetadata：缺 exportFingerprint 或 preset 直接抛（不落半形索引行）", () => {
  assert.throws(() => buildMasterArtifactMetadata({ exportFingerprint: "", preset: "landscape_169" }), TypeError);
  assert.throws(() => buildMasterArtifactMetadata({ exportFingerprint: "a".repeat(64), preset: "  " }), TypeError);
});

// ───────────────────────── 读取端契约：容错解析

test("readMasterArtifactMetadata：合法记录往返一致（指纹正规化为小写）", () => {
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

test("readMasterArtifactMetadata：非成片记录（缺键／缺指纹／缺 preset／型别不对）一律回 null", () => {
  assert.equal(readMasterArtifactMetadata(null), null);
  assert.equal(readMasterArtifactMetadata("not-json"), null);
  assert.equal(readMasterArtifactMetadata([]), null);
  // 一般 TTS/图片产物：只有 endpointLabel/voice_code → 不是成片
  assert.equal(readMasterArtifactMetadata({ endpointLabel: "newapi", voice_code: "zh-CN-X" }), null);
  // 有键但缺必要栏位
  assert.equal(readMasterArtifactMetadata({ [MASTER_ARTIFACT_METADATA_KEY]: { preset: "landscape_169" } }), null);
  assert.equal(readMasterArtifactMetadata({ [MASTER_ARTIFACT_METADATA_KEY]: { exportFingerprint: "a".repeat(64) } }), null);
  assert.equal(readMasterArtifactMetadata({ [MASTER_ARTIFACT_METADATA_KEY]: "string" }), null);
});

test("mapMasterArtifactRow：成片列 → 索引列；非成片列回 null（drop 不整份作废）", () => {
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

  // 一般产物（TTS 音频）在同一查询结果里 → 丢弃该列，不影响其余列
  const tts = mapMasterArtifactRow({ ...filmRow({ id: "art-tts" }), metadata_json: { endpointLabel: "tts", voice_code: "zh-CN-X" } });
  assert.equal(tts, null);
});

test("mapMasterArtifactRow：metadata_json 为字串（驱动回吐 jsonb 为 text）仍能解析", () => {
  const row = filmRow();
  const stringified = { ...row, metadata_json: JSON.stringify(row.metadata_json) };
  const mapped = mapMasterArtifactRow(stringified);
  assert.ok(mapped);
  assert.equal(mapped.preset, "landscape_169");
});

test("mapMasterArtifactRow：probe 未过（有 error）仍留纪录，verified=false——不把未过 probe 的成片冒充合格", () => {
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

// ───────────────────────── 查询层：口径与边界

test("listMasterArtifacts：只认 role='output' + metadata 带成片键（jsonb_exists），tenant 过滤走 generation_job", async () => {
  const { sql, calls } = mockSql([{ match: "FROM artifact", rows: [filmRow()] }]);
  const records = await listMasterArtifacts({ tenantId: "biz:key-1" }, sql);
  assert.equal(records.length, 1);
  const call = calls[0];
  assert.ok(call.sql.includes("FROM artifact"));
  assert.ok(call.sql.includes("JOIN generation_job ON generation_job.id = artifact.job_id"));
  assert.ok(call.sql.includes("jsonb_exists(artifact.metadata_json"), "成片存在性判准必须是 jsonb 键存在");
  assert.ok(call.sql.includes("ORDER BY artifact.created_at DESC"));
  // 占位符按模板出现顺序落参：role / metadata 键 / tenant / 分页。逐个查证而非锁死阵列长度
  // （同一键在 WHERE 中重复出现会多占位，属实作细节）。
  assert.equal(call.values[0], "output");
  assert.ok(call.values.includes(MASTER_ARTIFACT_METADATA_KEY));
  assert.ok(call.values.includes("biz:key-1"));
  assert.deepEqual(call.values.slice(-2), [MASTER_ARTIFACT_DEFAULT_LIMIT, 0]);
});

test("listMasterArtifacts：session_id / project_id 走产物自身 metadata，不是 job.workflow_json", async () => {
  const { sql, calls } = mockSql([{ match: "FROM artifact", rows: [] }]);
  await listMasterArtifacts({ tenantId: "biz:key-1", sessionId: "session-a", projectId: "project-1" }, sql);
  const call = calls[0];
  assert.ok(call.sql.includes("->> 'sessionId' = "));
  assert.ok(call.sql.includes("->> 'projectId' = "));
  assert.equal(call.sql.includes("workflow_json"), false, "不得靠 workflow_json 过滤（该栏对成片无契约保证）");
  assert.equal(call.values[0], "output");
  assert.ok(call.values.includes(MASTER_ARTIFACT_METADATA_KEY));
  assert.ok(call.values.includes("biz:key-1"));
  assert.ok(call.values.includes("session-a"));
  assert.ok(call.values.includes("project-1"));
});

test("listMasterArtifacts：分页 clamp——超上限截到 100、非法值回预设、offset 不得为负", async () => {
  const { sql, calls } = mockSql([{ match: "FROM artifact", rows: [] }]);
  await listMasterArtifacts({ limit: 9999, offset: -5 }, sql);
  assert.deepEqual(calls[0].values.slice(-2), [MASTER_ARTIFACT_MAX_LIMIT, 0]);

  const second = mockSql([{ match: "FROM artifact", rows: [] }]);
  await listMasterArtifacts({ limit: Number.NaN, offset: Number.NaN }, second.sql);
  assert.deepEqual(second.calls[0].values.slice(-2), [MASTER_ARTIFACT_DEFAULT_LIMIT, 0]);
});

test("listMasterArtifacts：查询命中但 metadata 形状不合法的列被丢弃（回传数可少于列数）", async () => {
  const rows = [filmRow(), { ...filmRow({ id: "art-img" }), metadata_json: { endpointLabel: "newapi" } }];
  const { sql } = mockSql([{ match: "FROM artifact", rows }]);
  const records = await listMasterArtifacts({}, sql);
  assert.deepEqual(records.map((r) => r.artifactId), ["art-film-1"]);
});

test("countMasterArtifacts：与 listMasterArtifacts 同一套 WHERE 口径", async () => {
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

test("countMasterArtifacts：驱动回传脏值（null/非数）视为 0，不伪造数字", async () => {
  const { sql } = mockSql([{ match: "count(*) AS count", rows: [{ count: null }] }]);
  assert.equal(await countMasterArtifacts({}, sql), 0);
});
