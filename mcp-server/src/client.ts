// Image Studio HTTP client —— 纯函式 + 可注入 fetch，供 MCP server 主体与 smoke 测试共用。

export interface TaskArtifact {
  id?: string;
  url?: string | null;
  b64_json?: string | null;
  content_type?: string | null;
}

export interface TaskResponse {
  object?: string;
  id: string;
  status: string;
  model?: string;
  result_url?: string;
  data?: TaskArtifact[];
  error?: { code: string; message: string };
}

export interface ClientConfig {
  apiBase: string;
  apiKey: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeJsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export type FetchLike = typeof fetch;

export async function requestJson(
  url: string,
  options: RequestInit,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...options,
    headers: { ...(options.headers ?? {}), Authorization: `Bearer ${apiKey}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`上游 ${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`上游回传非 JSON 回应: ${text.slice(0, 300)}`);
  }
}

export function taskOf(payload: unknown): TaskResponse {
  if (!isJsonObject(payload) || typeof payload.id !== "string") {
    throw new Error("回应缺少 task 物件");
  }
  return payload as unknown as TaskResponse;
}

export function artifactOf(artifact: unknown): { url: string | null; b64: string | null; id: string | null } {
  const a = isJsonObject(artifact) ? artifact : {};
  return {
    url: typeof a.url === "string" && a.url ? a.url : null,
    b64: typeof a.b64_json === "string" && a.b64_json ? (a.b64_json as string) : null,
    id: typeof a.id === "string" ? (a.id as string) : null,
  };
}

export function summarizeArtifacts(artifacts: TaskArtifact[] | undefined): unknown {
  return (artifacts ?? []).map((artifact) => {
    const a = artifactOf(artifact);
    return {
      id: a.id,
      url: a.url,
      b64_json_present: a.b64 !== null,
      b64_json_length: a.b64?.length ?? 0,
    };
  });
}

export async function pollTaskUntilDone(
  apiBase: string,
  apiKey: string,
  taskId: string,
  pathPrefix: "images" | "videos",
  pollIntervalMs: number,
  pollTimeoutMs: number,
  fetchImpl: FetchLike = fetch,
): Promise<TaskResponse> {
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const payload = await requestJson(`${apiBase}/${pathPrefix}/${taskId}`, { method: "GET" }, apiKey, fetchImpl);
    const task = taskOf(payload);
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
      return task;
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待 ${pathPrefix}/${taskId} 超过 ${pollTimeoutMs}ms 仍未终结（目前 ${task.status}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export interface GenerationOutcome {
  status: string;
  id: string;
  artifacts: unknown;
  url: string | null;
  error?: { code: string; message: string };
}

/**
 * 送出生成请求并轮询至终结，回传 MCP tool 可序列化的 outcome。
 * 路径为 /images/generations 或 /videos/generations（不含 /api/v1 前缀）。
 */
export async function generateAndWait(
  config: ClientConfig,
  path: "/images/generations" | "/videos/generations",
  body: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<GenerationOutcome> {
  const payload = await requestJson(
    `${config.apiBase}${path}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    config.apiKey,
    fetchImpl,
  );
  const task = taskOf(payload);
  const done = await pollTaskUntilDone(
    config.apiBase,
    config.apiKey,
    task.id,
    path.startsWith("/videos") ? "videos" : "images",
    config.pollIntervalMs,
    config.pollTimeoutMs,
    fetchImpl,
  );
  const first = artifactOf(done.data?.[0]);
  return {
    status: done.status,
    id: done.id,
    artifacts: summarizeArtifacts(done.data),
    url: first.url,
    ...(done.status !== "succeeded" && done.error ? { error: done.error } : {}),
  };
}

/** 直接把 outcome 收敛成 MCP 的 tool 回传。失败时标 isError。 */
export function toolResult(outcome: GenerationOutcome): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  const ok = outcome.status === "succeeded";
  return {
    content: [{ type: "text", text: safeJsonText(outcome) }],
    ...(ok ? {} : { isError: true }),
  };
}