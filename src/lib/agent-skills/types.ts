/**
 * Agent Skill（能力條目）——型別單一真源（2026-09-27 立）。
 *
 * 定位（與既有兩層的關係，禁造第二套 catalog）：
 * - `recipe-templates`   = 六槽參數快照（填進工作台表單的一組值）。
 * - `agent-templates`    = 起手模板（重：有 showcase 資產、8 環 pipeline、payload、門禁）。
 * - `agent-skills`（本層）= **輕量能力條目**：一句話說清「什麼場景／要你給什麼／交付什麼／
 *   可調用哪些 harness 工具／主責哪個 Expert」，可被列舉、可被搜尋、可被斜線直呼。
 *   條目可用 `templateId` 附掛到既有起手模板（= 這條 skill 有一條完整 pipeline 可跑），
 *   但**不複製**模板的 pipeline/payload 資料；附掛關係是引用，不是拷貝。
 *
 * 並行契約（同 agent-templates 2026-09-20 的做法）：一個 family 一個檔，
 * 由 `index.ts` 匯總。改一個題材家族只動一個檔。
 *
 * 硬約束（驗收會逐條斷言）：
 * 1. `toolIds` 每個 id 必須存在於 `harness-tool-registry.ts` 的 `HARNESS_TOOL_IDS`。
 * 2. `expertId` 必須存在於 `expert-registry.ts` 的 `EXPERT_REGISTRY`。
 * 3. `templateId` 若存在，必須存在於 `agent-templates` 的 `AGENT_TEMPLATES`。
 * 4. `aesthetic` 只寫**風格語言與流派特徵**（風格不受版權保護）；
 *    禁止寫「復刻《某片》某鏡」這類指向具體作品的畫面搬運指令。
 */

/**
 * 題材家族。與 LibTV 市集標籤對齊後收斂：專業影視 / 商業廣告 / 短劇漫劇 /
 * 動漫遊戲 / 自媒體創作 / 音樂 MV / 通用技能。
 */
export type AgentSkillFamily =
  | "cinema-auteur" // 電影美學·作者風格
  | "ad-tvc" // 商業廣告 TVC
  | "short-drama" // 短劇·漫劇
  | "script" // 劇本寫作
  | "storyboard" // 分鏡·鏡頭設計
  | "casting" // 選角·角色資產
  | "ugc" // UGC 帶貨·口播
  | "music-mv" // 音樂 MV
  | "travel-life" // 旅拍·Vlog·生活
  | "vfx-animation"; // 特效·動效·動畫

/** 這條 skill 的主交付形態。mixed = 一條鏈上多形態（文本→圖→視頻）。 */
export type AgentSkillOutputKind =
  | "image"
  | "text"
  | "video"
  | "audio"
  | "director"
  | "mixed";

export interface AgentSkillSpec {
  /** kebab-case，全庫唯一。前綴用家族短名，如 `cine-hopper-light`。 */
  id: string;
  /** 使用者看到的第一行：中文具名，短、具體、不堆術語。 */
  name: string;
  /** 一句話（≤ 24 漢字）：這條 skill 幹什麼。 */
  oneLiner: string;
  family: AgentSkillFamily;
  /** 選它的理由：適用場景。 */
  useScenario: string;
  /** 使用者要提供什麼（輸入面）。 */
  inputType: string;
  /** 交付什麼（產出面）。 */
  outputContent: string;
  outputKind: AgentSkillOutputKind;
  /** 這條 skill 可調用的 harness 工具 id（必須在 HARNESS_TOOL_IDS 內）。 */
  toolIds: readonly string[];
  /** 主責 Expert id（必須在 EXPERT_REGISTRY 內）。 */
  expertId?: string;
  /** 可選：附掛的既有起手模板 id（AGENT_TEMPLATES 內）。引用，非拷貝。 */
  templateId?: string;
  /** 檢索詞：風格名／流派／題材／拍攝手法，供斜線搜尋命中。 */
  tags: readonly string[];
  /**
   * 美學錨（可選）：風格語言與流派特徵。例如「低照度自然光、固定機位、
   * 大量留白的中景」；**不寫具體作品的畫面搬運指令**。
   */
  aesthetic?: string;
}
