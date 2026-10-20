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


export { GATEWAY, MusicToolError, musicPromptChainPath, probeMusicChannels, resolveKey } from "./music-tools/core"
export type { MusicChannelProbe, MusicChannelProbeStatus, MusicToolArgSpec, MusicToolContext, MusicToolDef, MusicToolResult } from "./music-tools/core"
export { musicGenTool } from "./music-tools/gen"
export type { LyriaMusicContract } from "./music-lyria"
export { buildLyriaStylePrompt } from "./music-lyria"
export { MUSIC_HARNESS_TOOL_IDS } from "./harness-tool-ids"
