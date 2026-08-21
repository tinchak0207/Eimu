// agent-lora：AI 助理的 LoRA 搜索引擎（站内实现）。
//
// 迁移自专业模式 LoraLibraryPanel（2026-08-18，PRD §5 / docs/skills/agent-lora.md）。
// 设计约束（PRD §5 铁律）：
//  - 复用 /api/lora-models（PixAI bridge 代理）+ /api/lora-preferences（用户收藏/最近），
//    不新建第二套 LoRA 存储，不给 bridge 路由加 id 参数。
//  - lora_get 通过搜索 /api/lora-models 后按 versionId 过滤实现，不新增 bridge 面。
//  - 单选铁律：装配 generate_image 参数时 loraModelVersionIds 只保留 1 个
//    （服务端 normalizeGenerationConfig 的 slice(0,1) 兜底）。
//  - PixAI-only：模型无 capabilities.lora 时工具返回明确错误，不静默忽略。

export interface AgentLoraModel {
  versionId: string;
  title: string;
  thumb: string;
  tags?: string[];
  author?: string;
  favorite: boolean;
}

export type AgentLoraView = "all" | "favorites" | "recent";
export type AgentLoraSort = "popular" | "newest" | "liked";

export interface AgentLoraSearchParams {
  query?: string;
  view?: AgentLoraView;
  sort?: AgentLoraSort;
  page?: number;
  limit?: number;
}

export interface AgentLoraSearchResult {
  models: AgentLoraModel[];
  total: number;
  page: number;
}

export class AgentLoraError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentLoraError";
    this.code = code;
  }
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** 站内 LoRA catalog 代理 origin（与 /api/lora-models 同源部署）。 */
function siteOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const origin = (env.IMAGE_SITE_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return origin || "https://eimu.dev";
}

interface BridgeLoraEntry {
  versionId?: unknown;
  id?: unknown;
  title?: unknown;
  name?: unknown;
  thumb?: unknown;
  image?: unknown;
  previewUrl?: unknown;
  tags?: unknown;
  author?: unknown;
}

interface LoraCatalogPayload {
  models?: unknown;
  items?: unknown;
  list?: unknown;
  data?: unknown;
}

/** 从 bridge 各类 payload 形状中提取模型数组（宽松兼容，不猜精确结构）。 */
function extractModels(payload: unknown): BridgeLoraEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as LoraCatalogPayload;
  const raw = root.models ?? root.items ?? root.list ?? root.data;
  if (Array.isArray(raw)) return raw.filter((item): item is BridgeLoraEntry => Boolean(item && typeof item === "object"));
  if (Array.isArray(root.data)) return root.data.filter((item): item is BridgeLoraEntry => Boolean(item && typeof item === "object"));
  return [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeModel(entry: BridgeLoraEntry): AgentLoraModel {
  const versionId = firstString(entry.versionId, entry.id);
  const title = firstString(entry.title, entry.name);
  const thumb = firstString(entry.thumb, entry.image, entry.previewUrl);
  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20)
    : undefined;
  const author = firstString(entry.author);
  return {
    versionId,
    title,
    thumb,
    ...(tags ? { tags } : {}),
    ...(author ? { author } : {}),
    favorite: false,
  };
}

