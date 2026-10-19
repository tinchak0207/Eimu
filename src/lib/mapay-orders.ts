// mPay（epay 相容）订单查询客户端——用支付商自己的资料独立对帐「已付款 vs 已履约」。
//
// 为什么需要它：我方后端帐本被实锤会吞单（2026-09-19 out_trade_no=IMGMU7UH9SFF9A21D，
// 用户实付 ¥9.93、handler 回 500、帐本零痕迹、数月无人发现）。用我方自己的表断言「付了
// 没履约」是同源断言（违反 AGENTS.md 禁同源断言）；唯一独立来源＝支付商后台/介面。
//
// 已验证契约（2026-10-04 生产实证，勿再猜）：
//   GET <gateway>/api.php?act=order&pid=<PID>&key=<KEY>&out_trade_no=<商户单号>   单笔查（按商户单号）
//   生产实测 act=order 不带单号 → HTTP 200 {"code":0,"msg":"系统订单号 和 商户订单号 二选一"}
//     ⇒ `act=order` 是「按单号单查」，**不是列表端点**（无法列举；对帐只能由我方已知单号逐笔查）。
//   缺 pid → {"code":502,"message":"请输入商户ID"}
//   缺 key → {"code":502,"message":"请输入商户通讯密钥"}
//   pid/key 不匹配 → {"code":0,"msg":"没有找到商户信息"}
// **成功码 = 1**；**code=0 是失败**（上面两条 code=0 都是错误讯息，不是空成功）。
// 因此本客户端：① 成功判定＝`code===1` 或响应真的带出订单实体，**不得只看 code**——
//   code:0 或任何带错误 msg 而无订单实体一律归错误（不是「成功但 data 为空」）
// ② 原始响应（pid/key 遮蔽后）落进日志（契约取证）
// ③ 单查不到（成功码但零订单）回 null＝「查无此单」，与「成功查到」不混同。

import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  signBizKeySync,
} from "@/lib/biz-key-sync";
import { getMapayConfig, isMapayPaymentSuccessful, type MapayConfig } from "@/lib/mapay";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type EnvLike = Record<string, string | undefined>;

/** 逾时 / 非 JSON / 非 0 code 的明确错误型别（呼叫端据此决定退避或告警，不吞成 null）。 */
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

/** 正规化后的 mPay 订单（栏位名别名一律在此收敛，呼叫端不碰原始键）。 */
export interface MapayOrder {
  outTradeNo: string;
  tradeNo: string | null;
  money: number | null;
  status: string;
  /** 支付商是否回报「已付款成功」。 */
  paid: boolean;
  name: string | null;
  type: string | null;
  /** 下单时间 ISO（可解析才有值）。 */
  createdAt: string | null;
  /** 支付时间 ISO（可解析才有值）。 */
  paidAt: string | null;
  /** 原始栏位（pid/key 已遮蔽；只作取证，勿当契约）。 */
  raw: Record<string, unknown>;
}

export interface MapayOrdersResult {
  orders: MapayOrder[];
  /** 支付商回 success 但没有任何订单（「成功但 data 为空」——与「code 非 0」不同）。 */
  empty: boolean;
  code: number | string | null;
  message: string | null;
  /** 本轮查询的端点（act=order/query）。 */
  endpoint: "order" | "query";
}

/** gateway 基底 → api.php 位址。基底来自 env（getMapayConfig），不得硬编码。 */
export function mapayApiUrl(gatewayUrl: string): string {
  const url = gatewayUrl.trim();
  if (/api\.php(?:$|\?)/.test(url)) return url;
  return new URL("api.php", url.endsWith("/") ? url : `${url}/`).toString();
}

/** pid/key 值在日志中遮蔽，避免 secret 入 log（AGENTS.md 红线）。 */
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

/** 容忍 `YYYY-MM-DD HH:mm:ss`、`YYYY/MM/DD HH:mm:ss`、秒/毫秒 epoch 与 ISO。 */
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

/** 单笔原始纪录 → 正规化订单。缺 out_trade_no 回 null（无法指认的列不收）。 */
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

/** 从信封抽出订单阵列：data 可能是阵列、单笔物件、或带 list/orders/rows 的物件。 */
function extractOrderRecords(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["list", "orders", "rows", "items", "records"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    // 单笔查询：data 直接是订单物件。
    if (firstString(record, ["out_trade_no", "outTradeNo"])) return [record];
  }
  return [];
}

