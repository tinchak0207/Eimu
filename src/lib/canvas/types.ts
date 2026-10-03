// 畫布指揮臺：資料結構與 SSE 事件契約。
//
// 角色 owner：reference 節點的 referenceRole 直接引用 image-types 的
// ReferenceImageRole（type-only import），不建第二套枚舉。
//
// 架構（暴君立場定稿 2026-08-12）：
//   deepseek（opencode agent）不思考畫布的事。它只提交 image_* 生成請求。
//   VPS gateway 攔截每個 image_* 工具的參數與結果，自動產生「畫布單元」，
//   並以 canvas.* 事件推送到前端。前端 reducer 接住事件自動渲染畫布。
//
// 本檔案 = 前端與後端共用的契約。任何改動必須同步兩端。

import type { ReferenceImageRole } from "../image-types";
import type { StoryboardSceneRef, StoryboardScriptShot } from "../storyboard-contract";
import type { StoryboardShotCandidateSet } from "./storyboard-shots";
import type { TaskVersionSet } from "./task-versions";
import { AID_PROJECT_TYPE_ENUM, type AidProjectTypeEnumValue } from "../aid-enums/creation";
// 劇本型別（P1-5／D7）：值域直接取自既有 AID enum（見 CanvasProject.scriptType 的註解）。
import { type CanvasScriptType } from "./project-narration";
// 批准狀態形狀的單一真源（type-only：執行期零依賴，不成環——`storyboard-contract.ts`
// 已用同一寫法 type-only import 本檔，本檔反向 type-only 取 `ApprovalState` 是同構先例）。
import type { ApprovalState } from "../character-cards";

// ─────────────────────────────────────────── 作品形態值域

/**
 * 作品形態值域：`movie`（電影）/ `series`（劇集）。
 *
 * 值域來源＝AID `ProjectTypeEnum`（`src/lib/aid-enums/creation.ts`，MIT 逐字入庫）。
 * 本站的作品/劇集實體本身就是吞 AID 產品層刀 1 的產物，形態詞彙不另立第二套——
 * 兩處各寫一份 `"movie" | "series"` 就是兩個漂移點（AID 改值時本站默默不收）。
 *
 * 消費點：`CanvasProject.projectType`（落盤形狀）與 `CanvasProjectMetaPatch.projectType`
 * （agent op 載荷）必須同值域，故共用本型別。
 */
export const CANVAS_PROJECT_TYPES = [
  AID_PROJECT_TYPE_ENUM.MOVIE.value,
  AID_PROJECT_TYPE_ENUM.SERIES.value,
] as const;

/** 作品形態（＝AID `ProjectTypeEnum` 的值集合）。 */
export type CanvasProjectType = AidProjectTypeEnumValue;

/**
 * 執行期判據。agent 載荷（SSE 反序列化）與 Blob 讀回的值都不可信，一律過此；
 * 直接寫 `v === "movie" || v === "series"` 則值域改動時必漏改一處。
 */
export function isCanvasProjectType(value: unknown): value is CanvasProjectType {
  return typeof value === "string" && (CANVAS_PROJECT_TYPES as readonly string[]).includes(value);
}

export type CanvasPosition = { x: number; y: number };

/** 平移 + 縮放，k = scale。 */
export type CanvasViewport = { x: number; y: number; k: number };

