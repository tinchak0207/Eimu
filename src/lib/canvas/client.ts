// 画布专案 API 的前端封装：/api/canvas/projects 的 list / save / delete。
//
// 认证头跟站内其它端点一致：Bearer token + x-user-id 成对送出
// （route.ts 走 requireVerifiedUser → authenticateImageUser，缺一半就 401）。
// 这里不 throw 认证错，回 { ok:false, reason } —— 画布是「顺手存」的东西，
// 没登入时安静降级成纯本端画布，而不是在画布上弹一张挡路的错误卡。

import { getStoredToken, getStoredUser } from "@/lib/new-api-client";
import { LOCAL_TEST_MODE } from "../local-test-mode";
import type { CanvasProject } from "./types";
import { parseCanvasProjectSummaries, toCanvasProjectSummaryWire, type CanvasProjectSummaryWire } from "./project-summary";

export type CanvasClientFailure =
  | "not_authenticated"
  /** 团队闸拒建共享画布（服务端 code=member_canvas_forbidden）：保留服务端团队文案，不降级成未登入。 */
  | "team_canvas_forbidden"
  /**
   * 服务器**明确**说这张专案不存在（P2-E）。
   * 只有 `HTTP 404` 与专属 `code=not_found` 同时成立时才回这个值——「确认不存在」与
   * 「本次瞬断／5xx／鉴权失败」必须可分辨：前者可安全采用空态，后者一律按兵不动
   * （误把已落盘的画布当空画布，会在下一次存档时把线上内容覆盖掉）。
   */
  | "not_found"
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
  // LOCAL_TEST_MODE：与 agent-chat-client 同款假头——站内代理的
  // resolveAgentCaller 在该模式下直接换 B 端 key，不验证这组头。
  // 缺这支 canvas 快照上行在本地测试会永远静默哑火。
  if (process.env.NODE_ENV !== "production" && LOCAL_TEST_MODE) {
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
    // 团队闸拒建共享画布（片P 刀 3）：**只认这个专属 code**，露出服务端团队文案，
    // 不再被当成 not_authenticated 静默降级成 offline。其他 401/403（无此 code）
    // 维持原降级行为，逐字不变——不扩散。
    const code =
      json && typeof json === "object" && typeof (json as { code?: unknown }).code === "string"
        ? (json as { code: string }).code
        : null;
    if (code === "member_canvas_forbidden") {
      return { ok: false, reason: "team_canvas_forbidden", message };
    }
    // P2-E：服务器**明确**说这张专案不存在——`HTTP 404` 与专属 `code=not_found` 两
    // 者同时成立才认。单看 404 会把「路由/页面本身缺失」的 Next 404（JSON 解析失败
    // 走上面 parse/server 分支）误判成「画布不存在」；单看 code 又可能被中间层伪造。
    if (res.status === 404 && code === "not_found") {
      return { ok: false, reason: "not_found", message };
    }
    return { ok: false, reason: res.status === 401 || res.status === 403 ? "not_authenticated" : "server", message };
  }
  const data = pick(json);
  if (data === undefined) return { ok: false, reason: "parse", message: "服务器未返回预期数据" };
  return { ok: true, data };
}

/** 读全部画布专案（服务端已按 updatedAt 由新到旧排序）。 */
export async function listCanvasProjects(): Promise<CanvasClientResult<CanvasProject[]>> {
  return request<CanvasProject[]>("/api/canvas/projects", { method: "GET" }, (json) => {
    const arr = (json as { projects?: unknown })?.projects;
    return Array.isArray(arr) ? (arr as CanvasProject[]) : undefined;
  });
}

/**
 * 历史清单摘要（效能审计 P0-B）：只拿标题/时间/节点数，不再整包下载全部专案。
 * 旧服务端不认 `view=summary` 会回全量 `projects` → 这里就地摘要（部署先后顺序无关）。
 */
export async function listCanvasProjectSummaries(): Promise<CanvasClientResult<CanvasProjectSummaryWire[]>> {
  return request<CanvasProjectSummaryWire[]>("/api/canvas/projects?view=summary", { method: "GET" }, (json) => {
    const summaries = parseCanvasProjectSummaries((json as { summaries?: unknown })?.summaries);
    if (summaries) return summaries;
    const arr = (json as { projects?: unknown })?.projects;
    return Array.isArray(arr) ? (arr as CanvasProject[]).map(toCanvasProjectSummaryWire) : undefined;
  });
}

/** 读单一画布专案（打开历史画布用）。旧服务端回全量时就地挑出同 id 那张。 */
export async function fetchCanvasProject(id: string): Promise<CanvasClientResult<CanvasProject>> {
  return request<CanvasProject>(`/api/canvas/projects?id=${encodeURIComponent(id)}`, { method: "GET" }, (json) => {
    const project = (json as { project?: unknown })?.project;
    if (project && typeof project === "object" && (project as CanvasProject).id === id) return project as CanvasProject;
    const arr = (json as { projects?: unknown })?.projects;
    return Array.isArray(arr) ? (arr as CanvasProject[]).find((p) => p?.id === id) : undefined;
  });
}

