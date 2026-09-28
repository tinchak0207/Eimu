// 畫布節點 metadata 的**鍵集合單一真源**（2026-09-25）。
//
// 為什麼要有這一層：節點 metadata 有**兩個獨立的白名單清洗入口**，鍵集合各自手工維護：
//   A（耐久化/還原端）`src/lib/canvas/layout.ts` 的 `toNodeMetadata`——所有載入路徑
//     （Blob 專案＋gateway 快照）都收束到 `fromCanvasProject → normalizeCanvasNode →
//     toNodeMetadata`，漏一鍵＝該鍵重載後靜默消失。
//   B（上行/壓縮端）`src/hooks/canvas/canvas-chat-types.ts` 的 `compactMetadataForAgent`
//     ——上行快照（`canvas-project-sync.postCanvasSnapshot`）的唯一資料源，漏一鍵＝
//     回舊會話/換裝置還原後該鍵靜默消失。
// 兩端任一漏放行的症狀是「功能完全沒反應」而不是報錯（2026-09-24 `emitsEntity` 實錘：
// 閘道節點 metadata 好好的，一進前端就被剝成 undefined，整條自動落卡不可能觸發）。
//
// 本檔只放**清單與理由**（可機器列舉），不放清洗實作：
//   · A 的清洗器實作留在 `layout.ts`（`DURABLE_FIELD_CLEANERS` 註冊表，鍵集合由本檔導出）
//   · B 的透傳實作留在 `canvas-chat-types.ts`（依本檔的 `transform` 分派）
// 這樣兩個入口的**鍵集合**只有一份，行為實作各自留在原檔，避免搬家造成的 import 風暴。
//
// 契約測試：`src/lib/canvas/node-metadata-fields.test.ts`（遍歷本檔清單做真實往復斷言）。

// ─────────────────────────────────────────── A：耐久化（還原端）鍵集合

/**
 * A 端清洗器名稱。**每個名稱都必須在 `layout.ts` 的 `DURABLE_FIELD_CLEANERS` 有實作**
 * （該表用 `Record<MetadataCleanerName, …>` 標型，漏一個 tsc 就紅）。
 */
export type MetadataCleanerName =
  | "string"
  | "finiteNumber"
  | "nodeStatus"
  | "errorDetails"
  | "sourceImage"
  | "referenceRole"
  | "pipelineCard"
  | "unsupportedFlag"
  | "stringOrTrue"
  | "nullableString"
  | "booleanFlag"
  | "sceneCard"
  | "storyboardShot"
  | "storyboardScene"
  | "shotCandidates"
  | "idList"
  | "trimmedString"
  | "emitsEntity"
  | "cardName"
  | "fontSize"
  | "gateConfirm"
  | "approval";

/** 一個耐久化鍵：鍵名 ＋ 清洗器名稱（型別對應）＋ 為何它必須活著。 */
export interface DurableFieldSpec {
  readonly key: string;
  readonly cleaner: MetadataCleanerName;
  readonly note: string;
}

/**
 * A 必須放行的鍵，**順序＝`toNodeMetadata` 的輸出鍵插入序**（改序會動到輸出物件鍵序，
 * 屬可觀察行為，勿隨意重排）。
 */
