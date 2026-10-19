import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROMO_ENTRY_UNDECIDED,
  PROMO_PENDING_KEY,
  PROMO_SEEN_KEY,
  PROMO_TRIAL_PROMPT,
  hasChannelParam,
  hasChannelReferrer,
  isChannelArrival,
  clearPendingTrial,
  isHandoffLink,
  readPendingTrial,
  resolvePromoEntry,
  resolvePromoTrialIntent,
  shouldPlayPromo,
  stashBlockedSend,
  writePendingTrial,
} from "./promo-gate";

/**
 * 行为断言（不是源码字串探针）：每一条测的是判定函式的输出，
 * 把任何一条守卫拿掉都会让对应案例变红。
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

test("冷启的未登入访客：播一次", () => {
  assert.equal(shouldPlayPromo(coldVisitor), true);
});

test("登入态水合中不播——否则已登入用户每次进站都会被插播一段宣传片", () => {
  assert.equal(shouldPlayPromo({ ...coldVisitor, isLoading: true }), false);
});

test("已登入用户永不播", () => {
  assert.equal(shouldPlayPromo({ ...coldVisitor, isLoggedIn: true }), false);
});

test("看过就记住：登出后回访不再自动播（每浏览器一次）", () => {
  assert.equal(shouldPlayPromo({ ...coldVisitor, seen: true }), false);
});

test("深链交接让路：别页交过来的一句话 / 别人分享的一段工作都不插播", () => {
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?agent=1&q=%E5%81%9A%E4%B8%80%E5%BC%A0" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?session=0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" }), false);
  // 阴性对照：不带交接参数的 query 不该被误判成深链，否则宣传片会在正常进站时被吞掉。
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?utm_source=google" }), true);
  assert.equal(isHandoffLink("?utm_source=google"), false);
});

test("渠道来访不播：人是被宣传片吸引来的，别把同一支片再播一次", () => {
  // ①自家投放链接带的渠道参数
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?utm_source=bilibili" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?utm_source=weixin&utm_medium=article" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?from=bilibili-video" }), false);
  // ②来源域名（含子网域；B 站短链）
  assert.equal(shouldPlayPromo({ ...coldVisitor, referrer: "https://www.bilibili.com/video/BV1xx" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, referrer: "https://m.bilibili.com/video/BV1xx" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, referrer: "https://b23.tv/abc123" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, referrer: "https://mp.weixin.qq.com/s/abc" }), false);
  // ③微信内建浏览器：参数被转发链接洗掉也认得出来
  assert.equal(shouldPlayPromo({ ...coldVisitor, userAgent: WECHAT_UA }), false);
});

test("渠道认定的阴性对照：无关来源与无关参数不得误挡（误挡＝白送掉的首次进站体验）", () => {
  assert.equal(hasChannelParam("?utm_source=google"), false);
  assert.equal(hasChannelParam("?utm_source=zhihu"), false);
  assert.equal(hasChannelParam("?ref=friend"), false);
  assert.equal(hasChannelReferrer("https://www.google.com/search?q=eimu"), false);
  assert.equal(hasChannelReferrer("https://t.co/abc"), false);
  // 近似域名不得被 endsWith 误命中（evil-bilibili.com 不是 B 站）
  assert.equal(hasChannelReferrer("https://fake-bilibili.com/x"), false);
  assert.equal(hasChannelReferrer("https://bilibili.com.evil.test/x"), false);
  assert.equal(hasChannelReferrer(""), false);
  assert.equal(hasChannelReferrer("not a url"), false);
  assert.equal(isChannelArrival({ search: "?utm_source=google", referrer: "https://www.google.com/", userAgent: CHROME_UA }), false);
});

test("?promo=1 是验收用的强制预览：穿过全部守卫（含渠道判定），但 ?promo=0 不算", () => {
  assert.equal(shouldPlayPromo({ ...coldVisitor, isLoading: true, isLoggedIn: true, seen: true, search: "?promo=1" }), true);
  assert.equal(shouldPlayPromo({ ...coldVisitor, isLoggedIn: true, search: "?promo=0" }), false);
  assert.equal(shouldPlayPromo({ ...coldVisitor, search: "?promo=1&utm_source=bilibili" }), true);
});

/**
 * 进站判定只做一次（2026-09-27 项目负责人实锤「?promo 在从登入态 logout 时也错误触发」）：
 * 登出让 isLoggedIn 由真翻假、effect 重跑，若重判就会对只是登出的人再插播一次。
 * 这里用纯函式的连续呼叫模拟那串登入态变化，把「定案就不改判」钉死。
 */
