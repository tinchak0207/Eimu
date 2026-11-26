/**
 * Agent Skill（能力条目）——型别单一真源（2026-09-27 立）。
 *
 * 定位（与既有两层的关系，禁造第二套 catalog）：
 * - `recipe-templates`   = 六槽参数快照（填进工作台表单的一组值）。
 * - `agent-templates`    = 起手模板（重：有 showcase 资产、8 环 pipeline、payload、门禁）。
 * - `agent-skills`（本层）= **轻量能力条目**：一句话说清「什么场景／要你给什么／交付什么／
 *   可调用哪些 harness 工具／主责哪个 Expert」，可被列举、可被搜寻、可被斜线直呼。
 *   条目可用 `templateId` 附挂到既有起手模板（= 这条 skill 有一条完整 pipeline 可跑），
 *   但**不复制**模板的 pipeline/payload 资料；附挂关系是引用，不是拷贝。
 *
 * 并行契约（同 agent-templates 2026-09-20 的做法）：一个 family 一个档，
 * 由 `index.ts` 汇总。改一个题材家族只动一个档。
 *
 * 硬约束（验收会逐条断言）：
 * 1. `toolIds` 每个 id 必须存在于 `harness-tool-registry.ts` 的 `HARNESS_TOOL_IDS`。
 * 2. `expertId` 必须存在于 `expert-registry.ts` 的 `EXPERT_REGISTRY`。
 * 3. `templateId` 若存在，必须存在于 `agent-templates` 的 `AGENT_TEMPLATES`。
 * 4. `aesthetic` 只写**风格语言与流派特征**（风格不受版权保护）；
 *    禁止写「复刻《某片》某镜」这类指向具体作品的画面搬运指令。
 */

/**
 * 题材家族。与 LibTV 市集标签对齐后收敛：专业影视 / 商业广告 / 短剧漫剧 /
 * 动漫游戏 / 自媒体创作 / 音乐 MV / 通用技能。
 */
export type AgentSkillFamily =
  | "cinema-auteur" // 电影美学·作者风格
  | "ad-tvc" // 商业广告 TVC
  | "short-drama" // 短剧·漫剧
  | "script" // 剧本写作
  | "storyboard" // 分镜·镜头设计
  | "casting" // 选角·角色资产
  | "ugc" // UGC 带货·口播
  | "music-mv" // 音乐 MV
  | "travel-life" // 旅拍·Vlog·生活
  | "vfx-animation"; // 特效·动效·动画

/** 这条 skill 的主交付形态。mixed = 一条链上多形态（文本→图→视频）。 */
export type AgentSkillOutputKind =
  | "image"
  | "text"
  | "video"
  | "audio"
  | "director"
  | "mixed";

export interface AgentSkillSpec {
  /** kebab-case，全库唯一。前缀用家族短名，如 `cine-hopper-light`。 */
  id: string;
  /** 使用者看到的第一行：中文具名，短、具体、不堆术语。 */
  name: string;
  /** 一句话（≤ 24 汉字）：这条 skill 干什么。 */
  oneLiner: string;
  family: AgentSkillFamily;
  /** 选它的理由：适用场景。 */
  useScenario: string;
  /** 使用者要提供什么（输入面）。 */
  inputType: string;
  /** 交付什么（产出面）。 */
  outputContent: string;
  outputKind: AgentSkillOutputKind;
  /** 这条 skill 可调用的 harness 工具 id（必须在 HARNESS_TOOL_IDS 内）。 */
  toolIds: readonly string[];
  /** 主责 Expert id（必须在 EXPERT_REGISTRY 内）。 */
  expertId?: string;
  /** 可选：附挂的既有起手模板 id（AGENT_TEMPLATES 内）。引用，非拷贝。 */
  templateId?: string;
  /** 检索词：风格名／流派／题材／拍摄手法，供斜线搜寻命中。 */
  tags: readonly string[];
  /**
   * 美学锚（可选）：风格语言与流派特征。例如「低照度自然光、固定机位、
   * 大量留白的中景」；**不写具体作品的画面搬运指令**。
   */
  aesthetic?: string;
}
