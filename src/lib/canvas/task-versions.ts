// 任務版本（Version）＋標籤（Tags）＋選中（Selected）（P1-9，對稱差 D37；2026-09-29）。
//
// D37 逐字：「任務 `{Version:"<時戳>", Tags:["main_image"|"main_video"], Status}`；
// 素材 `Version`/`Selected`」；判我方「有五態狀態機但**無 per-任務 Version 與 Tags 語義**」。
//
// 落點＝畫布節點 metadata 的 `taskVersions`（`{ items, selectedVersion }`）：
//
//   · 一「格」＝一顆節點；**同一格重跑＝一筆新任務 → 追加一筆新版本**，舊版本原樣留著
//     （append-only，不是覆蓋）。`items[].version` ＝任務的版本識別（Dramagic 的
//     `"<時戳>"`）＝**產生該任務的時刻**，正規化成 ISO 8601（UTC）字串 ⇒ 字典序＝時間序，
//     可排序、可辨識、可回溯。
//
//   · **刻意不用節點版本歷史**（`node-versions.ts` 的 `nodeVersions`，2026-09-27）代替：
//     那是「內容變更歷史」（title＋metadata 快照，掛在 `CanvasProject` 而非節點 metadata），
//     按內容簽名落版 ⇒ 同一 prompt 重跑第二筆可能不落版（任務憑空消失），
//     且它沒有任務身份/標籤/選中語義。兩個「版本」是不同的東西，不合併。
//
//   · `items[].tags` ＝任務標籤（值域 `TASK_TAGS`：`main_image` / `main_video`），可由現場
//     既有 kind 詞彙推導（`taskTagForKind`），也可直接宣告。未知值在清洗端**丟棄**
//     （fail-closed，不降格成 `main_image`——猜錯會讓分組把別的產物算進來）。
//
//   · `items[].status` ＝沿用節點四態（`CanvasNodeStatus`），不另立枚舉。
//
//   · `selectedVersion` ＝**星標選中的那一版任務**（＝Dramagic 素材 `Selected:true`）：
//     該版的交付 URL（`items[].url`）就是本格的採用稿。
//
// 形狀刻意照 `storyboard-shots.ts` 的 `StoryboardShotCandidateSet`（`items` ＋ 選中鍵），
// 刪除回退語義照 `reducer.ts` 批次主圖（`batchPrimaryImageId: kept[0]`）與
// `removeShotCandidate`（`items[0]`）——**不造第三套**。選中鍵命名 `selectedVersion`
// （而非候選集的 `selectedId`）是因為條目的身份鍵在 D37 口徑就是 `version`。
//
// 雙白名單鐵律：`taskVersions` 必須同時存在於還原端 `layout.toNodeMetadata` 與上行端
// `compactMetadataForAgent` 兩處白名單（真源＝`node-metadata-fields.ts`），
// 漏一端＝刷新/回舊會話後任務版本史與選中者**憑空消失且不報錯**（同 shotCandidates 病灶）。

import type { CanvasNode, CanvasNodeMetadata, CanvasNodeStatus } from "./types";

// ─────────────────────────────────────────── 值域與上限

/**
 * 任務標籤值域（D37 字面 `main_image`/`main_video`）。
 *
 * 為什麼用這兩個字面而不是 `image`/`video`：`image`/`video` 在本庫已被節點 kind 與
 * `mediaType` 佔用（值域＝生成物種類），D37 的 Tags 是**任務角色**（這條任務是不是
 * 本格的主圖/主片交付）。直接收斂成既有字面會與 kind 語義糾纏，故照 D37 逐字立值域，
 * 並在 `taskTagForKind` 提供 kind → tag 的**單向**推導（不反向、不合併兩套枚舉）。
 */
export const TASK_TAGS = ["main_image", "main_video"] as const;
export type TaskTag = (typeof TASK_TAGS)[number];

/** 執行期判據（SSE/Blob 讀回的值不可信，一律過此）。 */
export function isTaskTag(v: unknown): v is TaskTag {
  return typeof v === "string" && (TASK_TAGS as readonly string[]).includes(v);
}

/**
 * 單格（單節點）保留的任務版本上限。
 * 20 與節點版本歷史同尺（`node-versions.ts` 的 `MAX_NODE_VERSIONS_PER_NODE`）：一次
 * 「生成→看→再生成」的來回通常 ≤ 10 筆，20 給一倍餘裕。
 * **寫入端滿了回 `full` 明確拒絕，不靜默裁掉舊版本**——「舊版本要留得住」正是 D37 的要求，
 * 靜默裁舊＝直接違反它（要騰位子得由人明確 `removeTaskVersion`）。
 */
