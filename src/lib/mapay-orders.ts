// mPay（epay 相容）訂單查詢客戶端——用支付商自己的資料獨立對帳「已付款 vs 已履約」。
//
// 為什麼需要它：我方後端帳本被實錘會吞單（2026-09-19 out_trade_no=IMGMU7UH9SFF9A21D，
// 用戶實付 ¥9.93、handler 回 500、帳本零痕跡、數月無人發現）。用我方自己的表斷言「付了
// 沒履約」是同源斷言（違反 AGENTS.md 禁同源斷言）；唯一獨立來源＝支付商後台/介面。
//
// 已驗證契約（2026-10-04 生產實證，勿再猜）：
//   GET <gateway>/api.php?act=order&pid=<PID>&key=<KEY>&out_trade_no=<商戶單號>   單筆查（按商戶單號）
//   生產實測 act=order 不帶單號 → HTTP 200 {"code":0,"msg":"系统订单号 和 商户订单号 二选一"}
//     ⇒ `act=order` 是「按單號單查」，**不是列表端點**（無法列舉；對帳只能由我方已知單號逐筆查）。
//   缺 pid → {"code":502,"message":"请输入商户ID"}
//   缺 key → {"code":502,"message":"请输入商户通讯密钥"}
//   pid/key 不匹配 → {"code":0,"msg":"没有找到商户信息"}
// **成功碼 = 1**；**code=0 是失敗**（上面兩條 code=0 都是錯誤訊息，不是空成功）。
// 因此本客戶端：① 成功判定＝`code===1` 或響應真的帶出訂單實體，**不得只看 code**——
//   code:0 或任何帶錯誤 msg 而無訂單實體一律歸錯誤（不是「成功但 data 為空」）
// ② 原始響應（pid/key 遮蔽後）落進日誌（契約取證）
// ③ 單查不到（成功碼但零訂單）回 null＝「查無此單」，與「成功查到」不混同。

import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  signBizKeySync,
} from "@/lib/biz-key-sync";
import { getMapayConfig, isMapayPaymentSuccessful, type MapayConfig } from "@/lib/mapay";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type EnvLike = Record<string, string | undefined>;

/** 逾時 / 非 JSON / 非 0 code 的明確錯誤型別（呼叫端據此決定退避或告警，不吞成 null）。 */
export type MapayOrdersErrorKind =
  | "config_missing"
  | "timeout"
  | "network"
  | "http"
  | "non_json"
  | "upstream";

export class MapayOrdersError extends Error {
  readonly kind: MapayOrdersErrorKind;
  readonly httpStatus: number | null;
  readonly upstreamCode: number | string | null;
  readonly detail: string | null;

  constructor(
    kind: MapayOrdersErrorKind,
    message: string,
    extra: { httpStatus?: number | null; upstreamCode?: number | string | null; detail?: string | null } = {},
  ) {
    super(message);
    this.name = "MapayOrdersError";
    this.kind = kind;
    this.httpStatus = extra.httpStatus ?? null;
    this.upstreamCode = extra.upstreamCode ?? null;
    this.detail = extra.detail ?? null;
  }
}

/** 正規化後的 mPay 訂單（欄位名別名一律在此收斂，呼叫端不碰原始鍵）。 */
export interface MapayOrder {
  outTradeNo: string;
  tradeNo: string | null;
  money: number | null;
  status: string;
  /** 支付商是否回報「已付款成功」。 */
  paid: boolean;
  name: string | null;
  type: string | null;
  /** 下單時間 ISO（可解析才有值）。 */
  createdAt: string | null;
  /** 支付時間 ISO（可解析才有值）。 */
  paidAt: string | null;
  /** 原始欄位（pid/key 已遮蔽；只作取證，勿當契約）。 */
  raw: Record<string, unknown>;
}

export interface MapayOrdersResult {
  orders: MapayOrder[];
  /** 支付商回 success 但沒有任何訂單（「成功但 data 為空」——與「code 非 0」不同）。 */
  empty: boolean;
  code: number | string | null;
  message: string | null;
  /** 本輪查詢的端點（act=order/query）。 */
  endpoint: "order" | "query";
}

