// 影片证据面共用 lib（2026-09-28）。
//
// 职责：把「以影片为输入、取得结构化证据」这一格做成本机、零付费、零上游的能力面——
//   probe（时长/串流/解析度/fps）、cut（单段或有序多段拼接）、frames（逐格 JPEG，附来源真实时间）、
//   tile/tiles（拼板，含分页）、boundaries（机械式相邻帧变化候选）、transcript 叠词。
//
// 形态来源（逐条照抄，非自由设计）：竞品 hypit 的
//   packages/video-cli/src/process.ts      → 本档「外部程序」层
//   packages/video-cli/src/media.ts        → probeMedia / openAt / JPEG / GLYPHS / rasterLabel /
//                                            timecode / cutClip / cutProduction / writeCut / cutFrame /
//                                            tileFrameCount / tileSampleTimes / frameLabel / tileFrames /
//                                            visualBoundaries / sampleRange / sampleTimes / tiles
//   packages/video-cli/src/media-frames.ts → decodeMediaFrames
//   packages/video-cli/src/frame-grid.ts   → writeFrameGrid
//   packages/video-cli/src/transcript.ts   → readTranscript / wordsAt / phraseRanges
// 参数名、预设值、错误语义、ffmpeg 参数顺序一律照它；本轮偏离处逐条列在交付回报 §5。
//
// 我方轮子复用：ffmpeg/ffprobe 绝对路径惯例抄 lib/asr.ts:61-62；公网 blob 用 lib/img-composite.ts
// 的 uploadBlob/blobPath（本档不自行上传，由 tools/video_evidence.ts 呼叫）。
// 本档不是 tool，不得 export tool 定义。

export type { ProcessOutput } from "./video-evidence-process"
export { loadSharp, runProcess, runProcessOutput, runProcessWithInput } from "./video-evidence-process"
export { requireVideo, probeMedia, timecode, cutFrame, cutSpans, decodeMediaFrames } from "./video-evidence-probe"
export type { VideoProbe, MediaProbe, CutSpan, DecodedFrame } from "./video-evidence-probe"
export { writeTile, writeFrameGrid, tileFrameCount, tileSampleTimes, intervalSamples } from "./video-evidence-tiles"
export type { SampledFrame, NativeFrameOptions, SampleRangeInput, TileRangeSpec } from "./video-evidence-tiles"
export { tileFrames, writeFrames, nativeFrames, writeEveryFrame, parseTileRange, writeTiles } from "./video-evidence-tiles"
export { TILE_COLUMNS, TILE_CELL_WIDTH } from "./video-evidence-tiles"
export { SAMPLE_OPTIONS, sampleRange, sampleTimes } from "./video-evidence-sample"
export type { SampleRequest } from "./video-evidence-sample"
export { visualBoundaries, MOTION_THRESHOLDS, motionVerdict, parseMotionYavg, measureMotion } from "./video-evidence-motion"
export type { VisualBoundary, MotionThresholds, MotionStats } from "./video-evidence-motion"
export { TRANSCRIPT_FORMAT, parseTranscript, readTranscript, wordsAt, phraseRanges } from "./video-evidence-transcript"
export type { TranscriptWord, FrameWords } from "./video-evidence-transcript"
export { YTDLP_HOME, YTDLP_BIN, ytDlpPrepareCommand, YtDlpUnavailableError, isVideoUrl, fetchVideo } from "./video-evidence-fetch"
