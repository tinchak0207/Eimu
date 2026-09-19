/**
 * Agent 提示詞契約目錄（吞 AID 產品層單向差，刀 3-③，2026-09-15）。
 *
 * 結構範式參考：gzxx-2025/aid-server（MIT，copyright 光子讯息(杭州)科技有限公司）
 * `doc/提示词开发指南.md`（27 份契約：用途／輸入（占位符表）／輸出（形態＋頂層鍵＋
 * 欄位表）／開發要點／AI 生成指引 + 五條通用硬規則）。**本檔只借用結構範式，
 * 全部內容為我方自有**——八個 Expert 的職責、輸入欄位、輸出欄位一律從現場代碼
 * 讀出（persona／delegate／registry），沒有一項取自 AID。
 *
 * 口徑（現場取證，2026-09-15）：
 *   - `inputMode` 八個 Expert 一律 `"user_message"`：我方沒有 system prompt
 *     占位符替換通道，委託單是主腦以用戶消息遞給子代理的（gateway 原樣透傳
 *     `compose*Delegation(...).serialized` 或 `assemble*Prompt(...).prompt`）。
 *     故 `placeholders` 記錄的是「委託單 user message 欄位表」（AID 對 user_message
 *     類 agent 也是這樣記：輸入欄位表而非 `{xxx}` 表）。
 *   - `outputMode` / `topLevelKeys` / `fields` 描述的是**工具回執 JSON 的頂層契約**
 *     —— 即各 `*-delegate.ts` 的 `collect*DeliverableFromToolResult` 實際
 *     `JSON.parse` 後逐鍵查驗的那一層（`ok` 必為 true + 域必填鍵）。payload 欄位
 *     （registry `requiredFields`）在回執頂層不保證出現（由 collect 組裝），故列為
 *     `required: false` 並在 meaning 標明來源，不冒充必填。
 *   - director3d（`blender-director-persona.ts`）**無模型層 JSON 契約**：
 *     blender-delegate.ts 全檔 0 處 `JSON.parse`，產物分揀吃的是 bridge 回傳物件
 *     （`BlenderExecuteSuccess`），模型輸出是散文。依實情標 `structured_text`
 *     且 `fields: []`，缺口寫進 `pitfalls`。
 *
 * 硬規則（照 AID §二 通用硬規則，機械檢查見 agent-prompt-contract-check.ts）：
 *   ① 純 JSON：整段合法 JSON、首字符 `{`/`[`，禁前後說明/圍欄/註釋；
 *   ② 字符串值內引號用「」，禁未轉義英文雙引號；
 *   ③ 私有協議標記原樣保留（我方的標記＝回執鍵名與委託單段落標題）；
 *   ④ 必填欄位缺失即判失敗（不要的內容寫「无」或空數組，**不省略欄位**）；
 *   ⑤ 改提示詞不改契約：語氣／規則可調，輸入欄位、輸出結構、協議標記動了就斷鏈路。
 *
 * 本檔零運行時邏輯（純常量 + 一個查表函數）；改契約必同步改 *_delegate.ts 與
 * expert-registry 的 `deliverableContract`（三處同源，禁各抄一份）。
 */

import { DIRECTOR_PERSONA_DESCRIPTION } from "./blender-director-persona";
import { CRITIC_PERSONA_DESCRIPTION } from "./critic-persona";
import { EDITOR_PERSONA_DESCRIPTION } from "./editor-persona";
import { MOTION_DIRECTOR_PERSONA_DESCRIPTION } from "./motion-director-persona";
import { MUSIC_DIRECTOR_PERSONA_DESCRIPTION } from "./music-director-persona";
import { SCREENWRITER_PERSONA_DESCRIPTION } from "./screenwriter-persona";
import { VIDEO_DIRECTOR_PERSONA_DESCRIPTION } from "./video-director-persona";
import { WEB3D_DIRECTOR_PERSONA_DESCRIPTION } from "./web3d-director-persona";

// ─────────────────────────────────────────── 契約型別（結構照 AID）

/** 輸入欄位（user message 欄位表項；我方無 `{xxx}` 占位符通道）。 */
export interface PromptPlaceholder {
  /** 欄位名（委託單 JSON 鍵名，逐字不可改）。 */
  name: string;
  /** 含義（從 delegate 的 JSDoc／校驗讀出）。 */
  meaning: string;
  /** 來源（誰注入：主腦委託單／畫布節點／附件 path／URL…）。 */
  source: string;
}