export const DURABLE_METADATA_FIELDS: readonly DurableFieldSpec[] = [
  { key: "content", cleaner: "string", note: "圖片節點=交付 URL；文本節點=正文（NodeBody 全部卡型都讀）" },
  { key: "prompt", cleaner: "string", note: "生成提示詞；重生成與 Config 卡都讀" },
  { key: "negativePrompt", cleaner: "string", note: "負面詞（介面宣告鍵；目前全庫查無 metadata 讀者）" },
  { key: "model", cleaner: "string", note: "模型 id（Config 卡「模型」行）" },
  { key: "size", cleaner: "string", note: "尺寸/比例（Config 卡「尺寸」行；分鏡 QC 的 nodeSize 推導也讀）" },
  { key: "quality", cleaner: "string", note: "質量檔（Config 卡「质量」行）" },
  { key: "count", cleaner: "finiteNumber", note: "生成張數（Config 卡「数量」行）" },
  { key: "kind", cleaner: "string", note: "生成物種類 image|video（Config 卡「类型」行）" },
  { key: "source_image", cleaner: "sourceImage", note: "edit/upscale 來源（NodeBody 行＋重生成帶 sourceImage；null 亦為合法值）" },
  { key: "status", cleaner: "nodeStatus", note: "四態狀態（gateway 詞彙映射；節點配色與骨架渲染）" },
  { key: "errorDetails", cleaner: "errorDetails", note: "失敗人話（NodeBody error 分支；errorDetailsText）" },
  { key: "naturalWidth", cleaner: "finiteNumber", note: "自然寬（重生成尺寸提示）" },
  { key: "naturalHeight", cleaner: "finiteNumber", note: "自然高（重生成尺寸提示）" },
  { key: "cost_coins", cleaner: "finiteNumber", note: "實際花費（CanvasNodeView 徽章）" },
  { key: "cost_hint", cleaner: "finiteNumber", note: "預估花費（CanvasNodeView「预估 N 币」）" },
  { key: "imageTaskId", cleaner: "string", note: "生成任務 id（canvas-event-settler 以 task_id 對帳落地）" },
  { key: "startedAt", cleaner: "finiteNumber", note: "開始時間戳（介面宣告鍵；目前全庫查無 metadata 讀者）" },
  { key: "progress", cleaner: "finiteNumber", note: "進度（NodeBody 進度條＋batch-utils 批次聚合）" },
  { key: "referenceRole", cleaner: "referenceRole", note: "reference 節點參考角色（只收 ReferenceImageRole 六值）" },
  { key: "pipelineCard", cleaner: "pipelineCard", note: "結構卡標記 tool|gate|note|director（渲染分支的總開關）" },
  { key: "toolId", cleaner: "string", note: "工具卡：工具 id" },
  { key: "toolInput", cleaner: "string", note: "工具卡：輸入契約" },
  { key: "toolOutput", cleaner: "string", note: "工具卡：輸出契約" },
  { key: "requiredCapability", cleaner: "string", note: "工具卡：缺失的上游能力標識" },
  { key: "unsupported", cleaner: "unsupportedFlag", note: "工具卡：harness 未接上游旗標（truthy→true，boolean 形態）" },
  { key: "deliverable", cleaner: "string", note: "步驟頭卡：產出合同全文" },
  { key: "gate", cleaner: "stringOrTrue", note: "驗收門禁：string 全文 或 true（DSL 需人工批准旗標），兩形態並存" },
  { key: "directorSessionId", cleaner: "string", note: "導演台：gateway 會話 id（小視口據此拉 state）" },
  { key: "planName", cleaner: "nullableString", note: "導演台：當前方案名；明確 null＝「目前無方案」是語義，必須保留 null" },
  { key: "shotCount", cleaner: "finiteNumber", note: "導演台：活躍方案鏡頭數" },
  { key: "healthOk", cleaner: "booleanFlag", note: "導演台：分鏡健康徽章（true/false 兩態都要）" },
  { key: "topViewSvg", cleaner: "string", note: "導演台：俯視圖 SVG 原文（>48KB 級重料；見 B 端排除理由）" },
  { key: "cameraViewSvg", cleaner: "string", note: "導演台：鏡頭框圖 SVG 原文（同上）" },
  { key: "revision", cleaner: "finiteNumber", note: "導演台：工程 revision（變更比對重拉）" },
  { key: "sceneCard", cleaner: "sceneCard", note: "3D 場景卡（底線 glb_path+scene_summary，其餘四欄可選；缺底線整包丟）" },
  { key: "directorStageId", cleaner: "trimmedString", note: "3D 舞台參考溯源：來源 scene_3d 節點 id（缺＝無溯源，不寫空殼）" },
  { key: "shotId", cleaner: "trimmedString", note: "3D 舞台參考溯源：所屬鏡號（storyboard-contract shotId 口徑）" },
  { key: "episodeId", cleaner: "trimmedString", note: "分鏡的集歸屬（按集批次換模型的分組維度；缺＝不歸任何一集）" },
  { key: "storyboardShot", cleaner: "storyboardShot", note: "分鏡 AID 21 欄契約（shotNumber 為空即整包丟）" },
  { key: "shotCandidates", cleaner: "shotCandidates", note: "分鏡級抽卡候選集＋星標（id+prompt 缺一即丟該條；空集合＝省略鍵）" },
  { key: "storyboardScene", cleaner: "storyboardScene", note: "分鏡場景歸屬（sceneName 是唯一權威）" },
  { key: "characterCardIds", cleaner: "idList", note: "分鏡：角色卡引用 id 陣列" },
  { key: "sceneCardIds", cleaner: "idList", note: "分鏡：場景卡引用 id 陣列" },
  { key: "propCardIds", cleaner: "idList", note: "分鏡：道具卡引用 id 陣列" },
  { key: "entityCardId", cleaner: "trimmedString", note: "自動落卡冪等標記（trim 後非空才收）" },
  { key: "emitsEntity", cleaner: "emitsEntity", note: "模板實體宣告（驅動整條自動落卡；kind 不在五值域即整包丟）" },
  { key: "input", cleaner: "cardName", note: "卡名來源鍵①（nameFrom:\"input\" 依序取）" },
  { key: "characterName", cleaner: "cardName", note: "卡名來源鍵②" },
  { key: "sceneName", cleaner: "cardName", note: "卡名來源鍵③" },
  { key: "fontSize", cleaner: "fontSize", note: "文本節點字號（10..28 整數；漏放行＝重載回 14.5）" },
  { key: "gateConfirm", cleaner: "gateConfirm", note: "協作確認閘憑據（三欄全對才收；漏放行＝門禁卡退回純文字）" },
  { key: "approval", cleaner: "approval", note: "分鏡批准狀態（status 三值域；漏放行＝批准態重載後翻面）" },
];

