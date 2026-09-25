// 素材集合指紋 + URL 守衛（母帶導出冪等用）— 2026-09-15。
//
// 設計來源 AID（aid-server，MIT，copyright 光子讯息(杭州)科技有限公司）：
//   - 指紋：VideoComposeServiceImpl.java:979 `computeExportFingerprint`（素材歸一化 SHA-256，URL 轉相對路徑）
//   - 守衛：compose/util/MaterialUrlGuard.java（blob:/data:/嵌套協議/非 http(s) 拒絕）
// 本檔為 TS 重寫（AID 為 Java + hutool；此處只用 node:crypto，零新依賴）。
// 對齊 PRD 資產表：docs/symdiff-aid-swallow-prd.md §10「export 幂等指紋」「導出前 8 道結構校驗」。
//
// normalizeMaterialPath 的口徑（本檔選擇，AID 的 toRelativePath 細節未取到原件，故顯式聲明）：
//   1. **剝離協議 + host**：`https://a.com/x/y.mp4` 與 `/x/y.mp4` 視為同一素材（AID 明文口徑）。
//   2. **剝離查詢串（`?` 之後）與 fragment（`#` 之後）**：理由 = 素材 URL 絕大多數帶
//      OSS/CDN 簽名參數（`?Expires=…&Signature=…`），同一檔案每次取簽名不同；若保留查詢串，
//      指紋必然每次不同 → 冪等直接失效（AID 注釋「同一文件的全 URL 與相對路徑視為相同素材」
//      的意圖正是消除這類同檔異串）。代價：靠查詢串區分的同一路徑不同物料會被誤判為同一素材，
//      本方素材（mp4/wav/jpg）無此用法。
//   3. 空/空白輸入回 `""`；非 http(s)（含相對路徑、blob:/data:）只做 2 的規整，不改寫字面。
//
// 序列化口徑：不做「字串拼接 + 分隔符」（AID 用 `|` 拼接，分隔符污染風險），改為固定結構的
// `JSON.stringify`（數組固定位序），杜絕物件鍵序不穩；數值統一 3 位小數去尾零（AID 口徑）。

import { createHash } from "node:crypto"

/** 指紋版本號：序列化口徑變更時遞增，避免新舊口徑指紋互撞。 */
export const EXPORT_FINGERPRINT_VERSION = 1

export interface FingerprintClip {
  path: string
  durationSec: number
}

export interface FingerprintAudioClip extends FingerprintClip {
  /** 起始時間（秒）；缺省視為 0。有值時參與排序，讓「同時長不同位置」的音頻不被誤判同素材。 */
  startSec?: number
}

export interface FingerprintSubtitle {
  startSec: number
  endSec: number
  text: string
}

export interface ExportFingerprintInput {
  /** 視頻素材：**順序即語義**（拼接順序），不排序。 */
  clips: FingerprintClip[]
  /** 音頻素材：順序無語義，序列化前按 起始時間 → 時長 → 路徑 排序。 */
  audioClips: FingerprintAudioClip[]
  /** 字幕：序列化前按 起始 → 結束 → 文本 排序。 */
  subtitles: FingerprintSubtitle[]
  bgm?: { path: string; volume: number } | null
  aspect: string
  presetId: string
}

/** 3 位小數去尾零（AID `appendDurationList` 口徑）；非有限值歸 0。 */
function num3(n: number): number {
  const v = Number.isFinite(n) ? n : 0
  return Math.round(v * 1000) / 1000
}

/**
 * 素材 URL 轉相對路徑（同檔案的完整 URL 與相對路徑視為同一素材）。
 * 剝離協議/host 與查詢串、fragment（理由見檔頭）。空輸入回 `""`。
 */
export function normalizeMaterialPath(url: string): string {
  const raw = (url ?? "").trim()
  if (!raw) return ""
  let clean = raw
  const q = clean.indexOf("?")
  if (q >= 0) clean = clean.slice(0, q)
  const h = clean.indexOf("#")
  if (h >= 0) clean = clean.slice(0, h)
  const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(clean)
  if (!m) return clean
  return m[1] || "/"
}

/** blob:/data: 地址（出現在開頭或任一 path 段起始處均視為非法，覆蓋被誤拼進路徑的場景）。 */
const LOCAL_SCHEME_PATTERN = /(^|\/)(blob|data):/i

/**
 * 禁用 URL 判定（逐條對齊 AID `MaterialUrlGuard.isForbidden`）：
 * `blob:`／`data:`（含被誤拼進 path 的形態）、帶協議頭但非 http(s)、同一條鏈接出現第二個協議頭（嵌套 URL）。
 * 空值與普通相對路徑回 false（是否必填由調用方各自校驗）。
 */
export function isForbiddenMaterialUrl(url: string): boolean {
  const raw = (url ?? "").trim()
  if (!raw) return false
  const lower = raw.toLowerCase()
  // 瀏覽器臨時對象地址 / 內聯數據地址：服務端與上游廠商都無法訪問
  if (LOCAL_SCHEME_PATTERN.test(lower)) return true
  const firstScheme = lower.indexOf("://")
  if (firstScheme < 0) return false // 無協議頭：普通相對路徑
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return true
  // 同鏈接第二個協議頭：地址誤拼接
  return lower.indexOf("://", firstScheme + 3) >= 0
}

/**
 * 素材集合指紋（導出冪等用）：視頻（保序）+ 音頻（排序）+ 字幕（排序）+ BGM + 畫幅 + 預設
 * 歸一化序列化後 SHA-256 → 64 hex。素材任一欄位變化即換指紋；素材沒變則指紋不變，
 * 供上層（需持久層）判定「直接複用、不再合成不再扣費」。
 */
export function computeExportFingerprint(input: ExportFingerprintInput): string {
  const clips = (input.clips ?? []).map((c) => [normalizeMaterialPath(c.path), num3(c.durationSec)])

  const audio = (input.audioClips ?? [])
    .map((a) => [num3(a.startSec ?? 0), normalizeMaterialPath(a.path), num3(a.durationSec)] as [number, string, number])
    .sort((x, y) => x[0] - y[0] || x[2] - y[2] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))

  const subs = (input.subtitles ?? [])
    .map((s) => [num3(s.startSec), num3(s.endSec), s.text ?? ""] as [number, number, string])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0))

  const bgm = input.bgm ? [normalizeMaterialPath(input.bgm.path), num3(input.bgm.volume)] : null

  // 固定位序的數組結構（非物件鍵序敏感的 map），ensure 序列化穩定
  const canonical = JSON.stringify([
    "eimu-master-export",
    EXPORT_FINGERPRINT_VERSION,
    String(input.presetId ?? ""),
    String(input.aspect ?? ""),
    clips,
    audio,
    subs,
    bgm,
  ])
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}
