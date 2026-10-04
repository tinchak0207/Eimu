// 成片导出索引的生产端（G4，2026-09-17）——刀 4 读取端的对侧。
//
// 资料流：VPS gateway 导出成功（POST /agent/v1/timeline/master → masterExport()）→
// 签名回呼本服务（经 /v1/internal/masters/ingest）→ 这里落 generation_job(kind='film_export',
// status='succeeded') + artifact(role='output', metadata_json.masterExport) → /v1/masters 可列举。
//
// 诚实铁律（本服务的存在理由）：
//   1. **任何栏位缺失/非法 → 拒绝并逐栏回报，绝不补预设值**。索引里一条假资料比缺一条资料糟：
//      读取端把 metadata 当事实转录给 B 端用户（resolution/durationSec 都是 probe 实测栏）。
//   2. 导出**是**一次真实生成工作（ffmpeg 合成、真实计算、真实产物），job 万 status='succeeded'
//      是正用；本服务不编造上游调用、不碰计费（billing_amount=0，导出免费，无 billing_operation）。
//   3.幂等键 `film_export:<session_id>:<fingerprint>`：同一会话同一素材指纹重复导出 → 同一条 job，
//      artifact ON CONFLICT DO NOTHING——重放不会制造重复索引行。
//
// 身份：tenant 由 gateway 传入（`web:<userId>`，gateway 经 resolve-owner 拿到的属主 userId）。
// 控制面**不**反解 gateway 的 owner hash（单向），读取端用同一 userId 推导同一 tenant（/v1/masters）。

import { createHash, randomUUID } from "node:crypto";
import { getGenerationSql, type GenerationSql } from "./database";
import { encryptGenerationPrompt } from "./crypto";
import { recordArtifact } from "./artifact-service";
import { buildMasterArtifactMetadata, type MasterProbeSummaryInput } from "./master-artifact-index";

/** 导出回呼的栏位（gateway → 控制面，snake_case 照通道惯例）。 */
export interface MasterIngestPayload {
  sessionId: string;
  tenantId: string;
  preset: string;
  fingerprint: string;
  fingerprintVersion: number | null;
  timelineVersion: number | null;
  aspect: string | null;
  deliveryUrl: string;
  coverUrl: string | null;
  sha256: string;
  mimeType: string;
  byteSize: number;
  projectId: string | null;
  probe: MasterProbeSummaryInput | null;
}

export type MasterIngestResult =
  | { ok: true; jobId: string; artifactId: string; jobDeduped: boolean; artifactInserted: boolean }
  | { ok: false; fields: string[] };

const HEX64 = /^[0-9a-f]{64}$/;
/**
 * tenant 白名单：`web:<userId>`。成片导出的唯一身份语义＝agent 属主（gateway 经
 * resolve-owner 拿到的 userId）；读取端（/v1/masters）用同一 userId 推导同一 tenant，
 * 两端对称。**刻意不收 `biz:<keyId>`**：读取端按 userId 查，收了 biz 也查不到——
 * 留一个写得进读不到的 namespace 是地雷；未来若开放 B 端直调导出，两端一起扩。
 */
const TENANT = /^web:\d{1,18}$/;
const ASPECT = /^\d{1,4}:\d{1,4}$/;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 裸 payload（route 层 JSON.parse 的产物）→ 校验后的强型别输入。
 * 回 `fields`（非法/缺失栏位名清单）而非第一个错就停：呼叫端一次看到全部问题，gateway 补齐成本最低。
 */