/** 輸出欄位（工具回執頂層契約欄位表項）。 */
export interface PromptField {
  name: string;
  /** 型別（boolean／string／number／string[]／object[]）。 */
  type: string;
  /** true = collect 實際強制該鍵在回執頂層出現，缺即 missing_deliverables。 */
  required: boolean;
  meaning: string;
}

export interface AgentPromptContract {
  /** 我方 Expert id（＝ expert-registry 鍵，如 "screenwriter"）。 */
  agentCode: string;
  /** 一句話職責（取 persona DESCRIPTION 常量，單一真源）。 */
  purpose: string;
  inputMode: "placeholder" | "user_message";
  placeholders: PromptPlaceholder[];
  outputMode: "json" | "structured_text";
  /** 回執 JSON 頂層鍵（json 模式；structured_text 為空陣列）。 */
  topLevelKeys: string[];
  fields: PromptField[];
  /** 不可動的常量（必現在檢查文本中的鍵名／協議標記）。 */
  frozenConstants: string[];
  /** 常見出錯點。 */
  pitfalls: string[];
}

// ─────────────────────────────────────────── 共用欄位表片段

/** 工具回執成功位（七個 delegate 一律 `parsed.ok !== true` 即判未交付）。 */
const FIELD_OK: PromptField = {
  name: "ok",
  type: "boolean",
  required: true,
  meaning: "工具回執成功位：必須存在且為 true（值判定由 collect 執行；false = 未交付，禁拿失敗回執組裝交付物）。",
};

/** 交付物指針二選一（artifact_path／url）——機械檢查器不表達二選一，如實標非必填。 */
const FIELD_ARTIFACT_PATH: PromptField = {
  name: "artifact_path",
  type: "string",
  required: false,
  meaning: "交付物本地/相對路徑指針（與 url 二選一，至少一項；二選一由 collect 強制，非本鍵單獨必填）。",
};

const FIELD_URL_OPT: PromptField = {
  name: "url",
  type: "string",
  required: false,
  meaning: "交付物公網 URL 指針（與 artifact_path 二選一，至少一項）。",
};

// ─────────────────────────────────────────── 契約目錄

/**
 * 八個 Expert 的提示詞契約（agentCode = expert-registry 註冊鍵；EXPERT_IDS 八值全覆蓋）。
 * 順序與 expert-registry.EXPERT_REGISTRY 宣告序一致（director3d → critic）。
 */
