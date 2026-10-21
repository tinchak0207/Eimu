/** 允许选择的文件类型；列表与网关约定一致，避免上传后无法解析的格式。 */
export const ACCEPTED_TYPES = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".xml",
  ".yaml",
  ".yml",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".mp4",
  ".mov",
  ".zip",
  // 音频附件（本地参考素材）：与闸道 ALLOWED_UPLOAD_EXTS 音频项对齐。
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
].join(",");

/**
 * 罪状 2b：上传 413 无声标红。单请求体上限 = Vercel 平台硬顶 4.5MB
 * （attachments 路由只是透传代理，代码层无法调高平台限制），留出 multipart
 * 边界等开销后按 4MB 预检。超限文件在上传前就地给出人话错误，不再等 413。
 * 影片／音频豁免此闸：原片走网关直传（uploadVideoDirect / uploadAudioDirect，
 * 绕开 Vercel），上限改用网关的 100MB（MAX_VIDEO_BYTES）。
 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * 音频副档名（本地参考素材，如一首真歌当翻唱 source_audio）。与闸道
 * `ALLOWED_UPLOAD_EXTS` 的音频项同一份语义、与 `ACCEPTED_TYPES` 对齐；
 * MIME 优先、副档名兜底（部分系统给空 MIME）。这类档走大档直传而非小档路。
 */
const AUDIO_FILE_EXTS = /\.(mp3|wav|m4a|aac|flac|ogg)$/i;

/** 判断一个 File 是否要走音频大档直传路径（与 isVideoFile 同款 MIME 优先、副档名兜底）。 */
export function isAudioFile(file: { type?: string; name?: string }): boolean {
  if (file.type?.startsWith("audio/")) return true;
  return AUDIO_FILE_EXTS.test(file.name ?? "");
}

/**
 * 上传等待的硬上限（缺陷 A 修复）。底层 fetch（原片直传 agent-uploads、站内
 * 代理 agent-chat-client）都没有 timeout、也没有 signal：高负载下请求可以一直
 * 在途不结束，附件 chip 就永久停在 uploading（实测 38MB 影片直传 150s+ 不落地）。
 * 到点视为逾时，让 chip 落明确终态。
 *
 * 值：原片可能数十 MB，取 3 分钟——38MB 在 0.25MB/s（约 2Mbps）的悲观上行也只要
 * ~152s，正常上传不会被误杀；同时把病态「永不完成」的请求挡在 180s。衍生档／
 * 关键帧只有几 MB 且走站内代理，60s 已极宽裕。
 */
export const VIDEO_UPLOAD_TIMEOUT_MS = 180_000;

export const DERIVED_UPLOAD_TIMEOUT_MS = 60_000;

/**
 * 非影片附件（普通文件）的等待硬上限。这条路走站内代理 `uploadAgentAttachments`，
 * 没有直传/抽帧降级链，卡住就只能永久停在 uploading。文件经 4MB 站内上限闸
 * （MAX_FILE_BYTES，见 enqueueFiles），几 MB 的档在悲观上行也只需数十秒；60s
 * 与衍生档同档，足够正常上传又不让病态请求无限挂起。逾时落 UploadTimeoutError，
 * 由 enqueueFiles 的 job.catch 写成带人话的 error chip（不静默消失）。
 */
export const PLAIN_UPLOAD_TIMEOUT_MS = 60_000;

/** 逾时专用错误：调用端据此区分「网络失败（可静默降级）」与「逾时（必须给人话）」。 */
export class UploadTimeoutError extends Error {
  constructor() {
    super("上传超时，请重试。");
    this.name = "UploadTimeoutError";
  }
}

/**
 * 给没有 signal 的等待加 deadline：到点 reject(UploadTimeoutError)，晚到的结果被丢弃。
 * 与 SEND_HARD_TIMEOUT_MS 同一姿势——时到必解锁，宁可让用户重试也不做假死状态。
 */
export function withUploadDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UploadTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 字节数 → 展示 MB（一位小数，四舍五入）。 */
export function formatMb(bytes: number): string {
  return (Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1);
}

/**
 * 送出锁的硬保险上限（20s）。relay 路径的 fetch 没有 timeout，请求卡死时
 * 不能把送出钮永久锁死——到点无条件解锁，宁可让用户重试也不做假死按钮。
 *
 * 2026-09-18 起面板层（AgentChatPanel 的「本轮还没开始」在途态）沿用同一个值，
 * 两处寿命一致：这里锁的是输入区自己的投递，那边锁的是面板在等的本轮开始。
 */
export const SEND_HARD_TIMEOUT_MS = 20_000;
