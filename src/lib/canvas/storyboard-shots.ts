// 分鏡層產能（P1-2，對稱差 D9；2026-09-29）。
//
// 補的兩個缺口（**不重寫既有分鏡契約**，只在其上加一層可編輯產物）：
//
//   ① 分鏡級抽卡＋星標（D9 逐字：「一分鏡 **≤4 條**；**星標選定**」）。
//      資料形狀刻意**不是**「把候選攤平成多個節點」——一鏡仍是一顆節點（identity 仍是
//      `metadata.storyboardShot.shotNumber`，見 `storyboard-contract.normalizeStoryboardShot`），
//      候選集就掛在該節點 metadata 的 `shotCandidates`（`{ items, selectedId }`）：
//         · `items`      —— 候選清單（每條自帶交付 URL/模型/狀態）
//         · `selectedId` —— **星標**選中的那一條＝本格的採用稿
//      語義上等同畫布既有的批次族（父節點 `batchChildren` ＋ `batchPrimaryImageId` 選主圖），
//      但**不新增節點**、不改動那條既有輪子；選中者被刪時回退到剩餘第一條——與 reducer
//      的批次主圖回退規則（`reducer.ts` 的 `batchPrimaryImageId: kept[0]`）同款語義。
//
//   ② prompt 回溯（D9 逐字：「**`T` 回溯生成用 prompt**」）。
//      每條候選自帶 `prompt`＝**產生它用的那一份 prompt**（鍵名照現場既有約定用 `prompt`，
//      不另立詞表），可經 `shotCandidatePrompt` / `shotRerunRequest` 讀回重跑。
//      沒有 prompt 的候選在清洗端就整條丟棄（回溯是本功能的存在理由，不是選配）。
//
// 另外附分鏡層的增刪複製重排（決策表逐字「含……＋分鏡增刪複製重排」）。順序真源＝清單陣列序，
// 與門禁橋接的既有推導同源（`storyboard-contract.storyboardQcShots`：`order ← 陣列序`）——
// **刻意不改 `shotNumber`**：它是鏡的唯一鍵（QC 的 `shot_identity`、卡引用回填都吃它），
// 重排改的是位置不是身份。
//
// 雙白名單鐵律：`shotCandidates` 必須同時存在於還原端 `layout.toNodeMetadata` 與上行端
// `compactMetadataForAgent` 兩處白名單（真源＝`node-metadata-fields.ts`），漏一端＝
// 刷新/回舊會話後候選集與星標憑空消失且不報錯（同 sceneCard / storyboardShot 家族病灶）。

import type { CanvasNode, CanvasNodeMetadata, CanvasNodeStatus } from "./types";

// ─────────────────────────────────────────── 值域與上限

/** 一分鏡的候選上限（D9 逐字「一分鏡 ≤4 條」）。 */
export const SHOT_CANDIDATE_LIMIT = 4;

/** 候選 id 上限（同族薄鍵的既有限法，128 遠大於實務）。 */
export const SHOT_CANDIDATE_ID_MAX = 128;

/**
 * 候選 prompt 的單欄上限（字元）。取 `STORYBOARD_SNAPSHOT_FIELD_CHARS` 同一把尺（4000）：
 * 該值是「上行快照的單欄預算」（`storyboard-contract.ts` 已對 21 欄用同一數字），
 * 一份候選 prompt 不該比一欄分鏡正文還重；≤4 條 × 4000 ≈ 16KB，仍在節點 metadata 量級內。
 */
export const MAX_SHOT_CANDIDATE_PROMPT_CHARS = 4000;

/** 交付 URL / 模型 id 的單欄上限。 */
const SHOT_CANDIDATE_FIELD_MAX = 2048;

/** 生成狀態值域（與節點 status 同一份，不另立第二套枚舉）。 */
const CANDIDATE_STATUSES: readonly CanvasNodeStatus[] = ["idle", "success", "loading", "error"];

// ─────────────────────────────────────────── 資料形狀

/**
 * 一條候選（一鏡的一次抽卡結果）。每條都是**自帶溯源的最小交付物**：
 * 沒有它自己那一份 prompt，這條候選在產品語義上不成立（無法回溯、無法重跑）。
 */
