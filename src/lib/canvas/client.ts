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

export function authHeaders(): Record<string, string> | null {
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

// ─────────────────────────────────────────── Wave C：agent 操作畫布的上行通道

/** 壓縮畫布快照 → gateway（agent 的 canvas_get_state 讀這份）。失敗靜默：快照是盡力而為。 */
export async function postCanvasSnapshot(sessionId: string, state: unknown): Promise<void> {
  const headers = authHeaders();
  if (!headers) return; // 未登入安靜降級，不送 401 請求。
  headers["Content-Type"] = "application/json";
  try {
    await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/canvas-state`, {
      method: "POST",
      headers,
      body: JSON.stringify({ state }),
      cache: "no-store",
      keepalive: true,
    });
  } catch {
    /* 盡力而為：斷網不打擾創作 */
  }
}

/** canvas.ops 執行結果回報 → gateway resolve 對應的 canvas_apply_ops 工具調用。 */
export async function postCanvasOpsResult(
  sessionId: string,
  requestId: string,
  result: { ok: boolean; error?: string; created_node_ids?: string[] },
): Promise<void> {
  const headers = authHeaders();
  if (!headers) return; // 未登入不可能有 agent 會話在跑，安靜返回。
  headers["Content-Type"] = "application/json";
  try {
    await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/canvas-ops-result`, {
      method: "POST",
      headers,
      body: JSON.stringify({ request_id: requestId, ...result }),
      cache: "no-store",
      keepalive: true,
    });
  } catch {
    /* gateway 端 30s 超時兜底，不重試 */
  }
}
