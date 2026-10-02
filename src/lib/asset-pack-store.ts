// 資產包真源（Blob 持久化）。
//
// 沿用 project-store.ts 的模式：每次寫入落到新路徑 + 修剪舊世代，
// 避免 Blob cacheControlMaxAge 60s 下限造成的「剛存讀不到」；單用戶寫入串行。
// 與畫布素材庫分開命名空間（asset-packs/），互不影響。
import { randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";
import { GHOST_ASSET_SCOPE, isUsableAssetId, MAX_ASSET_ID_LENGTH, normalizeAssetScope } from "./asset-scope";
import type { AssetScope } from "./asset-scope";
import { normalizeLineageLinks } from "./lineage";
import type { LineageLink } from "./lineage";
// 交付物種類真源（./deliverable-kind，零依賴純函數檔）：資產側的媒體 item kind
// （image/video/audio）與 URL 欄位（imageUrl/mediaUrl）全由它推導，不再各寫一份。
import { DELIVERABLE_KINDS } from "./deliverable-kind";

const PACK_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const INDEX_CACHE_TTL_MS = 3_000;

/** 每用戶資產包上限（超出時 saveAssetPack 拒絕，不做靜默截斷）。 */
export const MAX_PACKS_PER_USER = 100;
/** 每包 item 上限（超出時 normalizeAssetPack 截斷）。 */
export const MAX_ITEMS_PER_PACK = 50;
/** digest 語義摘要上限（模型注入用）。 */
export const MAX_DIGEST_LENGTH = 500;
/**
 * pack id 上限（與 share/mount 的 200 同一個界；超長 id 過去「可建不可分享」）。
 * 界線與字元邊界同源：一律走 asset-scope 的 isUsableAssetId。
 */
export const MAX_PACK_ID_LENGTH = MAX_ASSET_ID_LENGTH;
export const MAX_TITLE_LENGTH = 200;
const MAX_TAGS_PER_PACK = 20;
const MAX_TAG_LENGTH = 50;
const MAX_NOTE_LENGTH = 200;
const MAX_SCENE_SUMMARY_LENGTH = 500;

/**
 * 資產專屬 item kind（資產庫自身與配方/3D 等用途，不由歷史交付物直接產生）。
 * 與下面的媒體段分開宣告：新增交付物種類只動 deliverable-kind 註冊表，這裡不動。
 */
export const ASSET_ONLY_ITEM_KINDS = [
  "prompt",
  "reference",
  "lora",
  "recipe",
  // 3D 資產（Astra P1-5）：scene_3d=.blend/.glb 產物；bpy_script=bpy 腳本模板。
  "scene_3d",
  "bpy_script",
] as const;

/**
 * 資產包 item kind = 資產專屬六類 ∪ 交付物媒體種類（image/video/audio）。
 * 兩段都由真源推導（第二段直接取 deliverable-kind 註冊表的 assetItemKind），
 * 不手寫字串聯集；新增一種交付物＝在註冊表加一行，這裡自動跟上。
 */
export type AssetPackItemKind =
  | (typeof ASSET_ONLY_ITEM_KINDS)[number]
  | (typeof DELIVERABLE_KINDS)[number]["assetItemKind"];

export interface AssetPackItem {
  kind: AssetPackItemKind;
  title: string;
  /** prompt / recipe 用：提示詞或六槽配方文本。 */
  content?: string;
  /** reference / image 用：既有 URL（不複製位元組）。 */
  imageUrl?: string;
  /** video / audio 用：影片/音樂產物 URL（與 imageUrl 並存不互斥）。 */
  mediaUrl?: string;
  /** lora 用。 */
  loraVersionId?: string;
  loraWeight?: number;
  /** recipe 用：該配方對應的模型/size/lora 清單。 */
  modelId?: string;
  size?: string;
  loraModelVersionIds?: string[];
  /** scene_3d / bpy_script 用（Astra P1-5）：bridge 產物路徑 / 檔案大小 / 腳本指紋 / 場景摘要。 */
  artifactPath?: string;
  bytes?: number;
  fingerprint?: string;
  sceneSummary?: string;
  /** 來源標記。 */
  source?: { type: "history" | "canvas" | "chat" | "workflow" | "manual"; id: string; sessionId?: string };
  note?: string;
  createdAt?: string;
}

export interface AssetPack {
  id: string;
  title: string;
  /** 語義摘要（≤500 字，模型注入用）。 */
  digest?: string;
  items: AssetPackItem[];
  active?: boolean;
  tags: string[];
  note?: string;
  /**
   * REQ-B2 歸屬（個人 / 項目）：缺省＝personal（既有資產零改動）。
   * 只給人看（項目資產庫面板的歸屬標記與顯式分享入口）——
   * **裁決排除**：不進 canvas 節點 metadata、不進 toNodeMetadata、
   * 不進 compactMetadataForAgent（agent 不讀資產歸屬）。
   */
  scope?: AssetScope;
  /**
   * REQ-D1 血統（與 CharacterCard 同形、同一清洗收口）：REQ-B2b 的
   * 「包掛用＝在目標項目記本地包記錄＋lineage 指向來源包」寫入這一欄。
   * 同 D1 裁決：只存在包本體供人看，不進 canvas 節點 metadata、不進 agent 壓縮白名單。
   */
  lineage?: LineageLink[];
  /** parents 曾超上限被截尾的顯式標記。 */
  lineageTruncated?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 資產包數達上限時拋出（API 層轉 400，誠實拒絕）。 */
export class AssetPackLimitError extends Error {
  constructor() {
    super(`资产包数量已达上限 ${MAX_PACKS_PER_USER} 个`);
    this.name = "AssetPackLimitError";
  }
}

const memoryStore = new Map<number, AssetPack[]>();
const indexCache = new Map<number, { packs: AssetPack[]; expiresAt: number }>();
const writeQueues = new Map<number, Promise<unknown>>();

function userPrefix(userId: number): string {
  return `asset-packs/${sanitizeBlobSegment(String(userId), "0")}`;
}

function indexPrefix(userId: number): string {
  return `${userPrefix(userId)}/index-`;
}

function enqueue<T>(userId: number, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  writeQueues.set(userId, next.catch(() => undefined));
  return next;
}

type BlobRef = { url: string; pathname: string; uploadedAt: Date };

async function listIndexBlobs(userId: number): Promise<BlobRef[]> {
  const blobs: BlobRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: indexPrefix(userId), cursor });
    for (const blob of page.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}

/**
 * kind 白名單＝與 AssetPackItemKind 同源推導（資產專屬六類 ＋ 交付物媒體種類），
 * 消掉過去手抄的第二份清單；新增交付物種類這裡自動跟上。
 */
const ITEM_KINDS: readonly AssetPackItemKind[] = [
  ...ASSET_ONLY_ITEM_KINDS,
  ...DELIVERABLE_KINDS.map((kind) => kind.assetItemKind),
];

/**
 * 交付物媒體 kind → 資產 URL 欄位（由註冊表推導：image→imageUrl、video/audio→mediaUrl）。
 * 資產專屬六類不在表內；reference 收 imageUrl 的既有語義單獨處理。
 */
const MEDIA_URL_FIELD_BY_KIND: ReadonlyMap<string, "imageUrl" | "mediaUrl"> = new Map(
  DELIVERABLE_KINDS.map((kind) => [kind.assetItemKind, kind.assetUrlField] as const),
);

/**
 * 純函式：把不可信 item payload 正規化為 AssetPackItem。
 * 驗 kind/title；content/imageUrl/mediaUrl 按 kind 才收（媒體欄位由交付物註冊表推導）；
 * loraVersionId 僅 lora；recipe 收 modelId/size/loraModelVersionIds；source 白名單 type + 必填 id。
 * video/audio 缺 mediaUrl 回 null（媒體 item 無 URL 無意義）；其餘不合法回 null。
 */
function normalizeItem(payload: unknown): AssetPackItem | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<AssetPackItem>;
  const kind = p.kind;
  if (!kind || !ITEM_KINDS.includes(kind)) return null;
  if (typeof p.title !== "string" || !p.title.trim()) return null;

  const item: AssetPackItem = {
    kind,
    title: p.title.trim().slice(0, MAX_TITLE_LENGTH),
  };

  if (kind === "prompt" || kind === "recipe") {
    if (typeof p.content === "string") item.content = p.content;
  }
  // reference 沿用既有 imageUrl 收法（資產專屬參考圖，不因新增媒體種類而動）。
  if (kind === "reference") {
    if (typeof p.imageUrl === "string" && p.imageUrl.trim()) item.imageUrl = p.imageUrl.trim();
  }
  // 交付物媒體（image/video/audio）：收哪個 URL 欄位由註冊表推導（assetItemKind → assetUrlField）。
  //   * image → imageUrl，維持既有尺度：缺 URL 仍保留 item（僅 trim 後非空才收）。
  //   * video/audio → mediaUrl，**缺 mediaUrl 回 null**（無產物 URL 的媒體 item 無意義）。
  // 長度上限與 imageUrl 現行做法對齊：只 trim、不另設上限（imageUrl 既有亦無長度常數）。
  const mediaUrlField = MEDIA_URL_FIELD_BY_KIND.get(kind);
  if (mediaUrlField === "imageUrl") {
    if (typeof p.imageUrl === "string" && p.imageUrl.trim()) item.imageUrl = p.imageUrl.trim();
  } else if (mediaUrlField === "mediaUrl") {
    const mediaUrl = typeof p.mediaUrl === "string" ? p.mediaUrl.trim() : "";
    if (!mediaUrl) return null;
    item.mediaUrl = mediaUrl;
  }
  if (kind === "lora") {
    if (typeof p.loraVersionId === "string" && p.loraVersionId.trim()) item.loraVersionId = p.loraVersionId.trim();
    if (typeof p.loraWeight === "number" && Number.isFinite(p.loraWeight)) item.loraWeight = p.loraWeight;
  }
  if (kind === "recipe") {
    if (typeof p.modelId === "string" && p.modelId.trim()) item.modelId = p.modelId.trim();
    if (typeof p.size === "string" && p.size.trim()) item.size = p.size.trim();
    if (Array.isArray(p.loraModelVersionIds)) {
      const ids = p.loraModelVersionIds.filter((v): v is string => typeof v === "string");
      if (ids.length) item.loraModelVersionIds = ids;
    }
  }
  // 3D 資產（Astra P1-5）：scene_3d 收 bridge 產物欄（artifactPath/bytes/sceneSummary），
  // bpy_script 收腳本模板欄（content=腳本全文 + fingerprint 指紋）。與 recipe/lora 分支同構。
  if (kind === "scene_3d") {
    if (typeof p.artifactPath === "string" && p.artifactPath.trim()) item.artifactPath = p.artifactPath.trim();
    if (typeof p.bytes === "number" && Number.isFinite(p.bytes) && p.bytes >= 0) item.bytes = p.bytes;
    if (typeof p.sceneSummary === "string" && p.sceneSummary.trim()) {
      item.sceneSummary = p.sceneSummary.trim().slice(0, MAX_SCENE_SUMMARY_LENGTH);
    }
    if (typeof p.fingerprint === "string" && p.fingerprint.trim()) item.fingerprint = p.fingerprint.trim();
  }
  if (kind === "bpy_script") {
    if (typeof p.content === "string") item.content = p.content;
    if (typeof p.artifactPath === "string" && p.artifactPath.trim()) item.artifactPath = p.artifactPath.trim();
    if (typeof p.bytes === "number" && Number.isFinite(p.bytes) && p.bytes >= 0) item.bytes = p.bytes;
    if (typeof p.fingerprint === "string" && p.fingerprint.trim()) item.fingerprint = p.fingerprint.trim();
    if (typeof p.sceneSummary === "string" && p.sceneSummary.trim()) {
      item.sceneSummary = p.sceneSummary.trim().slice(0, MAX_SCENE_SUMMARY_LENGTH);
    }
  }
  if (p.source && typeof p.source === "object") {
    const s = p.source as { type?: unknown; id?: unknown; sessionId?: unknown };
    if (
      (s.type === "history" ||
        s.type === "canvas" ||
        s.type === "chat" ||
        s.type === "workflow" ||
        s.type === "manual") &&
      typeof s.id === "string"
    ) {
      item.source = {
        type: s.type,
        id: s.id,
        ...(typeof s.sessionId === "string" ? { sessionId: s.sessionId } : {}),
      };
    }
  }
  if (typeof p.note === "string" && p.note.trim()) item.note = p.note.trim();
  if (typeof p.createdAt === "string") item.createdAt = p.createdAt;
  return item;
}

