/**
 * FG-01：版本化失敗記錄（FailureRecord）。
 *
 * 病灶（2026-09-23 waoowaoo 機制 digest 第 4 條）：`generation_attempt.failure_detail`
 * 是一根扁平字串，`failure_class` 是封閉枚舉。上游原始錯誤（name/message/code/
 * status/requestId/metadata/cause 遞迴）在分類的那一刻就被壓成一句人話，之後
 * 誰也無法還原上游到底說了什麼。產品解釋與原生事實同欄位 = 事實被解釋覆蓋。
 *
 * 本檔的不變量（FG-01）：
 *  1. 原生欄位逐字保留，`cause` 遞迴（含巢狀層），永不因產品解釋而改寫。
 *  2. 產品解釋（分類／人話／HTTP 狀態）**只允許存在於 `explanation` 欄位**；
 *     `attachExplanation` 回傳新 record，`native` 原物件不動（只讀不覆寫）。
 *  3. 版本化：`version` 是記錄的一部分，未知版本必須可辨識地拒絕解析，
 *     而不是靜默當成當前版本讀（否則未來升版會把舊記錄讀成假的）。
 *
 * 儲存面：只落地到既有 generation_attempt / generation_job 的 jsonb 欄位，
 * **不新造第二條帳務/事件通道**（job_events append-only 鐵律不破，錯誤原文
 * 照既有路徑以 upstream_raw 進帳本）。
 */
import type { FailureClass } from "./types";

/** 當前記錄版本。升版 = 新值 + 遷移/解析分支，禁止就地改語義。 */
export const FAILURE_RECORD_VERSION = 1 as const;

/** 遞迴捕獲深度上限（防惡意/意外的長 cause 鏈打爆 jsonb 與日誌）。 */
const MAX_CAUSE_DEPTH = 8;

/**
 * 上游原生的單層錯誤節點。欄位語義 = 上游給什麼就存什麼，型別放寬到
 * `string | number` 是為了不把 `code: "1008"` 悄悄變成 `1008`。
 */
export interface NativeFailureNode {
  /** 上游錯誤類型名（Error.name 原文，例如 "AbortError"、"SupplierRequestError"）。 */
  name: string;
  /** 上游錯誤訊息原文（不截斷、不改寫、不翻譯）。 */
  message: string;
  /** 上游錯誤碼原文（數值或字串，型別保留）。 */
  code?: string | number | null;
  /** HTTP 狀態或上游自帶的 status 欄位原文。 */
  status?: number | string | null;
  /** 上游請求 id（requestId / request_id / providerRequestId 任一，原文）。 */
  requestId?: string | null;
  /** 上游回傳的原始 body 文字（若有）。 */
  responseBody?: string | null;
  /** 上游附帶的結構化欄位（metadata/context/details/data 任一，JSON 字面值保留）。 */
  metadata?: Record<string, unknown> | null;
  stack?: string | null;
  /** 巢狀原因，遞迴捕獲；非 Error 物件的 cause 以型別名 + 原樣字串化保存。 */
  cause?: NativeFailureNode | null;
}

/** 產品側對失敗的解釋。顯示層專用，永不回寫 native。 */
export interface FailureExplanation {
  /** 產品分類（封閉枚舉，見 types.FailureClass）——顯示／隔離用途，不驅動重放。 */
  failureClass: FailureClass;
  /** 產品說明文字（落庫的那句人話）。 */
  detail: string;
  /** 給終端用戶看的人話（顯示層）。 */
  humanMessage: string;
  httpStatus?: number | null;
}

export interface FailureRecord {
  version: number;
  /** 記錄建立時間（ISO）。 */
  capturedAt: string;
  /** 上游原生事實，逐字保留。 */
  native: NativeFailureNode;
  /** 產品解釋；未解釋時為 null（不假造解釋）。 */
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

/** 保留原始型別：數字就是數字，字串就是字串（不做 coerce）。 */
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
 * JSON 字面值安全化：能 JSON 化的原樣保留（數字精度、null、布林、巢狀結構），
 * 不能 JSON 化的（函式／undefined／迴圈引用／BigInt）以可辨識字串代替，
 * **不靜默丟欄位**（靜默丟 = 事實被吃掉）。
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
    // D-3（2026-09-23）：`upstreamStatus` 優先於 `status`。metaso / openai-video /
    // newapi-video 三個適配器刻意把非 401/403/429 的上游狀態改寫成 502 當作供應商側
    // 錯誤——那個改寫是**產品解釋**（隔離/冷卻照舊用它），不是原生事實。native 的
    // 規矩是「上游給什麼就存什麼」，故這裡存上游真實狀態；否則真 400 會以 502 進原生
    // 硬停判定，把確定性失敗當成暫時性錯誤重放到預算上限（D-3 實測 20 次）。
    status: readStatusValue(readFirst(source, ["upstreamStatus", "upstream_status", "status", "statusCode", "status_code", "httpStatus", "http_status"])),
    requestId: readStringValue(readFirst(source, ["requestId", "request_id", "providerRequestId", "provider_request_id", "xRequestId"])),
    responseBody,
    metadata: toJsonSafe(metadataSource),
    stack: readStringValue(source.stack),
  };

  if (depth < MAX_CAUSE_DEPTH && source.cause !== undefined && source.cause !== null) {
    node.cause = captureNode(source.cause, depth + 1, seen);
  } else if (source.cause !== undefined && source.cause !== null) {
    // 深度上限：明確標記被截斷，不靜默吞掉「底下還有原因」這件事。
    node.cause = { name: "TruncatedCause", message: `[cause truncated at depth ${MAX_CAUSE_DEPTH}]`, cause: null };
  } else {
    // 形狀穩定：無 cause 也顯式寫 null（jsonb 查詢/比較時欄位不會時有時無）。
    node.cause = null;
  }
  return node;
}

/**
 * 捕獲上游原生錯誤為可持久化的原生節點。純函數、不改動傳入物件。
 * 這是 FG-01 的唯一入口：所有落地失敗的地方都必須先過這裡。
 */
export function captureNativeFailure(error: unknown): NativeFailureNode {
  return captureNode(error, 0, new WeakSet<object>());
}

export interface CreateFailureRecordInput {
  error: unknown;
  /** 產品解釋（可空）。傳入後存進 explanation 欄位，native 不受影響。 */
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
 * 掛上／替換產品解釋。回傳**新** record；`native` 原封不動傳遞（同一物件引用）。
 * 這是「解釋只讀不覆寫」的機制化保證：呼叫方拿不到改寫 native 的路徑。
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
 * 解析落庫的失敗記錄。未知版本或結構壞掉 → 明確拒絕（可辨識的 reason），
 * 絕不「盡力而為」地把不可信的 jsonb 讀成當前的 record。
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

/** 便利包裝：解析失敗回 null（讀取面用；寫入面必須用 parseFailureRecord 檢查 reason）。 */
export function readFailureRecord(raw: unknown): FailureRecord | null {
  const parsed = parseFailureRecord(raw);
  return parsed.ok ? parsed.record : null;
}