export const MAX_TASK_VERSIONS_PER_NODE = 20;

/** 版本字串（ISO 8601）輸入長度上限：`2026-09-29T10:00:00.123+08:00` ＝ 29 字，留餘裕。 */
const VERSION_INPUT_MAX = 64;
/** 任務 id 長度上限（同族薄鍵量級）。 */
const TASK_ID_MAX = 200;
/** 交付 URL 長度上限（同 `shotCandidates` 的 URL 欄同尺）。 */
const TASK_URL_MAX = 2048;
/** kind 輸入長度上限（推導標籤時用）。 */
const KIND_MAX = 64;

/** 任務狀態值域＝節點四態（`types.ts:81` 的 `CanvasNodeStatus`），不另立第二套。 */
const TASK_STATUSES: readonly CanvasNodeStatus[] = ["idle", "success", "loading", "error"];

// ─────────────────────────────────────────── 資料形狀

/**
 * 一筆任務版本（＝D37 的任務 `{Version, Tags, Status}`；`url` ＝該版的交付物）
 * ＋ 該版產物的選中標記載體（選中記在集合的 `selectedVersion`，不寫每筆布林——「最多一筆
 * 選中」是結構保證，不靠清洗端補救）。
 */
export interface TaskVersionEntry {
  /** 版本識別：產生本任務的時刻（ISO 8601 UTC；字典序＝時間序）。 */
  version: string;
  /** 生成任務 id（`metadata.imageTaskId` 同源）；缺席＝本地補錄（不編造）。 */
  taskId?: string;
  /** 任務狀態（節點四態）。 */
  status?: CanvasNodeStatus;
  /** 任務標籤（值域內，首見序去重；空陣列＝推不出標籤，不是「沒有這個欄位」）。 */
  tags: TaskTag[];
  /** 本版任務的交付物 URL（＝D37 的素材；選中者就是採用稿）。 */
  url?: string;
}

/** 一格的任務版本史 ＋ 星標選中的那一版。 */
export interface TaskVersionSet {
  /** 任務版本清單（按 `version` 升序；末條＝最新一筆任務）。 */
  items: TaskVersionEntry[];
  /** 星標選中的版本（＝素材 `Selected`）；缺席＝尚未選定。 */
  selectedVersion?: string;
}

/** 一次任務版本變更的結果（**誠實拒絕**：塞不下就明說，不靜默丟）。 */
export interface TaskVersionMutation {
  /** 變更後的集合（未接受時＝原集合的等值新物件）。 */
  set: TaskVersionSet;
  accepted: boolean;
  /** 未被接受的原因（accepted=true 時缺席）。 */
  reason?: "invalid" | "duplicate" | "full";
}

