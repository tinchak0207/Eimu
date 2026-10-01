/**
 * 助理起手模板——顯示 metadata 入口（首屏只載入本目錄；2026-09-12 首屏減重拆分，
 * 2026-09-20 逐模板拆檔）。
 *
 * 卡面渲染所需欄位（標題/領域/痛點/漸變/海報/環節短名）留在本目錄各模板檔；
 * 大段執行文案（slots 六槽、initialPrompt、directive、步驟的
 * promptNotes/deliverable/inputFrom/gate/requiredTools）在同層
 * `agent-templates-payload/`，由使用處/回調 `await import()` 動態載入，
 * 經 `hydrateAgentTemplate(card)` 合併為 `AgentTemplateFull` 後再走
 * cropTemplate / templateToCanvasLayout / 注入鏈路。兩邊以模板 id +
 * 步驟索引對齊；hydrate 帶防呆，步數漂移即拋錯。
 * 禁止把執行文案加回本目錄——靜態 import 鏈會把它們再灌進 app/page chunk。
 *
 * 新增模板 = 加一個 `<slug>.ts`（卡面）+ 一個 payload 檔 + 兩邊 index 各一行。
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
 * H15（2026-10-02）題材 → 後端 workflow 模板映射護欄。
 * 病根：OP/MV 類（片頭曲/主題曲/卡點 MV/預告）被路由到 shortdrama_visual，整條鏈是 9:16 豎屏短劇骨架
 * （分鏡 9:16、鏡頭視頻 size=9:16、成片 9:16），與 OP/MV 橫屏母帶衝突；真實生產走的是 feature_film（16:9）。
 * repo 內沒有專用 MV 模板，feature_film（泛用多鏡頭、16:9 影片配置）是最貼近的橫屏模板。
 * 純函式：任何以題材文字決定 harnessTemplateId 的使用處，一律過這裡；非 MV/OP 題材原樣回傳。
 */
export const MV_OP_TOPIC_RE =
  /(?:\bMV\b|\bOP\b|\bED\b|\bPV\b|music\s*video|opening\s*(?:theme|song)|片头曲|片頭曲|片头|片頭|主题曲|主題曲|角色歌|卡点|卡點|音乐视频|音樂視頻|音樂影片|歌曲\s*MV)/i;

/** 橫屏 MV/OP 落點：repo 現有最貼近的橫屏模板。 */
export const MV_OP_HARNESS_TEMPLATE_ID = "feature_film";

/** 豎屏短劇模板 id（MV/OP 不得落此）。 */
export const VERTICAL_SHORTDRAMA_TEMPLATE_ID = "shortdrama_visual";

export function isMvOpTopic(text: string): boolean {
  return typeof text === "string" && MV_OP_TOPIC_RE.test(text);
}

/**
 * 依題材文字修正 harnessTemplateId：題材為 OP/MV 且候選落在 shortdrama_visual → feature_film（橫屏）。
 * 用戶明說「豎屏/竖屏/9:16」時尊重其意圖，不改寫。
 */
export function resolveHarnessTemplateId(candidateId: string | undefined, topicText: string): string | undefined {
  if (candidateId !== VERTICAL_SHORTDRAMA_TEMPLATE_ID) return candidateId;
  if (!isMvOpTopic(topicText)) return candidateId;
  if (/竖屏|豎屏|9\s*:\s*16|vertical/i.test(topicText)) return candidateId;
  return MV_OP_HARNESS_TEMPLATE_ID;
}
