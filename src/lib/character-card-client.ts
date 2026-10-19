// 角色/场景卡 API 的前端封装：/api/character-cards 的 list / save / delete。
//
// 认证头复用 canvas/client 的 authHeaders（Bearer token + x-user-id 成对），
// 行为模式对齐 canvas/client：不 throw 认证错，回 { ok:false, reason }——
// 卡是「顺手锁定」的配置，未登入时安静降级，不挡画布创作。
import { authHeaders, type CanvasClientResult } from "@/lib/canvas/client";
import { bumpCharacterCardIndexRevision } from "@/lib/character-card-index";
import type { CharacterCard } from "@/lib/character-cards";

async function request<T>(
  path: string,
  init: RequestInit,
  pick: (json: unknown) => T | undefined,
): Promise<CanvasClientResult<T>> {
  const headers = authHeaders();
  if (!headers) return { ok: false, reason: "not_authenticated" };
  if (init.body) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, cache: "no-store" });
  } catch {
    return { ok: false, reason: "network", message: "网络连接失败" };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: res.ok ? "parse" : "server", message: "服务器回应格式错误" };
  }
  if (!res.ok) {
    const message =
      json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
        ? (json as { error: string }).error
        : "请求失败";
    return { ok: false, reason: res.status === 401 || res.status === 403 ? "not_authenticated" : "server", message };
  }
  const data = pick(json);
  if (data === undefined) return { ok: false, reason: "parse", message: "服务器未返回预期数据" };
  return { ok: true, data };
}

/** 读全部卡（服务端已按 updatedAt 由新到旧排序）。 */
export function listCharacterCards(): Promise<CanvasClientResult<CharacterCard[]>> {
  return request<CharacterCard[]>("/api/character-cards", { method: "GET" }, (json) => {
    const arr = (json as { cards?: unknown })?.cards;
    return Array.isArray(arr) ? (arr as CharacterCard[]) : undefined;
  });
}

/** 存一张卡（upsert by id）。 */
export async function saveCharacterCard(card: CharacterCard): Promise<CanvasClientResult<true>> {
  const res = await request<true>(
    "/api/character-cards",
    { method: "POST", body: JSON.stringify(card) },
    (json) => ((json as { success?: unknown })?.success === true ? true : undefined),
  );
  if (res.ok) bumpCharacterCardIndexRevision();
  return res;
}

/** 删若干卡。 */
export async function deleteCharacterCards(ids: string[]): Promise<CanvasClientResult<number>> {
  const res = await request<number>(
    "/api/character-cards",
    { method: "DELETE", body: JSON.stringify({ ids }) },
    (json) => {
      const n = (json as { deleted?: unknown })?.deleted;
      return typeof n === "number" ? n : 0;
    },
  );
  if (res.ok) bumpCharacterCardIndexRevision();
  return res;
}