/** A 必須放行的鍵名清單（供測試與消費端列舉）。 */
export const DURABLE_METADATA_FIELD_KEYS: readonly string[] = DURABLE_METADATA_FIELDS.map((f) => f.key);

// ─────────────────────────────────────────── B：上行（agent 壓縮端）鍵集合

/**
 * B 端透傳動作。與 A 的清洗器刻意不同名：B 是「把 A 清洗過的值挑出來傳」，
 * 部分鍵帶 token 預算截斷（見 `AGENT_TRUNCATION_BUDGETS`）。
 */
export type AgentFieldTransform =
  /** content：超 `AGENT_CONTENT_TRUNCATE_TRIGGER` 字則截 `…KEEP` 字＋省略號。 */
  | "content"
  /** prompt：無條件截 `AGENT_PROMPT_TRUNCATE_KEEP` 字。 */
  | "prompt"
  /** truthy 才寫，值原樣（模型/尺寸/狀態/角色/合同/門禁/場景卡…）。 */
  | "truthy"
  /** `typeof === "number"` 才寫（count/cost_coins/shotCount/revision）。 */
  | "number"
  /** `typeof === "boolean"` 才寫（unsupported/healthOk）。 */
  | "boolean"
  /** `!== undefined` 才寫（planName：明確 null 也是語義，必須傳）。 */
  | "defined"
  /** pipelineCard 四值枚舉（tool|gate|note|director）。 */
  | "pipelineCard"
  /** id 陣列收斂（非空字串、首見序去重、空集合省略鍵）。 */
  | "idList"
  /** 卡名收斂（trim＋上限 100）。 */
  | "cardName"
  /** 分鏡 21 欄壓縮（逐欄截 `STORYBOARD_SNAPSHOT_FIELD_CHARS`）。 */
  | "storyboardShot"
  /** emitsEntity 清洗（與 A 同一份 `cleanEmitsEntity`）。 */
  | "emitsEntity"
  /** 字號清洗（與 A 同一把尺 10..28）。 */
  | "fontSize"
  /** 門禁憑據清洗（與 A 同一份 `toGateConfirm`）。 */
  | "gateConfirm"
  /** 批准狀態清洗（與 A 同一份 `normalizeApprovalState`）。 */
  | "approval";