/** 解析 epay 信封。回 null＝信封完全无法辨识（呼叫端当 non_json 之外的 upstream 错误）。 */
export function parseMapayOrdersResponse(json: unknown): { orders: MapayOrder[]; empty: boolean; code: number | string | null; message: string | null } {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { orders: [], empty: true, code: null, message: null };
  }
  const envelope = json as Record<string, unknown>;
  const code = (envelope.code ?? envelope.status ?? null) as number | string | null;
  const message = firstString(envelope, ["msg", "message", "info"]);
  // 两种形态都认：① 订单包在容器键里（列表或旧形态）② 单查时订单栏位平铺在信封根层
  //   （2026-10-04 生产实证：act=order&out_trade_no= 的响应根层直接带 out_trade_no/trade_no，
  //   无 data/result/orders/list；此时信封本身即那一笔订单）。
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
  /** 日志出口（默认 console.info）；测试注入以断言已落原始响应。 */
  logger?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** 上游成功码（生产实证：只有 1 是成功；code=0 是失败）。 */
const SUCCESS_CODES = new Set<number | string>([1, "1"]);

/**
 * 信封是否代表「支付商成功受理」。**不得只看 code**：
 * code===1 是权威成功码；此外只要响应真的带出订单实体也视为成功（有资料就是有资料，
 * 容忍上游版本差异）。code:0 或任何带错误 msg 而无订单实体 → false（呼叫端归「上游错误」，
 * 不得当成「成功但 data 为空」）。
 */
export function isMapayEnvelopeSuccess(parsed: { orders: MapayOrder[]; code: number | string | null }): boolean {
  if (SUCCESS_CODES.has(parsed.code as number | string)) return true;
  return parsed.orders.length > 0;
}

/**
 * 「查无此单」的权威特征（生产实证 2026-10-04）：HTTP 200 + code:0 +
 * msg「没有找到订单信息」。刻意**不**用「code===0 一律当查无此单」——code:0 也涵盖
 * 「系统订单号 和 商户订单号 二选一」这类真错误（见 mapay-orders.test.ts 的钉子）。
 */
export const MAPAY_ORDER_NOT_FOUND_MESSAGE = "没有找到订单信息";

export function isMapayOrderNotFoundEnvelope(parsed: { code: number | string | null; message?: string | null }): boolean {
  if (parsed.code !== 0 && parsed.code !== "0") return false;
  return (parsed.message ?? "").includes(MAPAY_ORDER_NOT_FOUND_MESSAGE);
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
 * 本实例是否握有 mPay 凭证（不 throw）。有 → 直连支付商；无 → 转投 Vercel 中继。
 * 对帐器跑在控制面（无凭证），这条分流让它仍能取得支付商资料。
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
  options: { notFoundAsEmpty?: boolean } = {},
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
    throw new MapayOrdersError(kind, `mPay ${act} 查询失败（${kind}）：${message}`, { detail: message });
  }

  const text = await response.text().catch(() => "");
  // 原始响应（pid/key 遮蔽后）落日志：首次生产执行即确立真实契约。
  logger(`[mapay-orders] act=${act} HTTP ${response.status} raw=${redactMapaySecrets(text.slice(0, 4000), config)}`);

  if (!response.ok) {
    throw new MapayOrdersError("http", `mPay ${act} 回 HTTP ${response.status}`, {
      httpStatus: response.status,
      detail: redactMapaySecrets(text.slice(0, 500), config),
    });
  }
  if (!text.trim()) {
    throw new MapayOrdersError("non_json", `mPay ${act} 回应为空（非 JSON）`, { httpStatus: response.status });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MapayOrdersError("non_json", `mPay ${act} 回应非 JSON`, {
      httpStatus: response.status,
      detail: redactMapaySecrets(text.slice(0, 500), config),
    });
  }

  const parsed = parseMapayOrdersResponse(json);
  // 单号单查的「查无此单」是正常结果（回 null＝not_found），不是通道错误。
  // 只有 op=order 的呼叫端会开这个开关；批次/列举路径维持「code:0 一律抛错」。
  if (options.notFoundAsEmpty && isMapayOrderNotFoundEnvelope(parsed)) {
    return { orders: [], empty: true, code: parsed.code, message: parsed.message, endpoint: act };
  }
  // 成功判定：code===1 或真的带出订单实体。code:0（例「系统订单号 和 商户订单号 二选一」
  // 「没有找到商户信息」）或任何无订单实体的错误信封 = 上游错误，不是「空成功」。
  if (!isMapayEnvelopeSuccess(parsed)) {
    const codeText = parsed.code === null ? "无 code" : `code=${String(parsed.code)}`;
    throw new MapayOrdersError(
      "upstream",
      `mPay ${act} 回 ${codeText}：${parsed.message ?? "无订单资料，视为失败（不当空成功）"}`,
      {
        httpStatus: response.status,
        upstreamCode: parsed.code,
        detail: parsed.message,
      },
    );
  }
  return { orders: parsed.orders, empty: parsed.orders.length === 0, code: parsed.code, message: parsed.message, endpoint: act };
}