/** 存一个画布专案（upsert by id）。 */
export async function saveCanvasProject(project: CanvasProject): Promise<CanvasClientResult<true>> {
  return request<true>(
    "/api/canvas/projects",
    { method: "PUT", body: JSON.stringify(project) },
    (json) => ((json as { success?: unknown })?.success === true ? true : undefined),
  );
}

/** 删若干画布专案。 */
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

/** 挑最近更新的一个专案。空清单回 null。 */
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

/** 触发一次浏览器下载（汇出用）。 */
export function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

// ─────────────────────────────────────────── Wave C：agent 操作画布的上行通道

/**
 * canvas-state 404 静默降级（罪状 2c）：会话已被网关回收后，画布每动一下
 * 快照上行/下行仍会打向同一个端点，产生一串 404（console 噪音）。
 * 这里用进程内 Set 记住「已确认死亡」的会话：一旦某次快照请求吃到 404，
 * 该会话的后续快照请求直接跳过——清空本地态语义、停轮询，不弹任何提示。
 * （进程内 Set：刷新归零，与快照「尽力而为」同生命周期。）
 */
const deadSnapshotSessions = new Set<string>();

/** 压缩画布快照 → gateway（agent 的 canvas_get_state 读这份）。失败静默：快照是尽力而为。 */
export async function postCanvasSnapshot(sessionId: string, state: unknown): Promise<void> {
  if (deadSnapshotSessions.has(sessionId)) return; // 会话已死：不再上行，不产生 404 噪音。
  const headers = authHeaders();
  if (!headers) return; // 未登入安静降级，不送 401 请求。
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
    /* 尽力而为：断网不打扰创作 */
  }
}

/** 会话画布快照下行（resume 回填，2026-08-26）：GET 同一上行端点的闸道存档。
 *  无快照（新会话/从未上行）或任何失败回 null —— 与上行同哲学：尽力而为，不挡路。
 *  注意与上行刻意不同：不因「本端无 token」提前放弃 —— 权限判定是站内路由的职责
 *  （resolveAgentCaller），本端拦截会让 LOCAL_TEST 与 token 恢复中的窗口永远拿不到回填。 */
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
    // 闸道把 POST 的 {state} 原样存取：下行可能是 {state:{nodes…}} 或扁平 {nodes…}。
    const body = json as Record<string, unknown>;
    const state =
      body.state && typeof body.state === "object" ? (body.state as Record<string, unknown>) : body;
    if (!Array.isArray(state.nodes) || state.nodes.length === 0) return null;
    return state;
  } catch {
    return null;
  }
}

/** canvas.ops 执行结果回报 → gateway resolve 对应的 canvas_apply_ops 工具调用。 */
export async function postCanvasOpsResult(
  sessionId: string,
  requestId: string,
  result: { ok: boolean; error?: string; created_node_ids?: string[] },
): Promise<void> {
  const headers = authHeaders();
  if (!headers) return; // 未登入不可能有 agent 会话在跑，安静返回。
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
    /* gateway 端 30s 超时兜底，不重试 */
  }
}

/** 一稿多版位裁切结果（/api/canvas/format-crops execute:true 的 done 项）。 */
export interface FormatCropOutput {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * 一稿多版位：对一张图跑 format-crops（execute:true），只回伺服器真正裁出的版位。
 * 扩图版位（outpaint）无上游、伺服器回 skipped，这里照实略过，不假装出了图。
 */
export async function fetchFormatCrops(sourceImageUrl: string): Promise<CanvasClientResult<FormatCropOutput[]>> {
  const headers = authHeaders();
  if (!headers) return { ok: false, reason: "not_authenticated" };
  headers["Content-Type"] = "application/json";
  try {
    const res = await fetch("/api/canvas/format-crops", {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ sourceImageUrl, execute: true }),
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      executed?: Array<{ id: string; status: string; dataUrl?: string; width?: number; height?: number }>;
    } | null;
    if (!res.ok || !json?.ok) {
      return { ok: false, reason: "server", message: json?.error ?? `裁切失败（HTTP ${res.status}）` };
    }
    const done = (json.executed ?? []).filter(
      (item): item is { id: string; status: string; dataUrl: string; width: number; height: number } =>
        item.status === "done" && typeof item.dataUrl === "string" && typeof item.width === "number" && typeof item.height === "number",
    );
    return { ok: true, data: done.map(({ id, dataUrl, width, height }) => ({ id, dataUrl, width, height })) };
  } catch {
    return { ok: false, reason: "network", message: "网络连接失败" };
  }
}
