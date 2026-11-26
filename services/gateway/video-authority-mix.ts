/** 成片混音以视频流时长为权威。短音轨补静音，长音轨裁到画面结束。禁止 -shortest。 */

export function videoAuthorityMixArgs(videoDurationSec: number): string[] {
  if (!(videoDurationSec > 0) || !Number.isFinite(videoDurationSec)) {
    throw new Error("视频时长无效，拒绝混流")
  }
  const seconds = videoDurationSec.toFixed(3)
  return [
    "-filter_complex",
    `[1:a]apad=whole_dur=${seconds},atrim=0:${seconds}[aout]`,
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-t",
    seconds,
    "-movflags",
    "+faststart",
  ]
}

export function assertVideoAuthorityMix(args: readonly string[]): void {
  if (args.some((arg) => arg === "-shortest" || arg.startsWith("-shortest="))) {
    throw new Error("混流禁止 -shortest，否则短音轨会截断画面")
  }
  if (!args.includes("-t")) throw new Error("混流必须用 -t 钉住视频时长")
  if (!args.some((arg) => arg.includes("apad"))) throw new Error("短音轨必须 apad")
}
