/**
 * composeEngine — 剪辑导出引擎 v2（替代 videoCompose 的剪辑路径；
 * videoCompose 保留给画布 TimelinePanel 旧调用）。
 *
 * 分步落盘（filter_complex 过长不可调试，每步独立可排错）：
 *   Pass1 逐段归一化：trim → 变速(setpts+atempo链/曲线分段) → 倒放 →
 *          翻转/旋转 → eq 调色 → 统一分辨率/帧率
 *   Pass2 拼接：全 cut 走 concat demuxer（copy），含转场走 xfade 链
 *   Pass3 合成主命令：PiP overlay（x/y 关键帧→t 分段线性表达式；
 *          缩放/透明度取静态值，见注释）→ 花字/特效 PNG 序列 overlay →
 *          音频图（adelay/afade/amix/loudnorm/afftdn）→ ASS 字幕 → 码率编码
 *
 * 已知近似（注释级声明，UI 提示同步）：
 * - 关键帧动画导出支持 x/y 位移；scale/opacity 取片段静态值（首关键帧）
 * - 曲线变速离散为 ≤6 段恒速拼接，总时长不变
 * - 花字/特效按成片画幅尺寸渲染，和最终合成尺寸保持一致
 */

export type { ComposeProgress, ExportStrategy, ExportAnalysis, RenderedVideoProbe, RenderedVideoExpectation } from './compose-engine-types';
export { hasVideoToolbox, finalVideoEncodeArgs } from './compose-engine-timeline';
export { analyzeEditorExport, probeRenderedVideo, runFfmpegWithProgress, exportSelectedMainClips, composeEditorTimeline } from './compose-engine-flow';
