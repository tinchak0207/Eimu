/** 原创歌词专家：复用编剧 persona 的声明与交付装配契约。 */
import { collectLyricistDeliverableFromToolResult, type LyricistToolResult } from "./lyricist-delegate";
import type { ExpertDeliverable } from "./expert-contract";
export const LYRICIST_PERSONA_ID = "lyricist" as const;
export const LYRICIST_PERSONA_LABEL = "歌词专家" as const;
export const LYRICIST_PERSONA_DESCRIPTION = "原创填词与歌词精修：意象、叙事、修辞、韵律与可唱性；交付完整歌词。" as const;
// 最小可用文件工具白名单：read 读两份 skill／既有原词，write/edit 落盘完整歌词。
// 这三支是 opencode runtime 的原生文件工具真名（opencode.json 的 lyricist 行
// read/write/edit 均为 true），不含域生成工具（music_gen 明令禁止）。
// 文学资料搜索与子派遣属共享基建，不进入域工具联集（避免裁掉其他专家能力）。
export const LYRICIST_PERSONA_TOOL_IDS = ["read", "write", "edit"] as const;
export const LYRICIST_PERSONA_SKILL_PATHS = ["skills/lyricist/SKILL.md", "skills/fang-wenshan/SKILL.md"] as const;
export const LYRICIST_PERSONA_PROMPT = "你是歌词 Expert，只写歌词，不生成音频。开始任务先 read .opencode/skills/lyricist/SKILL.md，再 read .opencode/skills/fang-wenshan/SKILL.md。创作方法、演唱字数预算与评分只以这两份技能为准，不在本提示词另记公式，不心算 Z%。公开版没有歌词语料库，不伪造参考曲精读或全库查重通过。用既有文件工具保存完整歌词，返回 title / lyrics / hook / prosody_notes / qc / artifact_path 顶层 JSON；完整正文不受过程摘要 token 帽裁剪，不得调用 music_gen。" as const;
export const LYRICIST_REPLY_SUMMARY_TOKEN_CAP = 500 as const;
/** 文本交付与文学接收分开；与 runtime persona 和谱曲交接保持同一要求。 */
export const LYRICIST_LITERARY_ACCEPTANCE_DIRECTIVE = "【歌词交接】原创歌词以 lyricist 落盘全文为准，先 read 来源文件，不从摘要改写；正文问题回交 lyricist。用户锁定原词原样谱曲。字数与 Z% 只引用回执或确定性计算，不心算。预算、专辑与超长披露在 lyricist、fang-wenshan、music-director 技能里，不在本段展开。" as const;
export type LyricistDelegationReply = { ok: true; deliverable: ExpertDeliverable; lyricist_summary: string } | { ok: false; code: string; hint: string };
export function assembleLyricistReply(result: LyricistToolResult, context: Parameters<typeof collectLyricistDeliverableFromToolResult>[1]): LyricistDelegationReply {
  const assembled = collectLyricistDeliverableFromToolResult(result, context);
  if (!assembled.ok) return { ok: false, code: assembled.code, hint: assembled.hint };
  return { ok: true, deliverable: assembled.deliverable, lyricist_summary: `歌词文本已交付，文学质量须读全文验收；完整正文见 deliverable.payload.lyrics，文件：${assembled.deliverable.evidence.artifactPath}` };
}
export { LYRICIST_DELIVERABLES } from "./lyricist-delegate";