test("进站判定只做一次：登出（登入态由真翻假）不得重判、不得再开浮层", () => {
  // ①已登入用户带著 ?promo=1 进站：定案为播（强制预览），这是他进站那一刻的决策。
  const preview = resolvePromoEntry(PROMO_ENTRY_UNDECIDED, {
    ...coldVisitor,
    isLoggedIn: true,
    search: "?promo=1",
  });
  assert.deepEqual(preview, { decided: true, play: true });

  // ②他按了登出：同一个定案物件原样返回——不再播一次。
  const afterLogout = resolvePromoEntry(preview, {
    ...coldVisitor,
    isLoggedIn: false,
    search: "?promo=1", // URL 上那条 promo 还在，也不得因此重播
  });
  assert.equal(afterLogout, preview);
  assert.equal(afterLogout.play, true, "沿用首次定案，不是重判出第二个 true");

  // ③反向也一样：已登入进站定案为不播，登出后不得补播一段。
  const quiet = resolvePromoEntry(PROMO_ENTRY_UNDECIDED, { ...coldVisitor, isLoggedIn: true });
  assert.deepEqual(quiet, { decided: true, play: false });
  assert.equal(resolvePromoEntry(quiet, { ...coldVisitor, isLoggedIn: false }).play, false);

  // ④冷启访客：首次定案照播。
  assert.deepEqual(resolvePromoEntry(PROMO_ENTRY_UNDECIDED, coldVisitor), {
    decided: true,
    play: true,
  });

  // ⑤水合中＝还不知道：不判也不记（记了等于对状态不明的用户定案），
  //    水合完成后才用真实登入态定案。
  const pending = resolvePromoEntry(PROMO_ENTRY_UNDECIDED, {
    ...coldVisitor,
    isLoading: true,
    isLoggedIn: true,
  });
  assert.equal(pending.decided, false);
  assert.equal(pending, PROMO_ENTRY_UNDECIDED);
  assert.equal(resolvePromoEntry(pending, { ...coldVisitor, isLoggedIn: false }).play, true);
});

test("储存键与试玩那句话是稳定的对外契约", () => {
  // 键改了＝所有看过的访客再被插播一次；这句话改了＝试玩预填对不上片中的原始许愿。
  assert.equal(PROMO_SEEN_KEY, "eimu-promo-seen-v1");
  assert.equal(PROMO_TRIAL_PROMPT, "生成秦始皇骑北极熊的电影");
});

test("待补送的试玩那句话：写入去空白、空字串不写、清掉就读不到", () => {
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
  assert.equal(readPendingTrial(fake), "生成秦始皇骑北极熊的电影", "空字串不得覆盖待送内容");
  clearPendingTrial(fake);
  assert.equal(readPendingTrial(fake), null);
  // 储存不可用（私密模式）时不炸，只让补送这条路失效。
  assert.doesNotThrow(() => writePendingTrial(null, "x"));
  assert.equal(readPendingTrial(null), null);
  assert.doesNotThrow(() => clearPendingTrial(undefined));
  assert.equal(PROMO_PENDING_KEY, "eimu-promo-trial-pending-v1");
});

/**
 * 主输入区那句话被登入挡下时走同一格（2026-09-27 追「登入完成 → 第一次提交」）。
 *
 * 测的是行为契约：stashBlockedSend 写进去的值，必须正好是既有补送 effect 会读到的
 * 那个值（同一条 key、同一个读取函式）——两边共用一格是这个修法的全部意义，
 * 它若偷偷用自己的 key，下面 readPendingTrial 的断言就会变红。
 */