export interface StoryboardShotCandidate {
  /** 候選 id（同一鏡的候選集內唯一）。 */
  id: string;
  /** 產生本候選用的 prompt（`T` 回溯的唯一真源；空＝不成立，清洗端丟棄）。 */
  prompt: string;
  /** 產生本候選用的模型 id。 */
  model?: string;
  /** 交付物 URL（視頻/圖）。 */
  url?: string;
  /** 生成狀態（沿用節點四態）。 */
  status?: CanvasNodeStatus;
  /** 生成時間（ISO 字串）。 */
  createdAt?: string;
  /** 若本候選另有落地節點，這裡放它的節點 id（可選；缺席＝只存 metadata）。 */
  nodeId?: string;
}

/** 一鏡的候選集＋星標選中者。 */
export interface StoryboardShotCandidateSet {
  /** 候選清單（≤ `SHOT_CANDIDATE_LIMIT`，首見序）。 */
  items: StoryboardShotCandidate[];
  /** 星標選中的候選 id（採用稿）；缺席＝尚未選定。 */
  selectedId?: string;
}

/** 一次候選集變更的結果（**誠實拒絕**：塞不下就明說，不靜默丟棄）。 */
export interface ShotCandidateMutation {
  /** 變更後的集合（未接受時＝原集合的等值新物件，呼叫端不會拿到突變的舊物件）。 */
  set: StoryboardShotCandidateSet;
  accepted: boolean;
  /** 未被接受的原因（accepted=true 時缺席）。 */
  reason?: "full" | "invalid" | "duplicate";
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

/** 單條候選清洗：`id` 與 `prompt` 缺一即丟（不製造沒有溯源的半形候選）。 */
export function normalizeShotCandidate(raw: unknown): StoryboardShotCandidate | null {
  if (!isRecord(raw)) return null;
  const id = trimmed(raw.id, SHOT_CANDIDATE_ID_MAX);
  const prompt = trimmed(raw.prompt, MAX_SHOT_CANDIDATE_PROMPT_CHARS);
  if (!id || !prompt) return null;
  const model = trimmed(raw.model, SHOT_CANDIDATE_FIELD_MAX);
  const url = trimmed(raw.url, SHOT_CANDIDATE_FIELD_MAX);
  const createdAt = trimmed(raw.createdAt, SHOT_CANDIDATE_FIELD_MAX);
  const nodeId = trimmed(raw.nodeId, SHOT_CANDIDATE_FIELD_MAX);
  const status = CANDIDATE_STATUSES.includes(raw.status as CanvasNodeStatus)
    ? (raw.status as CanvasNodeStatus)
    : undefined;
  return {
    id,
    prompt,
    ...(model ? { model } : {}),
    ...(url ? { url } : {}),
    ...(status ? { status } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(nodeId ? { nodeId } : {}),
  };
}

/**
 * 候選集清洗（逐項白名單，照 `normalizeStoryboardShot` 的範式）：
 *   · 非物件 / 無 `items` 陣列 → `undefined`（省略鍵，不寫空殼）
 *   · 逐條走 `normalizeShotCandidate`，非法條丟棄（不整包作廢）
 *   · 同 id 去重（保留首見）→ 截到 `SHOT_CANDIDATE_LIMIT`
 *   · `selectedId` **必須是集合成員**才收（指向不存在者＝不製造懸空星標）
 *   · 清完是空集合 → `undefined`（沒有候選＝沒有這個鍵）
 */
export function normalizeShotCandidates(raw: unknown): StoryboardShotCandidateSet | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  const items: StoryboardShotCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of raw.items) {
    const candidate = normalizeShotCandidate(entry);
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    items.push(candidate);
    if (items.length >= SHOT_CANDIDATE_LIMIT) break;
  }
  if (items.length === 0) return undefined;
  const selectedId = trimmed(raw.selectedId, SHOT_CANDIDATE_ID_MAX);
  return {
    items,
    ...(selectedId && seen.has(selectedId) ? { selectedId } : {}),
  };
}

/** 節點 metadata → 候選集（缺鍵／空集合＝`null`，不製造半形候選集）。 */
export function readShotCandidates(
  metadata: CanvasNodeMetadata | undefined,
): StoryboardShotCandidateSet | null {
  return normalizeShotCandidates(metadata?.shotCandidates) ?? null;
}

/**
 * 候選集 → metadata patch（純函式，呼叫端 `patchNodeMetadata` 直用）。
 * 空集合＝空 patch（不寫空殼鍵，與 `sceneDirectorTraceMetadata` 同款誠實邊界）。
 */
