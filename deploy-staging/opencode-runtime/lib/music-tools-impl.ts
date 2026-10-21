// <harness-only>
/**
 * music_gen harness 工具 VPS staging 稿（MOE Wave1 片B，2026-09-08 机械导出）。
 *
 * 本档由 tools/export-music-tools-staging.ts 从行为真源 src/lib/music-tools.ts
 * 机械导出：真源全文逐行保留（工具定义/ok-fail/resolveKey/ffprobe 时长/上传通路
 * 全在），除「环境适配」外与真源逐行等价。
 * 白名单 diff 仅六处：① 本注释头；②③④⑤⑥ 真源 `from "./music-lyria"` → `from "./music_lyria"`、
 * `from "./music-flowmusic"` → `from "./music_flowmusic"`、
 * `from "./music-prompt-director"` → `from "./music_prompt_director"`、
 * `from "./music-yue2"` → `from "./music_yue2"` 与
 * `from "./music-take-entropy"` → `from "./music_take_entropy"`（同目录落位档名惯例）。
 * 禁止手改本档——改真源后跑 `npx tsx tools/export-music-tools-staging.ts` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music-tools-impl.ts
 * env：GATEWAY_URL（默认 http://127.0.0.1:8081）、HARNESS_API_KEY（fallback）、
 *      GEMINI_STUDIO_API_KEY（lyria-3.5 generateContent 主 key，音频落盘经 gateway 会话上传存储）、
 *      GEMINI_API_KEY（Vertex lyria-002 降级）、FLOWMUSIC_ADMIN_USER／FLOWMUSIC_ADMIN_PASSWORD
 *      （FlowMusic 真鉴权探针 /api/tokens/1/refresh-credits 用；缺失时探针降级为 unreachable 提示）。
 */
// </harness-only>

/**
 * music_gen harness 工具（MOE 改革 Wave1 片B 音乐 Expert，2026-09-08）。
 *
 * 定义形状同构 src/lib/blender-tools.ts 的 BlenderToolDef（零依赖：
 * { id, description, args, execute } + ok()/fail() 契约，回 { title, output }，
 * output 为 JSON 字串）；ok/fail 与 resolveKey 逐行同构
 * src/vendor-bridges/lib/director-common.ts（VPS 落位范式：gateway
 * /internal/session-key 解 Bearer key，fallback env HARNESS_API_KEY）。
 *
 * 生成通路：Google Lyria（src/lib/music-lyria.ts，Gemini API v1beta/interactions，
 * env GEMINI_API_KEY）。duration_hint=full → lyria-3.5（整歌 ~3 分钟）；
 * clip30 → lyria-3-clip-preview（固定 30 秒）。无歌词默认按纯器乐处理
 * （官方写法 "Instrumental only, no vocals."），需要人声必须提供歌词。
 *
 * prompt 规则层：buildToolPrompt 组出完整文本（含器乐声明）后，最后一关过
 * src/lib/music-prompt-director.ts 的 directMusicPrompt（伪标签/时间戳剥除、
 * 六层补齐、通路长度上限），回执 prompt_director 如实回报改写/警告/截断。
 * 顺序不可颠倒：220 runes 上限要算进器乐声明等所有字元。
 *
 * 音频资产通路（复用既有 gateway 平台存储，与影片/TTS 同域）：生成成功的音频经
 * gateway 素材入库端点 POST {GATEWAY}/internal/media/upload?session_id=<id> 落盘
 * （JSON body {path_b64, filename}，鉴权 = session_id 解析＋loopback 门，请求形状同
 * tools/video_upload.ts），回应 url 即平台公网直连 URL
 * （https://store.tinchak0207.xyz/image-data/files/uploads/<name>），直接交付。
 * uploadOverride 允许 VPS 接线时整体替换上传入口（备用）。
 *
 * 时长：ffprobe 实测（同 audio_first_timeline 片4 先例，沙箱有 ffprobe）；
 * ffprobe 不可用时回退 model_hint（full≈180s / clip30=30s）并如实标注
 * duration_source，绝不把估算冒充实测。
 *
 * 错误铁律（同 blender-tools）：所有失败一律结构化 fail()，含人话 hint 与
 * 底层原因，绝不 throw 原始错误逃逸、绝不吞错。
 * 工具文案一律简体（记忆 agent-gateway-copy-rules）。
 */

import { buildLyriaStylePrompt, type LyriaMusicContract } from "./music_lyria"

export { GATEWAY, MusicToolError, resolveKey } from "./music-tools-impl-core"
export type { MusicToolArgSpec, MusicToolContext, MusicToolDef, MusicToolResult } from "./music-tools-impl-core"
export { musicPromptChainPath } from "./music-tools-impl-core"
export { MAX_SOURCE_AUDIO_BYTES, resolveSourceAudio } from "./music-tools-impl-source-audio"
export type { SourceAudioResolution, SourceAudioResolveResult } from "./music-tools-impl-source-audio"
export { probeMusicChannels } from "./music-tools-impl-probe"
export type { MusicChannelProbe, MusicChannelProbeStatus } from "./music-tools-impl-probe"
export { musicGenTool } from "./music-tools-impl-tool"
/** 情绪契约组装导出（Expert spec 模板用：orchestrator 心意 → 契约 → prompt）。 */
export type { LyriaMusicContract }
export { buildLyriaStylePrompt }

/** harness-tool-registry.ts 登记用 id 元组（同 BLENDER_HARNESS_TOOL_IDS 范式）。 */
export const MUSIC_HARNESS_TOOL_IDS = ["music_gen"] as const