/** 分族透傳條件：同伴鍵為指定字串值時，本鍵才透傳。 */
export interface AgentFieldCondition {
  readonly key: string;
  readonly oneOf: readonly string[];
}

/** 一個 agent 透傳鍵。 */
export interface AgentFieldSpec {
  readonly key: string;
  readonly transform: AgentFieldTransform;
  /** 分族條件（工具卡族要求 pipelineCard∈{tool,gate,note}；導演台族要求 =director）。 */
  readonly requires?: AgentFieldCondition;
  readonly note: string;
}

/** 工具卡族三值（pipelineCard）。 */
export const AGENT_TOOL_FAMILY_PIPELINE_CARDS = ["tool", "gate", "note"] as const;

/**
 * B 應透傳的鍵，**順序＝`compactMetadataForAgent` 的輸出鍵插入序**（同 A：鍵序是可觀察行為）。
 */
export const AGENT_METADATA_FIELDS: readonly AgentFieldSpec[] = [
  { key: "content", transform: "content", note: "正文/交付 URL；超預算截斷（見 AGENT_TRUNCATION_BUDGETS）" },
  { key: "prompt", transform: "prompt", note: "提示詞；截 120 字（token 預算）" },
  { key: "model", transform: "truthy", note: "模型 id" },
  { key: "size", transform: "truthy", note: "尺寸/比例" },
  { key: "status", transform: "truthy", note: "四態狀態（agent 讀畫布狀態要知道誰在跑誰失敗）" },
  { key: "referenceRole", transform: "truthy", note: "參考圖角色（agent 知道這張圖以什麼身份參與）" },
  { key: "deliverable", transform: "truthy", note: "步驟產出合同（漏傳＝下行還原後骨架失語義）" },
  { key: "gate", transform: "truthy", note: "驗收門禁（string 全文 / true 旗標）" },
  { key: "count", transform: "number", note: "生成張數" },
  { key: "cost_coins", transform: "number", note: "實際花費" },
  { key: "pipelineCard", transform: "pipelineCard", note: "結構卡標記；四值枚舉（未列舉值含 step_head 照舊丟）" },
  {
    key: "toolId",
    transform: "truthy",
    requires: { key: "pipelineCard", oneOf: AGENT_TOOL_FAMILY_PIPELINE_CARDS },
    note: "工具卡族（pipelineCard=tool|gate|note）",
  },
  {
    key: "toolInput",
    transform: "truthy",
    requires: { key: "pipelineCard", oneOf: AGENT_TOOL_FAMILY_PIPELINE_CARDS },
    note: "工具卡族",
  },
  {
    key: "toolOutput",
    transform: "truthy",
    requires: { key: "pipelineCard", oneOf: AGENT_TOOL_FAMILY_PIPELINE_CARDS },
    note: "工具卡族",
  },
  {
    key: "unsupported",
    transform: "boolean",
    requires: { key: "pipelineCard", oneOf: AGENT_TOOL_FAMILY_PIPELINE_CARDS },
    note: "工具卡族：harness 未接上游旗標",
  },
  {
    key: "requiredCapability",
    transform: "truthy",
    requires: { key: "pipelineCard", oneOf: AGENT_TOOL_FAMILY_PIPELINE_CARDS },
    note: "工具卡族：缺失能力標識",
  },
  {
    key: "directorSessionId",
    transform: "truthy",
    requires: { key: "pipelineCard", oneOf: ["director"] },
    note: "導演台族（pipelineCard=director）：缺指針＝還原出空殼導演台",
  },
  {
    key: "planName",
    transform: "defined",
    requires: { key: "pipelineCard", oneOf: ["director"] },
    note: "導演台族：明確 null（無方案）也是語義",
  },
  { key: "shotCount", transform: "number", requires: { key: "pipelineCard", oneOf: ["director"] }, note: "導演台族" },
  { key: "healthOk", transform: "boolean", requires: { key: "pipelineCard", oneOf: ["director"] }, note: "導演台族" },
  { key: "revision", transform: "number", requires: { key: "pipelineCard", oneOf: ["director"] }, note: "導演台族" },
  { key: "sceneCard", transform: "truthy", note: "3D 場景卡整族透傳（導入卡只帶 glb_path，全族皆小指針無 SVG 級重料）" },
  { key: "directorStageId", transform: "truthy", note: "3D 舞台參考溯源（漏傳＝還原後回分鏡指針消失）" },
  { key: "shotId", transform: "truthy", note: "3D 舞台參考溯源鏡號（漏傳＝還原後鏡號消失）" },
  { key: "episodeId", transform: "truthy", note: "集歸屬（漏傳＝還原後按集換模型漏掉這些格）" },
  { key: "storyboardShot", transform: "storyboardShot", note: "分鏡 21 欄整族透傳（逐欄截 STORYBOARD_SNAPSHOT_FIELD_CHARS）" },
  { key: "shotCandidates", transform: "truthy", note: "分鏡候選集＋星標（漏傳＝還原後抽卡結果與採用稿消失）" },
  { key: "storyboardScene", transform: "truthy", note: "分鏡場景歸屬" },
  { key: "characterCardIds", transform: "idList", note: "分鏡卡引用（漏傳＝還原後卡引用消失）" },
  { key: "sceneCardIds", transform: "idList", note: "分鏡卡引用" },
  { key: "propCardIds", transform: "idList", note: "分鏡卡引用" },
  { key: "entityCardId", transform: "truthy", note: "落卡冪等標記" },
  { key: "emitsEntity", transform: "emitsEntity", note: "模板實體宣告（漏傳＝還原後一卡都落不成）" },
  { key: "input", transform: "cardName", note: "卡名來源鍵①" },
  { key: "characterName", transform: "cardName", note: "卡名來源鍵②" },
  { key: "sceneName", transform: "cardName", note: "卡名來源鍵③" },
  { key: "fontSize", transform: "fontSize", note: "文本節點字號（漏傳＝回舊會話字號回 14.5）" },
  { key: "gateConfirm", transform: "gateConfirm", note: "協作確認閘憑據（漏傳＝重載後按不下批准）" },
  { key: "approval", transform: "approval", note: "分鏡批准狀態（漏傳＝重載後批准態翻面）" },
];

