// P0-W3：项目/聊天客户端状态的 API 封装（/api/projects 与 /api/projects/chats）。
//
// 认证头复用 canvas/client 的 authHeaders，行为模式对齐 project-assets-client：
// 不 throw 认证错，回 { ok:false, reason }——未登入时侧栏/聊天面安静降级，
// 而不是在画面上弹一张挡路的错误卡。
import { authHeaders, type CanvasClientResult } from "@/lib/canvas/client";
import type { CreativeProject, ProjectTitleSource } from "./types";

/**
 * 与 project-assets-client / canvas/client 同一支写法（逐行复制）：
 * authHeaders() 取头；失败回 { ok:false, reason } 不 throw；cache:"no-store"；
 * JSON 解析失败按 res.ok 分 parse / server；401/403 → not_authenticated。
 */
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

/** 从 `{ success:true, project }` 里挑出 project。 */
function pickProject(json: unknown): CreativeProject | undefined {
  const project = (json as { project?: unknown })?.project;
  return project && typeof project === "object" ? (project as CreativeProject) : undefined;
}

/** 读全部项目。 */
export async function listProjects(): Promise<CanvasClientResult<CreativeProject[]>> {
  return request<CreativeProject[]>("/api/projects", { method: "GET" }, (json) => {
    const arr = (json as { projects?: unknown })?.projects;
    return Array.isArray(arr) ? (arr as CreativeProject[]) : undefined;
  });
}

/** 新建项目（title 省略时由服务端给默认名）。 */
export async function createProject(title?: string): Promise<CanvasClientResult<CreativeProject>> {
  const body = title === undefined ? {} : { title };
  return request<CreativeProject>("/api/projects", { method: "POST", body: JSON.stringify(body) }, pickProject);
}

/** 改项目（标题 / 归档）。 */
export async function patchProject(
  id: string,
  patch: { title?: string; archived?: boolean },
): Promise<CanvasClientResult<CreativeProject>> {
  return request<CreativeProject>("/api/projects", { method: "PATCH", body: JSON.stringify({ id, ...patch }) }, pickProject);
}

/**
 * upsert 一条会话到项目（同 projectId+sessionId 合并）。
 * **canvasIds 没给就不带这个键**：后端口径「没给就保留既有」，这里也不先清空。
 */
export async function upsertChat(
  projectId: string,
  chat: {
    sessionId: string;
    title?: string;
    titleSource?: ProjectTitleSource;
    canvasIds?: string[];
    primaryCanvasId?: string;
    archived?: boolean;
  },
): Promise<CanvasClientResult<CreativeProject>> {
  const wire: Record<string, unknown> = { sessionId: chat.sessionId };
  if (chat.title !== undefined) wire.title = chat.title;
  if (chat.titleSource !== undefined) wire.titleSource = chat.titleSource;
  if (chat.canvasIds !== undefined) wire.canvasIds = chat.canvasIds;
  if (chat.primaryCanvasId !== undefined) wire.primaryCanvasId = chat.primaryCanvasId;
  if (chat.archived !== undefined) wire.archived = chat.archived;
  return request<CreativeProject>(
    "/api/projects/chats",
    { method: "PUT", body: JSON.stringify({ projectId, chat: wire }) },
    pickProject,
  );
}

/** 从项目移除一条会话。 */
export async function removeChat(projectId: string, sessionId: string): Promise<CanvasClientResult<CreativeProject>> {
  return request<CreativeProject>(
    "/api/projects/chats",
    { method: "DELETE", body: JSON.stringify({ projectId, sessionId }) },
    pickProject,
  );
}

/** 删除若干项目，返回实际删除数。 */
export async function deleteProjects(ids: string[]): Promise<CanvasClientResult<number>> {
  return request<number>("/api/projects", { method: "DELETE", body: JSON.stringify({ ids }) }, (json) => {
    const deleted = (json as { deleted?: unknown })?.deleted;
    return typeof deleted === "number" ? deleted : undefined;
  });
}
