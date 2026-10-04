import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildMapayCheckoutFields,
  createMapayOrderId,
  getMapaySubmitUrl,
  mapayMoneyAcceptable,
  signMapayParams,
  verifyMapaySignature,
} from "./mapay.ts";

function md5(value: string) {
  return createHash("md5").update(value, "utf8").digest("hex");
}

test("signMapayParams signs sorted epay fields without sign_type", () => {
  const params = {
    type: "alipay",
    pid: "11976",
    out_trade_no: "IMG202606150001",
    name: "梦芽 · 轻度尝鲜包",
    money: "9.90",
    sign_type: "MD5",
  };

  assert.equal(
    signMapayParams(params, "secret"),
    md5("money=9.90&name=梦芽 · 轻度尝鲜包&out_trade_no=IMG202606150001&pid=11976&type=alipaysecret"),
  );
});

test("buildMapayCheckoutFields creates signed checkout fields for a plan", () => {
  const fields = buildMapayCheckoutFields({
    config: {
      pid: "11976",
      key: "secret",
      gatewayUrl: "https://mzf.mapay.cc/xpay/epay/",
      siteUrl: "https://image.tinchak0207.xyz",
    },
    orderId: "IMG202606150002",
    paymentType: "alipay",
    plan: { id: "starter", name: "梦芽 · 轻度尝鲜包", price: 9.9, coins: 100 },
  });

  assert.equal(fields.pid, "11976");
  assert.equal(fields.type, "alipay");
  assert.equal(fields.money, "9.90");
  assert.equal(fields.notify_url, "https://image.tinchak0207.xyz/api/payments/mapay/notify");
  assert.equal(fields.return_url, "https://image.tinchak0207.xyz/api/payments/mapay/return");
  assert.equal(fields.name, "image.tinchak0207.xyz 梦芽 · 轻度尝鲜包 100金币");
  assert.equal(fields.param, "starter");
  assert.equal(fields.sign_type, "MD5");
  assert.equal(verifyMapaySignature(fields, "secret"), true);
});

test("createMapayOrderId stays short enough for new-api redemption lookup names", () => {
  assert.match(createMapayOrderId(1_766_000_000_000, "abcdef123456"), /^IMG[A-Z0-9]+$/);
  assert.ok(createMapayOrderId(1_766_000_000_000, "abcdef123456").length <= 20);
});

test("getMapaySubmitUrl accepts base or submit.php gateway urls", () => {
  assert.equal(
    getMapaySubmitUrl("https://mzf.mapay.cc/xpay/epay/"),
    "https://mzf.mapay.cc/xpay/epay/submit.php",
  );
  assert.equal(
    getMapaySubmitUrl("https://mzf.mapay.cc/xpay/epay/submit.php"),
    "https://mzf.mapay.cc/xpay/epay/submit.php",
  );
});

test("mapayMoneyAcceptable tolerates channel fees above the expected amount", () => {
  // 2026-09-19 漏单实案：下单 9.90、渠道回调 9.93。
  assert.equal(mapayMoneyAcceptable("9.93", 9.9), true);
  assert.equal(mapayMoneyAcceptable("9.90", 9.9), true);
});

test("mapayMoneyAcceptable rejects underpayment and over-tolerance amounts", () => {
  assert.equal(mapayMoneyAcceptable("9.89", 9.9), false);
  assert.equal(mapayMoneyAcceptable("10.41", 9.9), false);
  assert.equal(mapayMoneyAcceptable("905", 900), true);
  assert.equal(mapayMoneyAcceptable("899.99", 900), false);
});

test("mapayMoneyAcceptable rejects missing or non-numeric money", () => {
  assert.equal(mapayMoneyAcceptable(undefined, 9.9), false);
  assert.equal(mapayMoneyAcceptable("", 9.9), false);
  assert.equal(mapayMoneyAcceptable("abc", 9.9), false);
});