/** B 應透傳的鍵名清單。 */
export const AGENT_METADATA_FIELD_KEYS: readonly string[] = AGENT_METADATA_FIELDS.map((f) => f.key);

// ─────────────────────────────────────────── B：截斷預算（有理由的清單）

/**
 * content 觸發截斷的字數門檻（**值與既有 runtime 逐字相同，2026-09-25 只做單源化**）。
 * 超過則只留前 `AGENT_CONTENT_TRUNCATE_KEEP` 字＋省略號。
 */
export const AGENT_CONTENT_TRUNCATE_TRIGGER = 240;
/** content 超預算時保留的字數。 */
export const AGENT_CONTENT_TRUNCATE_KEEP = 120;
/** prompt 無條件截斷後保留的字數。 */
export const AGENT_PROMPT_TRUNCATE_KEEP = 120;

/** 一條截斷預算（供測試以行為斷言驗證宣告與實作一致）。 */
export interface AgentTruncationBudget {
  readonly key: string;
  /** 觸發門檻；null ＝無條件截斷到 keepChars。 */
  readonly triggerAt: number | null;
  readonly keepChars: number;
  readonly reason: string;
}

/**
 * B 的截斷清單。**理由**：上行快照要過 `agent/sessions/[id]/canvas-state` 的 512KB 上限
 * （`route.ts:15`），base64/長文會頂爆；agent 讀的是「畫布狀態」不是原文，
 * 需要全文時用工具讀真值。
 */
