// 成片（母带）产物索引 —— 刀 4（2026-09-15，能力建设）。
//
// 目标（可测量终态）：成片成为可列举、可回溯的一等产物——「这个项目/会话产过哪些成片」
// 一次查得出，每条带导出指纹、时长、解析度、来源。
//
// ── 形状选择与理由（任务书要求回报） ───────────────────────────────────────────
// **挂既有 `artifact` 表（`role='output'`）＋ `metadata_json` 命名空间键
// `masterExport`；不建表、不建 migration、不加 role 值。**
//
// 1. 为何 role='output' 而非新 role：`artifact.role` CHECK 只有 `('reference','output')`
//    （001:220）。成片在语义上就是「这个任务的产出物」，不是参考输入——用 output 不是
//    语义借用，是正用。新增 role 值要改 CHECK 约束 = 动 migration，且会让
//    `listCompletedGenerationArtifacts`（只认 role='output'）需要同步改，是白送的回归面。
// 2. 为何 metadata_json 而非新栏位：`metadata_json` 已是本仓既有的「任务型别专属栏位」
//    承载位——TTS 的 `voice_code`/`voice_source`（刀 3，见 tts-upstream.ts:149）、
//    `endpointLabel`（artifact-service.ts:395）都走这里，且已有明确的读取端范式
//    （`listCompletedGenerationArtifacts` 挑掉 `endpointLabel` 后把其余栏位对外透出）。
//    成片栏位照同一范式加一个**命名空间键**，语义自洽、零 migration。
// 3. 为何用命名空间物件（`{masterExport: {...}}`）而非平铺栏位：平铺会与既有
//    `endpointLabel`／TTS 栏位抢同一层键空间；日后任何一个 producer 写入同名键即
//    互相覆盖。命名空间把「成片」收敛成一个可原子判定的标记——索引的筛选条件就是
//    「这个键存在」（`jsonb_exists`），一个索引命中与否不依赖栏位拼写的巧合。
// 4. 为何 sessionId/projectId 放在**产物自己的 metadata** 而非 join
//    `generation_job.workflow_json`：导出侧 `masterExport(sessionId, …)`
//    （vendor-bridges/gateway/master.ts:196）本来就知道 session，写进产物是**事实转录**；
//    而 `workflow_json` 目前根本不是每个提交路径都塞 session（agent 路径
//    `agent-tool-adapter.ts:30` 只在 tenant 上落 session，video 提交不带 workflow），
//    靠它过滤等于把索引正确性押在一个没有契约保证的栏位上。放在产物 metadata，
//    过滤条件与写入事实同源。
//
// ── 边界（诚实声明，勿当缺漏） ─────────────────────────────────────────────────
// - **本档只做索引（读）与 metadata 契约（写的形状）**，不含成片导出的执行路径。
// - `artifact.job_id` 是 `NOT NULL REFERENCES generation_job(id)`（001:218）：
//   落成片索引行的**前提是该成片有一条真实的 `generation_job` 行**。索引端不伪造、
//   不为此建假 job；这是 producer（导出链）的义务，见回报「未尽事项」。
// - 不吞 AID `aid_episode_editor` 的 `pending_video_*` 双槽（审核用，本方无审核队列）
//   与阿里 MPS／腾讯 IMS 回调栏位；只借其**实体栏位语义**
//   （`final_video_fingerprint`／`export_fingerprint`／`export_status` 的语义对应本档
//   的 `exportFingerprint`／`probe.verified`）。
//
// 读取端范式对齐：`src/lib/generation-core/artifact-service.ts`（recordArtifact 的 sql
// 写法）与 `status-query.ts`（可注入 `sql`、tenant 为必备过滤键、kebab 条件式 SQL）。
// 写入端契约对齐：`material-fingerprint.ts` 的 `computeExportFingerprint`（64 hex）。

import { getGenerationSql, type GenerationSql } from "./database";

type Row = Record<string, unknown>;

/**
 * `artifact.metadata_json` 里的成片命名空间键。
 * 索引的存在性判准就是这个键——producer 写入时必须用它（见 `buildMasterArtifactMetadata`）。
 */