export enum CanvasNodeType {
  Image = "image",
  Text = "text",
  Config = "config",
  Video = "video",
  Group = "group",
  CharacterCard = "character_card",
  SceneCard = "scene_card",
  Audio = "audio",
  /** 提示詞備忘節點：可直編文本，連到生成節點時文本注入為 prompt 前綴。 */
  Prompt = "prompt",
  /** 帶角色的參考圖節點：復用 ReferenceImageRole，連到生成節點時自動帶圖+角色。 */
  Reference = "reference",
  /**
   * 3D 導演台節點（2026-09-02 spec §5 片5）：gateway director.done 攔截同步，
   * metadata 帶服務端預渲染 SVG 示意（topViewSvg/cameraViewSvg）與分鏡摘要。
   */
  Director = "director",
  /**
   * 3D 場景卡（2026-09-06 Astra PRD P1-3）：3D 導演 subagent 出片落地位——
   * turntable 視頻主體 + stills 縮圖網格 + 資產下載（.blend/.glb），P1 只讀+播放。
   * metadata 走 sceneCard 欄位族（Scene3dCardMetadata），雙白名單鐵律見
   * canvas-snapshot-compressor 記憶。
   */
  Scene3d = "scene_3d",
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";

/**
 * 錯誤詳情物件形（2026-08-27 G-FE 合同）：gateway 對失敗幀下發
 * `{ message, human_message }`——human_message 是給人看的中文短句，
 * message 是原文。舊載荷仍是純字串，兩形並存。
 */
export interface CanvasErrorDetails {
  message?: string;
  human_message?: string;
}

/** 錯誤詳情 → 展示文字：帶 human_message（中文短句）優先，缺省回落原文；空值回 undefined。 */
export function errorDetailsText(details: string | CanvasErrorDetails | undefined): string | undefined {
  if (typeof details === "string") return details.length > 0 ? details : undefined;
  if (!details) return undefined;
  const human = typeof details.human_message === "string" && details.human_message.length > 0 ? details.human_message : undefined;
  if (human !== undefined) return human;
  return typeof details.message === "string" && details.message.length > 0 ? details.message : undefined;
}

/**
 * 協作確認閘的裁決憑據（門禁卡 metadata.gateConfirm，2026-09-24）。
 * 寫入者只有網關（workflow-gw 的 markGateNodeState），前端只讀＋據此發一次
 * POST /api/agent/sessions/{session_id}/confirm（既有確認端點，不另開通路）。
 */
export interface CanvasNodeGateConfirm {
  /** 網關 pendingConfirms 的鍵（裁決憑據；同一筆重放是冪等的）。 */
  request_id: string;
  /** 站點轉發用的會話鍵（= 網關 session id）。 */
  session_id: string;
  /** 卡面狀態真值：pending 可批准/退回；approved/rejected 為已裁決（唯讀）。 */
  status: "pending" | "approved" | "rejected";
}

/** 節點元資料：承載 prompt/模型/尺寸/任務/結果。與 gateway autoCreateCanvasUnit 產出對齊。 */
export interface CanvasNodeMetadata {
  content?: string; // 圖片節點 = public URL；文本節點 = 正文
  prompt?: string;
  negativePrompt?: string;
  model?: string;
  size?: string;
  quality?: string;
  count?: number;
  kind?: string; // "image" | "video"
  source_image?: string | null; // edit/upscale 的來源 mediaId/URL
  status?: CanvasNodeStatus;
  errorDetails?: string | CanvasErrorDetails;
  naturalWidth?: number;
  naturalHeight?: number;
  cost_coins?: number;
  /** canvas.plan 的預估花費（單位幣；C-FE）：實際 cost_coins 落地前，節點卡顯示「預估 N 幣」。 */
  cost_hint?: number;
  imageTaskId?: string;
  startedAt?: number;
  progress?: number;
  // P1-3: 鏡頭語言 metadata
  shot_size?: string; // 景別：特寫/近景/中景/全景/遠景
  camera_move?: string; // 運鏡：固定/推進/拉遠/搖鏡/跟拍
  // P1: workflow 識別
  workflow_id?: string;
  session_id?: string;
  // P2: 角色卡/場景卡 metadata
  description?: string;
  key_features?: string[];
  role?: string;
  locked?: boolean;
  // P3: 批次 & 查閱 metadata
  referenceNodeIds?: string[];
  batchIndex?: number;
  batchTotal?: number;
  storageKey?: string;
  mimeType?: string;
  bytes?: number;
  /** 文本節點字號（px）；未設取 14.5。 */
  fontSize?: number;
  /** reference 節點的參考圖角色（復用 ReferenceImageRole，不另立枚舉）。 */
  referenceRole?: ReferenceImageRole;
  /**
   * 流水線結構卡標記（agent-template-canvas 鋪的泳道卡）：step_head = 步驟頭卡、
   * tool = 工具卡、gate = 門禁卡、note = 配方卡（後端 derived notes，正文=content）、
   * director = 導演台卡（gateway director.done 同步）。
   * 渲染層（NodeBody/CanvasNodeView）據此走結構化分層正文；與既有 kind（image/video）分開，不混用。
   */
  pipelineCard?: "step_head" | "tool" | "gate" | "note" | "director";
  /** 工具卡：工具 id（等寬字體渲染）。 */
  toolId?: string;
  /** 工具卡：輸入/輸出契約。 */
  toolInput?: string;
  toolOutput?: string;
  /** 工具卡：harness 未接 upstream（紅色警示行，不冒充可用）。 */
  unsupported?: boolean;
  /** 工具卡：缺失的上游能力標識。 */
  requiredCapability?: string;
  /** 步驟頭卡：本步產出合同全文。 */
  deliverable?: string;
  /**
   * 骨架節點：本步驗收門禁一行（後端 workflow 骨架經 SSE canvas.node.created/updated
   * 帶入；與 pipelineCard 的 "gate" 卡型別是兩回事，勿混）。boolean 形態是
   * workflow-dsl 的既有契約（compile.ts md.gate = true——「需人工批准」旗標），
   * 兩種寫入者共用本欄位，string = 全文門禁、true = 僅標記需批准。
   */
  gate?: string | boolean;
  /**
   * 門禁卡可操作狀態（2026-09-24 協作確認閘）：網關在協作檔的停點註冊 pending
   * confirm 後，把該筆確認回寫到門禁卡 metadata，前端據此把「驗收條件」從純文字
   * 變成可直接批准/退回的卡（不必回對話裡找確認卡）。
   * 只在協作檔、且僅在該次停點未決期間存在——批准/退回後 status 翻面並保持可讀；
   * 交付物變更（重生成/換圖）會重新回到 pending（網關按交付物指紋記批准）。
   */
  gateConfirm?: CanvasNodeGateConfirm;
  /**
   * 分鏡批准狀態（2026-09-24 WS-審查：分鏡審查面板的批准/駁回寫進節點）。
   * 形狀與卡側**同一個** `ApprovalState`（`character-cards.ts`，type-only import 不建
   * 第二套）；清洗唯一收口＝`normalizeApprovalState`（讀取端與上行端共用同一把尺）。
   *
   * ⚠️ 本鍵**必須同時**存在於兩處 metadata 白名單，否則刷新/回舊會話即靜默消失
   *（不是當下失效，是同會話內看起來正常、重載後退回「未批准」態）：
   *   - 讀取/還原端 `src/lib/canvas/layout.ts` 的 `toNodeMetadata`
   *   - 上行/壓縮端 `src/hooks/canvas/canvas-chat-types.ts` 的 `compactMetadataForAgent`
   *
   * 與同層 `gateConfirm`（網關門禁裁決憑據）是**兩個獨立鍵**：前者＝人對分鏡交付物的
   * 批准，後者＝協作確認閘的 pendingConfirms 憑據；不合併、不互相推導。
   */
  approval?: ApprovalState;
  /** 步驟頭卡：本步輸入來源。 */
  inputFrom?: string;
  /** 步驟序號（生成卡頂欄 stepName 條）。 */
  stepIndex?: number;
  /** 步驟全名（生成卡頂欄）。 */
  stepName?: string;
  /** 生成卡：本步 requiredTools 的 id 清單（agent 執行軌跡）。 */
  toolIds?: string[];
  // ── director 節點（pipelineCard: "director"，gateway director.done 攔截同步）──
  /** 導演工程所屬的 gateway 會話 id。 */
  directorSessionId?: string;
  /** 當前活躍方案名（無方案 / reset 後為 null）。 */
  planName?: string | null;
  /** 活躍方案的鏡頭數。 */
  shotCount?: number;
  /** 分鏡健康：true 綠徽章，false 琥珀。 */
  healthOk?: boolean;
  /** 服務端預渲染俯視圖（<svg> 原文；合計 >48KB 時省略）。 */
  topViewSvg?: string;
  /** 服務端預渲染鏡頭框圖（<svg> 原文；合計 >48KB 時省略）。 */
  cameraViewSvg?: string;
  /** 導演工程 revision（gateway doc.revision 透傳）：已掛載視口比對變化重拉 state。 */
  revision?: number;
  // ── 3D 場景卡節點（type: scene_3d，2026-09-06 Astra PRD P1-3；3D 導演 subagent 回傳寫入）──
  /** 3D 場景卡欄位族（單一物件欄位，內部形狀 = Scene3dCardMetadata）。 */
  sceneCard?: Scene3dCardMetadata;
  // ── 3D 舞台參考的回分鏡溯源（P1-1，2026-09-28）──
  /**
   * 本生成節點的參考圖來自哪個 3D 導演台 stage＝`scene_3d` 節點 id。
   * 鍵名沿用 director 族 `directorSessionId` 的 `<domain>Id` 形；值域＝節點 id 字串。
   * 寫入者＝生成時 `resolveSceneDirectorReferences` 配對的 trace（scene-3d-reference.ts）；
   * **雙白名單**：漏 `layout.toNodeMetadata` 或 `canvas-chat-types.compactMetadataForAgent`
   * 任一處＝刷新/回舊會話後指針憑空消失（與 sceneCard 同族鐵律）。
   */
  directorStageId?: string;
  /**
   * 本生成所屬鏡號（`storyboard-contract` 生產形 `StoryboardShotProduction.shotId`
   * 口徑＝`shotNumber`，上限 16 字）；無分鏡歸屬＝缺席。
   * 與 `directorStageId` 成對＝回分鏡可追溯指針；清洗規則同族。
   */
  shotId?: string;
  // ── 集歸屬（P1-2，2026-09-29；按集批次換模型／批次重跑的唯一分組維度）──
  /**
   * 本分鏡屬於哪一集＝`CanvasProject.episodes[].id`（`CanvasEpisode.id`，types.ts 的
   * 三級狀態機第二層）。鍵名沿用同族 `<domain>Id` 形（`directorStageId`/`directorSessionId`）。
   *
   * **現場缺口如實記錄**：畫布沒有 parent 邊、場景外殼只帶 `sceneName`、
   * `CanvasNodeMetadata` 原本無任何集欄位 ⇒ 分鏡→集無法推導，故以本欄位明示。
   * 缺席＝不歸任何一集（`storyboard-episode-batch.ts` 不猜、不按節點序切段）。
   * **雙白名單**：漏 `layout.toNodeMetadata` 或 `compactMetadataForAgent` 任一處
   * ＝刷新/回舊會話後集歸屬消失（按集換模型會靜默漏掉這些格）。
   */
  episodeId?: string;
  // ── 分鏡級抽卡（P1-2，2026-09-29；對稱差 D9「一分鏡 ≤4 條＋星標選定」）──
  /**
   * 本鏡的候選集＋星標選中者（形狀＝`StoryboardShotCandidateSet`，真源
   * `./storyboard-shots.ts`）。**刻意不是新增多個候選節點**：一鏡仍是一顆節點，
   * 候選集掛在此處，`selectedId` 就是採用稿。
   *
   * 清洗端＝`normalizeShotCandidates`（`id`+`prompt` 缺一即丟該條、同 id 去重、
   * 截到 `SHOT_CANDIDATE_LIMIT`、`selectedId` 必須是成員、空集合＝省略鍵）。
   * **雙白名單**：與 `storyboardShot` 同族鐵律。
   */
  shotCandidates?: StoryboardShotCandidateSet;
  // ── 任務版本＋標籤＋選中（P1-9，對稱差 D37；2026-09-29）──
  /**
   * 本格的任務版本史 ＋ 星標選中的那一版（形狀＝`TaskVersionSet`，真源
   * `./task-versions.ts`）。**刻意不是「任務節點」**：一「格」＝一顆節點，同一格重跑
   * ＝追加一筆**新版本**（`items[].version` ＝任務時戳，ISO 8601 UTC），舊版本原樣留著。
   *
   * `items[].tags` 值域＝`TASK_TAGS`（`main_image`/`main_video`，D37 字面）；
   * `selectedVersion` ＝素材 `Selected`（該版 `url` 即本格採用稿）。
   * 清洗端＝`normalizeTaskVersions`（`version` 解析不出即丟該筆、同版去重、按時序升序、
   * 裁到上限、`selectedVersion` 非成員即不收、空集合＝省略鍵）。
   *
   * **雙白名單**：與 `shotCandidates` 同族鐵律——漏 `layout.toNodeMetadata` 或
   * `canvas-chat-types.compactMetadataForAgent` 任一處＝刷新/回舊會話後版本史與採用稿消失。
   */
  taskVersions?: TaskVersionSet;
  // ── 單鏡旁白文本 ＋ 對白／旁白雙音軌（2026-09-30；`audioAnchorId` 的生產者）──
  /**
   * 單鏡旁白**文本**（編劇/agent 寫入；`storyboard-shots.bindShotAudioTrack` 只讀不覆蓋）。
   * **不是音檔**：它是 TTS 逐鏡合成的輸入，不構成「配音就緒」。
   * **雙白名單**：與 `shotCandidates` 同族鐵律（真源 `node-metadata-fields.ts`）——
   * 漏一端＝刷新/回舊會話後旁白文本消失，逐鏡 TTS 無輸入。
   */
  narration?: string;
  /**
   * 該鏡對白音檔的資產 id（音軌錨 `audioAnchorId` 的優先來源）。
   * **雙白名單**：與 `narration` 同族——漏一端＝重載後對白軌消失。
   */
  dialogueAudioId?: string;
  /** 該鏡旁白音檔的資產 id（無對白軌時為錨）。白名單規則同 `dialogueAudioId`。 */
  narrationAudioId?: string;
  /**
   * 音軌錨（**相容鍵**）＝`dialogueAudioId || narrationAudioId`；門禁
   * `audio_anchor_present`/`dialogue_alignment` 逐鏡讀它。白名單規則同 `dialogueAudioId`。
   */
  audioAnchorId?: string;
  // ── 分鏡實體（2026-09-15 刀 2；AID 21 欄契約，MIT）──
  /**
   * 一鏡（AID 21 欄契約，`src/lib/storyboard-contract.ts`）：掛在 Group 節點的子節點。
   * 形狀 = `StoryboardScriptShot`（21 個字串欄，空值 = ""）。讀取端以
   * `normalizeStoryboardShot` 收斂——`shotNumber` 為空則整包丟棄（不製造半形分鏡）。
   */
  storyboardShot?: StoryboardScriptShot;
  /**
   * 場景外殼：掛在 **Group 節點**，`sceneName` 是場景歸屬唯一權威
   *（AID v2.1.4 已廢 `sceneCode`）。真值 = 子節點的 `storyboardShot`，此處只存指針。
   */
  storyboardScene?: StoryboardSceneRef;
  // ── 分鏡實體的卡引用（WS7 收口，2026-09-24；照 referenceNodeIds 的同款 id 陣列先例）──
  /**
   * 本鏡引用的角色卡 id（agent 模板交付自動落卡後回填；項目級鎖定在 `CanvasProject.cardIds`）。
   * 寫入者：自動回填（agent-output-cards 的 shotBackfill）+ 人工/上游指定。
   * **雙白名單**：與 storyboardShot 同族——漏 layout.ts toNodeMetadata 或
   * canvas-chat-types.ts compactMetadataForAgent 任一處 = 刷新/回舊會話後憑空消失。
   */
  characterCardIds?: string[];
  /** 本鏡引用的場景卡 id。清洗/白名單規則同 `characterCardIds`。 */
  sceneCardIds?: string[];
  /** 本鏡引用的道具卡 id。清洗/白名單規則同 `characterCardIds`。 */
  propCardIds?: string[];
  /** 本節點交付物自動落成的卡 id（冪等標記：同一節點不重複建卡）。 */
  entityCardId?: string;
  // ── 模板交付自動落卡（WS11 收口，2026-09-24；保留鍵，型別層具名）──
  /**
   * 本節點交付物自動落成的實體標記（保留鍵）。真源＝gateway 模板節點的
   * `defaults.emitsEntity`（`deploy-staging/gateway/workflow-templates/*`），
   * `expandTemplate` spread 進節點 metadata 後隨 SSE `canvas.node.created/updated` 落地；
   * 畫布側據此自動建卡（`src/lib/agent-output-cards.ts` 的 `emittedEntityOf`）。
   *
   * ⚠️ 這個鍵必須**同時**存在於兩處 metadata 白名單，否則**一進前端就被剝掉**
   *（不是重載才消失，是當下就沒了）：
   *   - 讀取/還原端 `src/lib/canvas/layout.ts` 的 `toNodeMetadata`
   *   - 上行/壓縮端 `src/hooks/canvas/canvas-chat-types.ts` 的 `compactMetadataForAgent`
   * 症狀是「整條功能完全沒反應」，排查時先確認鍵有沒有活過這兩處。
   *
   * 形狀與 `layout.ts` 的 `EmittedEntityMetadata`（＝`agent-output-cards.ts` 的
   * `EmittedEntitySpec` 同構）結構相容。五值字面與 `character-cards.ts` 的
   * `CHARACTER_CARD_KIND_VALUES` **逐字同步，刻意不 import 以避免環依賴**
   *（types → character-cards → agent-chat-client → agent-chat-types → types；
   * 措辭同 `layout.ts` 的 `EMITS_ENTITY_KINDS`——本檔是前後端共用契約根，
   * 不反向依賴客戶端卡模組）。漂移時會在本欄位的指派點炸型別錯，不靜默。
   */
  emitsEntity?: {
    kind: "character" | "scene" | "style" | "prop" | "audio";
    /** 卡名來源：預設節點標題；`"input"` ＝依序取底下三鍵的第一個非空值。 */
    nameFrom?: "nodeTitle" | "input";
    /**
     * 參考圖來源 role 清單（模板作者宣告；四視圖＝`["view2","view3","view4"]`）：
     * 同模板實例上哪些 role 的交付物是本實體的參考圖。
     * 清洗走 `layout.ts` 的 `cleanEmitsEntity`（非空字串陣列、trim、去重、≤8 項、單項 ≤100）。
     */
    referenceRoles?: string[];
    /**
     * 參考圖來源**節點 id** 清單（引擎 `expandTemplate` 的參考圖 post-pass 解出；
     * 站點據此把兄弟節點的交付圖併進同一張卡——四視圖聚合的站點側接線）。
     * 與 `referenceRoles` 同一個清洗函式（漏放行＝聚合功能當下被剝，不是重載才消失）。
     */
    referenceNodeIds?: string[];
  };
  /**
   * 落卡取卡名的來源（保留鍵；僅在 `emitsEntity.nameFrom === "input"` 時被讀）。
   * 順序真源＝`agent-output-cards.ts` 的 `NAME_FROM_INPUT_KEYS`（input → characterName
   * → sceneName），空字串/非字串在讀取端就被省略鍵。
   * `input` 是通用鍵名，但 canvas 節點 metadata 只有本語義（與同層的 `inputFrom`
   * ＝步驟頭卡輸入來源、`toolInput`＝工具卡契約是**不同鍵**），故在此具名收斂。
   */
  input?: string;
  characterName?: string;
  sceneName?: string;
}

/**
 * 3D 場景卡 metadata 形狀。**兩條生產者**：
 *   - `source: "director"`（或未標）＝ 3D 導演 subagent 回傳寫入（`blender-delegate.ts`），
 *     六欄全形；卡面 turntable 播放器 ＋ stills 網格 ＋ 資產下載。
 *   - `source: "import"` ＝ 用戶從本機導入的 GLB/GLTF（`scene-3d-import.ts` ＋
 *     `/api/canvas/scene-3d`），只保證 `glb_path`；卡面只出 GLB 視口與下載，
 *     **缺的欄位整塊不渲染**（不給空播放器/空網格）。
 *
 * 契約底線（清洗端 `toScene3dCard` 的整包丟棄判據）：`glb_path` 與 `scene_summary`
 * 非空才算一張場景卡——導入卡也不例外（`scene_summary` 必須是**真實**來源文字，
 * 不許編造場景描述）。`turntable_url` / `stills_urls` / `blend_path` / `duration_ms`
 * 為**可選**欄位（2026-09-27 本機導入刀放寬；導演卡仍永遠給全六欄）。
 *
 * 鐵律（canvas-snapshot-compressor 事故教訓）：本欄位族必須同步兩處白名單——
 * 讀取端 toNodeMetadata（layout.ts）與上行壓縮端 compactMetadataForAgent
 * （canvas-chat-types.ts），漏一端 = 刷新後欄位憑空消失；往復合同測試釘死。
 */
export interface Scene3dCardMetadata {
  /** turntable 旋轉展示視頻（mp4/webm 可播放 URL）。導演卡必給；導入卡無此欄。 */
  turntable_url?: string;
  /** 渲染静帧縮圖（3-6 張，卡內網格展示）。導演卡必給；導入卡無此欄。 */
  stills_urls?: string[];
  /** .blend 源檔下載路徑。導演卡必給；導入卡無此欄。 */
  blend_path?: string;
  /** .glb 交換格式下載路徑（**契約底線，兩條來源都必填**）。 */
  glb_path: string;
  /** 場景摘要（一句話，副標題展示）。**必填**：導入卡寫真實來源（如「从本机导入的 GLB」）。 */
  scene_summary: string;
  /** turntable 時長（ms；無值時播放器自帶 duration 顯示）。導入卡無此欄。 */
  duration_ms?: number;
  /** 卡片來源：`director`＝3D 導演 subagent 六欄全形；`import`＝本機導入的 GLB。 */
  source?: "director" | "import";
}

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  title: string;
  position: CanvasPosition;
  width: number;
  height: number;
  metadata?: CanvasNodeMetadata;
  /** 手動拖動過 = 不再參與自動排版（用戶掌控位置） */
  moved?: boolean;
  /** 批次父節點：子節點 id 列表 */
  batchChildren?: string[];
  /** 批次是否展開（收起時只顯示主圖片） */
  batchExpanded?: boolean;
  /** 批次主圖片節點 id（縮圖/封面） */
  batchPrimaryImageId?: string;
  /**
   * 軟刪除標記（2026-09-27 節點版本歷史＋回退）：ISO 時間戳，有值＝已軟刪。
   *
   * 軟刪的節點**不進** reducer 的可見 `nodes`（改收進 `deletedNodes`），呼叫端語義
   * （列表不含、連線斷開）與舊的硬刪一致；差別是資料還在，可經
   * `POST /api/canvas/nodes/restore` 或 `restoreCanvasNodes` 還原。
   * 節點級欄位（不是 metadata）：不進 metadata 雙白名單，不會被 `toNodeMetadata` 剝掉。
   */
  deletedAt?: string;
}

