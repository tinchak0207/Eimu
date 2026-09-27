import test from "node:test";
import assert from "node:assert/strict";
import {
  PROMO_PENDING_KEY,
  PROMO_SEEN_KEY,
  PROMO_TRIAL_PROMPT,
  hasChannelParam,
  hasChannelReferrer,
  isChannelArrival,
  clearPendingTrial,
  isHandoffLink,
  readPendingTrial,
  resolvePromoTrialIntent,
  shouldPlayPromo,
  writePendingTrial,
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

test("待補送的試玩那句話：寫入去空白、空字串不寫、清掉就讀不到", () => {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  assert.equal(readPendingTrial(fake), null);
  writePendingTrial(fake, "  生成秦始皇骑北极熊的电影  ");
  assert.equal(readPendingTrial(fake), "生成秦始皇骑北极熊的电影");
  writePendingTrial(fake, "   ");
  assert.equal(readPendingTrial(fake), "生成秦始皇骑北极熊的电影", "空字串不得覆蓋待送內容");
  clearPendingTrial(fake);
  assert.equal(readPendingTrial(fake), null);
  // 儲存不可用（私密模式）時不炸，只讓補送這條路失效。
  assert.doesNotThrow(() => writePendingTrial(null, "x"));
  assert.equal(readPendingTrial(null), null);
  assert.doesNotThrow(() => clearPendingTrial(undefined));
  assert.equal(PROMO_PENDING_KEY, "eimu-promo-trial-pending-v1");
});


/**
 * 結尾送出的分流（2026-09-27 暴君第三輪）：未登入不得直接把話吞掉——必須留一份
 * pending 走登入；登入態才當場開跑。空框（直接按送出）兩條都要用片中的那句話。
 */
test("結尾送出分流：未登入留 pending 走登入，登入當場開跑", () => {
  const cold = resolvePromoTrialIntent("生成秦始皇骑北极熊的电影", false);
  assert.deepEqual(cold, { kind: "login", pending: "生成秦始皇骑北极熊的电影" });

  const warm = resolvePromoTrialIntent("生成秦始皇骑北极熊的电影", true);
  assert.deepEqual(warm, { kind: "run", text: "生成秦始皇骑北极熊的电影" });

  // 使用者自己打的那句話優先於片中的許願（兩種登入態都不准被換掉）。
  assert.equal(resolvePromoTrialIntent("  一只猫在月球上跳舞  ", true).kind, "run");
  assert.deepEqual(resolvePromoTrialIntent("  一只猫在月球上跳舞  ", false), {
    kind: "login",
    pending: "一只猫在月球上跳舞",
  });

  // 空框＝他直接按了送出：跑片中那句話，不是空字串。
  assert.deepEqual(resolvePromoTrialIntent("   ", false), {
    kind: "login",
    pending: PROMO_TRIAL_PROMPT,
  });
  assert.deepEqual(resolvePromoTrialIntent("", true), { kind: "run", text: PROMO_TRIAL_PROMPT });
});
