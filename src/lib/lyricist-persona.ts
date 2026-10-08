/** 原创歌词专家：复用编剧 persona 的声明与交付装配契约。 */
import { collectLyricistDeliverableFromToolResult, type LyricistToolResult } from "./lyricist-delegate";
import type { ExpertDeliverable } from "./expert-contract";
export const LYRICIST_PERSONA_ID = "lyricist" as const;
export const LYRICIST_PERSONA_LABEL = "歌词专家" as const;
export const LYRICIST_PERSONA_DESCRIPTION = "原创填词与歌词精修：意象、叙事、修辞、韵律与可唱性；交付完整歌词。" as const;
// 文件读写、文学资料搜索和子派遣为共享基建，不能进入域工具联集裁掉其他专家能力。
export const LYRICIST_PERSONA_TOOL_IDS: readonly string[] = [];
export const LYRICIST_PERSONA_SKILL_PATHS = ["skills/lyricist/SKILL.md", "skills/fang-wenshan/SKILL.md"] as const;
export const LYRICIST_PERSONA_PROMPT = "你是歌词 Expert，只写歌词，不生成音频。开始任务先 read .opencode/skills/lyricist/SKILL.md，再 read .opencode/skills/fang-wenshan/SKILL.md，采用后者的创作工作流与相关手法卡；前者只适配路径、原词保留和产品交付格式。公开版没有歌词语料库，不伪造参考曲精读或全库查重通过。用既有文件工具保存完整歌词，返回 title / lyrics / hook / prosody_notes / qc / artifact_path 顶层 JSON；完整正文不受过程摘要 token 帽裁剪，不得调用 music_gen。" as const;
export const LYRICIST_REPLY_SUMMARY_TOKEN_CAP = 500 as const;
/** 文本交付与文学接收分开；与 runtime persona 和谱曲交接保持同一要求。 */
export const LYRICIST_LITERARY_ACCEPTANCE_DIRECTIVE = "【歌词文学接收与谱曲交接】歌词创作采用 .opencode/skills/fang-wenshan/SKILL.md 的上游方法。原创歌词交给 music 前 read 完整歌词；发现具体正文问题时引用唱句及影响，回交 lyricist 定向修订。ok:true、交付字段、qc 与上游评分卡均不能代替作品验收；公开版没有 lyrics/catalog，不能宣称完成全库查重。交接完整正文与文件路径，music 不从摘要重写歌词。用户提供完整原词且未要求精修时原样谱曲；没有真实旋律时，可唱性评分仅为文字自评。" as const;
export type LyricistDelegationReply = { ok: true; deliverable: ExpertDeliverable; lyricist_summary: string } | { ok: false; code: string; hint: string };
export function assembleLyricistReply(result: LyricistToolResult, context: Parameters<typeof collectLyricistDeliverableFromToolResult>[1]): LyricistDelegationReply {
  const assembled = collectLyricistDeliverableFromToolResult(result, context);
  if (!assembled.ok) return { ok: false, code: assembled.code, hint: assembled.hint };
  return { ok: true, deliverable: assembled.deliverable, lyricist_summary: `歌词文本已交付，文学质量须读全文验收；完整正文见 deliverable.payload.lyrics，文件：${assembled.deliverable.evidence.artifactPath}` };
}
export { LYRICIST_DELIVERABLES } from "./lyricist-delegate";
