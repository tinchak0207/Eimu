import test from "node:test";
import assert from "node:assert/strict";
import {
  PROMO_SEEN_KEY,
  PROMO_TRIAL_PROMPT,
  hasChannelParam,
  hasChannelReferrer,
  isChannelArrival,
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
  referrer: "",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0 Safari/537.36",
};

const CHROME_UA = coldVisitor.userAgent;
const WECHAT_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.49";

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
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?utm_source=google" }), true);
  assert.equal(isHandoffLink("?utm_source=google"), false);
});

test("渠道來訪不播：人是被宣傳片吸引來的，別把同一支片再播一次", () => {
  // ①自家投放鏈接帶的渠道參數
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?utm_source=bilibili" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?utm_source=weixin&utm_medium=article" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?from=bilibili-video" }), false);
  // ②來源域名（含子網域；B 站短鏈）
  assert.equal(shouldPlayPromo({ ...coldVisitor, referrer: "https://www.bilibili.com/video/BV1xx" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, referrer: "https://m.bilibili.com/video/BV1xx" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, referrer: "https://b23.tv/abc123" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, referrer: "https://mp.weixin.qq.com/s/abc" }), false);
  // ③微信內建瀏覽器：參數被轉發鏈接洗掉也認得出來
  assert.equal(shouldPlayPromo({ ...coldVisitor, userAgent: WECHAT_UA }), false);
});

test("渠道認定的陰性對照：無關來源與無關參數不得誤擋（誤擋＝白送掉的首次進站體驗）", () => {
  assert.equal(hasChannelParam("?utm_source=google"), false);
  assert.equal(hasChannelParam("?utm_source=zhihu"), false);
  assert.equal(hasChannelParam("?ref=friend"), false);
  assert.equal(hasChannelReferrer("https://www.google.com/search?q=eimu"), false);
  assert.equal(hasChannelReferrer("https://t.co/abc"), false);
  // 近似域名不得被 endsWith 誤命中（evil-bilibili.com 不是 B 站）
  assert.equal(hasChannelReferrer("https://fake-bilibili.com/x"), false);
  assert.equal(hasChannelReferrer("https://bilibili.com.evil.test/x"), false);
  assert.equal(hasChannelReferrer(""), false);
  assert.equal(hasChannelReferrer("not a url"), false);
  assert.equal(isChannelArrival({ search: "?utm_source=google", referrer: "https://www.google.com/", userAgent: CHROME_UA }), false);
});

test("?promo=1 是驗收用的強制預覽：穿過全部守衛（含渠道判定），但 ?promo=0 不算", () => {
  assert.equal(shouldPlayPromo({ ...coldVisitor, isLoading: true, isLoggedIn: true, seen: true, search: "?promo=1" }), true);
  assert.equal(shouldPlayPromo({ ...coldVisitor, isLoggedIn: true, search: "?promo=0" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?promo=1&utm_source=bilibili" }), true);
});

test("儲存鍵與試玩那句話是穩定的對外契約", () => {
  // 鍵改了＝所有看過的訪客再被插播一次；這句話改了＝試玩預填對不上片中的原始許願。
  assert.equal(PROMO_SEEN_KEY, "eimu-promo-seen-v1");
  assert.equal(PROMO_TRIAL_PROMPT, "生成秦始皇骑北极熊的电影");
});
