// 畫布專案 API 的前端封裝：/api/canvas/projects 的 list / save / delete。
//
// 認證頭跟站內其它端點一致：Bearer token + x-user-id 成對送出
// （route.ts 走 requireVerifiedUser → authenticateImageUser，缺一半就 401）。
// 這裡不 throw 認證錯，回 { ok:false, reason } —— 畫布是「順手存」的東西，
// 沒登入時安靜降級成純本端畫布，而不是在畫布上彈一張擋路的錯誤卡。

import { getStoredToken, getStoredUser } from "@/lib/new-api-client";
import { LOCAL_TEST_MODE } from "../local-test-mode";
import type { CanvasProject } from "./types";

export type CanvasClientFailure =
  | "not_authenticated"
  /** 團隊閘拒建共享畫布（服務端 code=member_canvas_forbidden）：保留服務端團隊文案，不降級成未登入。 */
  | "team_canvas_forbidden"
  | "network"
  | "server"
  | "parse";

export interface CanvasClientResult<T> {
  ok: boolean;
  data?: T;
  reason?: CanvasClientFailure;
  message?: string;
}

export function authHeaders(): Record<string, string> | null {
  // LOCAL_TEST_MODE：與 agent-chat-client 同款假頭——站內代理的
  // resolveAgentCaller 在該模式下直接換 B 端 key，不驗證這組頭。
  // 缺這支 canvas 快照上行在本地測試會永遠靜默啞火。
  if (LOCAL_TEST_MODE) {
    return { Authorization: "Bearer local-test-token", "x-user-id": "0" };
  }
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
    // 團隊閘拒建共享畫布（片P 刀 3）：**只認這個專屬 code**，露出服務端團隊文案，
    // 不再被當成 not_authenticated 靜默降級成 offline。其他 401/403（無此 code）
    // 維持原降級行為，逐字不變——不擴散。
    const code =
      json && typeof json === "object" && typeof (json as { code?: unknown }).code === "string"
        ? (json as { code: string }).code
        : null;
    if (code === "member_canvas_forbidden") {
      return { ok: false, reason: "team_canvas_forbidden", message };
    }
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

/**
 * canvas-state 404 静默降级（罪状 2c）：会话已被网关回收后，画布每动一下
 * 快照上行/下行仍会打向同一个端点，产生一串 404（console 噪音）。
 * 这里用进程内 Set 记住「已确认死亡」的会话：一旦某次快照请求吃到 404，
 * 该会话的后续快照请求直接跳过——清空本地态语义、停轮询，不弹任何提示。
 * （进程内 Set：刷新归零，与快照「尽力而为」同生命周期。）
 */
const deadSnapshotSessions = new Set<string>();

/** 壓縮畫布快照 → gateway（agent 的 canvas_get_state 讀這份）。失敗靜默：快照是盡力而為。 */
export async function postCanvasSnapshot(sessionId: string, state: unknown): Promise<void> {
  if (deadSnapshotSessions.has(sessionId)) return; // 会话已死：不再上行，不产生 404 噪音。
  const headers = authHeaders();
  if (!headers) return; // 未登入安靜降級，不送 401 請求。
  headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/canvas-state`, {
      method: "POST",
      headers,
      body: JSON.stringify({ state }),
      cache: "no-store",
      keepalive: true,
    });
    // 会话已被网关回收：静默降级，之后不再打这个端点。
    if (res.status === 404) deadSnapshotSessions.add(sessionId);
  } catch {
    /* 盡力而為：斷網不打擾創作 */
  }
}

/** 會話畫布快照下行（resume 回填，2026-08-26）：GET 同一上行端點的閘道存檔。
 *  無快照（新會話/從未上行）或任何失敗回 null —— 與上行同哲學：盡力而為，不擋路。
 *  注意與上行刻意不同：不因「本端無 token」提前放棄 —— 權限判定是站內路由的職責
 *  （resolveAgentCaller），本端攔截會讓 LOCAL_TEST 與 token 恢復中的窗口永遠拿不到回填。 */
export async function fetchAgentCanvasSnapshot(sessionId: string): Promise<Record<string, unknown> | null> {
  if (deadSnapshotSessions.has(sessionId)) return null; // 会话已死：静默降级，不重复 404。
  const headers = authHeaders();
  try {
    const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/canvas-state`, {
      method: "GET",
      headers: { ...headers, Accept: "application/json" },
      cache: "no-store",
    });
    // 会话已被回收：记入死亡名单（上行也会跳过），本地快照态当空处理。
    if (res.status === 404) deadSnapshotSessions.add(sessionId);
    if (!res.ok) return null;
    const json: unknown = await res.json();
    if (!json || typeof json !== "object") return null;
    // 閘道把 POST 的 {state} 原樣存取：下行可能是 {state:{nodes…}} 或扁平 {nodes…}。
    const body = json as Record<string, unknown>;
    const state =
      body.state && typeof body.state === "object" ? (body.state as Record<string, unknown>) : body;
    if (!Array.isArray(state.nodes) || state.nodes.length === 0) return null;
    return state;
  } catch {
    return null;
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
