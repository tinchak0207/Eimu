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
 */
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
      ...(isNonBlankString(p.keyframeId) ? { keyframeId: p.keyframeId.trim() } : {}),
      ...(isNonBlankString(p.lastFrameId) ? { lastFrameId: p.lastFrameId.trim() } : {}),
      ...(isNonBlankString(p.audioAnchorId) ? { audioAnchorId: p.audioAnchorId.trim() } : {}),
      ...(isNonBlankString(p.aspectRatio) ? { aspectRatio: p.aspectRatio.trim() } : {}),
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
export type StoryboardQcFieldSource = "production" | "referenceAssets" | "nodeSize";

/**
 * 推導上下文。**每個欄位只在有真實來源時才生成**，缺者一律留在 `missing`（不補默認值）。
 *
 * - `production`：呼叫端已有的成片階段欄位（最高優先，覆蓋一切推導）
 * - `cards`：卡實體清單（唯一真源 = `character-card-store.listCharacterCards`，
 *   `src/lib/character-card-store.ts:122`）。**只用於名稱→id 解析**，不背書卡的存在性判定
 * - `shotMetadata`：每鏡節點 metadata（鍵 = `shotNumber`）。目前只用 `size` 一欄推 `aspectRatio`
 * - `locked*CardIds`：專案級鎖定卡（真源 = `CanvasProject.cardIds`，`src/lib/canvas/types.ts:356`）
 */
export interface StoryboardQcContext {
  production?: Readonly<Record<string, StoryboardQcProductionFields>>;
  cards?: readonly StoryboardQcCardRef[];
  shotMetadata?: Readonly<Record<string, { size?: unknown }>>;
  lockedCharacterCardIds?: readonly string[];
  lockedSceneCardIds?: readonly string[];
  segmentDurationSeconds?: number;
}

/** ratio 形狀（`9:16`）。**只認已顯式是比例的欄位**，不把像素尺寸換算成比例（見 `productionFieldsFromContext` 註）。 */
const RATIO_SHAPE = /^\d+:\d+$/;

/**
 * 卡名 → 卡 id 索引（**同名同kind 歧義者整批排除**）。
 *
 * 為何排除而非取首個：`CharacterCard.name` 沒有唯一性約束（`character-cards.ts:85` 只驗非空與長度），
 * 撞名時任取一個就是**猜**——寧可回報未解析（該鏡進 `missing`），也不把兩張卡混為一談。
 * 名稱比對用 trim 後逐字相等（不做大小寫/前綴模糊匹配：模糊匹配會把不同卡黏在一起）。
 */
export function indexCardsByName(cards: readonly StoryboardQcCardRef[]): {
  character: Map<string, string>;
  scene: Map<string, string>;
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
  for (const [key, entry] of seen) {
    if (entry.duplicated) continue;
    const [kind, name] = key.split("\u0000");
    if (kind === "character") character.set(name, entry.id);
    else if (kind === "scene") scene.set(name, entry.id);
  }
  return { character, scene };
}

/**
 * `referenceAssets` → 卡 id（**名稱逐字命中才成立**）。
 *
 * 語義邊界（誠實標記）：AID 的 `referenceAssets` 名稱取自**資產庫**（`storyboard-contract.ts`
 * 契約註：名稱取自資產庫、未命中者 AID 後端剔除），本站資產庫有兩族：
 *   - `CharacterCard`（`kind: "character"|"scene"`，`character-cards.ts:33-35`）→ 可解析成卡 id
 *   - 資產包/歷史資產條目（`node-to-asset-items.ts`）→ **沒有卡 id**，解析不到（留在 unsolved）
 * 故：解析失敗 = 名稱不存在於卡清單，或該名稱屬資產包另一族，或同名歧義 —— 三種都**不臆造 id**。
 * `prop` 段在本站沒有對應欄位（門禁 Shot 無 propCardIds）→ 原樣回報於 `unresolvedProps`，不靜默丟棄。
 */
export function resolveReferenceAssetsToCardIds(
  referenceAssets: string,
  cards: readonly StoryboardQcCardRef[],
): {
  characterCardIds: string[];
  sceneCardIds: string[];
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
  return {
    characterCardIds: character.ids,
    sceneCardIds: scene.ids,
    unresolvedCharacters: character.unresolved,
    unresolvedScenes: scene.unresolved,
    unresolvedProps: parsed.prop,
  };
}

export interface StoryboardQcContextFields {
  /** 鍵 = `shotNumber`；值只含**真的有來源**的欄位（呼叫端 production 覆蓋推導值）。 */
  fields: Record<string, StoryboardQcProductionFields>;
  /** 鍵 = `shotNumber` → 欄位 → 值來源（審計跡；無來源欄位不出現，改進 `missing`）。 */
  sources: Record<string, Record<string, StoryboardQcFieldSource>>;
}

