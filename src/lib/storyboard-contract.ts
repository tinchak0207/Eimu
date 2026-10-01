/**
 * 分鏡 21 欄位契約（作品 → 劇集 → 分鏡的第三層實體，刀 2）。
 *
 * 輪子來源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 源檔：`doc/提示词开发指南.md` §「分鏡脚本与画师链路」輸出欄位表（本地取證副本 `/tmp/aid-prompt-guide.md:840`）
 * 取得日：2026-09-15
 * 逐字保留：21 個英文 key 的名稱**與順序**（AID 硬規則 §開發要點 1：名稱與順序不可改動）
 * 白名單改寫（僅此處）：
 *   1. **剔除第 22 欄 `sceneCode`**。AID v2.1.4 已明令（同檔 §開發要點 5）「場景歸屬使用外層
 *      sceneName，禁止輸出 sceneCode」；舊版 22 欄契約的 `sceneCode` 是場次編碼（`aid_storyboard
 *      .source_scene_code`），本站無場次編碼表，場景歸屬一律走 Group 節點的 `storyboardScene.sceneName`。
 *   2. AID 用 DB 表承載（`aid_storyboard` + `script_params` JSON）；本站**不建表、不建 migration**，
 *      改用既有 `CanvasNode.metadata`（Group 節點 = 場景外殼，子節點 = 一鏡一 shot）——
 *      PRD `docs/symdiff-aid-swallow-prd.md` §刀 2「白名單改寫」。
 *   3. AID 的 `image_prompt` / `video_prompt*` / `final_*_id` 不在 21 欄內，屬**成片階段**產物
 *      （畫師 agent / 視覺導演 / 後端選片），本站由後續刀（分鏡→成片）補，本檔不冒充。
 *
 * 空值規則（逐字沿用 AID）：無內容欄位填 `""`，不寫 null、不寫「无」。
 *
 * 本檔為純常數 + 純函數，無副作用。消費入口：
 *   - `CanvasNodeMetadata.storyboardShot`（子節點，一鏡一 shot）/ `.storyboardScene`（Group 節點）
 *   - 雙白名單兩處：`layout.ts toNodeMetadata`（讀取端）+ `canvas-chat-types.ts
 *     compactMetadataForAgent`（上行壓縮端）。漏一端 = 刷新/換裝置後 21 欄憑空消失
 *     （2026-09-03 director SVG 事故同型病灶，見記憶 canvas-snapshot-compressor-director-whitelist-fix）。
 *
 * REQ-B2（2026-09-23）：本檔多了一個**純邏輯**依賴 `./asset-scope`（零 IO、不成環），
 * 只為在「專案 cardIds → 鎖定卡」這條**生成注入路徑**上過一次作用域裁決
 * （`options.scope` 給了才生效；未給＝既有行為逐位不變）。
 *
 * 資產批准閘（2026-09-24）：型別 `ApprovalState` 與判定函式 `isAssetApproved` **單一真源在
 * `./character-cards`**（不另建第二套 shape、不重寫第二套判定），本檔只負責把它接到
 * **分鏡卡引用欄**（`filterApprovedShotCardIds` ＋ `productionFieldsFromContext` 第 ⑥ 條）。
 * 檔位語義同樣在該檔：**只有 `"collaborate"` 會擋**，`preset`/`auto`/未給 mode 一律放行（護城河）。
 */
import { isAssetApproved } from "./character-cards";
import type { ApprovalState } from "./character-cards";
import type { AgentInteractionMode } from "./agent-chat-client";
import { canUseAsset } from "./asset-scope";
import type { AssetScope, AssetShareRecord } from "./asset-scope";

/**
 * 21 欄名稱，**順序即 AID 契約順序**（逐字取自 `doc/提示词开发指南.md` §分鏡脚本 輸出欄位表）。
 * 型別由本常數推導（`StoryboardShotField`），所以名稱或順序改動會同時改到型別——不會漂移。
 */
export const STORYBOARD_SHOT_FIELDS = [
  "shotNumber",
  "scriptContent",
  "visualDescription",
  "dialogue",
  "actionState",
  "narrativeFunction",
  "timeOfDay",
  "eraCoordinate",
  "dateCoordinate",
  "weather",
  "referenceAssets",
  "shotSize",
  "cameraAngle",
  "focalLength",
  "cameraMovement",
  "composition",
  "atmosphere",
  "colorTone",
  "lighting",
  "exposureBlur",
  "soundEffect",
] as const;

export type StoryboardShotField = (typeof STORYBOARD_SHOT_FIELDS)[number];

/** 一鏡的 21 欄（全字串；空值 = `""`）。 */
export type StoryboardScriptShot = { readonly [K in StoryboardShotField]: string };

/**
 * 單欄長度上限（字元）。
 * 用途：`aid_storyboard` 對應欄位是 `text`（64KB byte），本站要過
 * `agent/sessions/[id]/canvas-state` 的 512KB 快照與 Blob 存檔，故收斂到 20000 字/欄。
 * 刻意**不逐欄設不同上限**：21 欄各自一套數字 = 21 個漂移點；單一上限已遠大於
 * AID 實務值（正文片段／畫面描述／台詞 ≤15 字），正常分鏡不會觸發。
 */
export const MAX_STORYBOARD_FIELD_CHARS = 20000;

/**
 * 上行快照（`compactMetadataForAgent`）的單欄上限。
 * 為何不是 20000（本檔 `MAX_STORYBOARD_FIELD_CHARS`）：單鏡 21 欄 × 20000 = 420KB，
 * 一顆節點就頂爆 `canvas-state` 的 512KB（`route.ts:15`）。4000 字/欄已遠大於 AID 實務值
 * （`scriptContent` 是保序切片後的一段正文、`dialogue` ≤15 字、`visualDescription` 一段），
 * 21 欄 × 4000 ≈ 84KB 是理論上界、實務單鏡約 1-2KB。
 *
 * **殘餘風險（誠實標記）**：截斷只發生在「上行給 agent 的快照」這一層；Blob 正規存檔
 * （`saveCanvasProject` → `normalizeProject`，nodes 原樣透傳）永遠是全形值。但 agent 若把
 * 讀到的截斷值再經 `canvas_apply_ops` 寫回，會覆蓋真值——與 `canvas-project-sync.ts:168`
 * 記錄的 episodes 寫回風險同型。當前判據：4000 字遠大於實務值，觸發機率近零；
 * 若未來出現 >4000 字的單欄，改法應是「整鏡不進快照」而非繼續截。
 */
export const STORYBOARD_SNAPSHOT_FIELD_CHARS = 4000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 逐欄清洗：非字串 → `""`（AID 空值規則）；超長截斷；其餘**逐字保留**（不 trim，保 scriptContent 原文相加=完整劇本）。 */
function cleanField(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.length > MAX_STORYBOARD_FIELD_CHARS ? v.slice(0, MAX_STORYBOARD_FIELD_CHARS) : v;
}

/**
 * 逐欄白名單清洗（照 `normalizeProject` / `normalizeEpisode` 範式）：只認 21 欄，其餘丟棄。
 * 判據：非物件、或 `shotNumber`（鏡號，本實體唯一鍵）清洗後為空 → 回 null（呼叫端丟棄該鏡，不整份作廢）。
 * 回傳物件的 key **順序 = `STORYBOARD_SHOT_FIELDS` 順序**（AID 硬規則：順序不可改動）。
 */
export function normalizeStoryboardShot(payload: unknown): StoryboardScriptShot | null {
  if (!isRecord(payload)) return null;
  const shotNumber = typeof payload.shotNumber === "string" ? payload.shotNumber.trim().slice(0, 16) : "";
  if (!shotNumber) return null;
  const out = {} as Record<StoryboardShotField, string>;
  for (const field of STORYBOARD_SHOT_FIELDS) {
    out[field] = field === "shotNumber" ? shotNumber : cleanField(payload[field]);
  }
  return out as StoryboardScriptShot;
}

/** 分鏡清單清洗：逐鏡白名單 → 丟棄非法項；`ordinal` 供「無法供應鏡號」時回報位置資訊。 */
export function normalizeStoryboardShots(payload: unknown): StoryboardScriptShot[] | null {
  if (!Array.isArray(payload)) return null;
  const out: StoryboardScriptShot[] = [];
  for (const item of payload) {
    const shot = normalizeStoryboardShot(item);
    if (shot) out.push(shot);
  }
  return out;
}

// ─────────────────────────────────────────── 上行快照壓縮（雙白名單第二處的純函數）