// ─────────────────────────────────────────── 跨实例中继（本实例无凭证时）

/**
 * 域分隔前缀，必须与 Vercel 侧路由 src/app/api/internal/mapay-orders 的
 * verifyBizKeySync signatureDomain 一致。不得沿用其他用途的前缀。
 */
export const MAPAY_ORDERS_RELAY_SIGNATURE_DOMAIN = "mapay-orders";
const RELAY_PATH = "/api/internal/mapay-orders";
const DEFAULT_RELAY_TIMEOUT_MS = 20_000;

/**
 * 中继位址：控制面没有支付商凭证，只能问 Vercel（谁有凭证谁去问上游）。
 *
 * 优先复用控制面既有的 GENERATION_BILLING_RELAY_URL（值＝Vercel 上的
 * /api/internal/generation-billing）取其 origin——不新增环境变数；
 * MAPAY_ORDERS_RELAY_ORIGIN 仅作可选覆写（当 billing relay 位址不再是 Vercel 时）。
 * 秘密沿用两侧皆有的 GENERATION_BILLING_RELAY_SECRET（域分隔避免重放）。
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
 * 打一次 Vercel 中继。回 null＝通道不可用（env 缺失／网路／非 2xx／形状不符），
 * 由呼叫端收成「本实例无凭证且通道不可用」的 config_missing 错误——不假装成功。
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
  // 中继端已用同一个 fetchMapayOrders 做过窗口过滤，这里原样采纳，不二次过滤。
  return result as MapayOrdersResult;
}

/** 回 null＝找不到（支付商空 data）或通道不可用；用包装型别区分，呼叫端据此决定语义。 */
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
 * 拉取窗口内的支付商订单（**历史/中继相容入口**）。
 *
 * 生产实证后：上游 `act=order` 是「按单号单查」，不带单号会回 code:0（⇒ 本函式在真上游
 * 通常直接抛 upstream，这才是诚实行为——上游不支援列举）。对帐器的权威取数已改为
 * `fetchMapayOrder` 逐笔查（见 mapay-order-reconciliation.ts），本函式只保留给跨实例中继
 * 的 `op=orders` 相容路径，并沿用客户端时间过滤（时间戳不可解析的列保守保留）。
 */
export async function fetchMapayOrders(
  window: { since?: Date | string; until?: Date | string } = {},
  deps: ClientDeps = {},
): Promise<MapayOrdersResult> {
  // 本实例无凭证（对帐器跑在控制面）→ 转投 Vercel 中继；通道不可用则如实报 config_missing。
  if (!hasLocalConfig(deps)) {
    const relayed = await relayFetchMapayOrders(window, deps);
    if (relayed) return relayed;
    throw new MapayOrdersError("config_missing", "Missing MaPay merchant credentials.", {
      detail: "本实例没有 mPay 凭证，且跨实例订单查询通道不可用。",
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
      kept.push(order); // 时间不可解析 → 保守保留（残差由对帐器如实列出）
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
 * 单笔查询（**按商户单号**）：走 `act=order&out_trade_no=<单号>`。
 * 成功码但零订单＝回 null（明确的「查无此单」，与「成功查到」不混同）；
 * 业务错误（code:0／502）照样抛 MapayOrdersError，不吞成 null。
 */
export async function fetchMapayOrder(outTradeNo: string, deps: ClientDeps = {}): Promise<MapayOrder | null> {
  // 本实例无凭证 → 转投 Vercel 中继（找不到回 null，通道不可用如实报 config_missing）。
  if (!hasLocalConfig(deps)) {
    const relayed = await relayFetchMapayOrder(outTradeNo, deps);
    if (relayed) return relayed.order;
    throw new MapayOrdersError("config_missing", "Missing MaPay merchant credentials.", {
      detail: "本实例没有 mPay 凭证，且跨实例订单查询通道不可用。",
    });
  }

  const result = await requestOrders("order", { out_trade_no: outTradeNo }, deps, { notFoundAsEmpty: true });
  return result.orders.find((order) => order.outTradeNo === outTradeNo) ?? result.orders[0] ?? null;
}
