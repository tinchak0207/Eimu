/**
 * ffmpeg 全域限流器（VPS OOM 治本，2026-10-02）
 *
 * 背景：2026-10-02 08:36 全域 OOM，opencode-server（助理大脑，127.0.0.1:4096）
 * 被 OOM killer 杀死，断 85 秒；急性触发＝13 个并行 ffmpeg 各约 200–245MB
 * （合计 ~2.9GB），而主机仅 3.6GB RAM＋3.9GB swap（swap 已用 2.3GB）。
 *
 * 此模组是所有 gateway ffmpeg/ffprobe spawn 的统一节流闸。gateway 内部的
 * ffmpeg 执行最终都收敛到两条路径：
 *   1. editor/adapter/tauri-adapter.ts 的 executeCommand（composeEngine／
 *      videoCompose／master／mix／index.r6 皆经 invoke("execute_command")）
 *   2. lint.ts 的 runFF（node:child_process spawn）
 * 两者共用本模组的讯号量，故上限是「整个 gateway 进程全域」而非单档。
 *
 * 放行条件（同时成立才放行，否则排队）：
 *   1. 目前并发 ffmpeg/ffprobe 数 < FFMPEG_MAX_CONCURRENT（预设 2）
 *   2. 主机 MemAvailable >= FFMPEG_MIN_MEM_MB（预设 400MB）
 * 被唤醒的waiter 会重新检查两个条件（记忆体门槛未恢复时不放行）。
 *
 * 可调：env FFMPEG_MAX_CONCURRENT（0 = 关闭限流）／FFMPEG_MIN_MEM_MB。
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

/** 唤醒所有排队者；每人醒来后重新评估条件，抢不到 slot 的自己重回伫列。 */
function wakeAll(): void {
  if (waiters.length === 0) return
  const q = waiters.splice(0, waiters.length)
  for (const w of q) w()
}

// 记忆体由压力恢复、但无 ffmpeg 结束事件触发唤醒时，靠 ticker 周期性重评估。
const ticker = setInterval(wakeAll, 1000)
if (typeof (ticker as { unref?: () => void }).unref === "function") {
  ;(ticker as { unref: () => void }).unref()
}

/** 判断是否为 ffmpeg/ffprobe 指令（用于决定要不要过闸）。 */
export function shouldThrottleFfmpeg(cmd: string): boolean {
  return MAX_CONCURRENT > 0 && /\bffmpeg\b|\bffprobe\b/.test(cmd)
}

/** 取得一个 ffmpeg 执行槽（满载或记忆体不足时排队等待）。 */
export async function acquireFfmpegSlot(): Promise<void> {
  for (;;) {
    if (active < MAX_CONCURRENT && memAvailableMB() >= MIN_MEM_MB) {
      active += 1
      return
    }
    await new Promise<void>((resolve) => { waiters.push(resolve) })
  }
}

/** 释放一个 ffmpeg 执行槽并唤醒排队者。务必与 acquireFfmpegSlot 成对（finally）。 */
export function releaseFfmpegSlot(): void {
  active = Math.max(0, active - 1)
  wakeAll()
}

/** 观测用：目前并发数／排队数／MemAvailable。 */
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