/**
 * 21 欄 → 快照用壓縮形（逐欄截 `STORYBOARD_SNAPSHOT_FIELD_CHARS`）。
 * 供 `compactMetadataForAgent`（`src/hooks/canvas/canvas-chat-types.ts`）呼叫——
 * 壓縮邏輯留在本檔，是為了讓「欄位清單只有一份」：新增欄位時只改
 * `STORYBOARD_SHOT_FIELDS`，壓縮器與讀取端自動跟上，不會出現
 * 「壓縮端漏欄」（= 刷新後空殼，2026-09-03 director 事故）。
 */
export function compactStoryboardShot(shot: StoryboardScriptShot): StoryboardScriptShot {
  const out = {} as Record<StoryboardShotField, string>;
  for (const field of STORYBOARD_SHOT_FIELDS) {
    const v = shot[field] ?? "";
    out[field] = v.length > STORYBOARD_SNAPSHOT_FIELD_CHARS ? v.slice(0, STORYBOARD_SNAPSHOT_FIELD_CHARS) : v;
  }
  return out as StoryboardScriptShot;
}

// ─────────────────────────────────────────── 場景外殼（AID 根結構 `scenes[].sceneName`）

/**
 * 場景外殼：掛在 Group 節點 metadata。
 * AID 根結構 = `{"scenes":[{"sceneName":"…","shots":[...]}]}`；本站 Group 節點承載
 * `sceneName`（場景歸屬的唯一權威，取代已廢的 `sceneCode`），一鏡一 shot 掛子節點。
 * `shotCount` 是給卡面顯示的冗餘指針，真值永遠在子節點（不在此存 shots，避免雙真源）。
 */
export interface StoryboardSceneRef {
  /** 場景名（AID 規則：必須逐字選自可用場景資產）。 */
  sceneName: string;
  /** 本場鏡數（顯示用指針）。 */
  shotCount: number;
}

/** 場景外殼清洗：sceneName 非空字串才成立；shotCount 非負整數，缺省 0。 */
export function normalizeStoryboardSceneRef(payload: unknown): StoryboardSceneRef | null {
  if (!isRecord(payload)) return null;
  const sceneName = typeof payload.sceneName === "string" ? payload.sceneName.trim() : "";
  if (!sceneName) return null;
  const raw = payload.shotCount;
  const shotCount =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  return { sceneName: sceneName.slice(0, 200), shotCount };
}

// ─────────────────────────────────────────── referenceAssets 解析

/**
 * `referenceAssets` 結構化結果（AID 格式：`場景:[图名] 角色:[图名]、… 道具:[图名]`）。
 * 名稱取自資產庫，未命中者 AID 後端會剔除；本站解析只做結構化，不做資產存在性判定。
 */
export interface StoryboardReferenceAssets {
  scene: string[];
  character: string[];
  prop: string[];
}

const REFERENCE_LABELS: ReadonlyArray<{ key: keyof StoryboardReferenceAssets; label: RegExp }> = [
  { key: "scene", label: /场景\s*[:：]/ },
  { key: "character", label: /角色\s*[:：]/ },
  { key: "prop", label: /道具\s*[:：]/ },
];

/** `场景:[A] 角色:[B]、[C] 道具:[D]` → `{scene:["A"],character:["B","C"],prop:["D"]}`；無標籤段落入前一個標籤；空輸入回三空陣列。 */
export function parseReferenceAssets(text: string): StoryboardReferenceAssets {
  const out: StoryboardReferenceAssets = { scene: [], character: [], prop: [] };
  if (typeof text !== "string" || text.length === 0) return out;
  const marks: { key: keyof StoryboardReferenceAssets; start: number; end: number }[] = [];
  for (const { key, label } of REFERENCE_LABELS) {
    const m = label.exec(text);
    if (m) marks.push({ key, start: m.index, end: m.index + m[0].length });
  }
  marks.sort((a, b) => a.start - b.start);
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end;
    const to = i + 1 < marks.length ? marks[i + 1].start : text.length;
    for (const name of text.slice(from, to).matchAll(/\[([^[\]]+)\]/g)) {
      const clean = name[1].trim();
      if (clean) out[marks[i].key].push(clean);
    }
  }
  return out;
}

// ─────────────────────────────────────────── storyboard_qc_17 門禁輸入橋接

/**
 * `storyboard_qc_17`（VPS `workspace/.opencode/tools/storyboard_qc_17.ts`）的輸入欄位名。
 * **注意**：門禁的欄名與 AID 21 欄**完全不同名**——門禁吃的是成片階段口徑
 * （`shotId/order/sceneId/prompt/durationSeconds/characterCardIds/sceneCardIds/keyframeId/
 * lastFrameId/audioAnchorId/aspectRatio`），21 欄是編劇階段口徑（`shotNumber/
 * scriptContent/visualDescription/…`）。不經本橋接直接餵 21 欄 → 門禁全門 block。
 */
export interface StoryboardQcShot {
  shotId: string;
  order: number;
  /** 生圖/視頻描述。21 欄無對應「畫師 prompt」欄（AID 的 `image_prompt` 由畫師 agent 另產），回退 `visualDescription`。 */
  prompt: string;
  sceneId?: string;
  durationSeconds?: number;
  characterCardIds: string[];
  sceneCardIds: string[];
  /**
   * 道具卡 id（本場鏡頭引用的道具資產，2026-09-24 加成欄位）。
   * **刻意不在 `QC_REQUIRED_FIELDS` 內**（見該常數上方註）：道具是加成不是門檻，
   * 缺道具不得讓門禁 block。門禁讀到不認得的鍵時忽略，故多帶此鍵對 17 門判定零影響。
   */
  propCardIds: string[];
  /**
   * 本鏡旁白文本（2026-09-30 加成欄位；單一鏡的旁白，供旁白 TTS 逐鏡合成對齊）。
   * 結構性動機：分鏡過去無旁白欄 → 旁白 TTS 只能整段合成、無法按鏡對齊
   * （記憶 `tts-multiline-narration-p2-bug`）。本欄是**加成欄位**：有則更好、無則不罰。
   * **刻意不在 `QC_REQUIRED_FIELDS` 內**（見該常數上方註）：我方 21 欄契約無旁白欄、AID 的
   * `dialogue` 也不是旁白（見 `productionFieldsFromContext`「刻意不做的推導」），一旦列為門檻，
   * 全部既有鏡次會瞬間多一項 missing＝純回歸。門禁 `storyboard_qc_17` 讀具名欄位、未知鍵忽略
   * → 本鍵對 17 門判定零影響。只在呼叫端供給時出現（不補默認值）。
   */
  narration?: string;
  keyframeId?: string;
  lastFrameId?: string;
  audioAnchorId?: string;
  aspectRatio?: string;
  /**
   * 本鏡的分鏡確認狀態（決策 24：新建的分鏡審查面板與資產面板同構，**與資產側同一個 shape**）。
   * 缺省＝已批准（決策 23 存量相容）；只在呼叫端供給時出現（不補默認值）。
   * **不在 `QC_REQUIRED_FIELDS` 內**：門檻欄位清單一個字不加，否則全鏡次瞬間多一項 missing。
   * 門禁 `storyboard_qc_17` 讀具名欄位、未知鍵忽略 → 本鍵對 17 門判定零影響。
   */
  approval?: ApprovalState;
}

/**
 * 成片階段欄位（21 欄契約無法供應，須由呼叫端提供；缺者列進 `missing` 並由門禁自行 block）。
 * 鍵 = `shotNumber`（AID 鏡號三位數）。
 */
export interface StoryboardQcProductionFields {
  sceneId?: string;
  durationSeconds?: number;
  prompt?: string;
  characterCardIds?: string[];
  sceneCardIds?: string[];
  /** 道具卡 id（`kind === "prop"` 逐字命中；加成欄位，不入 `QC_REQUIRED_FIELDS`）。 */
  propCardIds?: string[];
  /** 本鏡旁白文本（單一鏡的旁白；**加成欄位**，不入 `QC_REQUIRED_FIELDS`——有則更好、無則不罰）。 */
  narration?: string;
  keyframeId?: string;
  lastFrameId?: string;
  audioAnchorId?: string;
  aspectRatio?: string;
  /**
   * 本鏡的分鏡確認狀態（決策 24：分鏡審查面板的載體，**與資產側同一個 shape**）。
   * 缺省＝已批准（決策 23 存量相容）；只在呼叫端供給時出現（不補默認值）。
   * **不在 `QC_REQUIRED_FIELDS` 內**：門檻欄位清單一個字不加（加了＝全鏡次多一項 missing）。
   */
  approval?: ApprovalState;
}

