// AI 助理空態快捷示例（首屏 chips）的唯一真源。
//
// 為什麼抽出來：2026-09-27 新人禮首登彈窗的主按鈕「马上生成第一张」要預填
// 「站上現有示例的第一條」——不自造示例句。清單留在 AgentChatPanel 裡的話，
// 彈窗只能再抄一份字串（兩處各自漂移，改一處忘一處就是顯示不一致）；
// 抽成這支常數模組後，聊天面板與彈窗引用同一份。
//
// 這支必須零依賴（不可 import 聊天面板）：首頁是靜態 import 它，而聊天面板
// 是 dynamic import 的（見 PromptInput 的 AgentChatSurface 懶載入）。

/** 空態快捷示例（點一下就發送，ChatGPT 同款模式）。 */
export const AGENT_EXAMPLE_PROMPTS = [
  "画一只戴帽子的橘猫，水彩风格",
  "让这瓶香水出现在落日海滩，自然光",
  "生成秦始皇骑北极熊的大电影",
] as const;

/** 示例 chips 的第一條（新人禮彈窗預填用）。 */
export const AGENT_FIRST_EXAMPLE_PROMPT = AGENT_EXAMPLE_PROMPTS[0];