/** gateway 基底 → api.php 位址。基底來自 env（getMapayConfig），不得硬編碼。 */
export function mapayApiUrl(gatewayUrl: string): string {
  const url = gatewayUrl.trim();
  if (/api\.php(?:$|\?)/.test(url)) return url;
  return new URL("api.php", url.endsWith("/") ? url : `${url}/`).toString();
}

/** pid/key 值在日誌中遮蔽，避免 secret 入 log（AGENTS.md 紅線）。 */
export function redactMapaySecrets(text: string, config: Pick<MapayConfig, "pid" | "key">): string {
  let out = text;
  if (config.key) out = out.split(config.key).join("***");
  if (config.pid) out = out.split(config.pid).join("***");
  return out;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** 容忍 `YYYY-MM-DD HH:mm:ss`、`YYYY/MM/DD HH:mm:ss`、秒/毫秒 epoch 與 ISO。 */
function parseMapayTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      const ms = n < 1e12 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }
  }
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.replace(/\//g, "-").replace(" ", "T");
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`;
  const date = new Date(withZone);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** 單筆原始紀錄 → 正規化訂單。缺 out_trade_no 回 null（無法指認的列不收）。 */
export function normalizeMapayOrder(raw: unknown): MapayOrder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const outTradeNo = firstString(record, ["out_trade_no", "outTradeNo", "order_no", "orderId"]);
  if (!outTradeNo) return null;
  const status = firstString(record, ["trade_status", "status", "tradeStatus"]) ?? "";
  return {
    outTradeNo,
    tradeNo: firstString(record, ["trade_no", "tradeNo", "transaction_id", "transactionId"]),
    money: firstNumber(record, ["money", "amount", "price", "total_fee", "totalFee"]),
    status,
    paid: isMapayPaymentSuccessful({
      trade_status: status,
      status: firstString(record, ["status"]) ?? undefined,
    } as Record<string, string>),
    name: firstString(record, ["name", "subject", "product_name", "productName"]),
    type: firstString(record, ["type", "pay_type", "payType"]),
    createdAt: parseMapayTime(firstString(record, ["addtime", "created_at", "create_time", "createdAt"])),
    paidAt: parseMapayTime(firstString(record, ["endtime", "pay_time", "paid_at", "paidAt", "trade_time"])),
    raw: record,
  };
}

/** 從信封抽出訂單陣列：data 可能是陣列、單筆物件、或帶 list/orders/rows 的物件。 */
function extractOrderRecords(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["list", "orders", "rows", "items", "records"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    // 單筆查詢：data 直接是訂單物件。
    if (firstString(record, ["out_trade_no", "outTradeNo"])) return [record];
  }
  return [];
}

/** 解析 epay 信封。回 null＝信封完全無法辨識（呼叫端當 non_json 之外的 upstream 錯誤）。 */
export function parseMapayOrdersResponse(json: unknown): { orders: MapayOrder[]; empty: boolean; code: number | string | null; message: string | null } {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { orders: [], empty: true, code: null, message: null };
  }
  const envelope = json as Record<string, unknown>;
  const code = (envelope.code ?? envelope.status ?? null) as number | string | null;
  const message = firstString(envelope, ["msg", "message", "info"]);
  // 兩種形態都認：① 訂單包在容器鍵裡（列表或舊形態）② 單查時訂單欄位平鋪在信封根層
  //   （2026-10-04 生產實證：act=order&out_trade_no= 的響應根層直接帶 out_trade_no/trade_no，
  //   無 data/result/orders/list；此時信封本身即那一筆訂單）。
  let records = extractOrderRecords(envelope.data ?? envelope.result ?? envelope.orders ?? envelope.list);
  if (records.length === 0 && firstString(envelope, ["out_trade_no", "outTradeNo", "trade_no", "tradeNo"])) {
    records = [envelope];
  }
  const orders: MapayOrder[] = [];
  for (const record of records) {
    const normalized = normalizeMapayOrder(record);
    if (normalized) orders.push(normalized);
  }
  return { orders, empty: orders.length === 0, code, message };
}

// ─────────────────────────────────────────── HTTP

interface ClientDeps {
  config?: MapayConfig;
  env?: EnvLike;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** 日誌出口（默認 console.info）；測試注入以斷言已落原始響應。 */
  logger?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** 上游成功碼（生產實證：只有 1 是成功；code=0 是失敗）。 */
const SUCCESS_CODES = new Set<number | string>([1, "1"]);

/**
 * 信封是否代表「支付商成功受理」。**不得只看 code**：
 * code===1 是權威成功碼；此外只要響應真的帶出訂單實體也視為成功（有資料就是有資料，
 * 容忍上游版本差異）。code:0 或任何帶錯誤 msg 而無訂單實體 → false（呼叫端歸「上游錯誤」，
 * 不得當成「成功但 data 為空」）。
 */
export function isMapayEnvelopeSuccess(parsed: { orders: MapayOrder[]; code: number | string | null }): boolean {
  if (SUCCESS_CODES.has(parsed.code as number | string)) return true;
  return parsed.orders.length > 0;
}

function resolveConfig(deps: ClientDeps): MapayConfig {
  if (deps.config) return deps.config;
  try {
    return getMapayConfig(deps.env as NodeJS.ProcessEnv | undefined);
  } catch (error) {
    throw new MapayOrdersError("config_missing", error instanceof Error ? error.message : "Missing MaPay merchant credentials.");
  }
}

/**
 * 本實例是否握有 mPay 憑證（不 throw）。有 → 直連支付商；無 → 轉投 Vercel 中繼。
 * 對帳器跑在控制面（無憑證），這條分流讓它仍能取得支付商資料。
 */
function hasLocalConfig(deps: ClientDeps): boolean {
  try {
    resolveConfig(deps);
    return true;
  } catch {
    return false;
  }
}

async function requestOrders(
  act: "order" | "query",
  extraParams: Record<string, string>,
  deps: ClientDeps,
): Promise<MapayOrdersResult> {
  const config = resolveConfig(deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const logger = deps.logger ?? ((message: string) => console.info(message));
  const url = new URL(mapayApiUrl(config.gatewayUrl));
  url.searchParams.set("act", act);
  url.searchParams.set("pid", config.pid);
  url.searchParams.set("key", config.key);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value) url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    const kind = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
    throw new MapayOrdersError(kind, `mPay ${act} 查詢失敗（${kind}）：${message}`, { detail: message });
  }

  const text = await response.text().catch(() => "");
  // 原始響應（pid/key 遮蔽後）落日誌：首次生產執行即確立真實契約。
  logger(`[mapay-orders] act=${act} HTTP ${response.status} raw=${redactMapaySecrets(text.slice(0, 4000), config)}`);

  if (!response.ok) {
    throw new MapayOrdersError("http", `mPay ${act} 回 HTTP ${response.status}`, {
      httpStatus: response.status,
      detail: redactMapaySecrets(text.slice(0, 500), config),
    });
  }
  if (!text.trim()) {
    throw new MapayOrdersError("non_json", `mPay ${act} 回應為空（非 JSON）`, { httpStatus: response.status });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MapayOrdersError("non_json", `mPay ${act} 回應非 JSON`, {
      httpStatus: response.status,
      detail: redactMapaySecrets(text.slice(0, 500), config),
    });
  }

  const parsed = parseMapayOrdersResponse(json);
  // 成功判定：code===1 或真的帶出訂單實體。code:0（例「系统订单号 和 商户订单号 二选一」
  // 「没有找到商户信息」）或任何無訂單實體的錯誤信封 = 上游錯誤，不是「空成功」。
  if (!isMapayEnvelopeSuccess(parsed)) {
    const codeText = parsed.code === null ? "無 code" : `code=${String(parsed.code)}`;
    throw new MapayOrdersError(
      "upstream",
      `mPay ${act} 回 ${codeText}：${parsed.message ?? "無訂單資料，視為失敗（不當空成功）"}`,
      {
        httpStatus: response.status,
        upstreamCode: parsed.code,
        detail: parsed.message,
      },
    );
  }
  return { orders: parsed.orders, empty: parsed.orders.length === 0, code: parsed.code, message: parsed.message, endpoint: act };
}

// ─────────────────────────────────────────── 跨實例中繼（本實例無憑證時）

/**
 * 域分隔前綴，必須與 Vercel 側路由 src/app/api/internal/mapay-orders 的
 * verifyBizKeySync signatureDomain 一致。不得沿用其他用途的前綴。
 */
export const MAPAY_ORDERS_RELAY_SIGNATURE_DOMAIN = "mapay-orders";
const RELAY_PATH = "/api/internal/mapay-orders";
const DEFAULT_RELAY_TIMEOUT_MS = 20_000;

/**
 * 中繼位址：控制面沒有支付商憑證，只能問 Vercel（誰有憑證誰去問上游）。
 *
 * 優先複用控制面既有的 GENERATION_BILLING_RELAY_URL（值＝Vercel 上的
 * /api/internal/generation-billing）取其 origin——不新增環境變數；
 * MAPAY_ORDERS_RELAY_ORIGIN 僅作可選覆寫（當 billing relay 位址不再是 Vercel 時）。
 * 秘密沿用兩側皆有的 GENERATION_BILLING_RELAY_SECRET（域分隔避免重放）。
 */
export function mapayOrdersRelayConfig(env: EnvLike = process.env as EnvLike): { url: string; secret: string } | null {
  let origin = (env.MAPAY_ORDERS_RELAY_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!origin) {
    const billingUrl = (env.GENERATION_BILLING_RELAY_URL ?? "").trim();
    if (billingUrl) {
      try {
        origin = new URL(billingUrl).origin;
      } catch {
        origin = "";
      }
    }
  }
  const secret = (env.GENERATION_BILLING_RELAY_SECRET ?? "").trim();
  if (!origin || !secret) return null;
  return { url: `${origin}${RELAY_PATH}`, secret };
}

/**
 * 打一次 Vercel 中繼。回 null＝通道不可用（env 缺失／網路／非 2xx／形狀不符），
 * 由呼叫端收成「本實例無憑證且通道不可用」的 config_missing 錯誤——不假裝成功。
 */
async function postMapayOrdersRelay(
  body: Record<string, unknown>,
  deps: ClientDeps,
): Promise<Record<string, unknown> | null> {
  const config = mapayOrdersRelayConfig(deps.env ?? (process.env as EnvLike));
  if (!config) return null;
  const rawBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  try {
    const res = await (deps.fetchImpl ?? fetch)(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [BIZ_KEY_SYNC_TIMESTAMP_HEADER]: timestamp,
        [BIZ_KEY_SYNC_SIGNATURE_HEADER]: signBizKeySync(
          config.secret,
          timestamp,
          rawBody,
          MAPAY_ORDERS_RELAY_SIGNATURE_DOMAIN,
        ),
      },
      body: rawBody,
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return data?.ok === true ? data : null;
  } catch (error) {
    console.error(`[mapay-orders] relay failed：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function relayFetchMapayOrders(
  window: { since?: Date | string; until?: Date | string },
  deps: ClientDeps,
): Promise<MapayOrdersResult | null> {
  const since = window.since ? new Date(window.since) : null;
  const until = window.until ? new Date(window.until) : null;
  const data = await postMapayOrdersRelay(
    {
      op: "orders",
      ...(since && Number.isFinite(since.getTime()) ? { since: since.toISOString() } : {}),
      ...(until && Number.isFinite(until.getTime()) ? { until: until.toISOString() } : {}),
    },
    deps,
  );
  const result = data?.result;
  if (!result || typeof result !== "object") return null;
  // 中繼端已用同一個 fetchMapayOrders 做過窗口過濾，這裡原樣採納，不二次過濾。
  return result as MapayOrdersResult;
}

/** 回 null＝找不到（支付商空 data）或通道不可用；用包裝型別區分，呼叫端據此決定語義。 */
async function relayFetchMapayOrder(
  outTradeNo: string,
  deps: ClientDeps,
): Promise<{ order: MapayOrder | null } | null> {
  const data = await postMapayOrdersRelay({ op: "order", outTradeNo }, deps);
  if (!data) return null;
  const order = data.order;
  return { order: order && typeof order === "object" ? (order as MapayOrder) : null };
}

/**
 * 拉取窗口內的支付商訂單（**歷史/中繼相容入口**）。
 *
 * 生產實證後：上游 `act=order` 是「按單號單查」，不帶單號會回 code:0（⇒ 本函式在真上游
 * 通常直接拋 upstream，這才是誠實行為——上游不支援列舉）。對帳器的權威取數已改為
 * `fetchMapayOrder` 逐筆查（見 mapay-order-reconciliation.ts），本函式只保留給跨實例中繼
 * 的 `op=orders` 相容路徑，並沿用客戶端時間過濾（時間戳不可解析的列保守保留）。
 */
export async function fetchMapayOrders(
  window: { since?: Date | string; until?: Date | string } = {},
  deps: ClientDeps = {},
): Promise<MapayOrdersResult> {
  // 本實例無憑證（對帳器跑在控制面）→ 轉投 Vercel 中繼；通道不可用則如實報 config_missing。
  if (!hasLocalConfig(deps)) {
    const relayed = await relayFetchMapayOrders(window, deps);
    if (relayed) return relayed;
    throw new MapayOrdersError("config_missing", "Missing MaPay merchant credentials.", {
      detail: "本實例沒有 mPay 憑證，且跨實例訂單查詢通道不可用。",
    });
  }

  const since = window.since ? new Date(window.since) : null;
  const until = window.until ? new Date(window.until) : null;
  const extra: Record<string, string> = {};
  if (since && Number.isFinite(since.getTime())) extra.starttime = since.toISOString().slice(0, 19).replace("T", " ");
  if (until && Number.isFinite(until.getTime())) extra.endtime = until.toISOString().slice(0, 19).replace("T", " ");

  const result = await requestOrders("order", extra, deps);
  if (!since && !until) return result;

  const sinceMs = since && Number.isFinite(since.getTime()) ? since.getTime() : null;
  const untilMs = until && Number.isFinite(until.getTime()) ? until.getTime() : null;
  const kept: MapayOrder[] = [];
  for (const order of result.orders) {
    const stamp = order.paidAt ?? order.createdAt;
    if (!stamp) {
      kept.push(order); // 時間不可解析 → 保守保留（殘差由對帳器如實列出）
      continue;
    }
    const ms = new Date(stamp).getTime();
    if (sinceMs !== null && ms < sinceMs) continue;
    if (untilMs !== null && ms > untilMs) continue;
    kept.push(order);
  }
  return { ...result, orders: kept };
}

/**
 * 單筆查詢（**按商戶單號**）：走 `act=order&out_trade_no=<單號>`。
 * 成功碼但零訂單＝回 null（明確的「查無此單」，與「成功查到」不混同）；
 * 業務錯誤（code:0／502）照樣拋 MapayOrdersError，不吞成 null。
 */
export async function fetchMapayOrder(outTradeNo: string, deps: ClientDeps = {}): Promise<MapayOrder | null> {
  // 本實例無憑證 → 轉投 Vercel 中繼（找不到回 null，通道不可用如實報 config_missing）。
  if (!hasLocalConfig(deps)) {
    const relayed = await relayFetchMapayOrder(outTradeNo, deps);
    if (relayed) return relayed.order;
    throw new MapayOrdersError("config_missing", "Missing MaPay merchant credentials.", {
      detail: "本實例沒有 mPay 憑證，且跨實例訂單查詢通道不可用。",
    });
  }

  const result = await requestOrders("order", { out_trade_no: outTradeNo }, deps);
  return result.orders.find((order) => order.outTradeNo === outTradeNo) ?? result.orders[0] ?? null;
}