export function shotCandidatesMetadata(
  set: StoryboardShotCandidateSet | null | undefined,
): Pick<CanvasNodeMetadata, "shotCandidates"> {
  const normalized = normalizeShotCandidates(set);
  return normalized ? { shotCandidates: normalized } : {};
}

// ─────────────────────────────────────────── 抽卡：加／選／刪

/** 集合的等值新物件（拒絕時回傳，保證呼叫端拿不到可被誤改的舊參考）。 */
function copySet(set: StoryboardShotCandidateSet): StoryboardShotCandidateSet {
  return {
    items: set.items.map((item) => ({ ...item })),
    ...(set.selectedId ? { selectedId: set.selectedId } : {}),
  };
}

/**
 * 加一條候選（抽卡）。
 *
 * 契約：
 *   · 髒條目（缺 id/prompt）→ `{ accepted:false, reason:"invalid" }`
 *   · 同 id → `duplicate`；已滿 `SHOT_CANDIDATE_LIMIT` → `full`（**明說塞不下，不靜默丟**）
 *   · 首條候選自動上星標（一鏡要有採用稿；後續只加不搶星標——星標的移動只走
 *     `selectShotCandidate`，避免「抽到最後一條就自動換稿」這種隱式改稿）
 */
export function addShotCandidate(
  set: StoryboardShotCandidateSet | undefined,
  raw: unknown,
): ShotCandidateMutation {
  const current = set ? copySet(set) : { items: [] };
  const candidate = normalizeShotCandidate(raw);
  if (!candidate) return { set: current, accepted: false, reason: "invalid" };
  if (current.items.some((item) => item.id === candidate.id)) {
    return { set: current, accepted: false, reason: "duplicate" };
  }
  if (current.items.length >= SHOT_CANDIDATE_LIMIT) {
    return { set: current, accepted: false, reason: "full" };
  }
  return {
    set: {
      items: [...current.items, candidate],
      selectedId: current.selectedId ?? candidate.id,
    },
    accepted: true,
  };
}

/**
 * 星標選定（`T` 之外的「星標選定當前分鏡視頻」）：只有集合成員可被選中，
 * 非成員＝不改（`selected:false`，不製造懸空星標）。
 */
export function selectShotCandidate(
  set: StoryboardShotCandidateSet | undefined,
  candidateId: string,
): { set: StoryboardShotCandidateSet; selected: boolean } {
  const current = set ? copySet(set) : { items: [] };
  const id = candidateId.trim();
  if (!id || !current.items.some((item) => item.id === id)) {
    return { set: current, selected: false };
  }
  return { set: { items: current.items, selectedId: id }, selected: true };
}

/**
 * 刪一條候選。刪掉的正是星標者時，回退到**剩餘第一條**（同 reducer 批次主圖回退規則）；
 * 全刪光＝沒有 selectedId（空集合由 `shotCandidatesMetadata` 收成省略鍵）。
 */
export function removeShotCandidate(
  set: StoryboardShotCandidateSet | undefined,
  candidateId: string,
): { set: StoryboardShotCandidateSet; removed: boolean } {
  const current = set ? copySet(set) : { items: [] };
  const id = candidateId.trim();
  if (!id || !current.items.some((item) => item.id === id)) {
    return { set: current, removed: false };
  }
  const items = current.items.filter((item) => item.id !== id);
  const selectedId =
    current.selectedId && current.selectedId !== id
      ? current.selectedId
      : items[0]?.id;
  return { set: { items, ...(selectedId ? { selectedId } : {}) }, removed: true };
}

/** 星標選中的候選（採用稿）；未選定／集合空＝`null`。 */
export function selectedShotCandidate(
  set: StoryboardShotCandidateSet | null | undefined,
): StoryboardShotCandidate | null {
  if (!set?.selectedId) return null;
  return set.items.find((item) => item.id === set.selectedId) ?? null;
}

// ─────────────────────────────────────────── prompt 回溯（`T`）

/** 回溯：這條候選是**用哪一份 prompt 生出來的**（找不到該候選＝`null`）。 */
export function shotCandidatePrompt(
  set: StoryboardShotCandidateSet | null | undefined,
  candidateId: string,
): string | null {
  const id = candidateId.trim();
  if (!id) return null;
  return set?.items.find((item) => item.id === id)?.prompt ?? null;
}

/** 模擬 `T` 的預設落點：對**星標那一條**回溯 prompt。 */
export function selectedShotCandidatePrompt(
  set: StoryboardShotCandidateSet | null | undefined,
): string | null {
  const selected = selectedShotCandidate(set);
  return selected ? selected.prompt : null;
}