export const AGENT_TRUNCATION_BUDGETS: readonly AgentTruncationBudget[] = [
  {
    key: "content",
    triggerAt: AGENT_CONTENT_TRUNCATE_TRIGGER,
    keepChars: AGENT_CONTENT_TRUNCATE_KEEP,
    reason: "content 可能是交付 URL 或長正文；超 240 字只留前 120 字＋省略號（agent 需要原圖時走工具讀）",
  },
  {
    key: "prompt",
    triggerAt: null,
    keepChars: AGENT_PROMPT_TRUNCATE_KEEP,
    reason: "prompt 無條件截 120 字（提示詞全文對「畫布狀態」判讀無增益，且可能夾帶長文本）",
  },
];

// ─────────────────────────────────────────── B：顯式排除清單（有理由）

/**
 * 排除理由的分類（機器可讀，供報告與裁定）：
 *   · `intentional`     —— 刻意排除，有明確設計理由（如 SVG 級重料）。
 *   · `suspected-gap`   —— 有**被讀的消費端**，B 不透傳＝回舊會話/換裝置還原後功能退化。
 *                          這是待暴君裁定的真缺口（本檔只登記，不改 runtime 語義）。
 *   · `dormant`         —— A 放行但全庫查無 metadata 讀者；透傳缺一暫無可觀察後果。
 */
export type AgentExclusionVerdict = "intentional" | "suspected-gap" | "dormant";

/** 一條排除：為何這個耐久鍵刻意不進 agent 上行快照。 */
export interface AgentFieldExclusion {
  readonly key: string;
  readonly reason: string;
  readonly verdict: AgentExclusionVerdict;
  /** 消費端/判據證據（檔案:行 或 grep 結論），供覆核。 */
  readonly evidence: string;
}

/**
 * A 放行、但 B **刻意不透傳**的鍵。每一個都必須有理由（測試會讀出來斷言非空）。
 *
 * 排除清單**不得說謊**：列在這裡的鍵若實際上被 B 透傳（存活），契約測試會紅
 * （`findStaleAgentExclusions`），所以不能靠「把鍵全列進排除」把破口洗白。
 */
export const AGENT_EXCLUDED_METADATA_FIELDS: readonly AgentFieldExclusion[] = [
  {
    key: "negativePrompt",
    reason: "介面宣告鍵，但全庫查無 metadata 讀者（生成入口讀的是 request body.negative_prompt）",
    verdict: "dormant",
    evidence: "grep 'metadata?.negativePrompt' 零命中；src/app/api/canvas/generate/route.ts:136 讀 body.negative_prompt",
  },
  {
    key: "quality",
    reason: "Config 卡「质量」行讀它；不透傳＝還原後 Config 卡少一行",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:584",
  },
  {
    key: "kind",
    reason: "Config 卡「类型」行讀它；不透傳＝還原後 Config 卡少一行",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:586",
  },
  {
    key: "source_image",
    reason: "Config 卡「参考图」行＋重生成帶 sourceImage；不透傳＝還原後 edit/upscale 節點丟失來源",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:587；src/components/canvas/embed/use-canvas-generation.ts:318",
  },
  {
    key: "errorDetails",
    reason: "失敗人話渲染；不透傳＝還原後錯誤節點只剩通用錯誤態",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:226（errorDetailsText）",
  },
  {
    key: "naturalWidth",
    reason: "重生成尺寸提示（與 naturalHeight 成對）；不透傳＝還原後尺寸提示消失",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/embed/use-canvas-generation.ts:344-345",
  },
  {
    key: "naturalHeight",
    reason: "同 naturalWidth（成對使用）",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/embed/use-canvas-generation.ts:344-345",
  },
  {
    key: "cost_hint",
    reason: "生成卡「预估 N 币」徽章；不透傳＝還原後預估花費消失",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/CanvasNodeView.tsx:240/503",
  },
  {
    key: "imageTaskId",
    reason: "canvas-event-settler 以 task_id 對帳落地；不透傳＝還原後在飛節點無法被 SSE 結算（卡在 pending）",
    verdict: "suspected-gap",
    evidence: "src/hooks/canvas/canvas-event-settler.ts:120/131/148",
  },
  {
    key: "startedAt",
    reason: "介面宣告鍵，但全庫查無 metadata.startedAt 讀者（同名欄位散見於 tool registry/job repository，非節點 metadata）",
    verdict: "dormant",
    evidence: "grep 'metadata?.startedAt' 零命中",
  },
  {
    key: "progress",
    reason: "NodeBody 進度條＋批次聚合讀它；不透傳＝還原後在飛節點失去進度（暫態，重載即過）",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:218-219；src/lib/canvas/batch-utils.ts:59",
  },
  {
    key: "topViewSvg",
    reason: "SVG 級重料（可達 48KB×2）會頂爆 512KB 上行快照；agent 用 director 工具讀工程真值、不讀 SVG",
    verdict: "intentional",
    evidence: "canvas-chat-types.test.ts:14 已釘死；NodeBody.tsx:670 讀者存在（靠 directorSessionId 拉 /director/state 補）",
  },
  {
    key: "cameraViewSvg",
    reason: "同 topViewSvg（成對的 SVG 級重料）",
    verdict: "intentional",
    evidence: "canvas-chat-types.test.ts:14 已釘死；NodeBody.tsx:671",
  },
];

