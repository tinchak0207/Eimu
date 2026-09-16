// 成片（母帶）產物索引 —— 刀 4（2026-09-15，能力建設）。
//
// 目標（可測量終態）：成片成為可列舉、可回溯的一等產物——「這個項目/會話產過哪些成片」
// 一次查得出，每條帶導出指紋、時長、解析度、來源。
//
// ── 形狀選擇與理由（任務書要求回報） ───────────────────────────────────────────
// **掛既有 `artifact` 表（`role='output'`）＋ `metadata_json` 命名空間鍵
// `masterExport`；不建表、不建 migration、不加 role 值。**
//
// 1. 為何 role='output' 而非新 role：`artifact.role` CHECK 只有 `('reference','output')`
//    （001:220）。成片在語義上就是「這個任務的產出物」，不是參考輸入——用 output 不是
//    語義借用，是正用。新增 role 值要改 CHECK 約束 = 動 migration，且會讓
//    `listCompletedGenerationArtifacts`（只認 role='output'）需要同步改，是白送的回歸面。
// 2. 為何 metadata_json 而非新欄位：`metadata_json` 已是本倉既有的「任務型別專屬欄位」
//    承載位——TTS 的 `voice_code`/`voice_source`（刀 3，見 tts-upstream.ts:149）、
//    `endpointLabel`（artifact-service.ts:395）都走這裡，且已有明確的讀取端範式
//    （`listCompletedGenerationArtifacts` 挑掉 `endpointLabel` 後把其餘欄位對外透出）。
//    成片欄位照同一範式加一個**命名空間鍵**，語義自洽、零 migration。
// 3. 為何用命名空間物件（`{masterExport: {...}}`）而非平鋪欄位：平鋪會與既有
//    `endpointLabel`／TTS 欄位搶同一層鍵空間；日後任何一個 producer 寫入同名鍵即
//    互相覆蓋。命名空間把「成片」收斂成一個可原子判定的標記——索引的篩選條件就是
//    「這個鍵存在」（`jsonb_exists`），一個索引命中與否不依賴欄位拼寫的巧合。
// 4. 為何 sessionId/projectId 放在**產物自己的 metadata** 而非 join
//    `generation_job.workflow_json`：導出側 `masterExport(sessionId, …)`
//    （vendor-bridges/gateway/master.ts:196）本來就知道 session，寫進產物是**事實轉錄**；
//    而 `workflow_json` 目前根本不是每個提交路徑都塞 session（agent 路徑
//    `agent-tool-adapter.ts:30` 只在 tenant 上落 session，video 提交不帶 workflow），
//    靠它過濾等於把索引正確性押在一個沒有契約保證的欄位上。放在產物 metadata，
//    過濾條件與寫入事實同源。
//
// ── 邊界（誠實聲明，勿當缺漏） ─────────────────────────────────────────────────
// - **本檔只做索引（讀）與 metadata 契約（寫的形狀）**，不含成片導出的執行路徑。
// - `artifact.job_id` 是 `NOT NULL REFERENCES generation_job(id)`（001:218）：
//   落成片索引行的**前提是該成片有一條真實的 `generation_job` 行**。索引端不偽造、
//   不為此建假 job；這是 producer（導出鏈）的義務，見回報「未盡事項」。
// - 不吞 AID `aid_episode_editor` 的 `pending_video_*` 雙槽（審核用，本方無審核隊列）
//   與阿里 MPS／騰訊 IMS 回調欄位；只借其**實體欄位語義**
//   （`final_video_fingerprint`／`export_fingerprint`／`export_status` 的語義對應本檔
//   的 `exportFingerprint`／`probe.verified`）。
//
// 讀取端範式對齊：`src/lib/generation-core/artifact-service.ts`（recordArtifact 的 sql
// 寫法）與 `status-query.ts`（可注入 `sql`、tenant 為必備過濾鍵、kebab 條件式 SQL）。
// 寫入端契約對齊：`material-fingerprint.ts` 的 `computeExportFingerprint`（64 hex）。