/** 请求 /api/lora-models 搜索（与 LoraLibraryPanel 同一条链）。 */
async function fetchCatalog(params: AgentLoraSearchParams): Promise<{ entries: BridgeLoraEntry[]; total: number }> {
  const query = new URLSearchParams({
    sort: params.sort ?? "popular",
    page: String(Math.max(1, params.page ?? 1)),
    pageSize: String(Math.min(MAX_PAGE_SIZE, Math.max(1, params.limit ?? DEFAULT_PAGE_SIZE))),
  });
  if (params.query?.trim()) query.set("keyword", params.query.trim());
  const response = await fetch(`${siteOrigin()}/api/lora-models?${query.toString()}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new AgentLoraError("lora_catalog_unavailable", `LoRA catalog request failed: ${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  const entries = extractModels(payload);
  // 不猜 total 字段：无则用条目数兜底。
  const total =
    payload && typeof payload === "object" && typeof (payload as { total?: unknown }).total === "number"
      ? Number((payload as { total: number }).total)
      : entries.length;
  return { entries, total };
}

/** 请求 /api/lora-preferences 用户收藏/最近（服务端权威）。 */
async function fetchPreferences(userId: number): Promise<{ versionId: string; favorite: boolean; lastUsedAt?: string }[]> {
  const response = await fetch(`${siteOrigin()}/api/lora-preferences`, {
    method: "GET",
    headers: { Authorization: `Bearer ${userId}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as { data?: { items?: { versionId?: unknown; favorite?: unknown; lastUsedAt?: unknown }[] } };
  const items = payload?.data?.items ?? [];
  return items
    .filter((item) => typeof item.versionId === "string")
    .map((item) => ({
      versionId: item.versionId as string,
      favorite: item.favorite === true,
      ...(typeof item.lastUsedAt === "string" ? { lastUsedAt: item.lastUsedAt } : {}),
    }));
}

/**
 * lora_search：搜索 + 收藏/最近过滤与标注。
 * view=all 返回目录结果（合并收藏态）；favorites/recent 以 /api/lora-preferences 为权威。
 */
export async function loraSearch(userId: number, params: AgentLoraSearchParams = {}): Promise<AgentLoraSearchResult> {
  const view = params.view ?? "all";
  const catalog = await fetchCatalog(view === "all" ? params : { sort: "popular", page: 1, limit: MAX_PAGE_SIZE });
  const prefs = await fetchPreferences(userId);
  const prefByVersionId = new Map(prefs.map((pref) => [pref.versionId, pref]));

  let entries = catalog.entries.map(normalizeModel).map((model) => ({
    ...model,
    favorite: prefByVersionId.get(model.versionId)?.favorite ?? false,
  }));

  if (view === "favorites") {
    entries = entries.filter((model) => model.favorite);
  } else if (view === "recent") {
    const recentIds = new Set(
      prefs
        .filter((pref) => pref.lastUsedAt)
        .sort((a, b) => Date.parse(b.lastUsedAt ?? "") - Date.parse(a.lastUsedAt ?? ""))
        .map((pref) => pref.versionId),
    );
    // recent 视图：目录命中 + 最近使用的交集，按最近使用时间排序。
    entries = entries.filter((model) => recentIds.has(model.versionId));
    const recentOrder = [...recentIds];
    entries.sort((a, b) => recentOrder.indexOf(a.versionId) - recentOrder.indexOf(b.versionId));
  }

  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, params.limit ?? DEFAULT_PAGE_SIZE));
  const total = entries.length;
  const paged = entries.slice((page - 1) * limit, page * limit);
  return { models: paged, total, page };
}

/**
 * lora_get：按 versionId 取单模型（搜索后过滤 + 收藏态合并），不新增 bridge 面。
 */
export async function loraGet(userId: number, versionId: string): Promise<AgentLoraModel | null> {
  if (!versionId.trim()) throw new AgentLoraError("invalid_request", "versionId is required");
  const catalog = await fetchCatalog({ query: versionId, sort: "popular", page: 1, limit: MAX_PAGE_SIZE });
  const prefByVersionId = new Map((await fetchPreferences(userId)).map((pref) => [pref.versionId, pref]));
  const match = catalog.entries
    .map(normalizeModel)
    .find((model) => model.versionId === versionId || model.versionId.endsWith(versionId) || versionId.endsWith(model.versionId));
  if (!match) return null;
  return { ...match, favorite: prefByVersionId.get(match.versionId)?.favorite ?? false };
}

export interface AgentLoraFavoriteInput {
  versionId: string;
  title: string;
  thumb: string;
  favorite: boolean;
}

/**
 * lora_favorite：收藏/取消收藏（委托 /api/lora-preferences PATCH）。
 */
export async function loraFavorite(userId: number, input: AgentLoraFavoriteInput): Promise<{ versionId: string; favorite: boolean }> {
  if (!input.versionId?.trim() || !input.title?.trim() || !input.thumb?.trim()) {
    throw new AgentLoraError("invalid_request", "versionId, title and thumb are required");
  }
  const response = await fetch(`${siteOrigin()}/api/lora-preferences`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${userId}`, "Content-Type": "application/json" },
    body: JSON.stringify({ versionId: input.versionId, title: input.title, thumb: input.thumb, favorite: input.favorite }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new AgentLoraError("preference_write_failed", `LoRA preference write failed: ${response.status}`);
  }
  return { versionId: input.versionId, favorite: input.favorite };
}

export interface AgentLoraGenerationParam {
  loraModelVersionIds: string[];
}

/**
 * loraToGenerationParam：单选铁律装配。传入多个 id 时只保留第一个
 * （服务端 normalizeGenerationConfig 的 slice(0,1) 兜底保持一致）。
 */
export function loraToGenerationParam(versionIds: string[] | undefined, supportsLora: boolean): AgentLoraGenerationParam | null {
  const clean = (versionIds ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  if (!supportsLora) return null;
  if (clean.length === 0) return null;
  return { loraModelVersionIds: clean.slice(0, 1) };
}