/** 排除清單的鍵名（供測試列舉）。 */
export const AGENT_EXCLUDED_METADATA_FIELD_KEYS: readonly string[] = AGENT_EXCLUDED_METADATA_FIELDS.map(
  (e) => e.key,
);

// ─────────────────────────────────────────── 契約檢查器（供測試／CI 用）

/** 一個通道破口：耐久鍵既沒被 B 透傳、也沒被顯式排除（或排除條目無理由）。 */
export interface AgentChannelGap {
  readonly key: string;
  readonly reason: string;
}

/**
 * 找出「A 放行、B 卻既不透傳也不排除」的鍵。
 *
 * 這是本模組的存在理由：把「兩份手工鍵集合要同步」從註釋約定升級成**可執行判據**。
 * 參數全部可注入（測試用注入清單構造「新增鍵未同步」的案例，不必改源碼）。
 */
export function findAgentChannelGaps(
  durable: readonly DurableFieldSpec[],
  transmittedKeys: readonly string[],
  exclusions: readonly AgentFieldExclusion[],
): AgentChannelGap[] {
  const transmitted = new Set(transmittedKeys);
  const excluded = new Map(exclusions.map((e) => [e.key, e]));
  const gaps: AgentChannelGap[] = [];
  for (const field of durable) {
    if (transmitted.has(field.key)) continue;
    const exclusion = excluded.get(field.key);
    if (!exclusion) {
      gaps.push({ key: field.key, reason: "耐久鍵未列入 agent 透傳清單，且未列入顯式排除清單（雙白名單漏一端）" });
      continue;
    }
    if (!exclusion.reason.trim()) gaps.push({ key: field.key, reason: "排除清單條目沒有理由（不許靜默排除）" });
  }
  return gaps;
}

/**
 * 找出**說謊的排除條目**：已被 B 透傳（實際存活）卻仍列在排除清單，或根本不是耐久鍵。
 * 用途＝防止「把鍵全塞進排除清單」把 `findAgentChannelGaps` 洗白。
 */
export function findStaleAgentExclusions(
  durable: readonly DurableFieldSpec[],
  transmittedKeys: readonly string[],
  exclusions: readonly AgentFieldExclusion[],
): AgentFieldExclusion[] {
  const durableKeys = new Set(durable.map((f) => f.key));
  const transmitted = new Set(transmittedKeys);
  return exclusions.filter((e) => transmitted.has(e.key) || !durableKeys.has(e.key));
}