export interface StoryboardQcBridgeResult {
  shots: StoryboardQcShot[];
  /** 仍有鏡次缺的成片階段欄位名（誠實回報，不補假值；門禁據此 block 是預期行為）。 */
  missing: string[];
  /** 全鏡成片階段欄位齊備（唯一可以宣告「門禁可望 17/17」的條件）。 */
  complete: boolean;
}

/**
 * 「缺了就列進 `missing`」的**門檻欄位**清單（門檻語義 = 缺 → `missing` → 門禁 block）。
 *
 * **刻意不含 `propCardIds`（2026-09-24 裁定，勿加）**：`missing` 會讓 `storyboard_qc_17`
 * 門禁把該鏡 block。現存所有鏡次都沒有 `propCardIds`，一旦把道具卡列為門檻欄位，
 * **全部鏡次會瞬間多一項 missing**（門禁分數從 11/17 起直接再掉）＝純回歸，不是新能力。
 * 道具卡是**加成欄位**：它照樣出現在 `StoryboardQcShot` 輸出上（與
 * `characterCardIds`/`sceneCardIds` 同構）、照樣有 `unresolvedProps` 誠實回報未命中的道具名，
 * 但**不參與** `missing` / `complete` 的判定——有則更好，無則不罰。
 *
 * **同樣刻意不含 `narration`（2026-09-30 裁定，勿加）**：旁白是同一類**加成欄位**——只有呼叫端
 * 供給時才出現在輸出上，未供給既不補默認值也不進 `missing`。理由同道具卡（加了＝全鏡次多一項
 * missing＝純回歸）；且我方 21 欄契約無旁白欄、無合法推導來源（見下方「刻意不做的推導」）。
 */
const QC_REQUIRED_FIELDS = [
  "sceneId",
  "durationSeconds",
  "characterCardIds",
  "sceneCardIds",
  "keyframeId",
  "lastFrameId",
  "audioAnchorId",
  "aspectRatio",
] as const;

/** 非空（trim 後）字串——門禁讀值前一律 trim（VPS `text()`），故純空白字串等於「沒有值」。 */
function isNonBlankString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * 「這一欄真的有值」的判準——**判的是值，不是鍵存不存在**。
 *
 * 為何不能只判 `v === undefined`（2026-09-17 實測缺陷，已修）：
 *   - `sceneId: ""` 舊判準算「已供給」→ `missing` 漏報、`complete` 回 `true`；
 *     但門禁 `Boolean(text(s.sceneId))` 照樣 block →「橋接宣告可望 17/17、門禁實際 11/17」。
 *   - `durationSeconds: NaN` 舊判準算「已供給」，且 `typeof NaN === "number"` 讓它**真的被送進門禁**；
 *     `JSON.stringify` 把 NaN 變成 `null` → 門禁 `num(null)` → `undefined` → 一樣 block。
 *   兩者都是「用空值騙門禁」的同型病灶，故本判準與門禁自身的正規化（trim 後非空、有限數）對齊。
 */
function hasUsableQcValue(field: (typeof QC_REQUIRED_FIELDS)[number], v: unknown): boolean {
  if (field === "characterCardIds" || field === "sceneCardIds") {
    return Array.isArray(v) && v.some((id): boolean => isNonBlankString(id));
  }
  if (field === "durationSeconds") return typeof v === "number" && Number.isFinite(v);
  return isNonBlankString(v);
}

/** 卡 id 陣列 → 只留非空字串（門禁 `strArr` 只認字串；非字串項不送過去，避免製造假綁定）。 */
function usableCardIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((id): id is string => isNonBlankString(id)) : [];
}

/**
 * `usableCardIds` + 去重（清洗規則**完全復用**，只多一步「同一來源內重複 id 只留一份」）。
 * 為何要一致：①②④ 的名稱解析路徑（`resolveReferenceAssetsToCardIds`）與
 * `storyboardQcContextFromProject` 的節點累積本來就 `!ids.includes(id)` 去重；
 * ⑤ 若不去重，同一批 id 會在 `fields` 裡長成 `["a","a"]`（審計跡與輸出無謂膨脹）。
 */