/** 分鏡節點的鏡號（`storyboardShot.shotNumber`；空＝不是分鏡節點）。 */
export function shotNumberOf(node: CanvasNode | undefined): string | undefined {
  const raw = node?.metadata?.storyboardShot?.shotNumber;
  if (typeof raw !== "string") return undefined;
  const shotNumber = raw.trim();
  return shotNumber || undefined;
}

/** 分鏡節點判準（現場唯一判準＝`metadata.storyboardShot.shotNumber` 非空）。 */
export function isStoryboardShotNode(node: CanvasNode | undefined): boolean {
  return shotNumberOf(node) !== undefined;
}

/**
 * 單鏡的重跑請求（「拿回來重跑」的落地形）。
 *
 * prompt 來源**照優先序**：星標候選的 prompt（＝這格真正用過的稿）→ 節點自身
 * `metadata.prompt`（未抽卡時的一次生成 prompt）。都沒有＝`null`（沒有 prompt 就沒有重跑，
 * 不編造）。model 同序：星標候選的 model → 節點 `metadata.model`。
 */
export interface ShotRerunRequest {
  nodeId: string;
  shotNumber: string;
  prompt: string;
  model?: string;
}

export function shotRerunRequest(node: CanvasNode | undefined): ShotRerunRequest | null {
  const shotNumber = shotNumberOf(node);
  if (!node || !shotNumber) return null;
  const set = readShotCandidates(node.metadata);
  const selected = selectedShotCandidate(set);
  const prompt = selected?.prompt ?? (typeof node.metadata?.prompt === "string" ? node.metadata.prompt.trim() : "");
  if (!prompt) return null;
  const nodeModel = typeof node.metadata?.model === "string" ? node.metadata.model.trim() : "";
  const model = selected?.model ?? (nodeModel || undefined);
  return { nodeId: node.id, shotNumber, prompt, ...(model ? { model } : {}) };
}

// ─────────────────────────────────────────── 分鏡增刪複製重排

/**
 * 分鏡清單項（順序真源＝陣列序；`shotNumber` 是唯一鍵，重排不動它）。
 */
export interface ShotListEntry {
  nodeId: string;
  shotNumber: string;
}

/** 分鏡清單操作的結果（`ok:false` 時 `shots` ＝輸入的等值新陣列）。 */
export interface ShotListMutation {
  shots: ShotListEntry[];
  ok: boolean;
  /** 被拒絕的原因（ok=true 時缺席）。 */
  reason?: "unknown-node" | "duplicate-node" | "duplicate-shot-number" | "out-of-range";
}

function copyList(entries: readonly ShotListEntry[]): ShotListEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

/**
 * 新增一顆分鏡在 `at` 位置（`at` 為插入後的 0-based 索引；`at === length` ＝ 追加到末尾）。
 * 節點 id 與鏡號都必須是清單內未出現過的（分鏡清單內兩者是唯一鍵）。
 */
export function insertShotEntry(
  entries: readonly ShotListEntry[],
  at: number,
  entry: ShotListEntry,
): ShotListMutation {
  const shots = copyList(entries);
  if (!Number.isInteger(at) || at < 0 || at > shots.length) return { shots, ok: false, reason: "out-of-range" };
  const nodeId = entry.nodeId.trim();
  const shotNumber = entry.shotNumber.trim();
  if (!nodeId || !shotNumber) return { shots, ok: false, reason: "unknown-node" };
  if (shots.some((item) => item.nodeId === nodeId)) return { shots, ok: false, reason: "duplicate-node" };
  if (shots.some((item) => item.shotNumber === shotNumber)) return { shots, ok: false, reason: "duplicate-shot-number" };
  shots.splice(at, 0, { nodeId, shotNumber });
  return { shots, ok: true };
}

/** 刪一顆分鏡。 */
export function deleteShotEntry(
  entries: readonly ShotListEntry[],
  nodeId: string,
): ShotListMutation {
  const shots = copyList(entries);
  const id = nodeId.trim();
  if (!shots.some((item) => item.nodeId === id)) return { shots, ok: false, reason: "unknown-node" };
  return { shots: shots.filter((item) => item.nodeId !== id), ok: true };
}