export const MASTER_ARTIFACT_METADATA_KEY = "masterExport";

/** 成片索引只认产出物；参考输入（role='reference'）永不进索引。 */
export const MASTER_ARTIFACT_ROLE = "output";

/** `computeExportFingerprint` 的输出长度（sha256 hex）。仅作查证提示，不作过滤条件。 */
export const MASTER_EXPORT_FINGERPRINT_HEX_LENGTH = 64;

/** 索引预设/上限（与 status-query 的分页口径同哲学：有界，不无界回吐）。 */
export const MASTER_ARTIFACT_DEFAULT_LIMIT = 20;
export const MASTER_ARTIFACT_MAX_LIMIT = 100;

/** probe 摘要（导出侧 `MasterExportResult.probe` 的持久化形状）。 */
export interface MasterProbeSummary {
  codec: string;
  width: number;
  height: number;
  durationSec: number;
  sizeBytes: number | null;
  /** true = probeRenderedVideo 全门通过（容器/解析度/时长/首帧）。 */
  verified: boolean;
  /** probe 失败原文（probe_error）；通过时 null。 */
  error: string | null;
}

/** 成片产物特有的可查证栏位（metadata_json.masterExport 的值）。 */
export interface MasterArtifactMetadata {
  /** 素材集合指纹（64 hex，`computeExportFingerprint` 输出）。 */
  exportFingerprint: string;
  /** 指纹序列化口径版本（对应 `EXPORT_FINGERPRINT_VERSION`）；旧资料可缺。 */
  fingerprintVersion: number | null;
  /** 导出预设 id（如 landscape_169）。**存 id 不存解析度表**——解析度一律以 probe 实测为准。 */
  preset: string;
  /** 实测解析度（probe 值，非预设宣告值）。 */
  resolution: { width: number; height: number } | null;
  /** 成片时长（秒，probe 实测优先）。 */
  durationSec: number | null;
  /** 导出当时的时间线版本号（回溯「哪一版时间线产出这条成片」）。 */
  timelineVersion: number | null;
  /** 所属会话（导出侧已知，事实转录）。 */
  sessionId: string | null;
  /** 所属作品/项目（呼叫端有才带）。 */
  projectId: string | null;
  /** 封面帧 URL（导出侧 withCover 产物）。 */
  coverUrl: string | null;
  /** 生产者标签（如 "timeline_master"），供来源归因。 */
  source: string | null;
  probe: MasterProbeSummary | null;
}

/** 索引查询条件。全部可选；tenantId 为多租户隔离键。 */
export interface MasterArtifactFilter {
  tenantId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  limit?: number | null;
  offset?: number | null;
}

/** 索引对外列（每条 = 一条成片）。 */
export interface MasterArtifactRecord {
  artifactId: string;
  jobId: string;
  tenantId: string;
  /** 成片可播 URL（导出产物落公网目录后回填）。 */
  deliveryUrl: string | null;
  objectKey: string | null;
  mimeType: string;
  /** 位元组 sha256（与 exportFingerprint 不同：前者是档案内容，后者是素材集合）。 */
  sha256: string;
  byteSize: number;
  createdAt: Date;
  exportFingerprint: string;
  fingerprintVersion: number | null;
  preset: string;
  resolution: { width: number; height: number } | null;
  durationSec: number | null;
  timelineVersion: number | null;
  sessionId: string | null;
  projectId: string | null;
  coverUrl: string | null;
  source: string | null;
  probe: MasterProbeSummary | null;
  /** 来源归因：产出该成片的 job 种类与模型。 */
  jobKind: string;
  modelId: string;
}

// ───────────────────────────────────────────────────── 写入端：metadata 契约

export interface MasterArtifactMetadataInput {
  exportFingerprint: string;
  preset: string;
  fingerprintVersion?: number | null;
  resolution?: { width: number; height: number } | null;
  durationSec?: number | null;
  timelineVersion?: number | null;
  sessionId?: string | null;
  projectId?: string | null;
  coverUrl?: string | null;
  source?: string | null;
  probe?: MasterProbeSummaryInput | null;
}