function uniqueCardIds(v: unknown): string[] {
  const out: string[] = [];
  for (const id of usableCardIds(v)) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * 21 欄分鏡 → 門禁輸入。只做**欄名映射**，不製造 21 欄裡不存在的值：
 *   - `shotId` ← `shotNumber`（無則 `S{序}`）、`order` ← 陣列序（門禁 `shot_order` 要求 1..N 連續）
 *   - `prompt` ← `production.prompt` ?? `visualDescription`
 *   - 其餘成片階段欄位只從 `production` 取，缺者列進 `missing`。
 */
export function storyboardQcShots(
  shots: readonly StoryboardScriptShot[],
  production?: Readonly<Record<string, StoryboardQcProductionFields>>,
): StoryboardQcBridgeResult {
  return storyboardQcShotsWith(shots, production);
}

/** `storyboardQcShots` 的實作本體（保持原函數簽名與語義不動，只抽出可被下方複用）。 */
function storyboardQcShotsWith(
  shots: readonly StoryboardScriptShot[],
  production?: Readonly<Record<string, StoryboardQcProductionFields>>,
): StoryboardQcBridgeResult {
  const missing = new Set<string>();
  const out = shots.map((shot, i) => {
    const p = production?.[shot.shotNumber] ?? {};
    const prompt = isNonBlankString(p.prompt) ? p.prompt : shot.visualDescription.trim();
    if (!prompt) missing.add("prompt");
    for (const field of QC_REQUIRED_FIELDS) {
      if (!hasUsableQcValue(field, p[field])) missing.add(field);
    }
    return {
      shotId: shot.shotNumber || `S${i + 1}`,
      order: i + 1,
      prompt,
      ...(isNonBlankString(p.sceneId) ? { sceneId: p.sceneId.trim() } : {}),
      ...(typeof p.durationSeconds === "number" && Number.isFinite(p.durationSeconds)
        ? { durationSeconds: p.durationSeconds }
        : {}),
      characterCardIds: usableCardIds(p.characterCardIds),
      sceneCardIds: usableCardIds(p.sceneCardIds),
      propCardIds: usableCardIds(p.propCardIds),
      ...(isNonBlankString(p.keyframeId) ? { keyframeId: p.keyframeId.trim() } : {}),
      ...(isNonBlankString(p.lastFrameId) ? { lastFrameId: p.lastFrameId.trim() } : {}),
      ...(isNonBlankString(p.audioAnchorId) ? { audioAnchorId: p.audioAnchorId.trim() } : {}),
      ...(isNonBlankString(p.aspectRatio) ? { aspectRatio: p.aspectRatio.trim() } : {}),
      // 旁白（加成欄位）：呼叫端供給才帶（同 `approval` 範式，未供給不補默認值 → 既有輸出鍵逐位不變）。
      ...(isNonBlankString(p.narration) ? { narration: p.narration.trim() } : {}),
      // 分鏡確認狀態：呼叫端供給才帶（未供給＝缺省＝已批准，不補默認值 → 既有輸出鍵逐位不變）。
      ...(p.approval ? { approval: p.approval } : {}),
    } satisfies StoryboardQcShot;
  });
  const missingList = [...missing];
  return { shots: out, missing: missingList, complete: shots.length > 0 && missingList.length === 0 };
}

// ─────────────────────────────────────────── 上下文 → 成片階段欄位（G5 合法推導）

/**
 * 卡索引最小形：只吃解析需要的三欄。
 * **刻意不 import `character-cards.ts`**：`canvas/types.ts:19` 已 type-only import 本檔，
 * 反向 import 會成環；本檔維持「純常數 + 純函式、零依賴」。呼叫端傳 `CharacterCard[]`
 * 結構相容（`id`/`name`/`kind` 三欄，見 `character-cards.ts:39-41`）。
 */
export interface StoryboardQcCardRef {
  id: string;
  name: string;
  kind: string;
  /**
   * REQ-B2 作用域（可選）。缺省＝personal（本帳號所有項目可用）。
   * 只在 `options.scope` 給了上下文時生效；未給＝既有行為逐位不變（零回歸）。
   */
  scope?: AssetScope;
  /**
   * 資產批准狀態（2026-09-24，**與 `CharacterCard.approval` 同一個 shape**，
   * 型別真源在 `./character-cards`）。缺省＝已批准（決策 23）。
   * 只在協作檔當門檻（見 `filterApprovedShotCardIds`）。
   */
  approval?: ApprovalState;
}

/**
 * REQ-B2 作用域裁決上下文（可選）。給了它＝卡清單與 `project.cardIds` 都先過
 * `canUseAsset`（= `resolveAssetVisibility` 的唯一入口）：跨項目、未顯式分享的卡
 * **不可見即不可用**——不進鎖定集合、不進注入上下文，另在 `outOfScopeCardIds` 如實回報。
 */
export interface StoryboardQcScopeContext {
  viewerUserId: number;
  /** 當前項目 id；null＝無項目上下文（項目歸屬的卡一律不可用，個人卡照用）。 */
  projectId: string | null;
  shares: readonly AssetShareRecord[];
}

/** 每鏡每欄的**值來源**（合法推導的可審計痕跡；缺者不在表內，改進 `missing`）。 */
export type StoryboardQcFieldSource = "production" | "referenceAssets" | "nodeSize" | "nodeMetadata";

/**
 * 分鏡節點 metadata 的最小形（**結構相容 `CanvasNodeMetadata`，不 import**）。
 * 為何不 import `canvas/types.ts`：該檔已 type-only import 本檔（`types.ts:19`），反向 import
 * 會成環；本檔維持「純常數 + 純函式、零依賴」（同 `StoryboardQcCardRef` / `StoryboardQcNodeRef` 範式）。
 *
 * `size` 語義不變（canvas 的 `size` 就是交付比例，見 ③ 條推導）。三個卡 id 欄（2026-09-24 新增）
 * 的真源是 agent 自動落卡後回填進節點 metadata 的引用——**粗（可能把該模板產出的卡全填上）**，
 * 因此推導優先序刻意排在 `referenceAssets`（編劇逐字指名）之後。
 *
 * `audioAnchorId`（2026-09-30 新增）**有真生產者**：逐鏡配音（`storyboard-voiceover`）把
 * `dialogueAudioId || narrationAudioId` 寫回節點 metadata；本欄供 `productionFieldsFromContext`
 * 第 ⑤ 條在呼叫端未供給時把它餵進門禁的 `audio_anchor_present`/`dialogue_alignment`。
 */
export interface StoryboardQcShotNodeMetadata {
  size?: unknown;
  /** 本鏡引用的實體卡 id（canvas 節點 metadata；真源見 `CanvasNodeMetadata`）。 */
  characterCardIds?: unknown;
  sceneCardIds?: unknown;
  propCardIds?: unknown;
  /**
   * 本鏡的音軌錨 id（2026-09-30 新增；節點 metadata 的相容鍵
   * `CanvasNodeMetadata.audioAnchorId` = `dialogueAudioId || narrationAudioId`，寫入者 =
   * `storyboard-voiceover` 逐鏡配音回寫）。**單值語義**（同 `size`，非卡 id 的集合語義）：
   * 同鏡多節點取首個非空，矛盾則整個不給——音軌錨是單一交付物，猜不得。
   */
  audioAnchorId?: unknown;
}

/**
 * 推導上下文。**每個欄位只在有真實來源時才生成**，缺者一律留在 `missing`（不補默認值）。
 *
 * - `production`：呼叫端已有的成片階段欄位（最高優先，覆蓋一切推導）
 * - `cards`：卡實體清單（唯一真源 = `character-card-store.listCharacterCards`，
 *   `src/lib/character-card-store.ts:122`）。**只用於名稱→id 解析**，不背書卡的存在性判定
 * - `shotMetadata`：每鏡節點 metadata（鍵 = `shotNumber`）。用兩族欄位：
 *   `size` 一欄推 `aspectRatio`（③）；`characterCardIds`/`sceneCardIds`/`propCardIds` 三欄推
 *   同名成片欄位（⑤，**只在 `production` 與 `referenceAssets` 都沒供給時才生效**）；
 *   `audioAnchorId` 一欄推同名成片欄位（⑤，2026-09-30；**單值語義**，只在 `production` 未供給時生效）
 * - `locked*CardIds`：專案級鎖定卡（真源 = `CanvasProject.cardIds`，`src/lib/canvas/types.ts:356`）
 */
export interface StoryboardQcContext {
  production?: Readonly<Record<string, StoryboardQcProductionFields>>;
  cards?: readonly StoryboardQcCardRef[];
  shotMetadata?: Readonly<Record<string, StoryboardQcShotNodeMetadata>>;
  lockedCharacterCardIds?: readonly string[];
  lockedSceneCardIds?: readonly string[];
  segmentDurationSeconds?: number;
  /**
   * 互動檔位（型別真源 = `AgentInteractionMode`，`src/lib/agent-chat-client.ts:749`）。
   * **只有 `"collaborate"` 會讓批准閘（第 ⑥ 條）生效**；未給 = `preset`/`auto` 待遇 =
   * 既有行為逐位不變（決策 2：全自動檔零改動、不停不阻塞＝護城河）。
   */
  mode?: AgentInteractionMode;
}

/** ratio 形狀（`9:16`）。**只認已顯式是比例的欄位**，不把像素尺寸換算成比例（見 `productionFieldsFromContext` 註）。 */
const RATIO_SHAPE = /^\d+:\d+$/;

/**
 * 卡名 → 卡 id 索引（**同名同kind 歧義者整批排除**）。
 *
 * 為何排除而非取首個：`CharacterCard.name` 沒有唯一性約束（`character-cards.ts:85` 只驗非空與長度），
 * 撞名時任取一個就是**猜**——寧可回報未解析（該鏡進 `missing`），也不把兩張卡混為一談。
 * 名稱比對用 trim 後逐字相等（不做大小寫/前綴模糊匹配：模糊匹配會把不同卡黏在一起）。
 * `prop` 表**沿用完全同一套規則**（同 kind 逐字命中、同名同 kind 歧義整批排除），
 * 不為道具另立規則；`style` 卡不進任何表（風格不是道具）。
 */
export function indexCardsByName(cards: readonly StoryboardQcCardRef[]): {
  character: Map<string, string>;
  scene: Map<string, string>;
  prop: Map<string, string>;
} {
  const seen = new Map<string, { id: string; duplicated: boolean }>();
  for (const card of cards) {
    if (!card || typeof card.id !== "string" || typeof card.name !== "string" || typeof card.kind !== "string") continue;
    const id = card.id.trim();
    const name = card.name.trim();
    if (!id || !name) continue;
    const key = `${card.kind}\u0000${name}`;
    const prev = seen.get(key);
    if (prev) prev.duplicated = true;
    else seen.set(key, { id, duplicated: false });
  }
  const character = new Map<string, string>();
  const scene = new Map<string, string>();
  const prop = new Map<string, string>();
  for (const [key, entry] of seen) {
    if (entry.duplicated) continue;
    const [kind, name] = key.split("\u0000");
    if (kind === "character") character.set(name, entry.id);
    else if (kind === "scene") scene.set(name, entry.id);
    else if (kind === "prop") prop.set(name, entry.id);
    // 其餘 kind（含 "style"）不進任何表：風格卡不是道具、也不屬門禁兩集。
  }
  return { character, scene, prop };
}

/**
 * `referenceAssets` → 卡 id（**名稱逐字命中才成立**）。
 *
 * 語義邊界（誠實標記）：AID 的 `referenceAssets` 名稱取自**資產庫**（`storyboard-contract.ts`
 * 契約註：名稱取自資產庫、未命中者 AID 後端剔除），本站資產庫有兩族：
 *   - `CharacterCard`（`kind: "character"|"scene"|"prop"`）→ 可解析成卡 id
 *   - 資產包/歷史資產條目（`node-to-asset-items.ts`）→ **沒有卡 id**，解析不到（留在 unsolved）
 * 故：解析失敗 = 名稱不存在於卡清單，或該名稱屬資產包另一族，或同名歧義 —— 三種都**不臆造 id**。
 *
 * **三段的 `unresolved*` 語義現在一致**（2026-09-24 統一）：「真的沒命中」的名稱清單——
 * 名稱在卡清單裡找不到（含同名歧義、kind 不符）才進這裡。舊版 `unresolvedProps` 是
 * 「本站沒有對應欄位」的原樣回報（`propCardIds` 不存在於門禁 Shot），道具卡走完解析鏈後
 * 該語義已失效：`prop` 段現在與角色/場景段**逐字同一條解析規則**（`kind === "prop"` 命中
 * `indexCardsByName` 的 prop 表 → 卡 id；未命中 → `unresolvedProps`）。
 */
export function resolveReferenceAssetsToCardIds(
  referenceAssets: string,
  cards: readonly StoryboardQcCardRef[],
): {
  characterCardIds: string[];
  sceneCardIds: string[];
  propCardIds: string[];
  unresolvedCharacters: string[];
  unresolvedScenes: string[];
  unresolvedProps: string[];
} {
  const parsed = parseReferenceAssets(referenceAssets);
  const index = indexCardsByName(cards);
  const resolve = (names: string[], table: Map<string, string>) => {
    const ids: string[] = [];
    const unresolved: string[] = [];
    for (const name of names) {
      const id = table.get(name);
      if (id === undefined) unresolved.push(name);
      else if (!ids.includes(id)) ids.push(id);
    }
    return { ids, unresolved };
  };
  const character = resolve(parsed.character, index.character);
  const scene = resolve(parsed.scene, index.scene);
  const prop = resolve(parsed.prop, index.prop);
  return {
    characterCardIds: character.ids,
    sceneCardIds: scene.ids,
    propCardIds: prop.ids,
    unresolvedCharacters: character.unresolved,
    unresolvedScenes: scene.unresolved,
    unresolvedProps: prop.unresolved,
  };
}

// ─────────────────────────────────────────── 資產批准閘（檔位相關，2026-09-24）

/** 分鏡的三條卡引用欄（鍵名 = `storyboard_qc_17` 門禁欄名；本檔唯一清單，勿另立）。 */
const SHOT_CARD_ID_FIELDS = ["characterCardIds", "sceneCardIds", "propCardIds"] as const;

/**
 * 卡 id 過批准閘（純函式；**只有協作檔會擋**——護城河寫在函式體內，不靠呼叫端自律）。
 *
 * 規則（決策 2/23）：
 *   - `mode !== "collaborate"`（含 `preset`/`auto`/**未給 mode**）→ **原樣回傳**：
 *     順序與重複項逐位不變（全自動檔零改動、既有呼叫端零漂移）。
 *   - `mode === "collaborate"` → 逐 id 問 `isAssetApproved`（判定單一真源在 `./character-cards`）：
 *     顯式 `pending`/`rejected` 的卡 id 剔除；缺 `approval` 的卡（＝已批准）保留。
 *   - **卡清單裡查不到的 id → 保留**：查不到 ≠ 未批准，不猜（與 `unresolvedCardIds` 同一條界線）。
 *   - 同 id 多筆卡且其中有未批准者 → **擋**（不能證明已批准的，不當已批准處理）。
 *
 * 呼叫端＝寫入/消費分鏡卡引用欄的人（分鏡審查面板、`productionFieldsFromContext` 第 ⑥ 條）。
 * 本函式**只做判定**：不做 UI 觸發、不改 gateway、不動扣費。
 */
export function filterApprovedShotCardIds(
  ids: readonly string[] | undefined,
  cards: readonly StoryboardQcCardRef[],
  mode?: AgentInteractionMode,
): string[] {
  const list = Array.isArray(ids) ? ids : [];
  if (mode !== "collaborate") return [...list];
  const unapproved = new Set<string>();
  for (const card of cards ?? []) {
    if (!card || typeof card.id !== "string") continue;
    const id = card.id.trim();
    if (!id) continue;
    if (!isAssetApproved(card.approval, mode)) unapproved.add(id);
  }
  return list.filter((id) => typeof id === "string" && !unapproved.has(id.trim()));
}

export interface StoryboardQcContextFields {
  /** 鍵 = `shotNumber`；值只含**真的有來源**的欄位（呼叫端 production 覆蓋推導值）。 */
  fields: Record<string, StoryboardQcProductionFields>;
  /** 鍵 = `shotNumber` → 欄位 → 值來源（審計跡；無來源欄位不出現，改進 `missing`）。 */
  sources: Record<string, Record<string, StoryboardQcFieldSource>>;
  /**
   * 鍵 = `shotNumber` → 被批准閘擋下的卡 id（**只在協作檔且真的有擋到時出現**）。
   * 為何要回報：被擋下的 id 不進 `fields`（連帶該欄進 `missing`），若不同時回報，
   * 呼叫端只看到「憑空少了一張卡」＝無法解釋，正是本閘要修的「不明不白」病灶。
   */
  blockedCardIdsByShot?: Record<string, string[]>;
}

/**
 * 上下文 → 成片階段欄位（純函數，唯一推導入口——**不用隱式魔法、不改任何既有函數語義**）。
 *
 * 目前**只有五條**推導成立（每條都有來源，逐條列在回報）：
 *   1. `characterCardIds` ← `referenceAssets` 的 `角色:[…]` 名稱 → 卡 id（`kind==="character"` 逐字命中）
 *   2. `sceneCardIds` ← `referenceAssets` 的 `场景:[…]` 名稱 → 卡 id（`kind==="scene"` 逐字命中）
 *   3. `aspectRatio` ← 該鏡節點 `metadata.size`（canvas 的 `size` **就是比例**：
 *      `src/app/api/canvas/generate/route.ts:133` `const aspectRatio = body.size ?? "1:1"`；
 *      可選值域見 `src/components/canvas/CanvasNodePromptPanel.tsx:96-102`）
 *   4. `propCardIds` ← `referenceAssets` 的 `道具:[…]` 名稱 → 卡 id（`kind==="prop"` 逐字命中，
 *      2026-09-24 新增）。**加成欄位**：推導不到不進 `missing`（`QC_REQUIRED_FIELDS` 刻意不含它，
 *      否則全部既有鏡次瞬間多一項 missing＝門禁回歸）。`kind==="style"` 的卡不進 prop 表。
 *   5. `characterCardIds`/`sceneCardIds`/`propCardIds`/`audioAnchorId` ← 該鏡節點 `metadata` 的同名
 *      欄（2026-09-24 卡 id；2026-09-30 `audioAnchorId`）。來源 = agent 自動落卡後回填 ＋ 逐鏡配音
 *      回寫（閉環的消費端）。卡 id 是**集合**語義（聯集去重）；`audioAnchorId` 是**單值**語義
 *      （同鏡矛盾不給，值真源見 `storyboardQcContextFromProject`）。
 *
 * **推導優先序（照抄，勿改）**：`production`（呼叫端供給） > `referenceAssets`（①②④）
 * > 節點 metadata（⑤）。理由：`referenceAssets` 是**編劇階段逐字寫下的意圖**（名稱級、有明確
 * 指名）；節點 metadata 的卡 id 多半是**機器自動落卡後回填**（粗：可能把該模板產出的卡全填上）。
 * 若讓 metadata 優先，會用「機器猜的較大集合」蓋掉「編劇明確指名的較小集合」。
 * 實作上 ①②④ 的 `if (!out.x …)` 寫法保證「已供給者不被覆蓋」，⑤ 再對同一條件做第二次檢查。
 *
 * **刻意不做的推導（附理由，避免下游誤以為漏做）**：
 *   - `durationSeconds`：本 repo 有兩把尺但**互相衝突**且**輸入契約不同**——
 *     `drama-recipe.ts:340 deriveDurations`（4 字/秒，吃「場次 beat 清單」）與
 *     `shortdrama-domain/index.ts:499`（4 字/秒，吃「台詞行清單」），而劇本模板教義寫 **4.5 字/秒**
 *     （`agent-templates-payload.ts:103`）。射手的 `dialogue` 是**單一字串**、其 `[角色]：「…」`
 *     標記格式無契約文件，硬套等於**自造轉換**→ 不生成，留 `missing` 由門禁如實 block。
 *   - `narration`（2026-09-30）：**旁白不從 `dialogue` 猜**。我方 21 欄契約**無旁白欄**，
 *     射手的 `dialogue` 是**單一字串**且其 `[角色]：「…」` 標記格式**無契約文件**——從 `dialogue`
 *     切出旁白＝**自造轉換**（同 `durationSeconds` 的病灶），且分鏡的旁白本就非逐鏡台詞可比。
 *     故本檔不推導 `narration`，一律留給呼叫端供給：供給即進 `fields`（來源記 `production`）；
 *     未供給＝加成欄位不罰（不進 `missing`）。
 *   - `sceneId`：門禁 `sceneId` 是**場次編號**（`drama-recipe.ts:111-112` `DramaScriptScene.sceneId`
 *     「場次編號（如 S01）」），21 欄只有外層 `sceneName` = **場景資產名**（`storyboard-contract.ts:148`）。
 *     兩者是不同實體，名稱不可互換 → 不生成。
 *   - `keyframeId`/`lastFrameId`：本 repo **無生產者**（`grep keyframeId src/` 除本檔與
 *     `shortdrama-domain` 型別外無寫入端）→ 不生成。
 *   - `audioAnchorId`：**2026-09-30 起有生產者**——`storyboard-voiceover`／voiceboard 把
 *     `dialogueAudioId || narrationAudioId` 寫回節點 metadata 的相容鍵，本橋第 ⑤ 條現會在
 *     呼叫端未供給時從節點 metadata 讀取（單值語義：同鏡矛盾不給）。因為 `audioAnchorId`
 *     已在 `QC_REQUIRED_FIELDS` 內，供給後自然不再進 `missing`。（舊註「無生產者→不生成」已過時。）
 *   - `pixels→ratio` 換算（`aspectRatioFromImageSize`）：canvas 存的是比例不是像素，用不到；
 *     且會把「尺寸」與「交付比例」兩概念混一，故只認已是 ratio 形狀的值。
 */
export function productionFieldsFromContext(
  shots: readonly StoryboardScriptShot[],
  context?: StoryboardQcContext,
): StoryboardQcContextFields {
  const fields: Record<string, StoryboardQcProductionFields> = {};
  const sources: Record<string, Record<string, StoryboardQcFieldSource>> = {};
  const blockedByShot: Record<string, string[]> = {};
  const cards = context?.cards ?? [];
  for (const shot of shots) {
    const key = shot.shotNumber;
    if (!key) continue;
    const supplied = context?.production?.[key] ?? {};
    const out: StoryboardQcProductionFields = { ...supplied };
    const src: Record<string, StoryboardQcFieldSource> = {};
    for (const field of QC_REQUIRED_FIELDS) {
      if (supplied[field] !== undefined) src[field] = "production";
    }
    if (supplied.prompt) src.prompt = "production";
    // `propCardIds` 不在 `QC_REQUIRED_FIELDS`（加成欄位，見該常數註），故上面的迴圈不會標它；
    // 呼叫端有供給時補記來源（與 `prompt` 同一範式），否則它在審計跡裡會是「有值卻無來源」。
    if (supplied.propCardIds !== undefined) src.propCardIds = "production";
    // `narration` 同樣不在 `QC_REQUIRED_FIELDS`（加成欄位，見該常數註），迴圈不標它；呼叫端供給時
    // 補記來源（與 `propCardIds`/`prompt` 同一範式），否則審計跡裡會是「有值卻無來源」。
    if (supplied.narration !== undefined) src.narration = "production";

    // ① / ② referenceAssets 名稱 → 卡 id（僅在呼叫端未供給時才推導；已供給者不被覆蓋）
    const resolved = resolveReferenceAssetsToCardIds(shot.referenceAssets, cards);
    if (!(out.characterCardIds && out.characterCardIds.length > 0) && resolved.characterCardIds.length > 0) {
      out.characterCardIds = resolved.characterCardIds;
      src.characterCardIds = "referenceAssets";
    }
    if (!(out.sceneCardIds && out.sceneCardIds.length > 0) && resolved.sceneCardIds.length > 0) {
      out.sceneCardIds = resolved.sceneCardIds;
      src.sceneCardIds = "referenceAssets";
    }

    // ③ 節點 ratio → aspectRatio（只認已是 ratio 形狀者，絕不做像素換算或補默認值）
    const nodeSize = context?.shotMetadata?.[key]?.size;
    if (!out.aspectRatio && typeof nodeSize === "string" && RATIO_SHAPE.test(nodeSize.trim())) {
      out.aspectRatio = nodeSize.trim();
      src.aspectRatio = "nodeSize";
    }

    // ④ referenceAssets 道具名稱 → propCardIds（僅在呼叫端未供給時才推導）
    // 加成欄位：推導不到不進 missing（`QC_REQUIRED_FIELDS` 刻意不含它），有命中才回報來源。
    if (!(out.propCardIds && out.propCardIds.length > 0) && resolved.propCardIds.length > 0) {
      out.propCardIds = resolved.propCardIds;
      src.propCardIds = "referenceAssets";
    }

    // ⑤ 分鏡節點 metadata 的卡 id → 三欄（**只在 ①②④ 都沒推導到、且呼叫端未供給時**才生效）
    // 優先序最低的理由見上方函數註（編劇逐字指名 > 機器自動落卡的較大集合）。
    // 清洗復用 `usableCardIds`（`uniqueCardIds` = 同規則 + 去重）。
    const nodeCards = context?.shotMetadata?.[key];
    if (!(out.characterCardIds && out.characterCardIds.length > 0)) {
      const ids = uniqueCardIds(nodeCards?.characterCardIds);
      if (ids.length > 0) {
        out.characterCardIds = ids;
        src.characterCardIds = "nodeMetadata";
      }
    }
    if (!(out.sceneCardIds && out.sceneCardIds.length > 0)) {
      const ids = uniqueCardIds(nodeCards?.sceneCardIds);
      if (ids.length > 0) {
        out.sceneCardIds = ids;
        src.sceneCardIds = "nodeMetadata";
      }
    }
    if (!(out.propCardIds && out.propCardIds.length > 0)) {
      const ids = uniqueCardIds(nodeCards?.propCardIds);
      if (ids.length > 0) {
        out.propCardIds = ids;
        src.propCardIds = "nodeMetadata";
      }
    }
    // `audioAnchorId` 同樣由節點 metadata 帶入（2026-09-30；寫法與上方三條卡 id 逐行對稱，
    // 含 `src[X] = "nodeMetadata"` 的來源補記）。**單值語義**（同 `size`，非卡 id 的集合語義），
    // 故只在呼叫端未供給且節點值是非空字串時才拿；因為本欄在 `QC_REQUIRED_FIELDS` 內，
    // 供給後自然不再進 `missing`。
    if (!isNonBlankString(out.audioAnchorId)) {
      const nodeAudioAnchorId = nodeCards?.audioAnchorId;
      if (isNonBlankString(nodeAudioAnchorId)) {
        out.audioAnchorId = nodeAudioAnchorId.trim();
        src.audioAnchorId = "nodeMetadata";
      }
    }

    // ⑥ 資產批准閘（**只在協作檔生效**，決策 2/23）：未批准的卡 id 不得進分鏡卡引用欄。
    // 未給 mode／preset／auto → 整段跳過（既有行為逐位不變，這是全自動檔的護城河）。
    // 三條欄一律過（不論值來自 production 還是 ①②④⑤ 推導）：使用者在落卡後才駁回時，
    // 節點 metadata 裡的舊綁定照樣要被擋——否則「駁回」只是事後貼紙。
    // 擋到一個都不剩 → **連鍵與來源一起移除**（改進 `missing` 讓門禁如實 block，
    // 不留 `[]` 這種「有鍵無值」騙門禁的空值；擋下的 id 記進 `blockedCardIdsByShot` 回報）。
    if (context?.mode === "collaborate") {
      for (const field of SHOT_CARD_ID_FIELDS) {
        const before = out[field];
        if (!before || before.length === 0) continue;
        const after = filterApprovedShotCardIds(before, cards, context.mode);
        if (after.length === before.length) continue;
        const blocked = before.filter((id) => !after.includes(id));
        if (blocked.length === 0) continue;
        const list = (blockedByShot[key] ??= []);
        for (const id of blocked) if (!list.includes(id)) list.push(id);
        if (after.length > 0) out[field] = after;
        else {
          delete out[field];
          delete src[field];
        }
      }
    }

    fields[key] = out;
    sources[key] = src;
  }
  return {
    fields,
    sources,
    ...(Object.keys(blockedByShot).length > 0 ? { blockedCardIdsByShot: blockedByShot } : {}),
  };
}

// ─────────────────────────────────────────── 專案上下文 → 橋接上下文（G5 接線）

/**
 * 專案側最小形（**結構相容 `CanvasProject`，不 import**）：只吃推導真正需要的兩個欄位。
 * 為何不 import `canvas/types.ts`：該檔已 type-only import 本檔（`types.ts:19`），反向 import
 * 會成環；本檔維持「純常數 + 純函式、零依賴」。
 */
export interface StoryboardQcProjectRef {
  /** 專案級鎖定卡 id（真源 = `CanvasProject.cardIds`，`src/lib/canvas/types.ts:356`）。 */
  cardIds?: readonly string[];
  /** 節點清單（真源 = `CanvasProject.nodes`）；只用 `metadata.size` 一欄推比例。 */
  nodes?: readonly StoryboardQcNodeRef[];
}

/** 節點側最小形（結構相容 `CanvasNode`）：用 `metadata` 的 `size`、卡 id 三欄與鏡號。 */
export interface StoryboardQcNodeRef {
  /**
   * 節點 id（真源 = `CanvasNode.id`）。**只**供 `affectedShotNodesByCardIds` 回報
   * 「受影響的分鏡節點 id」；缺省/非字串 → 不回報該節點（不臆造 id）。
   */
  id?: unknown;
  metadata?:
    | (StoryboardQcShotNodeMetadata & { storyboardShot?: { shotNumber?: unknown } | null })
    | null;
}

/**
 * 專案上下文 → 橋接上下文（**唯一專案級推導入口，顯式不魔法**）。
 *
 * 目前只有四條專案級推導成立（每條都有來源）：
 *   1. `lockedCharacterCardIds` / `lockedSceneCardIds` ← `project.cardIds` 按卡 `kind` 分流
 *      （卡實體真源 = `listCharacterCards`，`src/lib/character-card-store.ts:122`）。
 *      門禁 `character_lock`/`scene_lock` 要求「每鏡引用的卡都在鎖定集合內」——集合就是專案鎖定卡。
 *      `kind` 分流只認門禁真有集合的兩族：`style`/`prop`（2026-09-24 起 prop 是真 kind）都
 *      **靜默略過**（既不進鎖定集合也不算未解析）——門禁 `Shot` 沒有 lockedStyle/lockedProp 這兩集。
 *   2. `shotMetadata[k]` ← `project.nodes` 中 `metadata.size`（供 `productionFieldsFromContext`
 *      推 `aspectRatio`；該欄位是否**真的**已是 ratio 形狀由下游 `RATIO_SHAPE` 把關）。
 *   3. `shotMetadata[k]` ← `project.nodes` 中 `metadata.characterCardIds`/`sceneCardIds`/
 *      `propCardIds`（2026-09-24 新增；供 `productionFieldsFromContext` 第 ⑤ 條推導——即
 *      「agent 自動落卡 → 節點 metadata 宣告 → 門禁消費」閉環的帶入端）。清洗用 `usableCardIds`，
 *      **空陣列省略該鍵**（不造 `characterCardIds: []` 的空鍵，否則 `src` 審計跡會誤報「有值」）。
 *   4. `shotMetadata[k]` ← `project.nodes` 中 `metadata.audioAnchorId`（2026-09-30 新增；供第 ⑤ 條
 *      推導——「逐鏡配音回寫 → 節點 metadata → 門禁 `audio_anchor_present`/`dialogue_alignment`」
 *      閉環的帶入端）。**單值語義**（同 `size`）：同鏡多節點取首個非空，矛盾則整個不給；空值/非
 *      字串一律省略該鍵（不臆造、不誤報「有值」）。
 *
 * **刻意不做的推導**：`aspectRatio` 沒有專案級欄位可取（`grep aspectRatio src/lib/canvas/types.ts`
 * 為空——比例只存在於**節點** metadata，不在 `CanvasProject`），故不「從專案繼承」；
 * 亦無 `segmentDurationSeconds` 的專案級來源（`CanvasEpisode` 無時長欄位）。
 *
 * `unresolvedCardIds`：`cardIds` 中**查不到卡片實體**的 id（卡未載入/已刪）。這些 id 無法判定
 * `kind` → **不猜**、不塞進任一鎖定集合，如實回報。缺卡清單時（`cards` 未提供）同理：
 * 寧可回報全部未解析，也不把角色卡當場景卡通關。
 */
export function storyboardQcContextFromProject(
  project?: StoryboardQcProjectRef,
  options?: {
    cards?: readonly StoryboardQcCardRef[];
    production?: Readonly<Record<string, StoryboardQcProductionFields>>;
    segmentDurationSeconds?: number;
    /**
     * 互動檔位（`AgentInteractionMode`）。未給 → 既有行為逐位不變（零回歸）；
     * 給了 `"collaborate"` → 推導出的分鏡卡引用欄再過一次批准閘（第 ⑥ 條）。
     */
    mode?: AgentInteractionMode;
    /**
     * REQ-B2 作用域上下文。未給 → 既有行為逐位不變（零回歸）；
     * 給了 → 卡與 cardIds 先過作用域裁決（不可見即不可用）。
     */
    scope?: StoryboardQcScopeContext;
  },
): { context: StoryboardQcContext; unresolvedCardIds: string[]; outOfScopeCardIds: string[] } {
  const cards = options?.cards ?? [];
  const scope = options?.scope;
  // 作用域裁決：唯一入口 canUseAsset（= resolveAssetVisibility）。未給上下文＝全放行
  // （＝本刀之前的行為，逐位不變）；給了＝跨項目未分享的卡在此不可用。
  const usableCard = (card: StoryboardQcCardRef): boolean => {
    if (!scope) return true;
    const id = typeof card?.id === "string" ? card.id.trim() : "";
    if (!id) return true; // 無 id 的卡既非可見也非不可見，走原有「不猜」路徑
    return canUseAsset(
      { id, kind: "card", scope: card.scope, ownerUserId: scope.viewerUserId },
      { viewerUserId: scope.viewerUserId, projectId: scope.projectId, shares: scope.shares },
    );
  };
  const visibleCards = scope ? cards.filter(usableCard) : cards;
  // 被作用域拒掉的卡 id：與「查不到卡實體」分開如實回報（兩態不混）。
  const outOfScopeCardIds: string[] = [];
  if (scope) {
    for (const card of cards) {
      if (usableCard(card)) continue;
      const id = typeof card?.id === "string" ? card.id.trim() : "";
      if (id && !outOfScopeCardIds.includes(id)) outOfScopeCardIds.push(id);
    }
  }

  const kindById = new Map<string, string>();
  for (const card of visibleCards) {
    if (!card || typeof card.id !== "string" || typeof card.kind !== "string") continue;
    const id = card.id.trim();
    if (!id) continue;
    // 同 id 多卡：kind 不一致 → 無法判定，標成歧義（空字串）以排除出兩個鎖定集合
    const prev = kindById.get(id);
    if (prev !== undefined && prev !== card.kind) kindById.set(id, "\u0000ambiguous");
    else if (prev === undefined) kindById.set(id, card.kind);
  }

  const lockedCharacterCardIds: string[] = [];
  const lockedSceneCardIds: string[] = [];
  const unresolvedCardIds: string[] = [];
  for (const raw of project?.cardIds ?? []) {
    if (!isNonBlankString(raw)) continue;
    const id = raw.trim();
    // 不可見即不可用：跨項目未分享的卡不進鎖定集合（已在上方如實回報，不重複算未解析）。
    if (outOfScopeCardIds.includes(id)) continue;
    const kind = kindById.get(id);
    if (kind === "character") {
      if (!lockedCharacterCardIds.includes(id)) lockedCharacterCardIds.push(id);
    } else if (kind === "scene") {
      if (!lockedSceneCardIds.includes(id)) lockedSceneCardIds.push(id);
    } else if (kind === "style") {
      // style 卡不屬門禁兩集（`Shot` 無 styleCardIds）→ 既非未解析也非兩者之一，靜默略過
    } else if (kind === "prop") {
      // prop 卡同理：門禁 `Shot` 沒有 lockedPropCardIds 這一集（道具是加成欄位，不設鎖），
      // 故既不入角色/場景鎖定集合，也**不得**被當成「查不到卡實體」而誤進 unresolvedCardIds。
    } else {
      // 查不到卡實體 / id 撞 kind / 非字串 kind → 不猜
      if (!unresolvedCardIds.includes(id)) unresolvedCardIds.push(id);
    }
  }

  const shotMetadata: Record<string, StoryboardQcShotNodeMetadata> = {};
  // 卡 id 三欄與 `size` **分開累積**：`size` 是同鏡矛盾就整個不給（比例是單一交付格式，猜不得）；
  // 卡 id 是**集合**語義（節點宣告「本鏡引用這些卡」），同鏡多節點取聯集去重、不取首個也不丟資訊。
  const cardsByShot: Record<string, { character: string[]; scene: string[]; prop: string[] }> = {};
  // `audioAnchorId` 與 `size` **同範式（單值語義）**、**不照卡 id 的聯集**：同鏡多節點取首個非空，
  // 一旦矛盾（第二個非空值不同）就整個不給（`null` 哨兵），後續節點不得把它「救回」——音軌錨是
  // 單一交付物，猜不得。空/非字串值一律忽略（不佔位、不算首個）。
  const anchorByShot: Record<string, string | null> = {};
  for (const node of project?.nodes ?? []) {
    const meta = node?.metadata;
    const shotNumber = meta?.storyboardShot?.shotNumber;
    if (!isNonBlankString(shotNumber)) continue; // 無鏡號的節點不歸屬任一鏡（不臆造鍵）
    const key = shotNumber.trim();

    const bucket = (cardsByShot[key] ??= { character: [], scene: [], prop: [] });
    const collect = (target: string[], raw: unknown) => {
      for (const id of uniqueCardIds(raw)) if (!target.includes(id)) target.push(id);
    };
    collect(bucket.character, meta?.characterCardIds);
    collect(bucket.scene, meta?.sceneCardIds);
    collect(bucket.prop, meta?.propCardIds);

    const rawAnchor = meta?.audioAnchorId;
    if (isNonBlankString(rawAnchor)) {
      const anchor = rawAnchor.trim();
      const prevAnchor = anchorByShot[key];
      if (prevAnchor === undefined) anchorByShot[key] = anchor;
      else if (prevAnchor !== anchor) anchorByShot[key] = null; // 同鏡矛盾 → 不給（不取首個猜）
    }

    const size = meta?.size;
    if (size === undefined) continue;
    // 同鏡號多節點：ratio 不一致 → 寧可不給（該鏡 aspectRatio 留 missing），不取首個猜
    const prev = shotMetadata[key];
    if (prev === undefined) shotMetadata[key] = { size };
    else if (prev.size !== size) shotMetadata[key] = {};
  }
  // 音軌錨：真的有單一非空值時才掛上；同鏡矛盾則**保留該鏡鍵但不給值**（照 `size` 範式——
  // `{ [key]: {} }`，審計跡不誤報「有值」）。
  for (const [key, anchor] of Object.entries(anchorByShot)) {
    const entry = (shotMetadata[key] ??= {});
    if (anchor === null) continue;
    entry.audioAnchorId = anchor;
  }
  // 卡 id 只在真的有值時掛上（空陣列省略該鍵 → 審計跡不誤報「有值」）
  for (const [key, bucket] of Object.entries(cardsByShot)) {
    if (bucket.character.length === 0 && bucket.scene.length === 0 && bucket.prop.length === 0) continue;
    const entry = (shotMetadata[key] ??= {});
    if (bucket.character.length > 0) entry.characterCardIds = bucket.character;
    if (bucket.scene.length > 0) entry.sceneCardIds = bucket.scene;
    if (bucket.prop.length > 0) entry.propCardIds = bucket.prop;
  }

  const context: StoryboardQcContext = {
    ...(options?.production ? { production: options.production } : {}),
    // 注入上下文只帶可用（可見）的卡：不可見即不可用，卡實體也不例外。
    cards: visibleCards,
    ...(Object.keys(shotMetadata).length > 0 ? { shotMetadata } : {}),
    ...(lockedCharacterCardIds.length > 0 ? { lockedCharacterCardIds } : {}),
    ...(lockedSceneCardIds.length > 0 ? { lockedSceneCardIds } : {}),
    ...(typeof options?.segmentDurationSeconds === "number" ? { segmentDurationSeconds: options.segmentDurationSeconds } : {}),
    ...(options?.mode ? { mode: options.mode } : {}),
  };
  return { context, unresolvedCardIds, outOfScopeCardIds };
}

export interface StoryboardQcGateArgs {
  /** 本地判定邏輯（`runShortDramaTool("storyboard_qc_17", input)`，`shortdrama-domain/index.ts:411`）的輸入。 */
  input: {
    shots: StoryboardQcShot[];
    lockedCharacterCardIds?: string[];
    lockedSceneCardIds?: string[];
    segmentDurationSeconds?: number;
  };
  /** VPS 工具 `storyboard_qc_17` 的 args（`shots` 與鎖定 id 是 **JSON 字串**，見工具 schema）。 */
  toolArgs: {
    shots: string;
    locked_character_card_ids?: string;
    locked_scene_card_ids?: string;
    segment_duration_seconds?: number;
  };
  /**
   * 門禁輸入缺項（欄位名）。**含兩個門禁層輸入**：`lockedCharacterCardIds`/`lockedSceneCardIds`
   *（缺 → 空集合 → `character_lock`/`scene_lock` 必 block）與 `segmentDurationSeconds`
   *（缺/≤0 → `segment_duration` 必 block）。誠實回報 = 不讓「只是沒填」被誤讀成「門禁過了」。
   */
  missing: string[];
  /** 所有門禁輸入齊備（**不同於** `storyboardQcShots().complete`——後者只算鏡欄位）。 */
  complete: boolean;
  sources: Record<string, Record<string, StoryboardQcFieldSource>>;
}

/**
 * 一次組出**可直接餵門禁的兩形 args**（本地判定 + VPS 工具），把推導結果真的接到門禁。
 * `missing` 為空不代表 17 門全過（門禁有自己的值域判定，如 `4:3` 不在 9:16/16:9/1:1 內），
 * 也不代表 `duration_bounds`/`scene_binding` 等已成立——**本函數只保證「輸入沒有缺項」**。
 */
export function storyboardQcGateArgs(
  shots: readonly StoryboardScriptShot[],
  context?: StoryboardQcContext,
): StoryboardQcGateArgs {
  const derived = productionFieldsFromContext(shots, context);
  const bridge = storyboardQcShotsWith(shots, derived.fields);
  const missing = new Set(bridge.missing);

  const lockedCharacters = (context?.lockedCharacterCardIds ?? []).filter((id) => typeof id === "string" && id.length > 0);
  const lockedScenes = (context?.lockedSceneCardIds ?? []).filter((id) => typeof id === "string" && id.length > 0);
  if (lockedCharacters.length === 0) missing.add("lockedCharacterCardIds");
  if (lockedScenes.length === 0) missing.add("lockedSceneCardIds");

  const segment = context?.segmentDurationSeconds;
  const segmentOk = typeof segment === "number" && Number.isFinite(segment) && segment > 0;
  if (!segmentOk) missing.add("segmentDurationSeconds");

  const input: StoryboardQcGateArgs["input"] = {
    shots: bridge.shots,
    ...(lockedCharacters.length > 0 ? { lockedCharacterCardIds: lockedCharacters } : {}),
    ...(lockedScenes.length > 0 ? { lockedSceneCardIds: lockedScenes } : {}),
    ...(segmentOk ? { segmentDurationSeconds: segment } : {}),
  };
  const toolArgs: StoryboardQcGateArgs["toolArgs"] = {
    shots: JSON.stringify(bridge.shots),
    ...(lockedCharacters.length > 0 ? { locked_character_card_ids: JSON.stringify(lockedCharacters) } : {}),
    ...(lockedScenes.length > 0 ? { locked_scene_card_ids: JSON.stringify(lockedScenes) } : {}),
    ...(segmentOk ? { segment_duration_seconds: segment } : {}),
  };
  const missingList = [...missing];
  return {
    input,
    toolArgs,
    missing: missingList,
    complete: shots.length > 0 && missingList.length === 0,
    sources: derived.sources,
  };
}

// ─────────────────────────────────────────── 重跑影響面（純判定，2026-09-24）

/**
 * 「某步重跑 → 哪些已完成結果受影響」的**純判定**（決策 15：步驟條可回跳，只重跑後續）。
 *
 * 輸入：
 *   - `nodes`：專案節點（`CanvasProject.nodes`，結構相容 `StoryboardQcNodeRef`）
 *   - `cardIds`：本輪會重做的卡 id。例：重跑資產步 → 該步節點的卡 id ＝
 *     `entityCardIdForNode(nodeId)`（`agent-output-cards.ts:154`，決定性推導），
 *     把這批 id 原樣餵進來即得影響面（**不新建節點→卡的第二套推導**）。
 * 輸出：
 *   - `affectedCardIds`：真的被某顆分鏡節點引用到的卡 id（輸入裡沒被引用的不回報）
 *   - `shotNodeIds`：宣告了這些卡的**分鏡節點** id（`metadata.storyboardShot.shotNumber`
 *     非空才算分鏡節點；節點無 id／非分鏡節點 → 不回報，不臆造）
 *
 * **邊界（誠實標記）**：只認**節點 metadata 三條卡引用欄**宣告的綁定；專案級鎖定集合
 * （`CanvasProject.cardIds` → 全項目注入）不在此判定內。只回報，不觸發任何重跑/UI/寫入。
 */
export function affectedShotNodesByCardIds(
  nodes: readonly StoryboardQcNodeRef[],
  cardIds: readonly string[],
): { affectedCardIds: string[]; shotNodeIds: string[] } {
  const targets = new Set(uniqueCardIds(cardIds));
  const affectedCardIds: string[] = [];
  const shotNodeIds: string[] = [];
  if (targets.size === 0) return { affectedCardIds, shotNodeIds };
  for (const node of nodes ?? []) {
    const meta = node?.metadata;
    if (!isNonBlankString(meta?.storyboardShot?.shotNumber)) continue;
    const hits: string[] = [];
    for (const field of SHOT_CARD_ID_FIELDS) {
      for (const id of uniqueCardIds(meta?.[field])) if (targets.has(id)) hits.push(id);
    }
    if (hits.length === 0) continue;
    for (const id of hits) if (!affectedCardIds.includes(id)) affectedCardIds.push(id);
    const nodeId = isNonBlankString(node.id) ? node.id.trim() : "";
    if (nodeId && !shotNodeIds.includes(nodeId)) shotNodeIds.push(nodeId);
  }
  return { affectedCardIds, shotNodeIds };
}
