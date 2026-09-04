// agent-assets：AI 助理的「资产包」站内查询与激活（站内实现）。
//
// 结构/风格逐行照抄 agent-lora.ts（站内函数 + 读站内 API + Bearer userId + 明确错误码 + 宽松 payload 解析）。
// 设计约束：
//  - 复用 /api/assets（资产包 list 接口）+ asset-pack-store（getActiveAssetPack），
//    不新建第二套资产存储，不给 assets 路由加参数。
//  - assetGet 通过请求 /api/assets 后按 id 容错匹配实现（同 loraGet 容忍度），不新增 API 面。
//  - 单选铁律：lora items 汇编 loraModelVersionIds 时套 loraToGenerationParam
//    （服务端 normalizeGenerationConfig 的 slice(0,1) 兜底保持一致）。
//  - 注入缺省：active pack 拿不到不阻塞会话建立/resume（缺省不阻塞）。

import { loraToGenerationParam } from "./agent-lora";
import { MAX_DIGEST_LENGTH } from "./asset-pack-store";
import type { AssetPack, AssetPackItem } from "./asset-pack-store";

export interface AgentAssetSummary {
  id: string;
  title: string;
  digest?: string;
  tags: string[];
  itemCount: number;
}

export class AgentAssetError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentAssetError";
    this.code = code;
  }
}

/** 站内资产包 API origin（与 /api/assets 同源部署）。 */
function siteOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const origin = (env.IMAGE_SITE_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return origin || "https://eimu.dev";
}

export interface AgentAssetSearchParams {
  query?: string;
  limit?: number;
}

/** 注入用：active pack 一次最多带进上下文的 item 数（同 AGENT_LESSONS_INJECT_LIMIT 精神）。 */
export const ACTIVE_ASSET_ITEMS_LIMIT = 5;

interface AssetListPayload {
  success?: unknown;
  packs?: unknown;
}

/** 从 /api/assets 各类 payload 形状中提取 packs（宽松兼容，不猜精确结构）。 */
function extractPacks(payload: unknown): AssetPack[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as AssetListPayload;
  if (!Array.isArray(root.packs)) return [];
  return root.packs.filter((pack): pack is AssetPack => Boolean(pack && typeof pack === "object"));
}

