/**
 * ffmpeg 全域限流器（VPS OOM 治本，2026-10-02）
 *
 * 背景：2026-10-02 08:36 全域 OOM，opencode-server（助理大腦，127.0.0.1:4096）
 * 被 OOM killer 殺死，斷 85 秒；急性觸發＝13 個並行 ffmpeg 各約 200–245MB
 * （合計 ~2.9GB），而主機僅 3.6GB RAM＋3.9GB swap（swap 已用 2.3GB）。
 *
 * 此模組是所有 gateway ffmpeg/ffprobe spawn 的統一節流閘。gateway 內部的
 * ffmpeg 執行最終都收斂到兩條路徑：
 *   1. editor/adapter/tauri-adapter.ts 的 executeCommand（composeEngine／
 *      videoCompose／master／mix／index.r6 皆經 invoke("execute_command")）
 *   2. lint.ts 的 runFF（node:child_process spawn）
 * 兩者共用本模組的訊號量，故上限是「整個 gateway 進程全域」而非單檔。
 *
 * 放行條件（同時成立才放行，否則排隊）：
 *   1. 目前併發 ffmpeg/ffprobe 數 < FFMPEG_MAX_CONCURRENT（預設 2）
 *   2. 主機 MemAvailable >= FFMPEG_MIN_MEM_MB（預設 400MB）
 * 被喚醒的waiter 會重新檢查兩個條件（記憶體門檻未恢復時不放行）。
 *
 * 可調：env FFMPEG_MAX_CONCURRENT（0 = 關閉限流）／FFMPEG_MIN_MEM_MB。
 */
import { readFileSync } from "node:fs"

const MAX_CONCURRENT = (() => {
  const v = Number(process.env.FFMPEG_MAX_CONCURRENT)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 2
})()
const MIN_MEM_MB = (() => {
  const v = Number(process.env.FFMPEG_MIN_MEM_MB)
  return Number.isFinite(v) && v >= 0 ? v : 400
})()

let active = 0
const waiters: Array<() => void> = []

function memAvailableMB(): number {
  try {
    const m = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m)
    return m ? Number(m[1]) / 1024 : Number.MAX_SAFE_INTEGER
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

/** 喚醒所有排隊者；每人醒來後重新評估條件，搶不到 slot 的自己重回佇列。 */
function wakeAll(): void {
  if (waiters.length === 0) return
  const q = waiters.splice(0, waiters.length)
  for (const w of q) w()
}

// 記憶體由壓力恢復、但無 ffmpeg 結束事件觸發喚醒時，靠 ticker 週期性重評估。
const ticker = setInterval(wakeAll, 1000)
if (typeof (ticker as { unref?: () => void }).unref === "function") {
  ;(ticker as { unref: () => void }).unref()
}

/** 判斷是否為 ffmpeg/ffprobe 指令（用於決定要不要過閘）。 */
export function shouldThrottleFfmpeg(cmd: string): boolean {
  return MAX_CONCURRENT > 0 && /\bffmpeg\b|\bffprobe\b/.test(cmd)
}

/** 取得一個 ffmpeg 執行槽（滿載或記憶體不足時排隊等待）。 */
export async function acquireFfmpegSlot(): Promise<void> {
  for (;;) {
    if (active < MAX_CONCURRENT && memAvailableMB() >= MIN_MEM_MB) {
      active += 1
      return
    }
    await new Promise<void>((resolve) => { waiters.push(resolve) })
  }
}

/** 釋放一個 ffmpeg 執行槽並喚醒排隊者。務必與 acquireFfmpegSlot 成對（finally）。 */
export function releaseFfmpegSlot(): void {
  active = Math.max(0, active - 1)
  wakeAll()
}

/** 觀測用：目前併發數／排隊數／MemAvailable。 */
export function ffmpegLimiterStats(): {
  active: number
  queued: number
  memAvailableMB: number
  maxConcurrent: number
  minMemMB: number
} {
  return {
    active,
    queued: waiters.length,
    memAvailableMB: Math.round(memAvailableMB()),
    maxConcurrent: MAX_CONCURRENT,
    minMemMB: MIN_MEM_MB,
  }
}
