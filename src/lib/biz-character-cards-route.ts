// 角色卡 B 端读写端点的**唯一实现**（两条 route 档只是它的薄壳）：
//   - `/api/v1/character-cards`  → 保留（开发/测试；未来若控制面补齐卡模型仍正确）
//   - `/api/biz/character-cards` → 生产真正会被 Vercel 服务的那条
//
// 为什么需要 `/api/biz/*`：生产的 `next.config.mjs` 有 `beforeFiles` 改写，`/v1/:path*` 与
// `/api/v1/:path*` **整体代理到控制面 origin**（VPS 容器，那棵树没有卡模型档）。`/api/biz/*`
// 不在改写清单里 ⇒ 挂在那里才是 Vercel 全功能应用在服务（有 Blob、有完整五值卡模型）。
// 两个挂载点共用本档，所以契约、清洗、上限常数只有一份，不会分叉。
//
// 与站点侧 `/api/character-cards` **共用同一个卡库**（src/lib/character-card-store.ts 的
// listCharacterCards / saveCharacterCard，Blob、user 维度）与**同一份清洗收口**
// （src/lib/character-cards.ts 的 normalizeCharacterCard）——本档不得长出第二套卡模型、
// 第二套清洗或第二份上限常数。两者只差认证：站点侧走 requireVerifiedUser（浏览器会话），
// 这里只认 `Authorization: Bearer sk-biz-…`（agent 工具不转发 x-user-id）。
//
// 零计费端点：只读写卡，不碰 reserve/refund/quota。
// 错误体沿用 OpenAI 风格（{ error: { message, type, code, param, trace_id } }），形状收在
// src/lib/biz-openai-error.ts，与 /v1/images/generations、/v1/assets 一致。
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { bizErrorResponse, guardBizApiKey } from "@/lib/biz-openai-error";
import { listCharacterCards, saveCharacterCard } from "@/lib/character-card-store";
import { MAX_CARD_REFERENCES, normalizeCharacterCard, toCharacterCardKind } from "@/lib/character-cards";
import type { CharacterCard, CharacterCardKind } from "@/lib/character-cards";

/** 列表默认条数与上限（同一数值：不传就是拿满 50，传超也只给 50）。 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

/** 决定性卡 id 前缀（与站点侧 `card-`/`card-node-` 两个 id 空间并列，一眼可辨来源）。 */
const BIZ_CARD_ID_PREFIX = "biz-";

/**
 * 对外的卡形状：**只给 agent 真正需要的字段**。
 * 刻意不回传 `lineage` / `scope` / `negativePrompt` / `approval` 等内部结构——
 * 一旦发出去就成了公开契约，日后无法再改；agent 要用什么再加什么。
 */
interface WireCharacterCard {
  id: string;
  name: string;
  kind: CharacterCardKind;
  prompt: string;
  reference_urls: string[];
  updated_at: string;
}

function toWireCard(card: CharacterCard): WireCharacterCard {
  return {
    id: card.id,
    name: card.name,
    kind: card.kind,
    prompt: card.prompt,
    reference_urls: card.references.map((ref) => ref.url),
    updated_at: card.updatedAt,
  };
}

/**
 * limit 解析：缺省/空/非数字 → 50；其余夹到 [1, 50]。
 * 夹取而非 400：limit 是分页提示不是数据，越界不值当让 agent 的调用整条失败。
 */
function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

/**
 * 决定性卡 id：`biz-<sha256(userId|kind|name) 前 16 码>`。
 *
 * 同一个 user 重复存「同名同 kind」的卡 → 同一 id → saveCharacterCard 的 upsert 语义
 * （见其实现：按 id 取代既有项）让它成为**更新**而不是新增。
 * 用了规范化后的 name（已 trim），所以 `"霍辞渊"` 与 `" 霍辞渊 "` 落同一张卡。
 */
function deterministicCardId(userId: number, kind: CharacterCardKind, name: string): string {
  const digest = createHash("sha256").update(`${userId}|${kind}|${name}`, "utf8").digest("hex").slice(0, 16);
  return `${BIZ_CARD_ID_PREFIX}${digest}`;
}

/**
 * 参考物 URL 判定：与 character-cards.ts 的 `isCardImageUrl` **同一把尺**
 * （`http` 前缀或 `data:image/`）。这里只做「非法项回 400」的前置校验，
 * 真正落卡的清洗仍在 normalizeCharacterCard。
 *
 * 已知边界（刻意）：`data:audio/` 是音频卡在卡模型里合法的参考物
 * （`isUsableCardReferenceUrl` 是 kind-aware 的），但本 B 端入口按已冻结契约只收
 * http(s)/data:image，音频卡的内嵌参考音频在此会被**明确 400**（不是静默丢）。
 * 要放开需先改契约，别在这里偷偷放宽。
 */
function isAllowedReferenceUrl(url: string): boolean {
  return url.startsWith("http") || url.startsWith("data:image/");
}

/**
 * GET /character-cards — 列出当前密钥绑定用户的卡。
 *
 * 200 `{ object: "list", data: WireCharacterCard[] }`；空卡库回 `data: []`（不是 404）。
 * 可选 query：
 *   - `kind`：精确匹配五值之一；给不认识的值 → 空列表（**不做收敛**，免得把
 *     `kind=乱填` 变成「回一堆 character 卡」这种假命中）。
 *   - `q`：name 子串，不分大小写。
 *   - `limit`：1..50，缺省 50。
 */