/**
 * 上下文 → 成片階段欄位（純函數，唯一推導入口——**不用隱式魔法、不改任何既有函數語義**）。
 *
 * 目前**只有三條**推導成立（每條都有來源，逐條列在回報）：
 *   1. `characterCardIds` ← `referenceAssets` 的 `角色:[…]` 名稱 → 卡 id（`kind==="character"` 逐字命中）
 *   2. `sceneCardIds` ← `referenceAssets` 的 `场景:[…]` 名稱 → 卡 id（`kind==="scene"` 逐字命中）
 *   3. `aspectRatio` ← 該鏡節點 `metadata.size`（canvas 的 `size` **就是比例**：
 *      `src/app/api/canvas/generate/route.ts:133` `const aspectRatio = body.size ?? "1:1"`；
 *      可選值域見 `src/components/canvas/CanvasNodePromptPanel.tsx:65-71`）
 *
 * **刻意不做的推導（附理由，避免下游誤以為漏做）**：
 *   - `durationSeconds`：本 repo 有兩把尺但**互相衝突**且**輸入契約不同**——
 *     `drama-recipe.ts:340 deriveDurations`（4 字/秒，吃「場次 beat 清單」）與
 *     `shortdrama-domain/index.ts:499`（4 字/秒，吃「台詞行清單」），而劇本模板教義寫 **4.5 字/秒**
 *     （`agent-templates-payload.ts:103`）。射手的 `dialogue` 是**單一字串**、其 `[角色]：「…」`
 *     標記格式無契約文件，硬套等於**自造轉換**→ 不生成，留 `missing` 由門禁如實 block。
 *   - `sceneId`：門禁 `sceneId` 是**場次編號**（`drama-recipe.ts:111-112` `DramaScriptScene.sceneId`
 *     「場次編號（如 S01）」），21 欄只有外層 `sceneName` = **場景資產名**（`storyboard-contract.ts:148`）。
 *     兩者是不同實體，名稱不可互換 → 不生成。
 *   - `keyframeId`/`lastFrameId`/`audioAnchorId`：本 repo **無生產者**（`grep keyframeId src/` 除本檔與
 *     `shortdrama-domain` 型別外無寫入端；`audio_first_timeline` 的 `anchorId` 亦無呼叫端）→ 不生成。
 *   - `pixels→ratio` 換算（`aspectRatioFromImageSize`）：canvas 存的是比例不是像素，用不到；
 *     且會把「尺寸」與「交付比例」兩概念混一，故只認已是 ratio 形狀的值。
 */
export function productionFieldsFromContext(
  shots: readonly StoryboardScriptShot[],
  context?: StoryboardQcContext,
): StoryboardQcContextFields {
  const fields: Record<string, StoryboardQcProductionFields> = {};
  const sources: Record<string, Record<string, StoryboardQcFieldSource>> = {};
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

    fields[key] = out;
    sources[key] = src;
  }
  return { fields, sources };
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

/** 節點側最小形（結構相容 `CanvasNode`）：只用 `metadata.size` 與鏡號。 */
export interface StoryboardQcNodeRef {
  metadata?: { size?: unknown; storyboardShot?: { shotNumber?: unknown } | null } | null;
}

/**
 * 專案上下文 → 橋接上下文（**唯一專案級推導入口，顯式不魔法**）。
 *
 * 目前只有兩條專案級推導成立（每條都有來源）：
 *   1. `lockedCharacterCardIds` / `lockedSceneCardIds` ← `project.cardIds` 按卡 `kind` 分流
 *      （卡實體真源 = `listCharacterCards`，`src/lib/character-card-store.ts:122`；`kind` 值域
 *      `"character"|"scene"|"style"`，`src/lib/character-cards.ts:17`）。
 *      門禁 `character_lock`/`scene_lock` 要求「每鏡引用的卡都在鎖定集合內」——集合就是專案鎖定卡。
 *   2. `shotMetadata[k]` ← `project.nodes` 中 `metadata.size`（供 `productionFieldsFromContext`
 *      推 `aspectRatio`；該欄位是否**真的**已是 ratio 形狀由下游 `RATIO_SHAPE` 把關）。
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
    } else {
      // 查不到卡實體 / id 撞 kind / 非字串 kind → 不猜
      if (!unresolvedCardIds.includes(id)) unresolvedCardIds.push(id);
    }
  }

  const shotMetadata: Record<string, { size?: unknown }> = {};
  for (const node of project?.nodes ?? []) {
    const size = node?.metadata?.size;
    if (size === undefined) continue;
    const shotNumber = node?.metadata?.storyboardShot?.shotNumber;
    if (!isNonBlankString(shotNumber)) continue; // 無鏡號的節點不歸屬任一鏡（不臆造鍵）
    const key = shotNumber.trim();
    // 同鏡號多節點：ratio 不一致 → 寧可不給（該鏡 aspectRatio 留 missing），不取首個猜
    const prev = shotMetadata[key];
    if (prev === undefined) shotMetadata[key] = { size };
    else if (prev.size !== size) shotMetadata[key] = {};
  }

  const context: StoryboardQcContext = {
    ...(options?.production ? { production: options.production } : {}),
    // 注入上下文只帶可用（可見）的卡：不可見即不可用，卡實體也不例外。
    cards: visibleCards,
    ...(Object.keys(shotMetadata).length > 0 ? { shotMetadata } : {}),
    ...(lockedCharacterCardIds.length > 0 ? { lockedCharacterCardIds } : {}),
    ...(lockedSceneCardIds.length > 0 ? { lockedSceneCardIds } : {}),
    ...(typeof options?.segmentDurationSeconds === "number" ? { segmentDurationSeconds: options.segmentDurationSeconds } : {}),
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