import { getGenerationSql, type GenerationSql } from "./database";

type Row = Record<string, unknown>;

/**
 * `artifact.metadata_json` 裡的成片命名空間鍵。
 * 索引的存在性判準就是這個鍵——producer 寫入時必須用它（見 `buildMasterArtifactMetadata`）。
 */
export const MASTER_ARTIFACT_METADATA_KEY = "masterExport";

/** 成片索引只認產出物；參考輸入（role='reference'）永不進索引。 */
export const MASTER_ARTIFACT_ROLE = "output";

/** `computeExportFingerprint` 的輸出長度（sha256 hex）。僅作查證提示，不作過濾條件。 */
export const MASTER_EXPORT_FINGERPRINT_HEX_LENGTH = 64;

/** 索引預設/上限（與 status-query 的分頁口徑同哲學：有界，不無界回吐）。 */
export const MASTER_ARTIFACT_DEFAULT_LIMIT = 20;
export const MASTER_ARTIFACT_MAX_LIMIT = 100;

/** probe 摘要（導出側 `MasterExportResult.probe` 的持久化形狀）。 */
export interface MasterProbeSummary {
  codec: string;
  width: number;
  height: number;
  durationSec: number;
  sizeBytes: number | null;
  /** true = probeRenderedVideo 全門通過（容器/解析度/時長/首幀）。 */
  verified: boolean;
  /** probe 失敗原文（probe_error）；通過時 null。 */
  error: string | null;
}

/** 成片產物特有的可查證欄位（metadata_json.masterExport 的值）。 */
export interface MasterArtifactMetadata {
  /** 素材集合指紋（64 hex，`computeExportFingerprint` 輸出）。 */
  exportFingerprint: string;
  /** 指紋序列化口徑版本（對應 `EXPORT_FINGERPRINT_VERSION`）；舊資料可缺。 */
  fingerprintVersion: number | null;
  /** 導出預設 id（如 landscape_169）。**存 id 不存解析度表**——解析度一律以 probe 實測為準。 */
  preset: string;
  /** 實測解析度（probe 值，非預設宣告值）。 */
  resolution: { width: number; height: number } | null;
  /** 成片時長（秒，probe 實測優先）。 */
  durationSec: number | null;
  /** 導出當時的時間線版本號（回溯「哪一版時間線產出這條成片」）。 */
  timelineVersion: number | null;
  /** 所屬會話（導出側已知，事實轉錄）。 */
  sessionId: string | null;
  /** 所屬作品/項目（呼叫端有才帶）。 */
  projectId: string | null;
  /** 封面幀 URL（導出側 withCover 產物）。 */
  coverUrl: string | null;
  /** 生產者標籤（如 "timeline_master"），供來源歸因。 */
  source: string | null;
  probe: MasterProbeSummary | null;
}

/** 索引查詢條件。全部可選；tenantId 為多租戶隔離鍵。 */
export interface MasterArtifactFilter {
  tenantId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  limit?: number | null;
  offset?: number | null;
}

/** 索引對外列（每條 = 一條成片）。 */
export interface MasterArtifactRecord {
  artifactId: string;
  jobId: string;
  tenantId: string;
  /** 成片可播 URL（導出產物落公網目錄後回填）。 */
  deliveryUrl: string | null;
  objectKey: string | null;
  mimeType: string;
  /** 位元組 sha256（與 exportFingerprint 不同：前者是檔案內容，後者是素材集合）。 */
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
  /** 來源歸因：產出該成片的 job 種類與模型。 */
  jobKind: string;
  modelId: string;
}

// ───────────────────────────────────────────────────── 寫入端：metadata 契約

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

