import { createHash, randomUUID } from "node:crypto";

export type MapayPaymentType = "alipay" | "wxpay" | "qqpay";

export interface MapayConfig {
  pid: string;
  key: string;
  gatewayUrl: string;
  siteUrl: string;
}

export interface MapayPlanInput {
  id: string;
  name: string;
  price: number;
  coins: number;
}

export type MapayFields = Record<string, string>;

const DEFAULT_GATEWAY_URL = "https://mzf.mapay.cc/xpay/epay/";
const DEFAULT_SITE_URL = "https://image.tinchak0207.xyz";
const PAYMENT_TYPES = new Set<MapayPaymentType>(["alipay", "wxpay", "qqpay"]);

export function getMapayConfig(env: Record<string, string | undefined> = process.env): MapayConfig {
  const pid = (env.MAPAY_PID ?? env.MAPAY_MERCHANT_ID ?? "").trim();
  const key = (env.MAPAY_KEY ?? env.MAPAY_SECRET ?? "").trim();
  const gatewayUrl = (env.MAPAY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL).trim();
  const siteUrl = (env.NEXT_PUBLIC_SITE_URL ?? env.SITE_URL ?? DEFAULT_SITE_URL).trim().replace(/\/+$/, "");

  if (!pid || !key) {
    throw new Error("Missing MaPay merchant credentials.");
  }

  return { pid, key, gatewayUrl, siteUrl };
}

export function getMapaySubmitUrl(gatewayUrl: string): string {
  const url = gatewayUrl.trim();
  if (/\/submit\.php(?:$|\?)/.test(url)) return url;
  return new URL("submit.php", url.endsWith("/") ? url : `${url}/`).toString();
}

export function normalizeMapayPaymentType(value: string | null): MapayPaymentType {
  return PAYMENT_TYPES.has(value as MapayPaymentType) ? (value as MapayPaymentType) : "alipay";
}

export function createMapayOrderId(now = Date.now(), suffix = randomUUID()): string {
  return `IMG${now.toString(36).toUpperCase()}${suffix.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

export function formatMapayMoney(value: number): string {
  return value.toFixed(2);
}

export function signMapayParams(params: MapayFields, key: string): string {
  const payload = Object.keys(params)
    .filter((name) => name !== "sign" && name !== "sign_type" && params[name] !== "")
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join("&");

  return createHash("md5").update(`${payload}${key}`, "utf8").digest("hex");
}

export function verifyMapaySignature(params: MapayFields, key: string): boolean {
  const sign = params.sign ?? "";
  return !!sign && signMapayParams(params, key).toLowerCase() === sign.toLowerCase();
}

export function isMapayPaymentSuccessful(params: MapayFields): boolean {
  const status = (params.trade_status ?? params.status ?? "").toUpperCase();
  return status === "TRADE_SUCCESS" || status === "SUCCESS" || status === "1";
}

export function mapayMoneyMatches(actual: string | undefined, expected: number): boolean {
  return Number(actual).toFixed(2) === formatMapayMoney(expected);
}

export function buildMapayCheckoutFields(input: {
  config: MapayConfig;
  orderId: string;
  paymentType: MapayPaymentType;
  plan: MapayPlanInput;
}): MapayFields {
  const { config, orderId, paymentType, plan } = input;
  const fields: MapayFields = {
    pid: config.pid,
    type: paymentType,
    out_trade_no: orderId,
    notify_url: `${config.siteUrl}/api/payments/mapay/notify`,
    return_url: `${config.siteUrl}/api/payments/mapay/return`,
    name: `image.tinchak0207.xyz ${plan.name} ${plan.coins}金币`,
    money: formatMapayMoney(plan.price),
    param: plan.id,
    sitename: "image.tinchak0207.xyz",
  };

  return {
    ...fields,
    sign: signMapayParams(fields, config.key),
    sign_type: "MD5",
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderMapaySubmitPage(action: string, fields: MapayFields): string {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join("");

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>跳转支付</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><form id="mapay-submit" method="post" action="${escapeHtml(action)}">${inputs}<noscript><button type="submit">继续支付</button></noscript></form><script>document.getElementById("mapay-submit").submit();</script></body></html>`;
}