export function validateMasterIngestPayload(raw: unknown): { ok: true; value: MasterIngestPayload } | { ok: false; fields: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, fields: ["body"] };
  }
  const p = raw as Record<string, unknown>;
  const fields: string[] = [];

  if (!nonEmptyString(p.session_id)) fields.push("session_id");
  if (!nonEmptyString(p.tenant_id) || !TENANT.test(p.tenant_id)) fields.push("tenant_id");
  if (!nonEmptyString(p.preset)) fields.push("preset");
  if (!nonEmptyString(p.fingerprint) || !HEX64.test(p.fingerprint)) fields.push("fingerprint");
  if (!nonEmptyString(p.sha256) || !HEX64.test(p.sha256)) fields.push("sha256");
  if (p.mime_type !== "video/mp4") fields.push("mime_type");
  if (typeof p.byte_size !== "number" || !Number.isInteger(p.byte_size) || p.byte_size <= 0) fields.push("byte_size");
  if (!nonEmptyString(p.delivery_url) || !/^https:\/\//.test(p.delivery_url)) fields.push("delivery_url");

  const fingerprintVersion = p.fingerprint_version === null || p.fingerprint_version === undefined ? null : optionalInt(p.fingerprint_version);
  if (p.fingerprint_version != null && fingerprintVersion === null) fields.push("fingerprint_version");
  const timelineVersion = p.timeline_version === null || p.timeline_version === undefined ? null : optionalInt(p.timeline_version);
  if (p.timeline_version != null && timelineVersion === null) fields.push("timeline_version");

  let aspect: string | null = null;
  if (p.aspect != null) {
    if (!nonEmptyString(p.aspect) || !ASPECT.test(p.aspect)) fields.push("aspect");
    else aspect = p.aspect;
  }
  for (const key of ["cover_url", "project_id"] as const) {
    if (p[key] != null && !nonEmptyString(p[key])) fields.push(key);
  }

  let probe: MasterProbeSummaryInput | null = null;
  if (p.probe != null) {
    if (!p.probe || typeof p.probe !== "object" || Array.isArray(p.probe)) {
      fields.push("probe");
    } else {
      const q = p.probe as Record<string, unknown>;
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const bad =
        (q.codec != null && !nonEmptyString(q.codec)) ||
        (q.width != null && num(q.width) === null) ||
        (q.height != null && num(q.height) === null) ||
        (q.duration_sec != null && num(q.duration_sec) === null) ||
        (q.size != null && num(q.size) === null) ||
        (q.probe_error != null && !nonEmptyString(q.probe_error));
      if (bad) fields.push("probe");
      else
        probe = {
          codec: nonEmptyString(q.codec) ? q.codec : null,
          width: num(q.width),
          height: num(q.height),
          duration_sec: num(q.duration_sec),
          size: num(q.size),
          probe_error: nonEmptyString(q.probe_error) ? q.probe_error : null,
        };
    }
  }

  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: {
      sessionId: (p.session_id as string).trim(),
      tenantId: p.tenant_id as string,
      preset: (p.preset as string).trim(),
      fingerprint: p.fingerprint as string,
      fingerprintVersion,
      timelineVersion,
      aspect,
      deliveryUrl: p.delivery_url as string,
      coverUrl: (p.cover_url as string | undefined) ?? null,
      sha256: p.sha256 as string,
      mimeType: p.mime_type as string,
      byteSize: p.byte_size as number,
      projectId: (p.project_id as string | undefined) ?? null,
      probe,
    },
  };
}

/**
 * 落 job + artifact（单一事务）。job 幂等键见档头；artifact 每 job 恰一条 output。
 * 回 `jobDeduped`/`artifactInserted` 让 route 诚实对外（重放导出 ≠ 新成片）。
 */
