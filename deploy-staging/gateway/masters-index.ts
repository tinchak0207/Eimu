// 從 index.ts 無損抽取（2026-09-19 第二階段 Wave1）：成片索引登記 G4——MASTERS_PUBLIC_BASE/registerMasterExport，原 index.ts 375–430 行。
import { createHash } from "node:crypto"
import { type MasterExportResult, type MasterPresetId } from "./master"
import { EXPORT_FINGERPRINT_VERSION } from "./material-fingerprint"
import { resolveCanonicalIdentity, hashKey } from "./auth-gw.ts"
import { memoryPostIngest } from "./memory-wiring.ts"
// TODO(整合)：以下符號仍住 index.ts 且未 export（本任務禁改 index.ts；bun build 對未 export 的 named import 報錯，已實測 2026-09-19）。
// 依第一階段 subagent 佔位符法（記憶 gateway-index-refactor-stage1-0919）：declare 佔位可過 bun build；整合 subagent 統一換真 import 或於 index.ts 補 export。
// ---- 成片索引登記（G4，2026-09-17）----------------------------------------
// 成片導出成功後回呼控制面（/v1/internal/masters/ingest，同一 HMAC 簽名通道）落
// generation_job(kind='film_export', status='succeeded') + artifact(metadata_json.masterExport)。
// 讀取端＝控制面 /v1/masters（B 端按屬主 userId 列舉）。

export const MASTERS_PUBLIC_BASE = (process.env.MASTERS_PUBLIC_BASE || "https://store.tinchak0207.xyz").replace(/\/+$/, "")

/** 導出成功（probe 過檔）才有資格調用：索引是「驗過的成片」清單，probe 未過檔不進。
 *  登記失敗**不**反悔導出——檔案已在盤上、靜態路由已可服務，只誠實記 note：
 *  缺索引的後果是 /v1/masters 查不到這條成片，不是成片不存在。 */
export async function registerMasterExport(key: string, sid: string, presetId: MasterPresetId, result: MasterExportResult): Promise<void> {
  try {
    if (!result.exported || !result.out_path) return
    const identity = await resolveCanonicalIdentity(key)
    if (identity.userId == null) {
      result.notes.push("成片索引登記跳過：屬主 user_id 解析失敗（無法歸屬 tenant）")
      return
    }
    const file = Bun.file(result.out_path)
    if (!(await file.exists())) {
      result.notes.push("成片索引登記跳過：導出檔案不在預期路徑")
      return
    }
    // sha256/byte_size 取導出檔實值（artifact 表 NOT NULL 欄，禁止拿 probe 缺值充數）
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
    if (json.job_deduped === true) result.notes.push("成片索引：同會話同素材指紋已有索引行（冪等命中，未重複登記）")
  } catch (e) {
    result.notes.push(`成片索引登記失敗：${e instanceof Error ? e.message : String(e)}（導出本身不受影響）`)
  }
}

