/**
 * 助理起手模板——显示 metadata 入口（首屏只载入本目录；2026-09-12 首屏减重拆分，
 * 2026-09-20 逐模板拆档）。
 *
 * 卡面渲染所需栏位（标题/领域/痛点/渐变/海报/环节短名）留在本目录各模板档；
 * 大段执行文案（slots 六槽、initialPrompt、directive、步骤的
 * promptNotes/deliverable/inputFrom/gate/requiredTools）在同层
 * `agent-templates-payload/`，由使用处/回调 `await import()` 动态载入，
 * 经 `hydrateAgentTemplate(card)` 合并为 `AgentTemplateFull` 后再走
 * cropTemplate / templateToCanvasLayout / 注入链路。两边以模板 id +
 * 步骤索引对齐；hydrate 带防呆，步数漂移即抛错。
 * 禁止把执行文案加回本目录——静态 import 链会把它们再灌进 app/page chunk。
 *
 * 新增模板 = 加一个 `<slug>.ts`（卡面）+ 一个 payload 档 + 两边 index 各一行。
 */

import type { AgentTemplate, AgentTemplateDomain } from "./types";
import { artCurationSeriesCard } from "./art-curation-series";
import { artStyleImmersionCard } from "./art-style-immersion";
import { ecommerceLaunchPackCard } from "./ecommerce-launch-pack";
import { ecommerceModelGridCard } from "./ecommerce-model-grid";
import { novelFilmPipelineCard } from "./novel-film-pipeline";
import { novelIpVisualPackCard } from "./novel-ip-visual-pack";
import { shortdramaPosterLineCard } from "./shortdrama-poster-line";
import { shortdramaVisualAssetsCard } from "./shortdrama-visual-assets";

export type {
  AgentTemplate,
  AgentTemplateDomain,
  AgentPipeline,
  AgentPipelineStep,
} from "./types";

export {
  artCurationSeriesCard,
  artStyleImmersionCard,
  ecommerceLaunchPackCard,
  ecommerceModelGridCard,
  novelFilmPipelineCard,
  novelIpVisualPackCard,
  shortdramaPosterLineCard,
  shortdramaVisualAssetsCard,
};

export const AGENT_TEMPLATE_DOMAIN_LABELS: Record<AgentTemplateDomain, string> = {
  novel: "小说",
  ecommerce: "电商",
  shortdrama: "短剧",
  art: "艺术",
};

/**
 * 范式来源（2026-08-25 双源交叉验证，仅 GitHub 通道 + Grok 调研答案 docs/grok-sota-pipeline-answer.md）：
 * 主干（双源互证，可信）：四领域共性骨架「文本结构化(JSON)→资产先行(角色/产品/风格 bible)→门禁审核(相似度阈值/人工批准)→组装产出」。
 * - novel/shortdrama：HVision-NKU/StoryDiffusion(6452★,一致性模块)、smthemex/ComfyUI_StoryDiffusion(514★)、
 *   ChrisChen667788/wind-comic(452★：Style Bible 关键帧 sref 锚/三视图+DNA 签名/sketch-lock+Vision Audit<70 分重生/
 *   global_assets embedding 身份漂移检测)、chenning9821/Agentic-Novel-Cinema(10-agent 链：NovelParser→CanonBuilder→
 *   Screenplay→Storyboard→PromptDirector 风格锁→AssetAgent 角色锚点包→ContinuityJudge QC→Repair)、
 *   drasstry/shortdrama-pipeline(113★：「剧本批准才生成人物，人物批准才生成视频」门禁状态机)、
 *   wushaojun321/ai-short-film(LLM 分镜+逐镜生成)。Grok 补充：情绪时序链「听见→停顿→眼神→表情→说话」(标注推断)。
 * - ecommerce：xiaoqahax-ui/comfyui-ecommerce-workflows(product-bg-replace=ControlNet Canny+IP-Adapter+RMBG/
 *   ai-model-tryon=OpenPose+Inpainting/product-detail-layout/batch-processor,ESRGAN≥2048)、
 *   ArifAhmed1995/ecommerce_sdxl(SDXL+LoRA 模特图)、aws-samples/sample-ai-powered-product-catalog、
 *   ayazmhmd Flux-UNO 虚拟试穿。Grok 补充：Product Lock/产品 DNA JSON、负空间 CTA 版(标注推断)。
 * - art：Google StyleAligned(注意力共享风格对齐)、illo-skill(~353★,Grok 标注)、jashan-web/awesome-gpt4o-images、
 *   tiktomato/awesome-seedream-prompts(220 条三语风格库)。策展完整拓扑 Grok 自注「多为推断」，主干取 wind-comic
 *   Style Bible Frame 迁移 + StyleAligned 论文范式。
 */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  // ———— 小说 ————
  novelFilmPipelineCard,
  novelIpVisualPackCard,
  // ———— 电商 ————
  ecommerceLaunchPackCard,
  ecommerceModelGridCard,
  // ———— 短剧 ————
  shortdramaVisualAssetsCard,
  shortdramaPosterLineCard,
  // ———— 艺术 ————
  artCurationSeriesCard,
  artStyleImmersionCard,
];

/**
 * H15（2026-10-02）题材 → 后端 workflow 模板映射护栏。
 * 病根：OP/MV 类（片头曲/主题曲/卡点 MV/预告）被路由到 shortdrama_visual，整条链是 9:16 竖屏短剧骨架
 * （分镜 9:16、镜头视频 size=9:16、成片 9:16），与 OP/MV 横屏母带冲突；真实生产走的是 feature_film（16:9）。
 * repo 内没有专用 MV 模板，feature_film（泛用多镜头、16:9 影片配置）是最贴近的横屏模板。
 * 纯函式：任何以题材文字决定 harnessTemplateId 的使用处，一律过这里；非 MV/OP 题材原样回传。
 */
export const MV_OP_TOPIC_RE =
  /(?:\bMV\b|\bOP\b|\bED\b|\bPV\b|music\s*video|opening\s*(?:theme|song)|片头曲|片头曲|片头|片头|主题曲|主题曲|角色歌|卡点|卡点|音乐视频|音乐视频|音乐影片|歌曲\s*MV)/i;

/** 横屏 MV/OP 落点：repo 现有最贴近的横屏模板。 */
export const MV_OP_HARNESS_TEMPLATE_ID = "feature_film";

/** 竖屏短剧模板 id（MV/OP 不得落此）。 */
export const VERTICAL_SHORTDRAMA_TEMPLATE_ID = "shortdrama_visual";

export function isMvOpTopic(text: string): boolean {
  return typeof text === "string" && MV_OP_TOPIC_RE.test(text);
}

/**
 * 依题材文字修正 harnessTemplateId：题材为 OP/MV 且候选落在 shortdrama_visual → feature_film（横屏）。
 * 用户明说「竖屏/竖屏/9:16」时尊重其意图，不改写。
 */
export function resolveHarnessTemplateId(candidateId: string | undefined, topicText: string): string | undefined {
  if (candidateId !== VERTICAL_SHORTDRAMA_TEMPLATE_ID) return candidateId;
  if (!isMvOpTopic(topicText)) return candidateId;
  if (/竖屏|竖屏|9\s*:\s*16|vertical/i.test(topicText)) return candidateId;
  return MV_OP_HARNESS_TEMPLATE_ID;
}