export async function ingestMasterExport(
  input: MasterIngestPayload,
  sql: GenerationSql = getGenerationSql(),
): Promise<{ jobId: string; artifactId: string; jobDeduped: boolean; artifactInserted: boolean }> {
  const idempotencyKey = `film_export:${input.sessionId}:${input.fingerprint}`;
  // request_hash：canonical 请求记录的 sha256（与 B 端 job 的 request_hash 同语义——「这次请求是什么」）。
  const requestJson = JSON.stringify({ session_id: input.sessionId, preset: input.preset, fingerprint: input.fingerprint });
  const requestHash = createHash("sha256").update(requestJson).digest("hex");
  const promptCiphertext = encryptGenerationPrompt(requestJson);

  const result = await sql.begin(async (tx) => {
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO generation_job (
        id, tenant_id, source, idempotency_key, request_hash, kind, model_id, ratio,
        prompt_ciphertext, workflow_json, status, requested_count, completed_count, billing_amount, deadline_at
      ) VALUES (
        ${randomUUID()}, ${input.tenantId}, 'agent', ${idempotencyKey}, ${requestHash}, 'film_export', 'timeline_master', ${input.aspect},
        ${promptCiphertext}, ${tx.json({} as never)}, 'succeeded', 1, 1, 0, now() + interval '1 hour'
      )
      ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id
    `;

    let jobId: string;
    let jobDeduped = false;
    if (inserted[0]) {
      jobId = String(inserted[0].id);
    } else {
      const existing = await tx<{ id: string }[]>`
        SELECT id FROM generation_job
        WHERE tenant_id = ${input.tenantId} AND idempotency_key = ${idempotencyKey}
        LIMIT 1
      `;
      if (!existing[0]) throw new Error(`master ingest: idempotent job lost for ${idempotencyKey}`);
      jobId = String(existing[0].id);
      jobDeduped = true;
    }

    const width = input.probe?.width ?? null;
    const height = input.probe?.height ?? null;
    const metadata = buildMasterArtifactMetadata({
      exportFingerprint: input.fingerprint,
      preset: input.preset,
      fingerprintVersion: input.fingerprintVersion,
      resolution: width != null && height != null ? { width, height } : null,
      durationSec: input.probe?.duration_sec ?? null,
      timelineVersion: input.timelineVersion,
      sessionId: input.sessionId,
      projectId: input.projectId,
      coverUrl: input.coverUrl,
      source: "timeline_master",
      probe: input.probe,
    });

    const artifact = await recordArtifact(
      {
        jobId,
        role: "output",
        outputIndex: 0,
        deliveryUrl: input.deliveryUrl,
        validated: { mimeType: input.mimeType, width, height, sha256: input.sha256 },
        byteSize: input.byteSize,
        metadata,
      },
      tx,
    );

    return { jobId, artifactId: artifact.id, jobDeduped, artifactInserted: artifact.inserted };
  });

  // 事后产物硬检（加法、预设 OFF）：只有 MEDIA_QUALITY_GATE=1 才启用；fire-and-forget，
  // 只写 log，任何情况不得 throw／阻断入库（见下方 helper 注解）。
  if (process.env.MEDIA_QUALITY_GATE === "1") {
    void runMediaQualityGateAfterIngest(result, input);
  }
  return result;
}

/**
 * 成片入库后的**确定性**事后硬检（parity-gap 第 1 格）：对既有 deliveryUrl 跑
 * ffprobe/ffmpeg 量测（解析度/时长/音轨/非空），把 verdict 写进 log。**纯观测**：
 * 不呼叫任何模型或付费上游、不动 DB、失败吞掉；绝不 throw、绝不阻断生成流程。
 */
async function runMediaQualityGateAfterIngest(
  result: { jobId: string; artifactId: string; jobDeduped: boolean; artifactInserted: boolean },
  input: MasterIngestPayload,
): Promise<void> {
  try {
    const { probeMedia, evaluateMediaQuality, QUALITY_POLICIES } = await import("../media-quality-gate");
    const probe = await probeMedia(input.deliveryUrl, 30_000);
    const verdict = evaluateMediaQuality(probe, QUALITY_POLICIES.video_default);
    console.log(
      `[media-quality-gate] job=${result.jobId} artifact=${result.artifactId} policy=${verdict.policyId} ok=${verdict.ok} failures=${JSON.stringify(verdict.failures)} measured=${JSON.stringify(verdict.measured)}`,
    );
  } catch (e) {
    console.log(`[media-quality-gate] 量测未完成（不影响入库）：${e instanceof Error ? e.message : String(e)}`);
  }
}
