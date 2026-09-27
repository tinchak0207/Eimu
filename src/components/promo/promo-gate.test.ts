import test from "node:test";
import assert from "node:assert/strict";
import {
  PROMO_SEEN_KEY,
  PROMO_TRIAL_PROMPT,
  isHandoffLink,
  shouldPlayPromo,
} from "./promo-gate";

/**
 * 行為斷言（不是源碼字串探針）：每一條測的是判定函式的輸出，
 * 把任何一條守衛拿掉都會讓對應案例變紅。
 */

const coldVisitor = {
  isLoading: false,
  isLoggedIn: false,
  seen: false,
  search: "",
};

test("冷啟的未登入訪客：播一次", () => {
  assert.equal(shouldPlayPromo(coldVisitor), true);
});

test("登入態水合中不播——否則已登入用戶每次進站都會被插播一段宣傳片", () => {
  assert.equal(shouldPlayPromo({ ...coldVisitor, isLoading: true }), false);
});

test("已登入用戶永不播", () => {
  assert.equal(shouldPlayPromo({ ...coldVisitor, isLoggedIn: true }), false);
});

test("看過就記住：登出後回訪不再自動播（每瀏覽器一次）", () => {
  assert.equal(shouldPlayPromo({ ...coldVisitor, seen: true }), false);
});

test("深鏈交接讓路：別頁交過來的一句話 / 別人分享的一段工作都不插播", () => {
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?agent=1&q=%E5%81%9A%E4%B8%80%E5%BC%A0" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?session=0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" }), false);
  // 陰性對照：不帶交接參數的 query 不該被誤判成深鏈，否則宣傳片會在正常進站時被吞掉。
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?utm_source=bilibili" }), true);
  assert.equal(isHandoffLink("?utm_source=bilibili"), false);
});

test("?promo=1 是驗收用的強制預覽：穿過全部守衛，但深鏈以外的正常進站不受影響", () => {
  assert.equal(shouldPlayPromo({ ...coldVisitor, isLoading: true, isLoggedIn: true, seen: true, search: "?promo=1" }), true);
  assert.equal(shouldPlayPromo({ ...coldVisitor, isLoggedIn: true, search: "?promo=0" }), false);
});

test("儲存鍵與試玩那句話是穩定的對外契約", () => {
  // 鍵改了＝所有看過的訪客再被插播一次；這句話改了＝試玩預填對不上片中的原始許願。
  assert.equal(PROMO_SEEN_KEY, "eimu-promo-seen-v1");
  assert.equal(PROMO_TRIAL_PROMPT, "生成秦始皇骑北极熊的电影");
});
