export interface AccountImportInput {
  contents?: unknown;
  name?: unknown;
  concurrency?: unknown;
  priority?: unknown;
  updateExisting?: unknown;
}

export interface Sub2APIAccount {
  id: number;
  name: string;
  status: string;
  schedulable: boolean;
  priority: number;
  concurrency: number;
  lastUsedAt: string | null;
  errorMessage: string;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  authMode: string;
  groupIds: number[];
  temporaryUnschedulableUntil: string | null;
  recentResult: "succeeded" | "failed" | "unverified" | "not-schedulable";
  recentResultAt: string | null;
  recentFailureStatus: number | null;
}

export interface RecentAccountFailure {
  accountId: number;
  occurredAt: string;
  statusCode: number | null;
}

export interface AccountImportRequest {
  path: string;
  payload: Record<string, unknown>;
  format: "codex-session" | "sub2api-data";
}

const MAX_IMPORT_BYTES = 2_000_000;
const MAX_IMPORT_FILES = 50;

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}必须为 ${min}-${max} 的整数。`);
  return number;
}

export function buildCodexImportPayload(input: AccountImportInput, env: EnvLike = process.env) {
  const contents = Array.isArray(input.contents)
    ? input.contents.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  if (!contents.length) throw new Error("请至少上传一个 JSON 文件。");
  if (contents.length > MAX_IMPORT_FILES) throw new Error(`一次最多上传 ${MAX_IMPORT_FILES} 个 JSON 文件。`);
  if (contents.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) > MAX_IMPORT_BYTES) {
    throw new Error("单次导入内容不能超过 2 MB。");
  }
  for (const content of contents) {
    try {
      JSON.parse(content);
    } catch {
      throw new Error("上传内容必须是有效的 JSON。");
    }
  }

  const name = typeof input.name === "string" ? input.name.trim().slice(0, 100) : "";
  return {
    contents,
    name,
    group_ids: sub2APIImageGroupId(env) ? [sub2APIImageGroupId(env)!] : [],
    proxy_id: null,
    concurrency: boundedInteger(input.concurrency, 3, 0, 100, "并发数"),
    priority: boundedInteger(input.priority, 50, 0, 100, "优先级"),
    rate_multiplier: 1,
    load_factor: 0,
    expires_at: null,
    auto_pause_on_expired: true,
    update_existing: input.updateExisting !== false,
  };
}

function isSub2APIData(value: unknown): value is Record<string, unknown> & { accounts: unknown[]; proxies: unknown[] } {
  const data = record(value);
  return (data.type === "sub2api-data" || data.type === "sub2api-bundle")
    && Array.isArray(data.accounts)
    && Array.isArray(data.proxies);
}

export function buildAccountImportRequest(input: AccountImportInput): AccountImportRequest {
  const contents = Array.isArray(input.contents)
    ? input.contents.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  const parsed = contents.map((content) => {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new Error("JSON file is invalid.");
    }
  });
  const dataBundles = parsed.filter(isSub2APIData);

  if (dataBundles.length > 0) {
    if (dataBundles.length !== parsed.length) throw new Error("Sub2API data files and Codex session files cannot be mixed.");
    const data = dataBundles.length === 1 ? dataBundles[0] : {
      type: "sub2api-bundle",
      version: dataBundles.find((item) => typeof item.version === "number")?.version,
      exported_at: new Date().toISOString(),
      proxies: dataBundles.flatMap((item) => item.proxies),
      accounts: dataBundles.flatMap((item) => item.accounts),
    };
    return {
      path: "/api/v1/admin/accounts/data",
      payload: { data, skip_default_group_bind: false },
      format: "sub2api-data",
    };
  }

  return {
    path: "/api/v1/admin/accounts/import/codex-session",
    payload: buildCodexImportPayload(input),
    format: "codex-session",
  };
}

export function normalizeAccountImportResult(body: unknown, format: AccountImportRequest["format"]) {
  const data = record(record(body).data);
  if (format === "codex-session") return data;
  const created = Number(data.account_created) || 0;
  const failed = Number(data.account_failed) || 0;
  return { total: created + failed, created, updated: 0, skipped: 0, failed };
}

export function sanitizeSub2APIError(body: unknown, status: number): string {
  if (record(body).code === "ADMIN_COMPLIANCE_ACK_REQUIRED") return "Sub2API 管理员需先完成合规确认。";
  if (status === 401 || status === 403) return "Sub2API 管理认证失败。";
  if (status === 413) return "导入文件过大。";
  if (status >= 500) return "Sub2API 暂时不可用。";
  return "Sub2API 拒绝了导入内容，请检查 JSON 格式和账号状态。";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function mapSub2APIAccounts(body: unknown): { total: number; items: Sub2APIAccount[] } {
  const data = record(record(body).data);
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items = rawItems.map((value) => {
    const item = record(value);
    const credentialsStatus = record(item.credentials_status);
    const temporaryUnschedulableUntil = typeof item.temp_unschedulable_until === "string"
      ? item.temp_unschedulable_until
      : null;
    const temporarilyUnschedulable = temporaryUnschedulableUntil !== null
      && Number.isFinite(Date.parse(temporaryUnschedulableUntil))
      && Date.parse(temporaryUnschedulableUntil) > Date.now();
    const temporaryReason = typeof item.temp_unschedulable_reason === "string"
      ? item.temp_unschedulable_reason.slice(0, 240)
      : "";
    return {
      id: Number(item.id),
      name: typeof item.name === "string" ? item.name : `账号 ${item.id ?? ""}`.trim(),
      status: typeof item.status === "string" ? item.status : "unknown",
      schedulable: item.schedulable === true && !temporarilyUnschedulable,
      priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 50,
      concurrency: Number.isFinite(Number(item.concurrency)) ? Number(item.concurrency) : 0,
      lastUsedAt: typeof item.last_used_at === "string" ? item.last_used_at : null,
      errorMessage: typeof item.error_message === "string" && item.error_message
        ? item.error_message.slice(0, 240)
        : temporarilyUnschedulable ? temporaryReason : "",
      hasAccessToken: credentialsStatus.has_access_token === true,
      hasRefreshToken: credentialsStatus.has_refresh_token === true,
      authMode: typeof record(item.credentials).auth_mode === "string"
        ? String(record(item.credentials).auth_mode)
        : "",
      groupIds: Array.isArray(item.group_ids)
        ? item.group_ids.map(Number).filter((groupId) => Number.isInteger(groupId) && groupId > 0)
        : [],
      temporaryUnschedulableUntil,
      recentResult: item.status === "active" && item.schedulable === true && !temporarilyUnschedulable
        ? (typeof item.last_used_at === "string" ? "succeeded" : "unverified")
        : "not-schedulable",
      recentResultAt: typeof item.last_used_at === "string" ? item.last_used_at : null,
      recentFailureStatus: null,
    } satisfies Sub2APIAccount;
  }).filter((item) => Number.isFinite(item.id))
    .sort((a, b) => a.priority - b.priority || a.id - b.id);
  return { total: Number.isFinite(Number(data.total)) ? Number(data.total) : items.length, items };
}

function newestErrorItem(body: unknown): Record<string, unknown> | null {
  const root = record(body);
  const data = record(root.data);
  const candidates = [data.items, data.errors, root.items, root.errors, data.data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate[0] && typeof candidate[0] === "object") return candidate[0] as Record<string, unknown>;
  }
  return null;
}

export function recentAccountFailureFromOps(body: unknown, accountId: number): RecentAccountFailure | null {
  const item = newestErrorItem(body);
  if (!item || Number(item.account_id) !== accountId || typeof item.created_at !== "string") return null;
  const statusCode = Number(item.status_code);
  return {
    accountId,
    occurredAt: item.created_at,
    statusCode: Number.isInteger(statusCode) && statusCode > 0 ? statusCode : null,
  };
}

export function applyRecentAccountFailures(accounts: Sub2APIAccount[], failures: RecentAccountFailure[]): Sub2APIAccount[] {
  const failureByAccount = new Map(failures.map((failure) => [failure.accountId, failure]));
  return accounts.map((account) => {
    const failure = failureByAccount.get(account.id);
    if (!failure || account.recentResult === "not-schedulable") return account;
    const lastSuccessAt = account.lastUsedAt ? Date.parse(account.lastUsedAt) : Number.NEGATIVE_INFINITY;
    const failureAt = Date.parse(failure.occurredAt);
    if (!Number.isFinite(failureAt) || failureAt < lastSuccessAt) return account;
    return {
      ...account,
      recentResult: "failed",
      recentResultAt: failure.occurredAt,
      recentFailureStatus: failure.statusCode,
    };
  });
}

export function shouldDeleteSub2APIAccount(account: Sub2APIAccount): boolean {
  if (account.recentFailureStatus === 402 || account.recentFailureStatus === 403) return true;
  return /\b(?:402|403)\b/.test(account.errorMessage);
}

export function sub2APIAdminConfig() {
  const baseURL = process.env.SUB2API_ADMIN_BASE_URL?.trim().replace(/\/+$/, "");
  const apiKey = process.env.SUB2API_ADMIN_API_KEY?.trim();
  if (!baseURL || !apiKey) throw new Error("SUB2API_NOT_CONFIGURED");
  return { baseURL, apiKey };
}

export async function sub2APIAdminFetch(path: string, init?: RequestInit): Promise<Response> {
  const { baseURL, apiKey } = sub2APIAdminConfig();
  return fetch(`${baseURL}${path}`, {
    ...init,
    headers: { ...init?.headers, "Content-Type": "application/json", "x-api-key": apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
}
import { sub2APIImageGroupId, type EnvLike } from "./sub2api";