test("主输入区送不出去的那句话：写进宣传片同一格，补送 effect 读得到", () => {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  // 使用者打的那句话（前后空白去干净）＝补送时真正会被送出去的字串。
  assert.equal(stashBlockedSend(fake, "  做一张水彩橘猫  "), "做一张水彩橘猫");
  assert.equal(readPendingTrial(fake), "做一张水彩橘猫");
  assert.equal(fake.getItem(PROMO_PENDING_KEY), "做一张水彩橘猫");
  // 空／全空白不得覆盖已存的（否则一次空句就把使用者的话吃掉）。
  assert.equal(stashBlockedSend(fake, "   "), "做一张水彩橘猫");
  assert.equal(readPendingTrial(fake), "做一张水彩橘猫");
  // 储存不可用（私密模式）＝补送这条路失效，但不炸、回 null。
  assert.equal(stashBlockedSend(null, "x"), null);
  assert.equal(stashBlockedSend(undefined, "  "), null);
});


/**
 * 结尾送出的分流（2026-09-27 项目负责人第三轮）：未登入不得直接把话吞掉——必须留一份
 * pending 走登入；登入态才当场开跑。空框（直接按送出）两条都要用片中的那句话。
 */
test("结尾送出分流：未登入留 pending 走登入，登入当场开跑", () => {
  const cold = resolvePromoTrialIntent("生成秦始皇骑北极熊的电影", false);
  assert.deepEqual(cold, { kind: "login", pending: "生成秦始皇骑北极熊的电影" });

  const warm = resolvePromoTrialIntent("生成秦始皇骑北极熊的电影", true);
  assert.deepEqual(warm, { kind: "run", text: "生成秦始皇骑北极熊的电影" });

  // 使用者自己打的那句话优先于片中的许愿（两种登入态都不准被换掉）。
  assert.equal(resolvePromoTrialIntent("  一只猫在月球上跳舞  ", true).kind, "run");
  assert.deepEqual(resolvePromoTrialIntent("  一只猫在月球上跳舞  ", false), {
    kind: "login",
    pending: "一只猫在月球上跳舞",
  });

  // 空框＝他直接按了送出：跑片中那句话，不是空字串。
  assert.deepEqual(resolvePromoTrialIntent("   ", false), {
    kind: "login",
    pending: PROMO_TRIAL_PROMPT,
  });
  assert.deepEqual(resolvePromoTrialIntent("", true), { kind: "run", text: PROMO_TRIAL_PROMPT });
});

/**
 * 接线探针（**变更探针，不是 oracle**）：上面那条是真的行为断言（写进同一格、
 * 读得回来）；这里只钉住「主输入区那条路真的接到那一格」的四个接点，任何一个被
 * 拔掉（参数漏传＝未登入的人打完字那句话还是消失）这里就变红。
 * 真人浏览器端到端（打字→被挡→GitHub 回来→自动送出）未验，不在本测试范围。
 */
test("接线探针：hook 的 auth 回报 → Surface → PromptInput → ImagePlayground 存进同一格", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const hook = read("../../hooks/use-agent-chat.ts");
  const surface = read("../agent-chat/AgentChatSurface.tsx");
  const prompt = read("../PromptInput.tsx");
  const playground = read("../ImagePlayground.tsx");

  // hook：认得出「送不出去是因为登入」，且只在 auth 这一种才上抛。
  assert.match(hook, /onSendBlockedByAuth\?: \(text: string\) => void/);
  assert.match(hook, /closedReasonRef\.current === "auth"[\s\S]{0,120}onSendBlockedByAuth\?\.\(trimmed\)/);
  // 三层转传（漏一层＝整条断）。
  assert.match(surface, /onSendBlockedByAuth\?: \(text: string\) => void/);
  assert.match(surface, /onSendBlockedByAuth \? \{ onSendBlockedByAuth \} : \{\}/);
  assert.match(prompt, /onSendBlockedByAuth \? \{ onSendBlockedByAuth \} : \{\}/);
  // 收口：存进的必须就是宣传片那一格（存错格＝补送 effect 读不到，等于没修）。
  assert.match(playground, /stashBlockedSend\(/);
  assert.match(playground, /onSendBlockedByAuth=\{handleSendBlockedByAuth\}/);
  assert.match(playground, /readPendingTrial\(/);
});