/** 请求 /api/assets 搜索（与资产管理页面同一条链）。 */
async function fetchPacks(userId: number, query?: string): Promise<AssetPack[]> {
  const url = new URL(`${siteOrigin()}/api/assets`);
  if (query?.trim()) url.searchParams.set("q", query.trim());
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${userId}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new AgentAssetError("asset_catalog_unavailable", `Asset catalog request failed: ${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  return extractPacks(payload);
}

function toSummary(pack: AssetPack): AgentAssetSummary {
  return {
    id: pack.id,
    title: pack.title,
    ...(typeof pack.digest === "string" && pack.digest.trim() ? { digest: pack.digest } : {}),
    tags: Array.isArray(pack.tags) ? pack.tags.filter((tag): tag is string => typeof tag === "string") : [],
    itemCount: Array.isArray(pack.items) ? pack.items.length : 0,
  };
}

/**
 * asset_search：搜索资产包（委托 /api/assets?q=，服务端按 title/tags/digest 过滤）。
 */
export async function assetSearch(userId: number, params: AgentAssetSearchParams = {}): Promise<AgentAssetSummary[]> {
  const packs = await fetchPacks(userId, params.query);
  const limit = Math.max(1, params.limit ?? packs.length);
  return packs.slice(0, limit).map(toSummary);
}

/**
 * asset_get：按 id 取单资产包（请求 /api/assets 后容错匹配，同 loraGet 容忍度）。
 */
export async function assetGet(userId: number, packId: string): Promise<AssetPack | null> {
  if (!packId.trim()) throw new AgentAssetError("invalid_request", "packId is required");
  const packs = await fetchPacks(userId);
  return (
    packs.find((pack) => pack.id === packId || pack.id.endsWith(packId) || packId.endsWith(pack.id)) ?? null
  );
}

export interface AgentAssetActivation {
  packId: string;
  title: string;
  digest?: string;
  /** 第一个含 content 的 prompt/recipe item 的 content。 */
  prompt?: string;
  /** lora items → loraToGenerationParam 单选铁律（多 lora 只取第一个）。 */
  loraModelVersionIds?: string[];
  /** reference/image items 的 imageUrl（去重）。 */
  referenceImageUrls?: string[];
  items: AssetPackItem[];
}

/**
 * 纯函数：从资产包解析激活参数（不碰网络，直接可由测试呼叫）。
 *  - prompt：第一个含 content 的 prompt/recipe item；
 *  - loraModelVersionIds：lora items → loraToGenerationParam 单选铁律；
 *  - referenceImageUrls：reference/image items 的 imageUrl，去重。
 *  - 无对应 item 时相关可选字段省略。
 */
export function resolveActivationFromPack(pack: AssetPack): AgentAssetActivation {
  const promptItem = pack.items.find(
    (item) =>
      (item.kind === "prompt" || item.kind === "recipe") &&
      typeof item.content === "string" &&
      item.content.trim(),
  );
  const loraVersionIds = pack.items
    .filter(
      (item) =>
        item.kind === "lora" && typeof item.loraVersionId === "string" && item.loraVersionId.trim(),
    )
    .map((item) => item.loraVersionId as string);
  const param = loraToGenerationParam(loraVersionIds, true);
  const seen = new Set<string>();
  const referenceImageUrls: string[] = [];
  for (const item of pack.items) {
    if (
      (item.kind === "reference" || item.kind === "image") &&
      typeof item.imageUrl === "string" &&
      item.imageUrl.trim()
    ) {
      const url = item.imageUrl.trim();
      if (!seen.has(url)) {
        seen.add(url);
        referenceImageUrls.push(url);
      }
    }
  }
  return {
    packId: pack.id,
    title: pack.title,
    ...(typeof pack.digest === "string" && pack.digest.trim() ? { digest: pack.digest } : {}),
    ...(promptItem && typeof promptItem.content === "string" ? { prompt: promptItem.content } : {}),
    ...(param ? { loraModelVersionIds: param.loraModelVersionIds } : {}),
    ...(referenceImageUrls.length ? { referenceImageUrls } : {}),
    items: pack.items,
  };
}

/**
 * 纯函数：把 active pack 组建成注入 payload。
 *  - null/undefined → null；空包（无 items）也回 null（不占上下文）；
 *  - items 至多 ACTIVE_ASSET_ITEMS_LIMIT 个（防撑爆上下文）；
 *  - digest 截 MAX_DIGEST_LENGTH。
 */
export function buildAssetPackInjection(
  activePack: AssetPack | null,
): { active_assets: { pack_id: string; title: string; digest?: string; items: AssetPackItem[] } } | null {
  if (!activePack) return null;
  if (!Array.isArray(activePack.items) || activePack.items.length === 0) return null;
  return {
    active_assets: {
      pack_id: activePack.id,
      title: activePack.title,
      ...(typeof activePack.digest === "string" && activePack.digest.trim()
        ? { digest: activePack.digest.trim().slice(0, MAX_DIGEST_LENGTH) }
        : {}),
      items: activePack.items.slice(0, ACTIVE_ASSET_ITEMS_LIMIT),
    },
  };
}

/**
 * asset_activate：取 active 指向的资产包并解析为激活参数。
 * 找不到（含 id 容错匹配失败）抛 AgentAssetError("asset_pack_not_found", ...)。
 */
export async function assetActivate(userId: number, packId: string): Promise<AgentAssetActivation> {
  const pack = await assetGet(userId, packId);
  if (!pack) {
    throw new AgentAssetError("asset_pack_not_found", `Asset pack not found: ${packId}`);
  }
  return resolveActivationFromPack(pack);
}