/**
 * 純函式：把不可信 payload 正規化為 AssetPack。
 * 驗 id/title；items 逐項 normalizeItem（非法項 drop、超出 MAX_ITEMS_PER_PACK 截斷）；
 * tags 陣列化 + 去重 + 截斷；標題截 200；digest 截 500；note 截 200；
 * active 只收 boolean（僅 true 寫入）。不合法回 null。
 *
 * id 邊界（REQ-B2）：走 asset-scope 的 isUsableAssetId —— **拒絕**（非截斷）空 /
 * 超長（>MAX_PACK_ID_LENGTH）/ 含保留分隔符 `:` / 含控制字元的 id。
 * 截斷會讓兩個不同 id 落成同一個 id（作用域層確定性鍵的撞鍵源），故一律 fail-closed；
 * 也與 share/mount 的長度界對齊，避免「可建不可分享」。
 */
export function normalizeAssetPack(payload: unknown): AssetPack | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<AssetPack>;
  if (!isUsableAssetId(p.id)) return null;
  if (typeof p.title !== "string" || !p.title.trim()) return null;

  const items: AssetPackItem[] = [];
  if (Array.isArray(p.items)) {
    for (const raw of p.items) {
      const item = normalizeItem(raw);
      if (!item) continue;
      items.push(item);
      if (items.length >= MAX_ITEMS_PER_PACK) break;
    }
  }

  const seen = new Set<string>();
  const tags: string[] = [];
  if (Array.isArray(p.tags)) {
    for (const raw of p.tags) {
      if (typeof raw !== "string") continue;
      const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
      if (tags.length >= MAX_TAGS_PER_PACK) break;
    }
  }

  const now = new Date().toISOString();
  const note = typeof p.note === "string" ? p.note.trim().slice(0, MAX_NOTE_LENGTH) : "";
  const digest = typeof p.digest === "string" ? p.digest.trim().slice(0, MAX_DIGEST_LENGTH) : "";
  // REQ-B2 作用域：走 ./asset-scope 的清洗收口（非 project/team 一律收斂成 personal 並省略欄位，
  // 不寫 `scope:{owner:"personal"}` 冒充已設定）；**鬼狀態（project 但無 projectId / team 但無
  // teamId）寫回 GHOST_ASSET_SCOPE 而非降格成 personal**——降格＝把歸屬不明的項目資產變成
  // 人人可用的個人資產（D3）。P0-2：team 作用域同樣要落欄（否則團隊包在存檔端靜默丟歸屬）。
  const scope = normalizeAssetScope(p.scope);
  // REQ-D1 血統欄位復用 ./lineage 的清洗收口（非法條目丟、上限截尾並顯式標記）；
  // 與 character-cards.normalizeCharacterCard 同款，宿主不同、白名單同一把尺。
  const lineageRaw = Array.isArray(p.lineage) ? normalizeLineageLinks(p.lineage) : null;
  return {
    id: p.id.trim(),
    title: p.title.trim().slice(0, MAX_TITLE_LENGTH),
    ...(digest ? { digest } : {}),
    items,
    ...(p.active === true ? { active: true } : {}),
    tags,
    ...(note ? { note } : {}),
    ...(scope === null
      ? { scope: { ...GHOST_ASSET_SCOPE } }
      : scope.owner === "project" || scope.owner === "team"
        ? { scope }
        : {}),
    ...(lineageRaw && lineageRaw.parents.length
      ? {
          lineage: lineageRaw.parents,
          ...(lineageRaw.truncated || p.lineageTruncated === true ? { lineageTruncated: true } : {}),
        }
      : {}),
    createdAt: typeof p.createdAt === "string" ? p.createdAt : now,
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : now,
  };
}

