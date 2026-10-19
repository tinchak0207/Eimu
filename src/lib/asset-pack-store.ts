// 资产包真源（Blob 持久化）。
//
// 沿用 project-store.ts 的模式：每次写入落到新路径 + 修剪旧世代，
// 避免 Blob cacheControlMaxAge 60s 下限造成的「刚存读不到」；单用户写入串行。
// 与画布素材库分开命名空间（asset-packs/），互不影响。
import { randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";
import { GHOST_ASSET_SCOPE, isUsableAssetId, MAX_ASSET_ID_LENGTH, normalizeAssetScope, normalizeProjectIds } from "./asset-scope";
import type { AssetScope } from "./asset-scope";
import { normalizeLineageLinks } from "./lineage";
import type { LineageLink } from "./lineage";
// 交付物种类真源（./deliverable-kind，零依赖纯函数档）：资产侧的媒体 item kind
// （image/video/audio）与 URL 栏位（imageUrl/mediaUrl）全由它推导，不再各写一份。
import { DELIVERABLE_KINDS } from "./deliverable-kind";

const PACK_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const INDEX_CACHE_TTL_MS = 3_000;

/** 每用户资产包上限（超出时 saveAssetPack 拒绝，不做静默截断）。 */
export const MAX_PACKS_PER_USER = 100;
/** 每包 item 上限（超出时 normalizeAssetPack 截断）。 */
export const MAX_ITEMS_PER_PACK = 50;
/** digest 语义摘要上限（模型注入用）。 */
export const MAX_DIGEST_LENGTH = 500;
/**
 * pack id 上限（与 share/mount 的 200 同一个界；超长 id 过去「可建不可分享」）。
 * 界线与字元边界同源：一律走 asset-scope 的 isUsableAssetId。
 */
export const MAX_PACK_ID_LENGTH = MAX_ASSET_ID_LENGTH;
export const MAX_TITLE_LENGTH = 200;
const MAX_TAGS_PER_PACK = 20;
const MAX_TAG_LENGTH = 50;
const MAX_NOTE_LENGTH = 200;
const MAX_SCENE_SUMMARY_LENGTH = 500;

/**
 * 资产专属 item kind（资产库自身与配方/3D 等用途，不由历史交付物直接产生）。
 * 与下面的媒体段分开宣告：新增交付物种类只动 deliverable-kind 注册表，这里不动。
 */
export const ASSET_ONLY_ITEM_KINDS = [
  "prompt",
  "reference",
  "lora",
  "recipe",
  // 3D 资产（Astra P1-5）：scene_3d=.blend/.glb 产物；bpy_script=bpy 脚本模板。
  "scene_3d",
  "bpy_script",
] as const;

/**
 * 资产包 item kind = 资产专属六类 ∪ 交付物媒体种类（image/video/audio）。
 * 两段都由真源推导（第二段直接取 deliverable-kind 注册表的 assetItemKind），
 * 不手写字串联集；新增一种交付物＝在注册表加一行，这里自动跟上。
 */
export type AssetPackItemKind =
  | (typeof ASSET_ONLY_ITEM_KINDS)[number]
  | (typeof DELIVERABLE_KINDS)[number]["assetItemKind"];

export interface AssetPackItem {
  kind: AssetPackItemKind;
  title: string;
  /** prompt / recipe 用：提示词或六槽配方文本。 */
  content?: string;
  /** reference / image 用：既有 URL（不复制位元组）。 */
  imageUrl?: string;
  /** video / audio 用：影片/音乐产物 URL（与 imageUrl 并存不互斥）。 */
  mediaUrl?: string;
  /** lora 用。 */
  loraVersionId?: string;
  loraWeight?: number;
  /** recipe 用：该配方对应的模型/size/lora 清单。 */
  modelId?: string;
  size?: string;
  loraModelVersionIds?: string[];
  /** scene_3d / bpy_script 用（Astra P1-5）：bridge 产物路径 / 档案大小 / 脚本指纹 / 场景摘要。 */
  artifactPath?: string;
  bytes?: number;
  fingerprint?: string;
  sceneSummary?: string;
  /** 来源标记。 */
  source?: { type: "history" | "canvas" | "chat" | "workflow" | "manual"; id: string; sessionId?: string };
  note?: string;
  createdAt?: string;
}

export interface AssetPack {
  id: string;
  title: string;
  /** 语义摘要（≤500 字，模型注入用）。 */
  digest?: string;
  items: AssetPackItem[];
  active?: boolean;
  tags: string[];
  note?: string;
  /**
   * REQ-B2 归属（个人 / 项目）：缺省＝personal（既有资产零改动）。
   * 只给人看（项目资产库面板的归属标记与显式分享入口）——
   * **裁决排除**：不进 canvas 节点 metadata、不进 toNodeMetadata、
   * 不进 compactMetadataForAgent（agent 不读资产归属）。
   */
  scope?: AssetScope;
  /**
   * P1-A 项目标签（多归属，纯加法）：与 scope 并存；缺省＝没有标签。
   * **语义**：给资产打「属于哪些创作项目」的标签（天然多归属），可见性判定见
   * asset-scope.resolveAssetScopeVisibility 的新允许路径。
   * 只给人看与前端筛选——不进 canvas 节点 metadata、不进 toNodeMetadata、
   * 不进 compactMetadataForAgent（同 scope 裁决）。
   */
  projectIds?: string[];
  /**
   * REQ-D1 血统（与 CharacterCard 同形、同一清洗收口）：REQ-B2b 的
   * 「包挂用＝在目标项目记本地包记录＋lineage 指向来源包」写入这一栏。
   * 同 D1 裁决：只存在包本体供人看，不进 canvas 节点 metadata、不进 agent 压缩白名单。
   */
  lineage?: LineageLink[];
  /** parents 曾超上限被截尾的显式标记。 */
  lineageTruncated?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 资产包数达上限时抛出（API 层转 400，诚实拒绝）。 */
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
 * kind 白名单＝与 AssetPackItemKind 同源推导（资产专属六类 ＋ 交付物媒体种类），
 * 消掉过去手抄的第二份清单；新增交付物种类这里自动跟上。
 */
const ITEM_KINDS: readonly AssetPackItemKind[] = [
  ...ASSET_ONLY_ITEM_KINDS,
  ...DELIVERABLE_KINDS.map((kind) => kind.assetItemKind),
];

/**
 * 交付物媒体 kind → 资产 URL 栏位（由注册表推导：image→imageUrl、video/audio→mediaUrl）。
 * 资产专属六类不在表内；reference 收 imageUrl 的既有语义单独处理。
 */
const MEDIA_URL_FIELD_BY_KIND: ReadonlyMap<string, "imageUrl" | "mediaUrl"> = new Map(
  DELIVERABLE_KINDS.map((kind) => [kind.assetItemKind, kind.assetUrlField] as const),
);

/**
 * 纯函式：把不可信 item payload 正规化为 AssetPackItem。
 * 验 kind/title；content/imageUrl/mediaUrl 按 kind 才收（媒体栏位由交付物注册表推导）；
 * loraVersionId 仅 lora；recipe 收 modelId/size/loraModelVersionIds；source 白名单 type + 必填 id。
 * video/audio 缺 mediaUrl 回 null（媒体 item 无 URL 无意义）；其余不合法回 null。
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
  // reference 沿用既有 imageUrl 收法（资产专属参考图，不因新增媒体种类而动）。
  if (kind === "reference") {
    if (typeof p.imageUrl === "string" && p.imageUrl.trim()) item.imageUrl = p.imageUrl.trim();
  }
  // 交付物媒体（image/video/audio）：收哪个 URL 栏位由注册表推导（assetItemKind → assetUrlField）。
  //   * image → imageUrl，维持既有尺度：缺 URL 仍保留 item（仅 trim 后非空才收）。
  //   * video/audio → mediaUrl，**缺 mediaUrl 回 null**（无产物 URL 的媒体 item 无意义）。
  // 长度上限与 imageUrl 现行做法对齐：只 trim、不另设上限（imageUrl 既有亦无长度常数）。
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
  // 3D 资产（Astra P1-5）：scene_3d 收 bridge 产物栏（artifactPath/bytes/sceneSummary），
  // bpy_script 收脚本模板栏（content=脚本全文 + fingerprint 指纹）。与 recipe/lora 分支同构。
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
 * 纯函式：把不可信 payload 正规化为 AssetPack。
 * 验 id/title；items 逐项 normalizeItem（非法项 drop、超出 MAX_ITEMS_PER_PACK 截断）；
 * tags 阵列化 + 去重 + 截断；标题截 200；digest 截 500；note 截 200；
 * active 只收 boolean（仅 true 写入）。不合法回 null。
 *
 * id 边界（REQ-B2）：走 asset-scope 的 isUsableAssetId —— **拒绝**（非截断）空 /
 * 超长（>MAX_PACK_ID_LENGTH）/ 含保留分隔符 `:` / 含控制字元的 id。
 * 截断会让两个不同 id 落成同一个 id（作用域层确定性键的撞键源），故一律 fail-closed；
 * 也与 share/mount 的长度界对齐，避免「可建不可分享」。
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
  // REQ-B2 作用域：走 ./asset-scope 的清洗收口（非 project/team 一律收敛成 personal 并省略栏位，
  // 不写 `scope:{owner:"personal"}` 冒充已设定）；**鬼状态（project 但无 projectId / team 但无
  // teamId）写回 GHOST_ASSET_SCOPE 而非降格成 personal**——降格＝把归属不明的项目资产变成
  // 人人可用的个人资产（D3）。P0-2：team 作用域同样要落栏（否则团队包在存档端静默丢归属）。
  const scope = normalizeAssetScope(p.scope);
  // P1-A 项目标签：走 ./asset-scope 的 normalizeProjectIds 收口（去重 / 只留非空 string /
  // 截 120 / 上限 20）；**结果为空则省略键**（不写空阵列冒充设定，同 tags/scope 的收口范式）。
  const projectIds = normalizeProjectIds(p.projectIds);
  // REQ-D1 血统栏位复用 ./lineage 的清洗收口（非法条目丢、上限截尾并显式标记）；
  // 与 character-cards.normalizeCharacterCard 同款，宿主不同、白名单同一把尺。
  const lineageRaw = Array.isArray(p.lineage) ? normalizeLineageLinks(p.lineage) : null;
  return {
    id: p.id.trim(),
    title: p.title.trim().slice(0, MAX_TITLE_LENGTH),
    ...(digest ? { digest } : {}),
    items,
    ...(p.active === true ? { active: true } : {}),
    tags,
    ...(note ? { note } : {}),
    ...(projectIds.length ? { projectIds } : {}),
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
  // 上限在 saveAssetPack 拒绝，这里只排序（newest 优先），不静默丢资料。
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
      console.error("[asset-packs] 清理旧索引失败。", error);
    });
  }
}

// ─────────────────────────────────────────── 对外接口

/** 读全部资产包（newest 优先）。 */
export async function listAssetPacks(userId: number): Promise<AssetPack[]> {
  return readPacks(userId);
}

/** 读 active===true 的资产包；无则回 null（单一 active 铁律）。 */
export async function getActiveAssetPack(userId: number): Promise<AssetPack | null> {
  const packs = await readPacks(userId);
  return packs.find((p) => p.active === true) ?? null;
}

/**
 * 储存/覆盖一个资产包（upsert by id）。
 * 不合法抛错（呼叫端应先 normalizeAssetPack 验证）；新增超过上限抛 AssetPackLimitError。
 * 若新包 active===true，则把同用户其它包的 active 清掉（单一 active 铁律）。
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

/** 删除若干资产包（不存在的 id 忽略）。 */
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

/** 仅测试：重置进程内状态。 */
export function __resetAssetPackStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
