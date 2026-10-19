/**
 * FG-01：版本化失败记录（FailureRecord）。
 *
 * 病灶（2026-09-23 waoowaoo 机制 digest 第 4 条）：`generation_attempt.failure_detail`
 * 是一根扁平字串，`failure_class` 是封闭枚举。上游原始错误（name/message/code/
 * status/requestId/metadata/cause 递回）在分类的那一刻就被压成一句人话，之后
 * 谁也无法还原上游到底说了什么。产品解释与原生事实同栏位 = 事实被解释覆盖。
 *
 * 本档的不变量（FG-01）：
 *  1. 原生栏位逐字保留，`cause` 递回（含巢状层），永不因产品解释而改写。
 *  2. 产品解释（分类／人话／HTTP 状态）**只允许存在于 `explanation` 栏位**；
 *     `attachExplanation` 回传新 record，`native` 原物件不动（只读不覆写）。
 *  3. 版本化：`version` 是记录的一部分，未知版本必须可辨识地拒绝解析，
 *     而不是静默当成当前版本读（否则未来升版会把旧记录读成假的）。
 *
 * 储存面：只落地到既有 generation_attempt / generation_job 的 jsonb 栏位，
 * **不新造第二条帐务/事件通道**（job_events append-only 铁律不破，错误原文
 * 照既有路径以 upstream_raw 进帐本）。
 */
import type { FailureClass } from "./types";

/** 当前记录版本。升版 = 新值 + 迁移/解析分支，禁止就地改语义。 */
export const FAILURE_RECORD_VERSION = 1 as const;

/** 递回捕获深度上限（防恶意/意外的长 cause 链打爆 jsonb 与日志）。 */
const MAX_CAUSE_DEPTH = 8;

/**
 * 上游原生的单层错误节点。栏位语义 = 上游给什么就存什么，型别放宽到
 * `string | number` 是为了不把 `code: "1008"` 悄悄变成 `1008`。
 */
export interface NativeFailureNode {
  /** 上游错误类型名（Error.name 原文，例如 "AbortError"、"SupplierRequestError"）。 */
  name: string;
  /** 上游错误讯息原文（不截断、不改写、不翻译）。 */
  message: string;
  /** 上游错误码原文（数值或字串，型别保留）。 */
  code?: string | number | null;
  /** HTTP 状态或上游自带的 status 栏位原文。 */
  status?: number | string | null;
  /** 上游请求 id（requestId / request_id / providerRequestId 任一，原文）。 */
  requestId?: string | null;
  /** 上游回传的原始 body 文字（若有）。 */
  responseBody?: string | null;
  /** 上游附带的结构化栏位（metadata/context/details/data 任一，JSON 字面值保留）。 */
  metadata?: Record<string, unknown> | null;
  stack?: string | null;
  /** 巢状原因，递回捕获；非 Error 物件的 cause 以型别名 + 原样字串化保存。 */
  cause?: NativeFailureNode | null;
}

/** 产品侧对失败的解释。显示层专用，永不回写 native。 */
export interface FailureExplanation {
  /** 产品分类（封闭枚举，见 types.FailureClass）——显示／隔离用途，不驱动重放。 */
  failureClass: FailureClass;
  /** 产品说明文字（落库的那句人话）。 */
  detail: string;
  /** 给终端用户看的人话（显示层）。 */
  humanMessage: string;
  httpStatus?: number | null;
}

export interface FailureRecord {
  version: number;
  /** 记录建立时间（ISO）。 */
  capturedAt: string;
  /** 上游原生事实，逐字保留。 */
  native: NativeFailureNode;
  /** 产品解释；未解释时为 null（不假造解释）。 */
  explanation: FailureExplanation | null;
}

export type FailureRecordReadResult =
  | { ok: true; record: FailureRecord }
  | { ok: false; reason: "missing" | "malformed" | "unsupported_version"; version?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readFirst(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** 保留原始型别：数字就是数字，字串就是字串（不做 coerce）。 */
function readCodeValue(value: unknown): string | number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  return null;
}

function readStatusValue(value: unknown): number | string | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value;
  return null;
}

function readStringValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * JSON 字面值安全化：能 JSON 化的原样保留（数字精度、null、布林、巢状结构），
 * 不能 JSON 化的（函式／undefined／回圈引用／BigInt）以可辨识字串代替，
 * **不静默丢栏位**（静默丢 = 事实被吃掉）。
 */
function toJsonSafe(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  try {
    const plain = JSON.parse(JSON.stringify(value)) as unknown;
    return isRecord(plain) ? plain : null;
  } catch {
    const fallback: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      try {
        fallback[key] = JSON.parse(JSON.stringify(entry)) as unknown;
      } catch {
        fallback[key] = `[unserializable:${typeof entry}]`;
      }
    }
    return fallback;
  }
}