/**
 * 複製一顆分鏡：新項插在**來源的正後一格**（人的直覺＝「這格後面再來一格」）。
 * 新鏡號不得與既有任何一顆撞號（撞號＝`duplicate-shot-number`；鏡號是唯一鍵，不許自動編號）。
 */
export function duplicateShotEntry(
  entries: readonly ShotListEntry[],
  sourceNodeId: string,
  copy: ShotListEntry,
): ShotListMutation {
  const shots = copyList(entries);
  const sourceIndex = shots.findIndex((item) => item.nodeId === sourceNodeId.trim());
  if (sourceIndex < 0) return { shots, ok: false, reason: "unknown-node" };
  const nodeId = copy.nodeId.trim();
  const shotNumber = copy.shotNumber.trim();
  if (!nodeId || !shotNumber) return { shots, ok: false, reason: "unknown-node" };
  if (shots.some((item) => item.nodeId === nodeId)) return { shots, ok: false, reason: "duplicate-node" };
  if (shots.some((item) => item.shotNumber === shotNumber)) return { shots, ok: false, reason: "duplicate-shot-number" };
  shots.splice(sourceIndex + 1, 0, { nodeId, shotNumber });
  return { shots, ok: true };
}

/**
 * 重排：把某一顆移到 `toIndex`（**目標為最終 0-based 位置**，先摘除再插入）。
 * 移到原位 = 合法 no-op（`ok:true`，順序不變）。
 */
export function moveShotEntry(
  entries: readonly ShotListEntry[],
  nodeId: string,
  toIndex: number,
): ShotListMutation {
  const shots = copyList(entries);
  const fromIndex = shots.findIndex((item) => item.nodeId === nodeId.trim());
  if (fromIndex < 0) return { shots, ok: false, reason: "unknown-node" };
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= shots.length) {
    return { shots, ok: false, reason: "out-of-range" };
  }
  const [moved] = shots.splice(fromIndex, 1);
  shots.splice(toIndex, 0, moved);
  return { shots, ok: true };
}

/** 分鏡節點清單 → 分鏡清單項（非分鏡節點自動剔除，不臆造鏡號）。 */
export function shotListEntries(nodes: readonly CanvasNode[]): ShotListEntry[] {
  const out: ShotListEntry[] = [];
  for (const node of nodes) {
    const shotNumber = shotNumberOf(node);
    if (node && shotNumber) out.push({ nodeId: node.id, shotNumber });
  }
  return out;
}

/**
 * 複製分鏡節點（純函式，回傳新節點；**不動輸入**）。
 *
 * 形狀＝逐欄複製 CanvasNode（含 metadata 深拷貝），只改白名單四件事：
 *   ① `id` / `shotNumber`（新身份）
 *   ② `title`（預設帶新鏡號；來源標題不含鏡號時補上，避免複製品與來源同名）
 *   ③ 剝掉**屬於來源那一格的產物與裁決**：
 *      `shotCandidates`（新格還沒抽卡）、`entityCardId`（落卡冪等標記屬於來源節點）、
 *      `approval`（複製品是未批准的新稿）、`directorStageId`/`shotId`（溯源指針指向來源那一格）。
 *   ④ 位置（可選傳入；不傳＝沿用來源座標，版面由呼叫端決定）
 *
 * 卡引用（`characterCardIds`/`sceneCardIds`/`propCardIds`）**照抄**——那是這一鏡的內容，
 * 複製分鏡的用途正是沿用同一組角色/場景再改。
 */
export interface CloneShotNodeOptions {
  id: string;
  shotNumber: string;
  title?: string;
  position?: { x: number; y: number };
}

export function cloneShotNode(node: CanvasNode, options: CloneShotNodeOptions): CanvasNode {
  const nextShotNumber = options.shotNumber.trim();
  const metadata: CanvasNodeMetadata = { ...node.metadata };
  delete metadata.shotCandidates;
  delete metadata.entityCardId;
  delete metadata.approval;
  delete metadata.directorStageId;
  delete metadata.shotId;
  if (metadata.storyboardShot) {
    metadata.storyboardShot = { ...metadata.storyboardShot, shotNumber: nextShotNumber };
  }
  const title =
    options.title?.trim() ||
    (nextShotNumber && !node.title.includes(nextShotNumber) ? `${node.title} ${nextShotNumber}` : node.title);
  return {
    ...node,
    id: options.id.trim(),
    title,
    ...(options.position ? { position: { ...options.position } } : {}),
    ...(metadata ? { metadata } : {}),
  };
}