function parseDocument(payload: unknown): AssetPack[] {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { packs?: unknown } | null)?.packs)
      ? (payload as { packs: AssetPack[] }).packs
      : [];
  return raw.flatMap((item) => {
    const normalized = normalizeAssetPack(item);
    return normalized ? [normalized] : [];
  });
}

async function readBlobDocument(urlOrPath: string): Promise<AssetPack[]> {
  try {
    const blob = await get(urlOrPath, { access: "public" });
    if (!blob || blob.statusCode !== 200) return [];
    const text = await new Response(blob.stream).text();
    if (!text) return [];
    return parseDocument(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
}

async function fetchPacks(userId: number): Promise<AssetPack[]> {
  const blobs = await listIndexBlobs(userId);
  if (blobs.length) return readBlobDocument(blobs[0].url);
  return [];
}

async function readPacks(userId: number): Promise<AssetPack[]> {
  if (!ensureBlobBackendWritable("asset-pack-store.readPacks")) return [...(memoryStore.get(userId) ?? [])];
  const cached = indexCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return [...cached.packs];
  const packs = await fetchPacks(userId);
  indexCache.set(userId, { packs, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return [...packs];
}

async function writePacks(userId: number, packs: AssetPack[]): Promise<void> {
  // 上限在 saveAssetPack 拒絕，這裡只排序（newest 優先），不靜默丟資料。
  const sorted = [...packs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (!ensureBlobBackendWritable("asset-pack-store.writePacks")) {
    memoryStore.set(userId, sorted);
    indexCache.delete(userId);
    return;
  }
  const previous = await listIndexBlobs(userId).catch(() => [] as BlobRef[]);
  const document = { schemaVersion: PACK_SCHEMA_VERSION, packs: sorted };
  const pathname = `${indexPrefix(userId)}${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(document), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  indexCache.set(userId, { packs: sorted, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((b) => b.url)).catch((error) => {
      console.error("[asset-packs] 清理舊索引失敗。", error);
    });
  }
}

// ─────────────────────────────────────────── 對外接口

/** 讀全部資產包（newest 優先）。 */
export async function listAssetPacks(userId: number): Promise<AssetPack[]> {
  return readPacks(userId);
}

/** 讀 active===true 的資產包；無則回 null（單一 active 鐵律）。 */
export async function getActiveAssetPack(userId: number): Promise<AssetPack | null> {
  const packs = await readPacks(userId);
  return packs.find((p) => p.active === true) ?? null;
}

/**
 * 儲存/覆蓋一個資產包（upsert by id）。
 * 不合法拋錯（呼叫端應先 normalizeAssetPack 驗證）；新增超過上限拋 AssetPackLimitError。
 * 若新包 active===true，則把同用戶其它包的 active 清掉（單一 active 鐵律）。
 */
export async function saveAssetPack(userId: number, pack: AssetPack): Promise<void> {
  const normalized = normalizeAssetPack(pack);
  if (!normalized) throw new Error("invalid asset pack");
  await enqueue(userId, async () => {
    const current = await readPacks(userId);
    const exists = current.some((p) => p.id === normalized.id);
    if (!exists && current.length >= MAX_PACKS_PER_USER) throw new AssetPackLimitError();
    let next = current.filter((p) => p.id !== normalized.id);
    if (normalized.active === true) {
      next = next.map((p) => (p.active === true ? { ...p, active: undefined } : p));
    }
    await writePacks(userId, [normalized, ...next]);
  });
}

/** 刪除若干資產包（不存在的 id 忽略）。 */
export async function deleteAssetPacks(userId: number, ids: string[]): Promise<void> {
  const targets = new Set(ids.filter(Boolean));
  if (!targets.size) return;
  await enqueue(userId, async () => {
    const current = await readPacks(userId);
    const next = current.filter((p) => !targets.has(p.id));
    if (next.length === current.length) return;
    await writePacks(userId, next);
  });
}

/** 僅測試：重置進程內狀態。 */
export function __resetAssetPackStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
