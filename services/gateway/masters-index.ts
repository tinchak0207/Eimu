// 从 index.ts 无损抽取（2026-09-19 第二阶段 Wave1）：成片索引登记 G4——MASTERS_PUBLIC_BASE/registerMasterExport，原 index.ts 375–430 行。
import { createHash } from "node:crypto"
import { type MasterExportResult, type MasterPresetId } from "./master"
import { EXPORT_FINGERPRINT_VERSION } from "./material-fingerprint"
import { resolveCanonicalIdentity, hashKey } from "./auth-gw.ts"
import { memoryPostIngest } from "./memory-wiring.ts"
// TODO(整合)：以下符号仍住 index.ts 且未 export（本任务禁改 index.ts；bun build 对未 export 的 named import 报错，已实测 2026-09-19）。
// 依第一阶段 subagent 占位符法（记忆 gateway-index-refactor-stage1-0919）：declare 占位可过 bun build；整合 subagent 统一换真 import 或于 index.ts 补 export。
// ---- 成片索引登记（G4，2026-09-17）----------------------------------------
// 成片导出成功后回呼控制面（/v1/internal/masters/ingest，同一 HMAC 签名通道）落
// generation_job(kind='film_export', status='succeeded') + artifact(metadata_json.masterExport)。
// 读取端＝控制面 /v1/masters（B 端按属主 userId 列举）。

export const MASTERS_PUBLIC_BASE = (process.env.MASTERS_PUBLIC_BASE || "https://store.tinchak0207.xyz").replace(/\/+$/, "")

/** 导出成功（probe 过档）才有资格调用：索引是「验过的成片」清单，probe 未过档不进。
 *  登记失败**不**反悔导出——档案已在盘上、静态路由已可服务，只诚实记 note：
 *  缺索引的后果是 /v1/masters 查不到这条成片，不是成片不存在。 */
export async function registerMasterExport(key: string, sid: string, presetId: MasterPresetId, result: MasterExportResult): Promise<void> {
  try {
    if (!result.exported || !result.out_path) return
    const identity = await resolveCanonicalIdentity(key)
    if (identity.userId == null) {
      result.notes.push("成片索引登记跳过：属主 user_id 解析失败（无法归属 tenant）")
      return
    }
    const file = Bun.file(result.out_path)
    if (!(await file.exists())) {
      result.notes.push("成片索引登记跳过：导出档案不在预期路径")
      return
    }
    // sha256/byte_size 取导出档实值（artifact 表 NOT NULL 栏，禁止拿 probe 缺值充数）
    const buf = new Uint8Array(await file.arrayBuffer())
    const sha256 = createHash("sha256").update(buf).digest("hex")
    const byteSize = buf.byteLength
    const publicUrl = `${MASTERS_PUBLIC_BASE}/agent/v1/masters/${sid}/master_${presetId}.mp4`
    const coverUrl = result.cover_path ? `${MASTERS_PUBLIC_BASE}/agent/v1/masters/${sid}/master_${presetId}_cover.jpg` : null
    const body = JSON.stringify({
      session_id: sid,
      tenant_id: `web:${identity.userId}`,
      owner_key: await hashKey(identity.key),
      preset: presetId,
      aspect: result.preset?.aspect ?? null,
      fingerprint: result.fingerprint ?? null,
      fingerprint_version: EXPORT_FINGERPRINT_VERSION,
      timeline_version: result.timeline_version ?? null,
      delivery_url: publicUrl,
      cover_url: coverUrl,
      sha256,
      mime_type: "video/mp4",
      byte_size: byteSize,
      probe: result.probe ?? null,
      project_id: null,
    })
    const res = await memoryPostIngest("/v1/internal/masters/ingest", body, {})
    const json = (res.json ?? {}) as { artifact_id?: unknown; job_deduped?: unknown }
    result.public_url = publicUrl
    result.master_artifact_id = typeof json.artifact_id === "string" ? json.artifact_id : null
    if (json.job_deduped === true) result.notes.push("成片索引：同会话同素材指纹已有索引行（幂等命中，未重复登记）")
  } catch (e) {
    result.notes.push(`成片索引登记失败：${e instanceof Error ? e.message : String(e)}（导出本身不受影响）`)
  }
}