// ─────────────────────────────────────────── 清洗（讀取端／寫入端共用）

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** trim 後非空才回字串（超長截斷）。 */
function trimmed(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

/**
 * 版本識別正規化：能解析成時間的輸入 → ISO 8601 UTC 字串（**字典序＝時間序**，
 * 這是「可辨識、可排序」的根）。
 * 解析不出來 → `undefined`（**沒有時戳就沒有版本識別**：不編造版本號、不用陣列序當版本）。
 */
export function normalizeTaskVersion(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s || s.length > VERSION_INPUT_MAX) return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * kind → 標籤（值域收斂，**未知值不猜**）：
 *   · `"main_image"` / `"main_video"`（D37 字面）→ 原樣
 *   · 現場 image 族（`image`、`image_generate`、`image_edit`）→ `main_image`
 *   · 現場 video 族（`video`、`video_generate`、`video_edit`）→ `main_video`
 *   · 其餘（`tts`/`avatar`/`lipsync` 等語義上不是主圖/主片的，以及任何未知值）→ `null`
 *     （**不降格成 `main_image`**：猜錯會讓分組把別的產物算進來）
 *
 * 詞彙來源（現場真源，不另立）：
 *   · `CanvasNodeMetadata.kind` ∈ `"image"|"video"`（`types.ts:125`）
 *   · `GenerationTaskProjection.kind` ∈ 六值（`generation-task-types.ts:12`）
 *   · `HistoryEntry` 的 `mediaType` ∈ `"image"|"video"`（`history-types.ts`）
 */
export function taskTagForKind(kind: unknown): TaskTag | null {
  const k = trimmed(kind, KIND_MAX)?.toLowerCase();
  if (!k) return null;
  if (isTaskTag(k)) return k;
  if (k === "image" || k.startsWith("image_")) return "main_image";
  if (k === "video" || k.startsWith("video_")) return "main_video";
  return null;
}

/**
 * 標籤清單清洗：trim、只留值域內值（**未知值丟棄，fail-closed**）、首見序去重。
 * 非陣列/清洗後為空 → `[]`（刻意**保留空陣列**而非省略鍵：分組是總函式，
 * 每筆任務都要能回答「它帶什麼標籤」，空＝推不出，不是欄位缺席）。
 */
export function normalizeTaskTags(raw: unknown): TaskTag[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskTag[] = [];
  for (const item of raw) {
    const tag = trimmed(item, 32);
    if (!isTaskTag(tag) || out.includes(tag)) continue;
    out.push(tag);
  }
  return out;
}

/**
 * 單筆任務版本清洗：`version` 解析不出即丟該筆（不製造沒有版本識別的半形任務）。
 * 其餘欄位逐欄驗型：型別不符＝省略該欄，不連坐整筆。
 */
export function normalizeTaskVersionEntry(raw: unknown): TaskVersionEntry | null {
  if (!isRecord(raw)) return null;
  const version = normalizeTaskVersion(raw.version);
  if (!version) return null;
  const taskId = trimmed(raw.taskId, TASK_ID_MAX);
  const url = trimmed(raw.url, TASK_URL_MAX);
  const status = TASK_STATUSES.includes(raw.status as CanvasNodeStatus)
    ? (raw.status as CanvasNodeStatus)
    : undefined;
  return {
    version,
    ...(taskId ? { taskId } : {}),
    ...(status ? { status } : {}),
    tags: normalizeTaskTags(raw.tags),
    ...(url ? { url } : {}),
  };
}

/** 按 `version` 升序比較（ISO 8601 UTC 字串的字典序＝時間序）。 */
function byVersion(a: TaskVersionEntry, b: TaskVersionEntry): number {
  return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
}

/**
 * 任務版本集清洗（逐項白名單，照 `normalizeShotCandidates` 的範式）：
 *   · 非物件 / 無 `items` 陣列 → `undefined`（省略鍵，不寫空殼）
 *   · 逐筆走 `normalizeTaskVersionEntry`，非法筆丟棄（不整包作廢）
 *   · 同 `version` 去重（保留首見）→ 按 `version` 升序排序 → 裁到 `MAX_TASK_VERSIONS_PER_NODE`
 *     （**讀取端的防禦性裁剪**，同 `normalizeNodeVersions`；寫入端由 `appendTaskVersion`
 *     以 `full` 明確拒絕，兩條路徑語義不同、都不靜默丟資料）
 *   · `selectedVersion` **必須是成員**才收（指向不存在者＝不製造懸空星標）
 *   · 清完是空集合 → `undefined`（沒有任務版本＝沒有這個鍵）
 */
export function normalizeTaskVersions(raw: unknown): TaskVersionSet | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  const seen = new Set<string>();
  const collected: TaskVersionEntry[] = [];
  for (const entry of raw.items) {
    const clean = normalizeTaskVersionEntry(entry);
    if (!clean || seen.has(clean.version)) continue;
    seen.add(clean.version);
    collected.push(clean);
  }
  if (collected.length === 0) return undefined;
  const items = collected.sort(byVersion).slice(-MAX_TASK_VERSIONS_PER_NODE);
  const selected = normalizeTaskVersion(raw.selectedVersion);
  const kept = new Set(items.map((item) => item.version));
  return {
    items,
    ...(selected && kept.has(selected) ? { selectedVersion: selected } : {}),
  };
}

/** 節點 metadata → 任務版本集（缺鍵／空集合＝`null`，不製造半形集合）。 */
export function readTaskVersions(metadata: CanvasNodeMetadata | undefined): TaskVersionSet | null {
  return normalizeTaskVersions(metadata?.taskVersions) ?? null;
}

/**
 * 任務版本集 → metadata patch（純函式，呼叫端 `patchNodeMetadata` 直用）。
 * 空集合＝空 patch（不寫空殼鍵，與 `shotCandidatesMetadata` 同款誠實邊界）。
 */
export function taskVersionsMetadata(
  set: TaskVersionSet | null | undefined,
): Pick<CanvasNodeMetadata, "taskVersions"> {
  const normalized = normalizeTaskVersions(set);
  return normalized ? { taskVersions: normalized } : {};
}