/**
 * 節點版本快照的落版原因（2026-09-27 節點版本歷史＋回退）：
 *   · created   —— agent/模板首次落節點
 *   · generated —— 生成完成（status → success / 交付 URL 落地）
 *   · edited    —— 內容編輯（文本直編提交、改名、prompt 改寫）
 *   · metadata  —— 非內容的 metadata 更新（模型/尺寸/角色…）
 *   · revert    —— 由某一版回退產生的新版本（版本歷史是**追加式**，回退本身也留痕）
 */
export type CanvasNodeVersionReason = "created" | "generated" | "edited" | "metadata" | "revert";

/**
 * 節點版本快照（2026-09-27）：一次「內容變更」＝一版。
 *
 * 「內容」＝ `title` ＋ `metadata`（純資料面）。座標/尺寸/連線**不進版本**——
 * 它們是版面狀態不是內容，回退一版不該把節點搬回舊位置（版面權在前端 reducer）。
 *
 * 持久化：掛在既有 `CanvasProject.nodeVersions`（不新增 DB/檔案）；上限由
 * `node-versions.ts` 的 `MAX_NODE_VERSIONS_PER_NODE` 逐節點裁剪。
 */
export interface CanvasNodeVersion {
  /** 同一節點內 1 起、單調遞增（append-only，回退也 +1）。 */
  version: number;
  nodeId: string;
  createdAt: string;
  reason: CanvasNodeVersionReason;
  /** 該版快照的節點標題。 */
  title: string;
  /** 該版快照的節點 metadata（深拷貝，不與當前節點共用參考）。 */
  metadata: CanvasNodeMetadata;
}

