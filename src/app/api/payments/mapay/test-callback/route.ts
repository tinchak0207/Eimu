import { NextRequest, NextResponse } from "next/server";
import { PLANS } from "@/lib/plans";
import {
  createMapayOrderId,
  formatMapayMoney,
  getMapayConfig,
  normalizeMapayPaymentType,
  signMapayParams,
  type MapayFields,
} from "@/lib/mapay";

export const runtime = "nodejs";

function mask(value: string) {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "";
}

export async function GET(req: NextRequest) {
  const expectedToken = process.env.MAPAY_TEST_TOKEN ?? "";
  const token = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-mapay-test-token") ?? "";

  if (!expectedToken || token !== expectedToken) {
    return NextResponse.json({ success: false, message: "not_found" }, { status: 404 });
  }

  const plan = PLANS.find((item) => item.id === (req.nextUrl.searchParams.get("plan") ?? "starter"));
  if (!plan) {
    return NextResponse.json({ success: false, message: "plan_not_found" }, { status: 400 });
  }

  const config = getMapayConfig();
  const fields: MapayFields = {
    pid: config.pid,
    type: normalizeMapayPaymentType(req.nextUrl.searchParams.get("type")),
    out_trade_no: `TEST${createMapayOrderId().slice(3)}`,
    trade_no: `SIM${Date.now().toString(36).toUpperCase()}`,
    trade_status: "TRADE_SUCCESS",
    name: `${config.siteUrl.replace(/^https?:\/\//, "")} ${plan.name} ${plan.coins}金币`,
    money: formatMapayMoney(plan.price),
    param: plan.id,
  };
  const signedFields = {
    ...fields,
    sign: signMapayParams(fields, config.key),
    sign_type: "MD5",
  };
  const body = new URLSearchParams(signedFields);

  const notify = await fetch(new URL("/api/payments/mapay/notify", config.siteUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  const notifyText = await notify.text();

  const returnUrl = new URL("/api/payments/mapay/return", config.siteUrl);
  for (const [key, value] of body.entries()) returnUrl.searchParams.set(key, value);
  const returned = await fetch(returnUrl, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(5000) });
  const location = returned.headers.get("location") ?? "";
  const cdk = location ? (new URL(location).searchParams.get("cdk") ?? "") : "";

  return NextResponse.json({
    success: notify.ok && notifyText === "success" && !!cdk,
    orderId: fields.out_trade_no,
    plan: plan.id,
    notifyStatus: notify.status,
    notifyText,
    returnStatus: returned.status,
    hasCdk: !!cdk,
    cdk: req.nextUrl.searchParams.get("reveal") === "1" ? cdk : mask(cdk),
    location: req.nextUrl.searchParams.get("reveal") === "1" ? location : location.replace(cdk, mask(cdk)),
  });
}
