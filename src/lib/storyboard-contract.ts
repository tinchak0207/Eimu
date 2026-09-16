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
 */

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
  keyframeId?: string;
  lastFrameId?: string;
  audioAnchorId?: string;
  aspectRatio?: string;
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
  keyframeId?: string;
  lastFrameId?: string;
  audioAnchorId?: string;
  aspectRatio?: string;
}

export interface StoryboardQcBridgeResult {
  shots: StoryboardQcShot[];
  /** 仍有鏡次缺的成片階段欄位名（誠實回報，不補假值；門禁據此 block 是預期行為）。 */
  missing: string[];
  /** 全鏡成片階段欄位齊備（唯一可以宣告「門禁可望 17/17」的條件）。 */
  complete: boolean;
}

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
  const missing = new Set<string>();
  const out = shots.map((shot, i) => {
    const p = production?.[shot.shotNumber] ?? {};
    const prompt = p.prompt && p.prompt.length > 0 ? p.prompt : shot.visualDescription;
    if (!prompt) missing.add("prompt");
    for (const field of QC_REQUIRED_FIELDS) {
      const v = p[field];
      const absent = Array.isArray(v) ? v.length === 0 : v === undefined;
      if (absent) missing.add(field);
    }
    return {
      shotId: shot.shotNumber || `S${i + 1}`,
      order: i + 1,
      prompt,
      ...(p.sceneId ? { sceneId: p.sceneId } : {}),
      ...(typeof p.durationSeconds === "number" ? { durationSeconds: p.durationSeconds } : {}),
      characterCardIds: p.characterCardIds ?? [],
      sceneCardIds: p.sceneCardIds ?? [],
      ...(p.keyframeId ? { keyframeId: p.keyframeId } : {}),
      ...(p.lastFrameId ? { lastFrameId: p.lastFrameId } : {}),
      ...(p.audioAnchorId ? { audioAnchorId: p.audioAnchorId } : {}),
      ...(p.aspectRatio ? { aspectRatio: p.aspectRatio } : {}),
    } satisfies StoryboardQcShot;
  });
  const missingList = [...missing];
  return { shots: out, missing: missingList, complete: shots.length > 0 && missingList.length === 0 };
}
