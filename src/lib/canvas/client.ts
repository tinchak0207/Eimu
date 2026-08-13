// 畫布專案 API 的前端封裝：/api/canvas/projects 的 list / save / delete。
//
// 認證頭跟站內其它端點一致：Bearer token + x-user-id 成對送出
// （route.ts 走 requireVerifiedUser → authenticateImageUser，缺一半就 401）。
// 這裡不 throw 認證錯，回 { ok:false, reason } —— 畫布是「順手存」的東西，
// 沒登入時安靜降級成純本端畫布，而不是在畫布上彈一張擋路的錯誤卡。

import { getStoredToken, getStoredUser } from "@/lib/new-api-client";
import type { CanvasProject } from "./types";

export type CanvasClientFailure = "not_authenticated" | "network" | "server" | "parse";

export interface CanvasClientResult<T> {
  ok: boolean;
  data?: T;
  reason?: CanvasClientFailure;
  message?: string;
}

function authHeaders(): Record<string, string> | null {
  const token = getStoredToken();
  const userId = getStoredUser()?.id;
  if (!token || !userId) return null;
  return { Authorization: `Bearer ${token}`, "x-user-id": String(userId) };
}

async function request<T>(path: string, init: RequestInit, pick: (json: unknown) => T | undefined): Promise<CanvasClientResult<T>> {
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

/** 讀全部畫布專案（服務端已按 updatedAt 由新到舊排序）。 */
export async function listCanvasProjects(): Promise<CanvasClientResult<CanvasProject[]>> {
  return request<CanvasProject[]>("/api/canvas/projects", { method: "GET" }, (json) => {
    const arr = (json as { projects?: unknown })?.projects;
    return Array.isArray(arr) ? (arr as CanvasProject[]) : undefined;
  });
}

/** 存一個畫布專案（upsert by id）。 */
export async function saveCanvasProject(project: CanvasProject): Promise<CanvasClientResult<true>> {
  return request<true>(
    "/api/canvas/projects",
    { method: "PUT", body: JSON.stringify(project) },
    (json) => ((json as { success?: unknown })?.success === true ? true : undefined),
  );
}

/** 刪若干畫布專案。 */
export async function deleteCanvasProjects(ids: string[]): Promise<CanvasClientResult<number>> {
  return request<number>(
    "/api/canvas/projects",
    { method: "DELETE", body: JSON.stringify({ ids }) },
    (json) => {
      const n = (json as { deleted?: unknown })?.deleted;
      return typeof n === "number" ? n : 0;
    },
  );
}

/** 挑最近更新的一個專案。空清單回 null。 */
export function pickLatestProject(projects: CanvasProject[]): CanvasProject | null {
  let latest: CanvasProject | null = null;
  let latestAt = -Infinity;
  for (const p of projects) {
    const at = Date.parse(p.updatedAt);
    const ts = Number.isFinite(at) ? at : 0;
    if (ts >= latestAt) {
      latestAt = ts;
      latest = p;
    }
  }
  return latest;
}

/** 觸發一次瀏覽器下載（匯出用）。 */
export function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}