/** probe 摘要输入（导出侧 `MasterExportResult` 直译；长度栏位名沿用其下划线形）。 */
export interface MasterProbeSummaryInput {
  codec?: string | null;
  width?: number | null;
  height?: number | null;
  /** 导出侧栏位名为 `duration_sec`。 */
  duration_sec?: number | null;
  /** 导出侧栏位名为 `size`。 */
  size?: number | null;
  /** probe_error；有值即未通过。 */
  probe_error?: string | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * 把导出侧的 probe 结果转成持久化摘要。
 * `verified` 的判准：有 probe 且没有 probe_error（对齐 `masterExport.exported = probe !== null`）。
 */
function normalizeProbe(input: MasterProbeSummaryInput | null | undefined): MasterProbeSummary | null {
  if (!input) return null;
  const error = nonEmptyString(input.probe_error);
  const width = finiteNumber(input.width);
  const height = finiteNumber(input.height);
  if (width === null || height === null) {
    // 无实测解析度 = 没有可查证的 probe 摘要；只保留失败原文，不伪造数字。
    return error
      ? { codec: "", width: 0, height: 0, durationSec: 0, sizeBytes: null, verified: false, error }
      : null;
  }
  return {
    codec: nonEmptyString(input.codec) ?? "",
    width,
    height,
    durationSec: finiteNumber(input.duration_sec) ?? 0,
    sizeBytes: finiteNumber(input.size),
    verified: error === null,
    error,
  };
}

/**
 * 组出可传给 `recordArtifact({ metadata })` 的 metadata 物件。
 *
 * 写入侧唯一入口：producer 不自行拼平铺栏位，一律经此函式（键名与形状的唯一真源）。
 * 空值栏位一律**不落键**（不写 null），与 tts-upstream.ts:149 的条件展开同范式：
 * 「有值才写」让索引端的缺栏位与「本来没有」不可混淆。
 */
export function buildMasterArtifactMetadata(input: MasterArtifactMetadataInput): Record<string, unknown> {
  const exportFingerprint = nonEmptyString(input.exportFingerprint);
  if (!exportFingerprint) {
    throw new TypeError("buildMasterArtifactMetadata: exportFingerprint 不能为空。");
  }
  const preset = nonEmptyString(input.preset);
  if (!preset) {
    throw new TypeError("buildMasterArtifactMetadata: preset 不能为空。");
  }

  const metadata: Record<string, unknown> = { exportFingerprint, preset };

  const fingerprintVersion = finiteNumber(input.fingerprintVersion);
  if (fingerprintVersion !== null) metadata.fingerprintVersion = Math.trunc(fingerprintVersion);

  const width = finiteNumber(input.resolution?.width);
  const height = finiteNumber(input.resolution?.height);
  if (width !== null && height !== null) metadata.resolution = { width, height };

  const durationSec = finiteNumber(input.durationSec);
  if (durationSec !== null) metadata.durationSec = durationSec;

  const timelineVersion = finiteNumber(input.timelineVersion);
  if (timelineVersion !== null) metadata.timelineVersion = Math.trunc(timelineVersion);

  const sessionId = nonEmptyString(input.sessionId);
  if (sessionId) metadata.sessionId = sessionId;

  const projectId = nonEmptyString(input.projectId);
  if (projectId) metadata.projectId = projectId;

  const coverUrl = nonEmptyString(input.coverUrl);
  if (coverUrl) metadata.coverUrl = coverUrl;

  const source = nonEmptyString(input.source);
  if (source) metadata.source = source;

  const probe = normalizeProbe(input.probe);
  if (probe) metadata.probe = probe;

  return { [MASTER_ARTIFACT_METADATA_KEY]: metadata };
}

// ───────────────────────────────────────────────────── 读取端：metadata 解析

/**
 * 容错解析 `metadata_json.masterExport`。
 * 不是成片记录（缺键／缺 exportFingerprint／缺 preset／型别不对）一律回 null——
 * 呼叫端据此把该列丢掉，不整份查询作废（normalize-and-drop 范式，同 project-store）。
 * 缺 `probe` 不是缺陷：导出可诚实地 probe 未过而仍留下纪录（`verified:false` + error）。
 */
export function readMasterArtifactMetadata(raw: unknown): MasterArtifactMetadata | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const holder = raw as Record<string, unknown>;
  const value = holder[MASTER_ARTIFACT_METADATA_KEY];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const film = value as Record<string, unknown>;