// ─────────────────────────────────────────── 寫入（追加／回填／刪除／選中）

/** 集合的等值新物件（拒絕時回傳，保證呼叫端拿不到可被誤改的舊參考）。 */
function copySet(set: TaskVersionSet): TaskVersionSet {
  return {
    items: set.items.map((item) => ({ ...item, tags: [...item.tags] })),
    ...(set.selectedVersion ? { selectedVersion: set.selectedVersion } : {}),
  };
}

/**
 * 追加一筆任務版本（**同一格重跑的落點**）。
 *
 * 契約（形狀照 `addShotCandidate`）：
 *   · 髒筆（`version` 解析不出）→ `{ accepted:false, reason:"invalid" }`
 *   · 同 `version`（同一任務重放）→ `duplicate`（冪等：不重複登記同一筆任務）
 *   · 已滿 `MAX_TASK_VERSIONS_PER_NODE` → `full`（**明說塞不下，不靜默裁掉舊版本**）
 *   · **舊版本一律留在清單裡**（append-only；本函式沒有任何「覆蓋同版」的路徑）
 *   · 首筆自動上星標（本格要有採用稿；後續只加不搶星標——星標移動只走
 *     `selectTaskVersion`，避免「跑完就自動換稿」的隱式改稿）
 */
export function appendTaskVersion(set: TaskVersionSet | undefined, raw: unknown): TaskVersionMutation {
  const current = set ? copySet(set) : { items: [] };
  const entry = normalizeTaskVersionEntry(raw);
  if (!entry) return { set: current, accepted: false, reason: "invalid" };
  if (current.items.some((item) => item.version === entry.version)) {
    return { set: current, accepted: false, reason: "duplicate" };
  }
  if (current.items.length >= MAX_TASK_VERSIONS_PER_NODE) {
    return { set: current, accepted: false, reason: "full" };
  }
  const items = [...current.items, entry].sort(byVersion);
  return {
    set: { items, selectedVersion: current.selectedVersion ?? entry.version },
    accepted: true,
  };
}

/** 任務狀態/交付物的回填補丁（只做回填，不做清除：清除＝刪版本再追加）。 */
export interface TaskVersionPatch {
  status?: string | null;
  url?: string | null;
  taskId?: string | null;
}

/**
 * 就地回填某一版任務（同一任務跑完時寫狀態/交付 URL）。**版本不變** ⇒ 不產生新版本
 * （「同一任務的進度」不是新版本，這正是 D37 要求 Version 不能覆蓋的鏡像面）。
 * 找不到該版 → `updated:false`（不改集合）；補丁值清洗不出來 → 該欄不動（不把好值洗成空）。
 */
export function updateTaskVersion(
  set: TaskVersionSet | undefined,
  version: string,
  patch: TaskVersionPatch,
): { set: TaskVersionSet; updated: boolean } {
  const current = set ? copySet(set) : { items: [] };
  const target = normalizeTaskVersion(version);
  if (!target) return { set: current, updated: false };
  const index = current.items.findIndex((item) => item.version === target);
  if (index < 0) return { set: current, updated: false };

  const existing = current.items[index];
  const status = TASK_STATUSES.includes(patch.status as CanvasNodeStatus)
    ? (patch.status as CanvasNodeStatus)
    : undefined;
  const url = trimmed(patch.url, TASK_URL_MAX);
  const taskId = trimmed(patch.taskId, TASK_ID_MAX);
  const next: TaskVersionEntry = {
    version: existing.version,
    ...((taskId ?? existing.taskId) ? { taskId: taskId ?? existing.taskId } : {}),
    ...((status ?? existing.status) ? { status: status ?? existing.status } : {}),
    tags: existing.tags,
    ...((url ?? existing.url) ? { url: url ?? existing.url } : {}),
  };
  const items = [...current.items];
  items[index] = next;
  return { set: { items, ...(current.selectedVersion ? { selectedVersion: current.selectedVersion } : {}) }, updated: true };
}

/**
 * 星標選定（D37 素材 `Selected`）：只有集合成員可被選中，非成員＝不改
 * （`selected:false`，不製造懸空星標）。
 */
export function selectTaskVersion(
  set: TaskVersionSet | undefined,
  version: string,
): { set: TaskVersionSet; selected: boolean } {
  const current = set ? copySet(set) : { items: [] };
  const target = normalizeTaskVersion(version);
  if (!target || !current.items.some((item) => item.version === target)) {
    return { set: current, selected: false };
  }
  return { set: { items: current.items, selectedVersion: target }, selected: true };
}