export const AGENT_PROMPT_CONTRACTS: readonly AgentPromptContract[] = [
  {
    agentCode: "director3d",
    purpose: DIRECTOR_PERSONA_DESCRIPTION,
    // 委託單以序列化 JSON 文本作 prompt（blender-director-persona.ts
    // composeDirectorDelegationPrompt OFF 分支回 composed.serialized），非占位符替換。
    inputMode: "user_message",
    placeholders: [
      { name: "effect_description", meaning: "效果描述（一句話人話，3D 導演據此自主拆解 bpy 腳本）。", source: "主腦委託單（user message）" },
      { name: "shot_count", meaning: "鏡頭數（整數 1-12；超界結構化報錯）。", source: "主腦委託單（user message）" },
      { name: "deliverables", meaning: "交付物清單（白名單 turntable/stills/blend/glb）。", source: "主腦委託單（user message）" },
      { name: "duration_sec", meaning: "期望時長秒（1-120，選填）。", source: "主腦委託單（user message）" },
      { name: "style_constraints", meaning: "風格約束（渲染引擎／打光／色調，選填）。", source: "主腦委託單（user message）" },
      { name: "reference_refs", meaning: "參考資產引用（畫布節點 id／附件 path／URL，選填 ≤8 條）。", source: "畫布節點／附件／URL" },
    ],
    // 實情：blender-delegate.ts 全檔 0 處 JSON.parse；產物分揀吃 bridge 回傳物件
    // （collectSceneCardFromArtifacts(BlenderExecuteSuccess)），模型輸出為散文。
    outputMode: "structured_text",
    topLevelKeys: [],
    fields: [],
    // 模型層無 JSON 契約；此三鍵是**工具回執層**（blender-tools.ts ok() 產出，
    // 定義 L121-124；exec 回執 L564-572、render 回執 L774-787、export 回執
    // L829-837）的實際鍵。
    frozenConstants: ["ok", "artifacts", "scene_summary"],
    pitfalls: [
      "尚無機器契約：模型層輸出（散文 + 資產引用）不受純 JSON 檢查；契約檢查器對本 Expert 只能校驗工具回執層鍵名，餵散文會誤報——如實缺口，非現有規則可涵蓋。",
      "產物 kind 白名單 turntable=mp4／stills=png／blend／glb（blender-delegate.ts collectSceneCardFromArtifacts）：缺 mp4 用首張 png 兜底並在 scene_summary 前綴標注；缺 blend 或 glb 直接 missing_deliverables，不產半形數據。",
      "委託單 2k token 預算（DELEGATION_TOKEN_BUDGET）：超預算結構化報錯，不會截斷後派遣。",
    ],
  },
  {
    agentCode: "music",
    purpose: MUSIC_DIRECTOR_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "effect_description", meaning: "效果描述（一句話人話，音樂導演據此自主拆解情緒契約與生成參數）。", source: "主腦委託單（user message）" },
      { name: "emotion_contract", meaning: "情緒契約（genre／BPM／key／mood／結構，music-lyria.ts 真源形）。", source: "主腦委託單（user message）" },
      { name: "deliverables", meaning: "交付字段清單（白名單：emotion_contract/lyrics/melody_notation/audio_url/duration_source/qc）。", source: "主腦委託單（user message）" },
      { name: "lyrics", meaning: "自訂歌詞（選填；[Verse]/[Chorus] 段落標籤或時間戳；缺省純器樂）。", source: "主腦委託單（user message）" },
      { name: "duration_hint", meaning: "時長檔 full／clip30（選填，缺省 full）。", source: "主腦委託單（user message）" },
      { name: "reference_refs", meaning: "參考素材引用（選填 ≤8 條）。", source: "畫布節點／附件／URL" },
    ],
    outputMode: "json",
    // score_abc（2026-09-19 收錄）：工具回執層 additive 鍵，YuE2 通路帶白盒 ABC 樂譜，
    // 其餘通路固定 null（欄位一律在場）——是 melody_notation 的真源，故列為回執頂層契約；
    // 它非 collect 必查鍵（缺而不誤判），required: false 如實標，亦不入 frozenConstants
    // （frozenConstants ⊆ 必填欄位集是「極簡樣本零誤報」自檢的設計不變量）。
    // cot_mode／abc_sha256（2026-09-19 片 K 收錄）：樂譜編輯工作流的回執 additive 鍵——
    // cot_mode=實際生效的 YuE2 樂譜約束模式（full/melody，僅 YuE2 通路在場）；
    // abc_sha256=帶譜委託的樂譜指紋（有傳 abc 時在場，長樂譜不重複回傳）。
    // transcribed_abc_sha256／transcribe_warnings（2026-09-19 片 O 收錄）：翻唱工作流
    //（source_audio 扒譜）的回執 additive 鍵——前者＝扒譜產物的樂譜指紋（＝送入生成
    // 的旋律骨幹），後者＝扒譜警告如實透傳（可為空數組）。
    topLevelKeys: ["ok", "url", "duration_source", "score_abc", "channel", "fallback_from", "fallback_reason", "cot_mode", "abc_sha256", "transcribed_abc_sha256", "transcribe_warnings"],
    fields: [
      FIELD_OK,
      { name: "url", type: "string", required: true, meaning: "音頻公網 URL（music-delegate.ts:338；上游未上傳 gateway 即 missing_deliverables）→ payload.audio_url。" },
      { name: "duration_source", type: "string", required: true, meaning: "時長來源（ffprobe 實測／upstream_reported（YuE2 上游端真量測）／model_hint；music-delegate.ts:339）。" },
      { name: "score_abc", type: "string", required: false, meaning: "白盒 ABC 樂譜（music-tools.ts 回執層，欄位一律在場）：YuE2 通路帶可編輯 ABC 記譜（K: 調號＋Q: 節拍＋V: Vocal 聲部），其餘通路固定 null——melody_notation 的真源，導演可直接引用其 Vocal 聲部組裝交付。" },
      { name: "channel", type: "string", required: false, meaning: "生成通路標識（music-tools.ts 回執層：yue2_modal／flowmusic2api／lyria_gemini）；技能庫按回執 channel 欄選 DATA 檔，不預判通路。" },
      { name: "fallback_from", type: "string", required: false, meaning: "回落來源通路（music-tools.ts 回執層，僅 YuE2 拋錯且 FlowMusic 接手時出場，值 \"yue2_modal\"）；正常生成缺席，缺而不誤判。" },
      { name: "fallback_reason", type: "string", required: false, meaning: "回落原因摘要（YuE2 原錯誤壓平＋500 字截斷＋secret 遮蔽）；診斷用，導演可引用如實說明。" },
      { name: "cot_mode", type: "string", required: false, meaning: "實際生效的 YuE2 樂譜約束模式（music-tools.ts 回執層，僅 YuE2 通路在場）：full=旋律與和弦都被樂譜約束；melody=只約束旋律、伴奏自由適配（翻唱模式）。帶 abc 委託時導演可引用核對編輯語義是否生效。" },
      { name: "abc_sha256", type: "string", required: false, meaning: "帶譜委託的 ABC 樂譜指紋（music-tools.ts 回執層，有傳 abc 時在場；hex sha256）：長樂譜不重複回傳，比對指紋即知送入重渲染的樂譜版本。" },
      { name: "transcribed_abc_sha256", type: "string", required: false, meaning: "翻唱工作流（source_audio）的扒譜產物指紋（music-tools.ts 回執層，帶 source_audio 時在場；hex sha256）：＝送入生成的旋律骨幹 ABC——比對指紋即知本次翻唱沿用的旋律骨幹；與 abc_sha256（委託自備譜）互斥不同時在場。" },
      { name: "transcribe_warnings", type: "string[]", required: false, meaning: "扒譜警告（music-tools.ts 回執層，帶 source_audio 時在場，可為空數組）：SheetSage2 對源音頻的如實警告（如截斷提示），導演可引用說明扒譜品質；不粉飾不吞掉。" },
      { name: "duration_seconds", type: "number", required: false, meaning: "時長秒（music-delegate.ts:354-357，>0 才取用）→ evidence.durationSec。" },
      { name: "audio_bytes", type: "number", required: false, meaning: "音頻字節數（music-delegate.ts:353）→ evidence.bytes。" },
      { name: "mime_type", type: "string", required: false, meaning: "音頻 MIME（music-delegate.ts:366，進 qc 欄）。" },
      { name: "model", type: "string", required: false, meaning: "上游模型名（music-delegate.ts:366，進 qc 欄）。" },
      { name: "lyrics_echo", type: "string", required: false, meaning: "歌詞回聲（music-delegate.ts:358；缺省回退委託單 lyrics）。" },
      { name: "emotion_contract", type: "object", required: false, meaning: "payload 欄（registry requiredFields；由 collect 從委託單組裝，回執頂層不要求）。" },
      { name: "lyrics", type: "string", required: false, meaning: "payload 欄（registry requiredFields；由 collect 組裝，回執頂層不要求）。" },
      { name: "melody_notation", type: "string", required: false, meaning: "payload 欄（registry requiredFields）：人聲主旋律音高序列，由導演**正文**逐字出現欄位名＋實質內容（VPS 閘門判據），非回執鍵、collect 不偽造。" },
      { name: "audio_url", type: "string", required: false, meaning: "payload 欄（registry requiredFields；＝回執 url）。" },
      { name: "qc", type: "string", required: false, meaning: "payload 欄（registry requiredFields）：由 collect 生成（duration_source/mime/bytes/model 拼接），回執頂層不要求。" },
    ],
    frozenConstants: ["ok", "url", "duration_source"],
    pitfalls: [
      "melody_notation 不存在於工具回執：它由導演正文交付，缺整欄 = 未交付；委託單 deliverables 含它時組裝 prompt 會附「欄位名逐字＋實質內容」形態指引（music-delegate.ts assembleMusicDirectorPrompt）；YuE2 通路回執的 score_abc（ABC 記譜，K: 調號＋Q: 節拍＋V: Vocal 聲部）是其真源，可直接引用組裝，勿另行編造音名序列。",
      "duration_source 缺失即 missing_deliverables——時長不可自報口徑（上游自報與 ffprobe 實測必須標明來源）。",
      "melody_notation 之外的六欄裡，emotion_contract/lyrics/audio_url/qc 由 collect 組裝，勿在回執裡手拼。",
      "score_abc 是回執層欄非導演義務欄：非 YuE2 通路固定 null，勿手拼 ABC 樂譜回填（閘門只認導演正文的 melody_notation 欄）。",
      "樂譜編輯工作流（帶 abc 重渲染）僅 YuE2 通路有效：cot_mode／abc_sha256 只在 YuE2 回執在場；帶 abc 委託在 YuE2 拋錯時直接失敗不回落（FlowMusic 不認樂譜，回落會靜默丟失編輯語義）——導演引用時如實說明，勿把回落版本當編輯結果。",
      "翻唱工作流（source_audio 扒譜＋重演繹）僅 YuE2 通路有效：transcribed_abc_sha256／transcribe_warnings 只在帶 source_audio 的回執在場；source_audio 與 abc 互斥（同傳即 invalid_args）；扒譜 422 abc_missing 是確定性失敗（源音頻無可提取旋律）勿重試同一份音頻；扒譜/生成失敗直接報錯不回落——翻唱語義不可被無譜通路頂替。",
    ],
  },
  {
    agentCode: "video-director",
    purpose: VIDEO_DIRECTOR_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "subject", meaning: "主題（拍什麼／給誰看，視頻導演據此自主拆鏡頭）。", source: "主腦委託單（user message）" },
      { name: "action", meaning: "動作／劇情描述（畫面裡發生什麼）。", source: "主腦委託單（user message）" },
      { name: "deliverables", meaning: "交付字段清單（白名單：shots/duration_sec/model_hint/qc）。", source: "主腦委託單（user message）" },
      { name: "shots", meaning: "分鏡列表（選填；缺省導演自主分鏡 ≤20 條）。", source: "主腦委託單（user message）" },
      { name: "duration_hint", meaning: "時長檔（正數秒，取整；選填）。", source: "主腦委託單（user message）" },
      { name: "resolution", meaning: "分辨率檔（如 720p/1080p，選填）。", source: "主腦委託單（user message）" },
      { name: "model_hint", meaning: "模型提示（如 seedance-2.5／kling；導演自主終選）。", source: "主腦委託單（user message）" },
      { name: "camera_notes", meaning: "鏡頭筆記（運鏡／光影／節奏約束，選填）。", source: "主腦委託單（user message）" },
      { name: "reference_refs", meaning: "參考素材引用（選填 ≤8 條）。", source: "畫布節點／附件／URL" },
    ],
    outputMode: "json",
    topLevelKeys: ["ok", "url", "duration_seconds"],
    fields: [
      FIELD_OK,
      { name: "url", type: "string", required: true, meaning: "成片公網 URL（video-delegate.ts:374；未上傳 gateway 即 missing_deliverables）。" },
      { name: "duration_seconds", type: "number", required: true, meaning: "成片時長秒（video-delegate.ts:375-378，>0 才取用；缺失即 missing_deliverables，video-delegate.ts:381）。" },
      { name: "shots_echo", type: "string[]", required: false, meaning: "分鏡回聲（video-delegate.ts:392；缺省回退委託單 shots）。" },
      { name: "model", type: "string", required: false, meaning: "上游模型名（video-delegate.ts:394；缺省回退委託單 model_hint）。" },
      { name: "video_bytes", type: "number", required: false, meaning: "成片字節數（video-delegate.ts:395）→ evidence.bytes。" },
      { name: "mime_type", type: "string", required: false, meaning: "成片 MIME（video-delegate.ts:401，進 qc 欄）。" },
      { name: "shots", type: "string[]", required: false, meaning: "payload 欄（registry requiredFields；＝回執 shots_echo 或委託單 shots，回執頂層不要求）。" },
      { name: "duration_sec", type: "number", required: false, meaning: "payload 欄（registry requiredFields；＝回執 duration_seconds，鍵名不同）。" },
      { name: "model_hint", type: "string", required: false, meaning: "payload 欄（registry requiredFields；＝回執 model 或委託單 model_hint）。" },
      { name: "qc", type: "string", required: false, meaning: "payload 欄（registry requiredFields）：由 collect 生成，回執頂層不要求。" },
    ],
    frozenConstants: ["ok", "url", "duration_seconds"],
    pitfalls: [
      "回執鍵名與 payload 欄名不同（url→audio_url 家族：duration_seconds→duration_sec、model→model_hint）：改回執鍵名會斷 collect，改 payload 欄名會斷 registry 閘門。",
      "duration_seconds 缺失即 missing_deliverables——禁把委託單 duration_hint 當實測時長回填。",
      "分鏡回聲欄（shots_echo）缺席時 collect 回退委託單 shots 或「（导演自主分镜，未显式指定）」——此為兜底非交付。",
    ],
  },
  {
    agentCode: "editor",
    purpose: EDITOR_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "source_clips", meaning: "源素材清單（每個素材是什麼，剪輯師據此自主排時間線 ≤30 條）。", source: "主腦委託單（user message）" },
      { name: "deliverables", meaning: "交付字段清單（白名單：timeline_ops/duration_sec/qc）。", source: "主腦委託單（user message）" },
      { name: "timeline_ops", meaning: "時間線操作意圖（選填 ≤40 條；缺省剪輯師自主編排）。", source: "主腦委託單（user message）" },
      { name: "rhythm_notes", meaning: "節奏筆記（卡點／情緒曲線／段落停頓，選填）。", source: "主腦委託單（user message）" },
      { name: "mix_notes", meaning: "混音筆記（旁白／BGM／SFX 層級與 ducking，選填）。", source: "主腦委託單（user message）" },
      { name: "duration_hint", meaning: "時長檔（正數秒，取整；選填）。", source: "主腦委託單（user message）" },
      { name: "delivery_spec", meaning: "交付規格（如 1080p H.264 + AAC、豎屏 9:16，選填）。", source: "主腦委託單（user message）" },
      { name: "reference_refs", meaning: "參考素材引用（選填 ≤8 條）。", source: "畫布節點／附件／URL" },
    ],
    outputMode: "json",
    topLevelKeys: ["ok", "url", "duration_seconds", "qc"],
    fields: [
      FIELD_OK,
      { name: "url", type: "string", required: true, meaning: "成片公網 URL（editor-delegate.ts:367；未上傳 gateway 即 missing_deliverables）。" },
      { name: "duration_seconds", type: "number", required: true, meaning: "成片時長秒（editor-delegate.ts:368-371，>0 才取用；缺失即 missing_deliverables）。" },
      { name: "qc", type: "string", required: true, meaning: "質檢結論（editor-delegate.ts:373；timeline_lint／timeline_master 結論必須隨回執上交，缺失即 missing_deliverables）。" },
      { name: "timeline_ops_echo", type: "string[]", required: false, meaning: "時間線操作回聲（editor-delegate.ts:372；缺省回退委託單 timeline_ops）。" },
      { name: "video_bytes", type: "number", required: false, meaning: "成片字節數（editor-delegate.ts:389）→ evidence.bytes。" },
      { name: "timeline_ops", type: "string[]", required: false, meaning: "payload 欄（registry requiredFields；＝回執 timeline_ops_echo 或委託單 timeline_ops，editor-delegate.ts:391-395）。" },
      { name: "duration_sec", type: "number", required: false, meaning: "payload 欄（registry requiredFields；＝回執 duration_seconds，鍵名不同）。" },
    ],
    frozenConstants: ["ok", "url", "duration_seconds", "qc"],
    pitfalls: [
      "qc 是唯一在回執層就必填的域內結論欄（video/music 的 qc 由 collect 生成，剪輯域要求工具鏈自報）——省掉它 = 未交付。",
      "timeline_ops_echo 缺席時 collect 回退委託單 timeline_ops；回執不帶 echo 不等於交付了操作，是兜底。",
      "成片必須走 lint／master 質檢再回執：url 有了但 qc 空＝missing_deliverables。",
    ],
  },
  {
    agentCode: "screenwriter",
    purpose: SCREENWRITER_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "logline", meaning: "故事內核（一句話人話：誰在何處想幹什麼、遇到什麼阻力，≤600 字）。", source: "主腦委託單（user message）" },
      { name: "deliverables", meaning: "交付字段清單（白名單：beats/shotlist/qc）。", source: "主腦委託單（user message）" },
      { name: "genre", meaning: "題材（選填，≤120 字）。", source: "主腦委託單（user message）" },
      { name: "tone", meaning: "基調（選填，≤120 字）。", source: "主腦委託單（user message）" },
      { name: "beats", meaning: "既有故事節拍（選填 ≤24 條；缺省編劇自主拆解）。", source: "主腦委託單（user message）" },
      { name: "shotlist", meaning: "既有分鏡清單（選填 ≤48 場；每場 description 必填 ≤200 字、scene/duration_sec 取整）。", source: "主腦委託單（user message）" },
      { name: "characters", meaning: "角色清單（名字＋一句話人設，選填 ≤12 條）。", source: "主腦委託單（user message）" },
      { name: "world_refs", meaning: "世界觀／素材引用（畫布節點 id／附件 path／URL，原樣透傳 ≤8 條）。", source: "畫布節點／附件／URL" },
    ],
    outputMode: "json",
    topLevelKeys: ["ok", "beats", "shotlist", "qc"],
    fields: [
      FIELD_OK,
      { name: "beats", type: "string[]", required: true, meaning: "故事節拍（screenwriter-delegate.ts:385；空陣列即 missing_deliverables）。" },
      { name: "shotlist", type: "object[]", required: true, meaning: "分鏡清單（screenwriter-delegate.ts:386；空陣列即 missing_deliverables；元素是 ShotlistEntry）。" },
      { name: "qc", type: "string", required: true, meaning: "QC 結論（screenwriter-delegate.ts:387；缺失即 missing_deliverables）。" },
      FIELD_ARTIFACT_PATH,
      FIELD_URL_OPT,
    ],
    frozenConstants: ["ok", "beats", "shotlist", "qc"],
    pitfalls: [
      "beats／shotlist 必須是非空**陣列**（collect 只認 Array.isArray），字串或物件即視同空 → missing_deliverables。",
      "該域回執必須附 artifact_path 或 url 交付物指針（二選一），兩者皆缺即 missing_deliverables。",
      "shotlist 元素走白名單收斂（ShotlistEntry 已知鍵）：未知鍵被丟棄，description 為必填非空字串。",
    ],
  },
  {
    agentCode: "motion-director",
    purpose: MOTION_DIRECTOR_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "motion_spec", meaning: "動態規格（一句人話：什麼元素做什麼運動、什麼節奏與氛圍，≤600 字）。", source: "主腦委託單（user message）" },
      { name: "deliverables", meaning: "交付字段清單（白名單：motion_spec/qc）。", source: "主腦委託單（user message）" },
      { name: "keyframes", meaning: "既有關鍵幀清單（選填 ≤24 條；缺省動態導演自主拆）。", source: "主腦委託單（user message）" },
      { name: "easing_notes", meaning: "緩動／節奏筆記（easing／時長分配／物理感，選填）。", source: "主腦委託單（user message）" },
      { name: "duration_hint", meaning: "時長檔（正數秒，取整；選填）。", source: "主腦委託單（user message）" },
      { name: "deliverable_format", meaning: "交付格式（如 mp4／gif／png 序列，選填 ≤40 字）。", source: "主腦委託單（user message）" },
    ],
    outputMode: "json",
    topLevelKeys: ["ok", "motion_spec", "qc"],
    fields: [
      FIELD_OK,
      { name: "motion_spec", type: "string", required: true, meaning: "動態規格（motion-delegate.ts:323；空則回退委託單，仍空即 missing_deliverables）。" },
      { name: "qc", type: "string", required: true, meaning: "QC 結論（motion-delegate.ts:324；缺失即 missing_deliverables）。" },
      FIELD_ARTIFACT_PATH,
      FIELD_URL_OPT,
      { name: "keyframes_echo", type: "string[]", required: false, meaning: "關鍵幀回聲（motion-delegate.ts:327）→ payload.keyframes。" },
    ],
    frozenConstants: ["ok", "motion_spec", "qc"],
    pitfalls: [
      "回執必須附 artifact_path 或 url（二選一），兩者皆缺即 missing_deliverables。",
      "motion_spec 缺席時 collect 回退委託單原文；回退不是交付，缺整欄仍算未交付。",
      "keyframes_echo 可缺（payload.keyframes 為選填欄），但欄位名不得改寫成 keyframes 回填。",
    ],
  },
  {
    agentCode: "web3d-director",
    purpose: WEB3D_DIRECTOR_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "scene_spec", meaning: "場景規格（什麼場景、什麼視覺目標、跑在什麼頁面，≤600 字）。", source: "主腦委託單（user message）" },
      { name: "deliverables", meaning: "交付字段清單（白名單：scene_spec/bundle_ref/qc）。", source: "主腦委託單（user message）" },
      { name: "interactions", meaning: "交互清單（點擊／拖拽／滾輪／懸停，選填 ≤16 條）。", source: "主腦委託單（user message）" },
      { name: "camera_notes", meaning: "相機筆記（機位／軌道／視場／降級約束，選填）。", source: "主腦委託單（user message）" },
      { name: "bundle_hint", meaning: "資產鏈提示（GLB 來源／資產包 id／紋理口徑，選填 ≤300 字）。", source: "資產包／主腦委託單" },
    ],
    outputMode: "json",
    topLevelKeys: ["ok", "scene_spec", "bundle_ref", "qc"],
    fields: [
      FIELD_OK,
      { name: "scene_spec", type: "string", required: true, meaning: "場景規格（web3d-delegate.ts:300；空即 missing_deliverables）。" },
      { name: "bundle_ref", type: "string", required: true, meaning: "GLB／打包產物指針（web3d-delegate.ts:301；可回退 artifact_path／url，三者皆缺即 missing_deliverables）。" },
      { name: "qc", type: "string", required: true, meaning: "QC 結論（web3d-delegate.ts:302；缺失即 missing_deliverables）。" },
      FIELD_ARTIFACT_PATH,
      FIELD_URL_OPT,
    ],
    frozenConstants: ["ok", "scene_spec", "bundle_ref", "qc"],
    pitfalls: [
      "bundle_ref 同時是 payload 欄與 evidence 本體：http(s) 走 evidence.url，其餘（如 .blender-work/out/*.glb）走 evidence.artifactPath（web3d-delegate.ts:325-329）——改判定式會讓指針落錯槽。",
      "GLB 唯一現成出口是 blender_export_gltf（persona 工具白名單兩件之一）；沒有第二條資產通路。",
      "bundle_ref／artifact_path／url 三者皆缺即 missing_deliverables，別把 bundle_hint（委託單提示）當交付指針回填。",
    ],
  },
  {
    agentCode: "critic",
    purpose: CRITIC_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "review_target", meaning: "被審對象（審哪個交付物／聲稱、驗什麼收，≤600 字）。", source: "主腦委託單（user message）" },
      { name: "deliverables", meaning: "交付字段清單（白名單：verdict/issues/evidence/qc）。", source: "主腦委託單（user message）" },
      { name: "scope", meaning: "審核範圍／重點（選填，≤120 字）。", source: "主腦委託單（user message）" },
      { name: "checklist", meaning: "審核要點清單（選填 ≤24 條；缺省按交付契約自行展開）。", source: "主腦委託單（user message）" },
      { name: "reference_deliverables", meaning: "跨檔對表的交付物指針（畫布節點 id／附件 path／URL，原樣透傳 ≤8 條）。", source: "畫布節點／附件／URL" },
    ],
    outputMode: "json",
    topLevelKeys: ["ok", "verdict", "issues", "evidence", "qc"],
    fields: [
      FIELD_OK,
      { name: "verdict", type: "string", required: true, meaning: "審核結論（critic-delegate.ts:326；缺失即 missing_deliverables）。" },
      { name: "issues", type: "string[]", required: true, meaning: "駁回清單（critic-delegate.ts:327；**鍵必須在場**，通過時可為空數組——非 Array 即 missing_deliverables）。" },
      { name: "evidence", type: "string[]", required: true, meaning: "複算過程與指針（critic-delegate.ts:328；鍵必須在場，可為空數組；注意此鍵是**數組**，非 evidence 物件）。" },
      { name: "qc", type: "string", required: true, meaning: "自檢結論（critic-delegate.ts:329；缺失即 missing_deliverables）。" },
      FIELD_ARTIFACT_PATH,
      FIELD_URL_OPT,
    ],
    frozenConstants: ["ok", "verdict", "issues", "evidence", "qc"],
    pitfalls: [
      "issues／evidence 必須**在場且為數組**（可空數組）——「不需要就省略欄位」在本域直接判未交付（AID 硬規則 ④ 同款：寫「无」或空數組，不省欄）。",
      "本域 evidence 是字符串數組，與 ExpertDeliverable.evidence（可核驗指針物件）同名不同物：回執裡寫成物件即判缺失。",
      "審核官不產內容（工具白名單只有 search_web）：verdict 不得依賴任何生成工具，回執須附 artifact_path／url 指針（二選一）。",
    ],
  },
];

// ─────────────────────────────────────────── 查表

/** 按 agentCode 取契約（未註冊返回 undefined，不拋）。 */
export function getContract(agentCode: string): AgentPromptContract | undefined {
  return AGENT_PROMPT_CONTRACTS.find((c) => c.agentCode === agentCode);
}