  const exportFingerprint = nonEmptyString(film.exportFingerprint);
  if (!exportFingerprint) return null;
  const preset = nonEmptyString(film.preset);
  if (!preset) return null;

  const rawResolution = film.resolution as { width?: unknown; height?: unknown } | null | undefined;
  const width = finiteNumber(rawResolution?.width);
  const height = finiteNumber(rawResolution?.height);

  const rawProbe = film.probe as Record<string, unknown> | null | undefined;
  let probe: MasterProbeSummary | null = null;
  if (rawProbe && typeof rawProbe === "object" && !Array.isArray(rawProbe)) {
    const probeWidth = finiteNumber(rawProbe.width);
    const probeHeight = finiteNumber(rawProbe.height);
    const error = nonEmptyString(rawProbe.error);
    probe = {
      codec: nonEmptyString(rawProbe.codec) ?? "",
      width: probeWidth ?? 0,
      height: probeHeight ?? 0,
      durationSec: finiteNumber(rawProbe.durationSec) ?? 0,
      sizeBytes: finiteNumber(rawProbe.sizeBytes),
      // 本档的写入端一律显式写入 verified，故此分支只影响 legacy/手写列：
      // 缺旗标时以「有 error 即未通过」推断（对齐 masterExport 的 exported = probe !== null 语义）。
      verified: typeof rawProbe.verified === "boolean" ? rawProbe.verified : error === null,
      error,
    };
  }

  return {
    exportFingerprint: exportFingerprint.toLowerCase(),
    fingerprintVersion: finiteNumber(film.fingerprintVersion),
    preset,
    resolution: width !== null && height !== null ? { width, height } : null,
    durationSec: finiteNumber(film.durationSec),
    timelineVersion: finiteNumber(film.timelineVersion),
    sessionId: nonEmptyString(film.sessionId),
    projectId: nonEmptyString(film.projectId),
    coverUrl: nonEmptyString(film.coverUrl),
    source: nonEmptyString(film.source),
    probe,
  };
}

/** 单列 → 索引列；非成片记录（metadata 解析不过）回 null。汇出供单测直接锁 shape。 */
export function mapMasterArtifactRow(row: Row): MasterArtifactRecord | null {
  const rawMetadata = typeof row.metadata_json === "string"
    ? (() => { try { return JSON.parse(row.metadata_json as string) as unknown; } catch { return null; } })()
    : row.metadata_json;
  const metadata = readMasterArtifactMetadata(rawMetadata);
  if (!metadata) return null;

  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at));
  return {
    artifactId: String(row.id),
    jobId: String(row.job_id),
    tenantId: String(row.tenant_id),
    deliveryUrl: nonEmptyString(row.delivery_url),
    objectKey: nonEmptyString(row.object_key),
    mimeType: String(row.mime_type),
    sha256: String(row.sha256),
    byteSize: Number(row.byte_size ?? 0),
    createdAt,
    exportFingerprint: metadata.exportFingerprint,
    fingerprintVersion: metadata.fingerprintVersion,
    preset: metadata.preset,
    resolution: metadata.resolution,
    durationSec: metadata.durationSec,
    timelineVersion: metadata.timelineVersion,
    sessionId: metadata.sessionId,
    projectId: metadata.projectId,
    coverUrl: metadata.coverUrl,
    source: metadata.source,
    probe: metadata.probe,
    jobKind: String(row.job_kind ?? "unknown"),
    modelId: String(row.model_id ?? "unknown"),
  };
}

// ───────────────────────────────────────────────────── 查询层

function clampLimit(raw: unknown): number {
  const value = Number(raw);
  const limit = Number.isFinite(value) ? Math.floor(value) : MASTER_ARTIFACT_DEFAULT_LIMIT;
  return Math.min(Math.max(1, limit), MASTER_ARTIFACT_MAX_LIMIT);
}