/**
 * 刪一版任務（騰出版本位子的唯一手段）。
 *
 * **選中者被刪除時的處置（明確定義，照既有語義，不造第三套）**：
 * 回退到**剩餘清單第一條**＝`reducer.ts` 批次主圖「主圖被刪 → fallback 剩餘第一個」
 * （`batchPrimaryImageId: kept[0]`，reducer.ts:346-347）與 `removeShotCandidate` 的
 * `items[0]`，逐字同款。全刪光＝沒有 `selectedVersion`（空集合由
 * `taskVersionsMetadata` 收成省略鍵）。
 *
 * 註記（誠實）：本檔的清單是**時序升序**（末條最新），故「剩餘第一條」＝最舊的一筆。
 * 這是照既有回退語義的直接結果；若產品要「回退到最新」，那是**新的**語義，需另開裁定，
 * 本檔不擅自發明。
 */
export function removeTaskVersion(
  set: TaskVersionSet | undefined,
  version: string,
): { set: TaskVersionSet; removed: boolean } {
  const current = set ? copySet(set) : { items: [] };
  const target = normalizeTaskVersion(version);
  if (!target || !current.items.some((item) => item.version === target)) {
    return { set: current, removed: false };
  }
  const items = current.items.filter((item) => item.version !== target);
  const selectedVersion =
    current.selectedVersion && current.selectedVersion !== target
      ? current.selectedVersion
      : items[0]?.version;
  return {
    set: { items, ...(selectedVersion ? { selectedVersion } : {}) },
    removed: true,
  };
}

// ─────────────────────────────────────────── 查詢／分組

/** 某一版任務（找不到＝`null`）。 */
export function taskVersionOf(set: TaskVersionSet | null | undefined, version: string): TaskVersionEntry | null {
  const target = normalizeTaskVersion(version);
  if (!target) return null;
  return set?.items.find((item) => item.version === target) ?? null;
}

/** 最新一筆任務（時序最大；空集合＝`null`）。 */
export function latestTaskVersion(set: TaskVersionSet | null | undefined): TaskVersionEntry | null {
  if (!set?.items.length) return null;
  return set.items[set.items.length - 1];
}

/** 星標選中的任務版本（採用稿）；未選定／集合空＝`null`。 */
export function selectedTaskVersion(set: TaskVersionSet | null | undefined): TaskVersionEntry | null {
  if (!set?.selectedVersion) return null;
  return set.items.find((item) => item.version === set.selectedVersion) ?? null;
}

/** 星標選中那版任務的交付 URL（＝本格採用稿的素材）；沒有＝`null`。 */
export function selectedTaskVersionUrl(set: TaskVersionSet | null | undefined): string | null {
  return selectedTaskVersion(set)?.url ?? null;
}

/** 該標籤的任務版本（集合內查詢；保序）。 */
export function taskVersionsByTag(
  set: TaskVersionSet | null | undefined,
  tag: TaskTag,
): TaskVersionEntry[] {
  if (!set) return [];
  return set.items.filter((item) => item.tags.includes(tag));
}

/** 一組標籤分組（只出非空的組，順序＝`TASK_TAGS` 值域序，穩定可比對）。 */
export interface TaskTagGroup {
  tag: TaskTag;
  items: TaskVersionEntry[];
}

export function groupTaskVersionsByTag(set: TaskVersionSet | null | undefined): TaskTagGroup[] {
  return TASK_TAGS.map((tag) => ({ tag, items: taskVersionsByTag(set, tag) })).filter(
    (group) => group.items.length > 0,
  );
}

/** 畫布層的一條標籤命中（節點 id ＋ 該筆任務版本）。 */
export interface CanvasTaskVersionRef {
  nodeId: string;
  entry: TaskVersionEntry;
}

/**
 * 跨格的標籤查詢（畫布層分組的唯一入口）：
 * 逐節點讀 `metadata.taskVersions`，收該標籤的任務版本（節點序 × 版本時序）。
 * 沒有該鍵的節點＝零命中（不臆造）。
 */
export function taskVersionsWithTag(
  nodes: readonly CanvasNode[],
  tag: TaskTag,
): CanvasTaskVersionRef[] {
  const out: CanvasTaskVersionRef[] = [];
  if (!isTaskTag(tag)) return out;
  for (const node of nodes) {
    const set = readTaskVersions(node?.metadata);
    if (!set) continue;
    for (const entry of taskVersionsByTag(set, tag)) out.push({ nodeId: node.id, entry });
  }
  return out;
}