/** probe 摘要輸入（導出側 `MasterExportResult` 直譯；長度欄位名沿用其下劃線形）。 */
export interface MasterProbeSummaryInput {
  codec?: string | null;
  width?: number | null;
  height?: number | null;
  /** 導出側欄位名為 `duration_sec`。 */
  duration_sec?: number | null;
  /** 導出側欄位名為 `size`。 */
  size?: number | null;
  /** probe_error；有值即未通過。 */
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
 * 把導出側的 probe 結果轉成持久化摘要。
 * `verified` 的判準：有 probe 且沒有 probe_error（對齊 `masterExport.exported = probe !== null`）。
 */
function normalizeProbe(input: MasterProbeSummaryInput | null | undefined): MasterProbeSummary | null {
  if (!input) return null;
  const error = nonEmptyString(input.probe_error);
  const width = finiteNumber(input.width);
  const height = finiteNumber(input.height);
  if (width === null || height === null) {
    // 無實測解析度 = 沒有可查證的 probe 摘要；只保留失敗原文，不偽造數字。
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
 * 組出可傳給 `recordArtifact({ metadata })` 的 metadata 物件。
 *
 * 寫入側唯一入口：producer 不自行拼平鋪欄位，一律經此函式（鍵名與形狀的唯一真源）。
 * 空值欄位一律**不落鍵**（不寫 null），與 tts-upstream.ts:149 的條件展開同範式：
 * 「有值才寫」讓索引端的缺欄位與「本來沒有」不可混淆。
 */
export function buildMasterArtifactMetadata(input: MasterArtifactMetadataInput): Record<string, unknown> {
  const exportFingerprint = nonEmptyString(input.exportFingerprint);
  if (!exportFingerprint) {
    throw new TypeError("buildMasterArtifactMetadata: exportFingerprint 不能為空。");
  }
  const preset = nonEmptyString(input.preset);
  if (!preset) {
    throw new TypeError("buildMasterArtifactMetadata: preset 不能為空。");
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

// ───────────────────────────────────────────────────── 讀取端：metadata 解析

/**
 * 容錯解析 `metadata_json.masterExport`。
 * 不是成片記錄（缺鍵／缺 exportFingerprint／缺 preset／型別不對）一律回 null——
 * 呼叫端據此把該列丟掉，不整份查詢作廢（normalize-and-drop 範式，同 project-store）。
 * 缺 `probe` 不是缺陷：導出可誠實地 probe 未過而仍留下紀錄（`verified:false` + error）。
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
      // 本檔的寫入端一律顯式寫入 verified，故此分支只影響 legacy/手寫列：
      // 缺旗標時以「有 error 即未通過」推斷（對齊 masterExport 的 exported = probe !== null 語義）。
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

/** 單列 → 索引列；非成片記錄（metadata 解析不過）回 null。匯出供單測直接鎖 shape。 */
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

// ───────────────────────────────────────────────────── 查詢層

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
 * 列舉成片產物（預設 newest 優先）。
 *
 * 篩選口徑：
 *   - `role='output'` 且 `metadata_json` 帶成片命名空間鍵（`jsonb_exists`，比 `?` 運算子
 *     在參數化 SQL 下更無歧義）——這兩條一起構成了「這是成片」的判準；
 *   - tenant 為多租戶隔離鍵（金鑰只能看自己 tenant 的成片），與 status-query 同約定；
 *   - session／project 走產物自身 metadata（理由見檔頭 §4）：`jsonb -> key ->> field`，
 *     鍵名由常數綁定，避免路徑字面量與常數漂移。
 *
 * 不用 SQL 端做 metadata 形狀校驗（那是 `mapMasterArtifactRow` 的職責），
 * 避免「SQL 命中但 JS 丟棄」與「SQL 不命中」兩種空結果在下游無法區分。
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
 * 成片總數（同一套篩選口徑）。
 * 與 `listMasterArtifacts` 分開查是為了讓分頁 has_more 不必先拉全量；
 * 兩者的 WHERE 必須逐條同步——改一處必須改另一處。
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