function clampOffset(raw: unknown): number {
  const value = Number(raw);
  const offset = Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(0, offset);
}

/**
 * 列举成片产物（预设 newest 优先）。
 *
 * 筛选口径：
 *   - `role='output'` 且 `metadata_json` 带成片命名空间键（`jsonb_exists`，比 `?` 运算子
 *     在参数化 SQL 下更无歧义）——这两条一起构成了「这是成片」的判准；
 *   - tenant 为多租户隔离键（金钥只能看自己 tenant 的成片），与 status-query 同约定；
 *   - session／project 走产物自身 metadata（理由见档头 §4）：`jsonb -> key ->> field`，
 *     键名由常数绑定，避免路径字面量与常数漂移。
 *
 * 不用 SQL 端做 metadata 形状校验（那是 `mapMasterArtifactRow` 的职责），
 * 避免「SQL 命中但 JS 丢弃」与「SQL 不命中」两种空结果在下游无法区分。
 */
export async function listMasterArtifacts(
  filter: MasterArtifactFilter = {},
  sql: GenerationSql = getGenerationSql(),
): Promise<MasterArtifactRecord[]> {
  const tenantId = filter.tenantId ?? null;
  const sessionId = filter.sessionId ?? null;
  const projectId = filter.projectId ?? null;
  const limit = clampLimit(filter.limit);
  const offset = clampOffset(filter.offset);

  const rows = await sql<Row[]>`
    SELECT
      artifact.id, artifact.job_id, artifact.delivery_url, artifact.object_key,
      artifact.mime_type, artifact.sha256, artifact.byte_size, artifact.metadata_json,
      artifact.created_at,
      generation_job.tenant_id, generation_job.kind AS job_kind, generation_job.model_id
    FROM artifact
    JOIN generation_job ON generation_job.id = artifact.job_id
    WHERE artifact.role = ${MASTER_ARTIFACT_ROLE}
      AND jsonb_exists(artifact.metadata_json, ${MASTER_ARTIFACT_METADATA_KEY}::text)
      AND (${tenantId}::text IS NULL OR generation_job.tenant_id = ${tenantId})
      AND (${sessionId}::text IS NULL OR artifact.metadata_json -> ${MASTER_ARTIFACT_METADATA_KEY}::text ->> 'sessionId' = ${sessionId})
      AND (${projectId}::text IS NULL OR artifact.metadata_json -> ${MASTER_ARTIFACT_METADATA_KEY}::text ->> 'projectId' = ${projectId})
    ORDER BY artifact.created_at DESC, artifact.id DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  const records: MasterArtifactRecord[] = [];
  for (const row of rows) {
    const mapped = mapMasterArtifactRow(row);
    if (mapped) records.push(mapped);
  }
  return records;
}

/**
 * 成片总数（同一套筛选口径）。
 * 与 `listMasterArtifacts` 分开查是为了让分页 has_more 不必先拉全量；
 * 两者的 WHERE 必须逐条同步——改一处必须改另一处。
 */
export async function countMasterArtifacts(
  filter: MasterArtifactFilter = {},
  sql: GenerationSql = getGenerationSql(),
): Promise<number> {
  const tenantId = filter.tenantId ?? null;
  const sessionId = filter.sessionId ?? null;
  const projectId = filter.projectId ?? null;

  const rows = await sql<{ count: unknown }[]>`
    SELECT count(*) AS count
    FROM artifact
    JOIN generation_job ON generation_job.id = artifact.job_id
    WHERE artifact.role = ${MASTER_ARTIFACT_ROLE}
      AND jsonb_exists(artifact.metadata_json, ${MASTER_ARTIFACT_METADATA_KEY}::text)
      AND (${tenantId}::text IS NULL OR generation_job.tenant_id = ${tenantId})
      AND (${sessionId}::text IS NULL OR artifact.metadata_json -> ${MASTER_ARTIFACT_METADATA_KEY}::text ->> 'sessionId' = ${sessionId})
      AND (${projectId}::text IS NULL OR artifact.metadata_json -> ${MASTER_ARTIFACT_METADATA_KEY}::text ->> 'projectId' = ${projectId})
  `;
  const value = rows[0]?.count;
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}
