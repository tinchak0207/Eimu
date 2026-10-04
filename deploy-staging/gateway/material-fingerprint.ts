// 素材集合指纹 + URL 守卫（母带导出幂等用）— 2026-09-15。
//
// 设计来源 AID（aid-server，MIT，copyright 光子讯息(杭州)科技有限公司）：
//   - 指纹：VideoComposeServiceImpl.java:979 `computeExportFingerprint`（素材归一化 SHA-256，URL 转相对路径）
//   - 守卫：compose/util/MaterialUrlGuard.java（blob:/data:/嵌套协议/非 http(s) 拒绝）
// 本档为 TS 重写（AID 为 Java + hutool；此处只用 node:crypto，零新依赖）。
// 对齐 PRD 资产表：docs/symdiff-aid-swallow-prd.md §10「export 幂等指纹」「导出前 8 道结构校验」。
//
// normalizeMaterialPath 的口径（本档选择，AID 的 toRelativePath 细节未取到原件，故显式声明）：
//   1. **剥离协议 + host**：`https://a.com/x/y.mp4` 与 `/x/y.mp4` 视为同一素材（AID 明文口径）。
//   2. **剥离查询串（`?` 之后）与 fragment（`#` 之后）**：理由 = 素材 URL 绝大多数带
//      OSS/CDN 签名参数（`?Expires=…&Signature=…`），同一档案每次取签名不同；若保留查询串，
//      指纹必然每次不同 → 幂等直接失效（AID 注释「同一文件的全 URL 与相对路径视为相同素材」
//      的意图正是消除这类同档异串）。代价：靠查询串区分的同一路径不同物料会被误判为同一素材，
//      本方素材（mp4/wav/jpg）无此用法。
//   3. 空/空白输入回 `""`；非 http(s)（含相对路径、blob:/data:）只做 2 的规整，不改写字面。
//
// 序列化口径：不做「字串拼接 + 分隔符」（AID 用 `|` 拼接，分隔符污染风险），改为固定结构的
// `JSON.stringify`（数组固定位序），杜绝物件键序不稳；数值统一 3 位小数去尾零（AID 口径）。

import { createHash } from "node:crypto"

/** 指纹版本号：序列化口径变更时递增，避免新旧口径指纹互撞。 */
export const EXPORT_FINGERPRINT_VERSION = 1

export interface FingerprintClip {
  path: string
  durationSec: number
}

export interface FingerprintAudioClip extends FingerprintClip {
  /** 起始时间（秒）；缺省视为 0。有值时参与排序，让「同时长不同位置」的音频不被误判同素材。 */
  startSec?: number
}

export interface FingerprintSubtitle {
  startSec: number
  endSec: number
  text: string
}

export interface ExportFingerprintInput {
  /** 视频素材：**顺序即语义**（拼接顺序），不排序。 */
  clips: FingerprintClip[]
  /** 音频素材：顺序无语义，序列化前按 起始时间 → 时长 → 路径 排序。 */
  audioClips: FingerprintAudioClip[]
  /** 字幕：序列化前按 起始 → 结束 → 文本 排序。 */
  subtitles: FingerprintSubtitle[]
  bgm?: { path: string; volume: number } | null
  aspect: string
  presetId: string
}

/** 3 位小数去尾零（AID `appendDurationList` 口径）；非有限值归 0。 */
function num3(n: number): number {
  const v = Number.isFinite(n) ? n : 0
  return Math.round(v * 1000) / 1000
}

/**
 * 素材 URL 转相对路径（同档案的完整 URL 与相对路径视为同一素材）。
 * 剥离协议/host 与查询串、fragment（理由见档头）。空输入回 `""`。
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

/** blob:/data: 地址（出现在开头或任一 path 段起始处均视为非法，覆盖被误拼进路径的场景）。 */
const LOCAL_SCHEME_PATTERN = /(^|\/)(blob|data):/i

/**
 * 禁用 URL 判定（逐条对齐 AID `MaterialUrlGuard.isForbidden`）：
 * `blob:`／`data:`（含被误拼进 path 的形态）、带协议头但非 http(s)、同一条链接出现第二个协议头（嵌套 URL）。
 * 空值与普通相对路径回 false（是否必填由调用方各自校验）。
 */
export function isForbiddenMaterialUrl(url: string): boolean {
  const raw = (url ?? "").trim()
  if (!raw) return false
  const lower = raw.toLowerCase()
  // 浏览器临时对象地址 / 内联数据地址：服务端与上游厂商都无法访问
  if (LOCAL_SCHEME_PATTERN.test(lower)) return true
  const firstScheme = lower.indexOf("://")
  if (firstScheme < 0) return false // 无协议头：普通相对路径
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return true
  // 同链接第二个协议头：地址误拼接
  return lower.indexOf("://", firstScheme + 3) >= 0
}

/**
 * 素材集合指纹（导出幂等用）：视频（保序）+ 音频（排序）+ 字幕（排序）+ BGM + 画幅 + 预设
 * 归一化序列化后 SHA-256 → 64 hex。素材任一栏位变化即换指纹；素材没变则指纹不变，
 * 供上层（需持久层）判定「直接复用、不再合成不再扣费」。
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

  // 固定位序的数组结构（非物件键序敏感的 map），ensure 序列化稳定
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