export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await guardBizApiKey(req, traceId);
  if (!auth.ok) return auth.response;

  try {
    const params = req.nextUrl.searchParams;
    const kind = (params.get("kind") ?? "").trim();
    const q = (params.get("q") ?? "").trim().toLowerCase();
    const limit = parseLimit(params.get("limit"));

    // listCharacterCards 已按 updatedAt 新→旧排序。
    let cards = await listCharacterCards(auth.key.userId);
    if (kind) cards = cards.filter((card) => card.kind === kind);
    if (q) cards = cards.filter((card) => card.name.toLowerCase().includes(q));

    return withTraceId(
      NextResponse.json(
        { object: "list", data: cards.slice(0, limit).map(toWireCard) },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      ),
      traceId,
    );
  } catch (error) {
    console.error("[biz-character-cards] list failed:", error);
    return bizErrorResponse(500, "读取角色卡失败，请稍后再试。", "api_error", "internal_error", traceId);
  }
}

interface CardRequestBody {
  name?: unknown;
  kind?: unknown;
  prompt?: unknown;
  negative_prompt?: unknown;
  reference_urls?: unknown;
  id?: unknown;
}

/**
 * POST /character-cards — 建/更新一张卡。
 *
 * body（JSON）：`{ name, kind?, prompt?, negative_prompt?, reference_urls?, id? }`
 *   - `name` 必填 1..100（长度由 normalizeCharacterCard 的 boundedString 收口）。
 *   - `kind` 走 `toCharacterCardKind`：未知值收敛成 `character`，**不报错**。
 *   - `reference_urls` 每项需 http(s)/data:image，上限 `MAX_CARD_REFERENCES`（8）；
 *     非法项或超限 → **400**（不静默丢、不静默截尾）。
 *   - `id` 缺省 → 决定性 id `biz-<sha256(userId|kind|name) 前 16 码>` ⇒ 同名同 kind
 *     重复 POST 是**更新**（upsert by id，非 append）。
 *   - 清洗一律走 `normalizeCharacterCard`（唯一收口）。
 *
 * 成功固定回 **201** `{ object: "character_card", data: WireCharacterCard }`
 * （幂等 upsert 也用 201：卡确实被写入/更新了，不拿 200/201 区分「新建 vs 覆盖」，
 * 免得 agent 需要先查再决定用哪个语义）。
 */
export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await guardBizApiKey(req, traceId);
  if (!auth.ok) return auth.response;

  let body: CardRequestBody;
  try {
    body = (await req.json()) as CardRequestBody;
  } catch {
    return bizErrorResponse(400, "请求体不是合法的 JSON。", "invalid_request_error", "invalid_json", traceId);
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return bizErrorResponse(400, "缺少必填参数 name。", "invalid_request_error", "missing_name", traceId);
  }

  // kind 先落定（id 指纹要用它，且未知值收敛不报错）。
  const kind = toCharacterCardKind(body?.kind);

  // reference_urls：逐项校验，非法/超限一律 400——绝不静默丢或截尾
  //（normalizeCharacterCard 对超限是 slice，直接透传会让 agent 以为 8 张都存下了）。
  let referenceUrls: string[] = [];
  if (body?.reference_urls !== undefined) {
    if (!Array.isArray(body.reference_urls)) {
      return bizErrorResponse(400, "reference_urls 必须是字符串数组。", "invalid_request_error", "invalid_reference_urls", traceId);
    }
    if (body.reference_urls.length > MAX_CARD_REFERENCES) {
      return bizErrorResponse(
        400,
        `reference_urls 最多 ${MAX_CARD_REFERENCES} 条，收到 ${body.reference_urls.length} 条。`,
        "invalid_request_error",
        "too_many_reference_urls",
        traceId,
      );
    }
    const urls: string[] = [];
    for (const item of body.reference_urls) {
      const url = typeof item === "string" ? item.trim() : "";
      if (!url || !isAllowedReferenceUrl(url)) {
        return bizErrorResponse(
          400,
          `reference_urls 含非法项：${JSON.stringify(item)}（仅接受 http(s) 或 data:image/）。`,
          "invalid_request_error",
          "invalid_reference_url",
          traceId,
        );
      }
      urls.push(url);
    }
    referenceUrls = urls;
  }

  const providedId = typeof body?.id === "string" ? body.id.trim() : "";
  const id = providedId || deterministicCardId(auth.key.userId, kind, name);

  // 唯一清洗收口：所有字段都经它过一遍（与站点侧 POST 完全同一条路）。
  const normalized = normalizeCharacterCard({
    id,
    name,
    kind,
    ...(typeof body?.prompt === "string" ? { prompt: body.prompt } : {}),
    ...(typeof body?.negative_prompt === "string" ? { negativePrompt: body.negative_prompt } : {}),
    references: referenceUrls.map((url) => ({ url, role: "general", name })),
  });
  if (!normalized) {
    return bizErrorResponse(
      400,
      "卡数据无效（name 需 1..100 个字符，id 不得含保留字符 `:` 或控制字符）。",
      "invalid_request_error",
      "invalid_payload",
      traceId,
    );
  }

  try {
    // saveCharacterCard 语义 = **upsert by id（replace，非 append）**：
    // 同 id 的既有项被新卡取代并移到最前，卡总数不变。
    await saveCharacterCard(auth.key.userId, normalized);
    return withTraceId(
      NextResponse.json({ object: "character_card", data: toWireCard(normalized) }, { status: 201 }),
      traceId,
    );
  } catch (error) {
    console.error("[biz-character-cards] save failed:", error);
    return bizErrorResponse(500, "保存角色卡失败，请稍后再试。", "api_error", "internal_error", traceId);
  }
}