function captureNode(source: unknown, depth: number, seen: WeakSet<object>): NativeFailureNode {
  if (!isRecord(source)) {
    return { name: typeof source, message: String(source), cause: null };
  }
  if (seen.has(source)) {
    return { name: String((source as { name?: unknown }).name ?? "CircularCause"), message: "[circular cause]", cause: null };
  }
  seen.add(source);

  const name = readStringValue(readFirst(source, ["name", "type", "errorType"])) ?? "Error";
  const message = readStringValue(readFirst(source, ["message", "msg", "error", "errorMessage", "detail"])) ?? String(source);
  const responseBody = readStringValue(
    readFirst(source, ["responseBody", "response_body", "body", "raw", "text"]),
  ) ?? (isRecord(source.response) ? readStringValue(readFirst(source.response, ["body", "text", "data"])) : null);
  const metadataSource =
    readFirst(source, ["metadata", "meta", "context", "details", "data"]) ??
    (isRecord(source.response) ? readFirst(source.response, ["data", "metadata"]) : undefined);

  const node: NativeFailureNode = {
    name,
    message,
    code: readCodeValue(readFirst(source, ["code", "errorCode", "error_code", "errno"])),
    // D-3（2026-09-23）：`upstreamStatus` 优先于 `status`。metaso / openai-video /
    // newapi-video 三个适配器刻意把非 401/403/429 的上游状态改写成 502 当作供应商侧
    // 错误——那个改写是**产品解释**（隔离/冷却照旧用它），不是原生事实。native 的
    // 规矩是「上游给什么就存什么」，故这里存上游真实状态；否则真 400 会以 502 进原生
    // 硬停判定，把确定性失败当成暂时性错误重放到预算上限（D-3 实测 20 次）。
    status: readStatusValue(readFirst(source, ["upstreamStatus", "upstream_status", "status", "statusCode", "status_code", "httpStatus", "http_status"])),
    requestId: readStringValue(readFirst(source, ["requestId", "request_id", "providerRequestId", "provider_request_id", "xRequestId"])),
    responseBody,
    metadata: toJsonSafe(metadataSource),
    stack: readStringValue(source.stack),
  };

  if (depth < MAX_CAUSE_DEPTH && source.cause !== undefined && source.cause !== null) {
    node.cause = captureNode(source.cause, depth + 1, seen);
  } else if (source.cause !== undefined && source.cause !== null) {
    // 深度上限：明确标记被截断，不静默吞掉「底下还有原因」这件事。
    node.cause = { name: "TruncatedCause", message: `[cause truncated at depth ${MAX_CAUSE_DEPTH}]`, cause: null };
  } else {
    // 形状稳定：无 cause 也显式写 null（jsonb 查询/比较时栏位不会时有时无）。
    node.cause = null;
  }
  return node;
}

/**
 * 捕获上游原生错误为可持久化的原生节点。纯函数、不改动传入物件。
 * 这是 FG-01 的唯一入口：所有落地失败的地方都必须先过这里。
 */
export function captureNativeFailure(error: unknown): NativeFailureNode {
  return captureNode(error, 0, new WeakSet<object>());
}

export interface CreateFailureRecordInput {
  error: unknown;
  /** 产品解释（可空）。传入后存进 explanation 栏位，native 不受影响。 */
  explanation?: FailureExplanation | null;
  now?: Date;
}

export function createFailureRecord(input: CreateFailureRecordInput): FailureRecord {
  return {
    version: FAILURE_RECORD_VERSION,
    capturedAt: (input.now ?? new Date()).toISOString(),
    native: captureNativeFailure(input.error),
    explanation: input.explanation ?? null,
  };
}

/**
 * 挂上／替换产品解释。回传**新** record；`native` 原封不动传递（同一物件引用）。
 * 这是「解释只读不覆写」的机制化保证：呼叫方拿不到改写 native 的路径。
 */
export function attachExplanation(record: FailureRecord, explanation: FailureExplanation | null): FailureRecord {
  return { ...record, explanation };
}

export function serializeFailureRecord(record: FailureRecord): string {
  return JSON.stringify(record);
}

function isValidNativeNode(value: unknown): value is NativeFailureNode {
  return isRecord(value) && typeof value.name === "string" && typeof value.message === "string";
}

/**
 * 解析落库的失败记录。未知版本或结构坏掉 → 明确拒绝（可辨识的 reason），
 * 绝不「尽力而为」地把不可信的 jsonb 读成当前的 record。
 */
export function parseFailureRecord(raw: unknown): FailureRecordReadResult {
  if (raw === null || raw === undefined || raw === "") return { ok: false, reason: "missing" };
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }
  if (!isRecord(value)) return { ok: false, reason: "malformed" };
  if (typeof value.version !== "number") return { ok: false, reason: "malformed" };
  if (value.version !== FAILURE_RECORD_VERSION) {
    return { ok: false, reason: "unsupported_version", version: value.version };
  }
  if (!isValidNativeNode(value.native)) return { ok: false, reason: "malformed" };
  if (typeof value.capturedAt !== "string") return { ok: false, reason: "malformed" };
  const explanation = value.explanation ?? null;
  if (explanation !== null) {
    if (!isRecord(explanation)) return { ok: false, reason: "malformed" };
    if (typeof explanation.failureClass !== "string" || typeof explanation.detail !== "string") {
      return { ok: false, reason: "malformed" };
    }
  }
  return { ok: true, record: value as unknown as FailureRecord };
}

/** 便利包装：解析失败回 null（读取面用；写入面必须用 parseFailureRecord 检查 reason）。 */
export function readFailureRecord(raw: unknown): FailureRecord | null {
  const parsed = parseFailureRecord(raw);
  return parsed.ok ? parsed.record : null;
}