export interface CanvasConnection {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

/** 自動製畫布的「畫布單元」：一次生成請求 = 文本節點 + 配置節點 + 結果圖片節點。 */
export interface CanvasUnit {
  unitId: string;
  tool: string;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  /** canvas.plan 帶的預估花費（單位幣）；node.created 時蓋章到該單元的生成卡 metadata.cost_hint。workflow 計畫（tool 以 "workflow:" 開頭）例外——它是整圖總額，只進側欄不逐卡蓋章。 */
  costHint?: number;
}

// ─────────────────────────────────────────── SSE 事件契約（gateway → 前端）

/** canvas.plan — 一次生成請求的計畫卡。 */
export interface CanvasPlanEvent {
  unit_id: string;
  tool: string;
  label: string;
  prompt: string;
  model: string;
  size: string;
  count: number;
  kind: string;
  source_image: string | null;
  cost_hint: number | null;
}

/** canvas.node.created — 前端建一個節點。target_kind="result" 表示結果預留節點。 */
export interface CanvasNodeCreatedEvent {
  unit_id: string;
  node: CanvasNode;
  target_kind?: "result";
}

/** canvas.node.updated — 更新節點（通常是結果落地）。 */
export interface CanvasNodeUpdatedEvent {
  unit_id: string;
  node_id: string;
  patch: Partial<CanvasNodeMetadata> & { status?: CanvasNodeStatus };
  url?: string;
  cost_coins?: number;
}

/** canvas.node.connected — 建一條連線。 */
export interface CanvasNodeConnectedEvent {
  unit_id: string;
  connection: CanvasConnection;
  target_kind?: "result";
}

/** canvas.node.disconnected — 斷一條連線。 */
export interface CanvasNodeDisconnectedEvent {
  unit_id: string;
  from: string;
  to: string;
}

/** gateway 自動製畫布可能送出的全部 canvas 事件。 */
export type CanvasSseEvent =
  | { name: "canvas.plan"; data: CanvasPlanEvent }
  | { name: "canvas.node.created"; data: CanvasNodeCreatedEvent }
  | { name: "canvas.node.updated"; data: CanvasNodeUpdatedEvent }
  | { name: "canvas.node.connected"; data: CanvasNodeConnectedEvent }
  | { name: "canvas.node.disconnected"; data: CanvasNodeDisconnectedEvent }
  | { name: "canvas.node.generating"; data: { unit_id: string; node_id: string; status: string; progress?: number } }
  | { name: "canvas.node.deleted"; data: { unit_id: string; node_id?: string } }
  | { name: "canvas.derive.started"; data: { unit_id: string; source_node_id: string; instruction: string; interpretation?: string } }
  | { name: "canvas.budget.updated"; data: { unit_id?: string; used_coins: number; remaining_coins: number } }
  | { name: "canvas.ops"; data: CanvasAgentOpsEvent };

export const CANVAS_EVENT_NAMES = [
  "canvas.plan",
  "canvas.node.created",
  "canvas.node.updated",
  "canvas.node.connected",
  "canvas.node.disconnected",
  "canvas.node.generating",
  "canvas.node.deleted",
  "canvas.derive.started",
  "canvas.budget.updated",
  "canvas.ops",
] as const;

// ─────────────────────────────────────────── Agent 操作畫布（Wave C）

/**
 * 專案級欄位補丁（作品類型 / 流程步 / 劇集清單）。
 *
 * 形狀刻意與 `useCanvasChat().setProjectMeta` 的參數同構——那是這三欄的**唯一寫入口**
 * （`projectType`/`currentStep`/`episodes` 在 `CanvasProject` 頂層，不在 reducer state）。
 * 載荷一律不可信：執行前必須過 `normalizeProjectMetaPatch`（layout.ts）逐欄白名單。
 */
export interface CanvasProjectMetaPatch {
  projectType?: CanvasProjectType;
  currentStep?: number;
  episodes?: CanvasEpisode[];
  /**
   * 專案級風格綁定（P1-8／對稱差 D34）：`StyleTemplate.id`（值域唯一真源＝`STYLE_LIBRARY`，
   * 清洗見 `project-style.ts` 的 `normalizeProjectStyleId`）。型別是寬的 string 是因為
   * 載荷不可信——合法性一律在執行/落盤前判，非法值省略該鍵（同其余三欄語義）。
   */
  styleId?: string;
  /**
   * 劇本型別（P1-5／對稱差 D7）：值域與清洗同 `CanvasProject.scriptType`
   * （`project-narration.ts` 的 `normalizeProjectNarration`）。型別是寬的 string 是因為
   * 載荷不可信——合法性一律在執行/落盤前判，非法值省略該鍵（同其余欄語義）。
   */
  scriptType?: string;
  /** 旁白音色（P1-5／對稱差 D7）：`voice-library` 認可的 id；未知不落鍵。 */
  narrationVoice?: string;
}

/**
 * Agent 批量畫布操作：gateway 的 canvas_apply_ops 工具經 SSE 下發，
 * 前端一到即自動執行（畫布操作自動化，無人工確認閘）後把結果 POST 回 gateway resolve 該工具調用。
 * 與 infinite-canvas 的 8-op DSL 對齊，執行語義全在前端 reducer。
 *
 * 唯一例外：`set_project_meta`（2026-09-16 G1）改的是**專案級**欄位，不是畫布結構，
 * 由 hook 層的 `setProjectMeta` 執行（同 select_nodes / set_viewport / run_generation 的分工）。
 */
export type CanvasAgentOp =
  | { type: "add_node"; node: Partial<CanvasNode> & { id: string; type: CanvasNodeType | string } }
  | { type: "update_node"; id: string; patch: { title?: string; position?: CanvasPosition; width?: number; height?: number; metadata?: Partial<CanvasNodeMetadata> } }
  | { type: "delete_nodes"; ids: string[] }
  | { type: "connect_nodes"; connections: { fromNodeId: string; toNodeId: string }[] }
  | { type: "delete_connections"; ids: string[] }
  | { type: "select_nodes"; ids: string[] }
  | { type: "set_viewport"; viewport: Partial<CanvasViewport> }
  | { type: "run_generation"; node_id: string; prompt?: string; model?: string; size?: string; count?: number }
  /**
   * 專案級欄位補丁（2026-09-16 G1，刀 1 全鏈最後一環）：
   * `CanvasProject.currentStep/episodes/projectType` 在專案頂層，先前 8 個 op 無一可達
   * （PRD 全鏈定義「agent 調用 canvas_apply_ops 寫入 episode 節點成功」的缺口）。
   * 執行端 = hook 層 `setProjectMeta`；載荷清洗 = `normalizeProjectMetaPatch`。
   */
  | { type: "set_project_meta"; patch: CanvasProjectMetaPatch }
  /**
   * 節點版本回退（2026-10-03，人機共筆「版本回退」落地）：把該節點內容還原到指定版
   * （`version` 省略＝回上一版）。語義完全復用 reducer 的 `revert_node`（`applyNodeVersion`
   * 只還原 title+metadata，座標/尺寸不動；回退本身也 append 一版 reason="revert"，可再被回退）。
   * 與 `update_node` 的分工：update_node 寫新值；本 op 回到舊值——版本史住在畫布端，
   * agent 不必先把舊 metadata 抄進上下文。執行端＝adapter 的 agent_ops 分派（同一次 dispatch）。
   */
  | { type: "revert_node"; nodeId: string; version?: number };

export interface CanvasAgentOpsEvent {
  request_id: string;
  ops: CanvasAgentOp[];
  /** 一句話意圖（agent 提供）。 */
  label?: string;
}

// ─────────────────────────────────────────── 畫布專案（雲端持久化）

export interface CanvasProject {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport: CanvasViewport;
  backgroundMode: "dots" | "lines" | "blank";
  budget?: { totalCoins: number; usedCoins: number };
  /** P2 跨鏡頭一致性：鎖定到本畫布的角色/場景卡 id（CharacterCard.id）。 */
  cardIds?: string[];
  // ── 作品/劇集三級狀態機（2026-09-15 吞 AID 產品層刀 1；全部 optional，向後相容）──
  /** 作品類型：movie=電影（劇本用 episode 0）/ series=劇集。 */
  projectType?: CanvasProjectType;
  /** 7 步流程當前步驟（1..7）；未開始則 undefined。 */
  currentStep?: number;
  /** 劇集分集清單（電影留空）。 */
  episodes?: CanvasEpisode[];
  /**
   * 專案級風格綁定（P1-8／對稱差 D34）：`StyleTemplate.id`（見 `@/lib/style-library`）。
   *
   * 對應對手 `CreateProject.VisualPromptId`——風格 id 是**專案建立時的一等參數**，
   * 不是只在 skill/prompt 層的當次選擇；生成時由 `project-style.ts` 把 id 展開成
   * 對手 `VisualMeta.VisualStyle` 那樣的全文素材。**缺省＝無綁定，舊專案零改動**；
   * 註冊表查不到的 id 不落盤（`normalizeProject` 逐欄白名單省略該鍵）。
   */
  styleId?: string;
  /**
   * 劇本型別（P1-5／對稱差 D7）：`plot`（剧情演绎）｜`monologue`（真人解说漫＝**解說劇**）。
   *
   * 對應對手「AI Short drama」／「AI Commentary Drama」兩種型別。值域**不另立**，
   * 逐字取自既有 `AID_SCRIPT_TYPE_ENUM`（`@/lib/aid-enums/creation`）——該 enum 早就
   * 定義了這兩型，只是全 repo 沒有任何消費端（這正是 D7 說「零命中」的形狀）。
   * **缺省＝未宣告，舊專案零改動**；值域外的一律不落盤（`normalizeProject` 逐欄白名單省略該鍵）。
   */
  scriptType?: CanvasScriptType;
  /**
   * 旁白音色（P1-5／對稱差 D7）：對應對手的「narration voice configuration item」。
   *
   * 值域＝`voice-library.ts` 的語音庫（`normalizeVoiceId`，與 `POST /v1/tts/generations`
   * 的 `voice` 同一把尺）——避免出現「專案裡設了某音色、合成時被 400 voice_unknown」的假設定。
   * **只在 `scriptType === "monologue"` 時生效**；其他型別綁了＝衝突，
   * 由 `narrationVoiceConflicts` 具名回報（不靜默忽略、也不代用戶清掉）。
   * 缺省＝用上游預設音色（`DEFAULT_TTS_VOICE`），不假裝綁了某一顆。
   */
  narrationVoice?: string;
  /**
   * 節點版本歷史（2026-09-27）：所有節點的版本快照，按節點＋版號檢索。
   * 掛在既有專案物件上（不新增 DB/檔案）；逐節點上限見 node-versions.ts。
   * 舊專案無此欄＝空歷史，向後相容。
   */
  nodeVersions?: CanvasNodeVersion[];
  /**
   * 畫布作用域（2026-09-27 片P 刀 1）：`personal`（缺省）＝個人畫布，
   * 落 `canvas/<userId>/…`；`team`＝團隊共享畫布，落 `canvas/team/<teamId>/…`，
   * 該團隊所有成員可讀同一份（讀路徑合併），寫入仍為單寫（普通 PUT，後寫覆蓋，
   * 刻意不做鎖／CRDT／衝突解決）。
   *
   * **向後相容**：舊專案無此欄 ⇒ 一律視為 personal，路徑逐字不變。
   * 專案級欄位（不是節點/metadata）——不進 metadata 雙白名單，不會被 toNodeMetadata 剝掉
   *（同款先例：節點級 `deletedAt`／`nodeVersions`）。
   *
   * `teamId` 是**服務端蓋章**的權威值（來源＝控制面 team-membership 查詢），
   * 客戶端送來的 teamId 不採信（見 team-canvas-gate.ts）。
   */
  scope?: "personal" | "team";
  /** 團隊畫布所屬團隊 id（僅 scope="team" 時有意義；由服務端以已驗成員身份蓋章）。 */
  teamId?: string;
}

/**
 * 劇集分集（作品 → 劇集 → 分鏡的第二層）。
 *
 * 輪子來源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 源檔：sql/aid-init.sql 的 `aid_comic_episode` 表 + `aid_comic_script.original_text`
 * 取得日：2026-09-15
 * 逐字保留：episode_no（→ episodeNo）/ comic_title（→ title）/ original_text（→ script）
 * 白名單改寫（僅兩處）：
 *   1. 砍掉 AID 的審核三態 —— EpisodeStatusEnum 六態（0草稿/1制作中/2完成未审核/3审核中/
 *      4审核通过/5审核失败）在本站收斂為 `draft | processing | finished`（本站無審核隊列）。
 *   2. 剔除 pending_*（待審欄位）/ comic_desc / comic_cover_url / gen_mode / creation_mode /
 *      del_flag / create_by / update_by / remark。
 */
export interface CanvasEpisode {
  id: string;
  /** 集號，1 起整數。 */
  episodeNo: number;
  title: string;
  /** 完成狀態（砍 AID 審核三態）。 */
  status: "draft" | "processing" | "finished";
  /** 該集劇本原文（對應 aid_comic_script.original_text）。 */
  script?: string;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────── 節點預設尺寸

export const CANVAS_NODE_DEFAULT_SIZE: Record<CanvasNodeType, { width: number; height: number; title: string }> = {
  [CanvasNodeType.Image]: { width: 340, height: 240, title: "图片" },
  [CanvasNodeType.Text]: { width: 340, height: 240, title: "文本" },
  [CanvasNodeType.Config]: { width: 440, height: 240, title: "生成配置" },
  [CanvasNodeType.Video]: { width: 420, height: 236, title: "视频" },
  [CanvasNodeType.Group]: { width: 760, height: 480, title: "组" },
  [CanvasNodeType.CharacterCard]: { width: 340, height: 280, title: "角色卡" },
  [CanvasNodeType.SceneCard]: { width: 340, height: 280, title: "场景卡" },
  [CanvasNodeType.Audio]: { width: 340, height: 240, title: "音频" },
  [CanvasNodeType.Prompt]: { width: 340, height: 200, title: "提示词" },
  [CanvasNodeType.Reference]: { width: 300, height: 260, title: "参考图" },
  [CanvasNodeType.Director]: { width: 420, height: 300, title: "导演台" },
  [CanvasNodeType.Scene3d]: { width: 420, height: 360, title: "3D 场景卡" },
};

// ─────────────────────────────────────────── 批次 & 資源參考

/** 資源參考：節點關聯的可查閱資源（圖片/音訊等）。 */
export interface CanvasResourceReference {
  nodeId: string;
  kind: string; // 資源種類，如 "image" | "audio"
  label: string;
  title: string;
  previewUrl?: string;
  text?: string;
  active: boolean;
}

/** 批次操作指令：前端對批次父節點的本地操作。 */
export type CanvasBatchOperation =
  | { type: "add_child"; childId: string; imageUrl: string }
  | { type: "set_primary"; childId: string }
  | { type: "delete_child"; childId: string }
  | { type: "toggle_expanded" };
