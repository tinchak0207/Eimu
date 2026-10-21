/**
 * Music Prompt Director — 规则层音乐提示词导演。
 *
 * 用户的短 prompt 在进上游之前被这层自动「导演化」：侦测六层风格公式
 * (GENRE + MOOD + INSTRUMENTATION + VOCAL + STRUCTURE + PRODUCTION) 的缺漏
 * 并补齐中性指令、把 `[BPM: 120]` 这类所有平台都不解析的伪装参数改写成散文、
 * 把空泛／缺陷词换成库内有依据的具体语汇、修剪超过两个的 MOOD，最后依目标
 * 通路执行硬规则：flowmusic 剥除死掉的时间戳、**把决定性参数（BPM／调性／和弦
 * 进行／段落结构）整句前移到 GENRE 之后**（上游 sound_prompt 摘要只保前段，
 * 2026-10-04 G1/G3）、无歌词标签时压成单行并压进 220 runes
 * （超限先丢低权重描述性修饰子句，仍超才硬截——硬截尽量用满预算：
 * 先取前 cap runes，≥60% cap 有子句边界才退、否则退到最后空白或就地切）；
 * lyria 保留官方时间戳、不设 220 上限；yue2 剥除时间戳（YuE2 不认时间戳结构控制）但
 * **保留 [Verse]/[Chorus] 段落标签**（那是歌词栏必需语法）、允许换行、上限 600 runes（超出按权重丢低优先层）。
 * 全程在后端发生，用户无感。
 *
 * 知识来源：SunoForge v3.0 配方库（repo `skills/music-director/files/`，MIT，
 * 上游 sanic732/SunoForge）＋本专案对生产通路 FlowMusic2API 的实测
 * （`DATA_FLOWMUSIC_2026-09.md`，2026-09-11，n=3×2 clips）。每个规则对应
 * 一项「某种音乐 prompt 为什么会挂」的生产事实，注释逐条引用来源档行号。
 *
 * 两处刻意的「不建」——库无依据就留空，禁止发明：
 *   1. 同义词陷阱（homograph）表：库的四档里没有任何音乐域同义词／双义词条目
 *      （grep 无 homograph/synonym/ambiguity 条目），故 HOMOGRAPH_FIXES 留空。
 *   2. 中文空泛词（好听／震撼…）：库内无对应词条或替换目标，未建替换表。
 *   3. 中文侦测词表同理：六层侦测用库内英文词条＋DATA_FLOWMUSIC 的方括号
 *      段落标签；纯中文用词侦测不到时，layers 如实回报 false 并补中性指令。
 *
 * 零依赖（同 `music-lyria.ts` 惯例）：VPS 落位档必须自足，本档不 import 任何模组。
 */


export type { MusicChannel, MusicLayerId, MusicDirectorOptions, MusicDirectorResult, PromptCheck, RetainedPromptInfo } from "./music-prompt-director/rules-core";
export { MUSIC_LAYER_IDS } from "./music-prompt-director/rules-core";
export { MUSIC_LAYER_LABELS, describeRetainedLayers, describeRetainedParts, directMusicPrompt, evaluatePromptChecks, stripLyricsTimestamps } from "./music-prompt-director/rules-transform";
