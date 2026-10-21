/**
 * 未登入新访客「进站播一次宣传片」的判定。
 *
 * 2026-09-27 暴君裁定落地（原始决策见记忆 manju-relay-objection-and-demo-onboarding-0922：
 * 「进站 cookie/session 未自动登入＝判定新用户 → 直接播影片」）。落地时暴君补两条：
 * ①频率＝每浏览器只自动播一次（回访的未登入用户不被反覆挡在门外）
 * ②收尾＝全屏浮层播完直进试玩（把震撼接上真实产线，不是看完就散）
 *
 * 判定链不碰 DOM，抽成纯函式以便 node --test 直接做行为断言：
 * 任何一条守卫被拿掉（例如漏掉 isLoading 就对水合中的已登入用户插播），
 * 这里的测试必须变红。
 */

/** 每浏览器一次：看过就记住，登出后回访也不再自动播。 */
export const PROMO_SEEN_KEY = "eimu-promo-seen-v1";

/**
 * 「开始试玩」要预填进输入框的那句话：片中那部《始皇帝的北境征途》的原始许愿，
 * 逐字来自一次真实会话（2026-08-29），不是文案。
 */
export const PROMO_TRIAL_PROMPT = "生成秦始皇骑北极熊的电影";

export interface PromoGateInput {
  /** 登入态水合中（useAuth().isLoading）。水合完成前一律不播。 */
  isLoading: boolean;
  isLoggedIn: boolean;
  /** localStorage 已记住看过（判定留给呼叫方，纯函式不碰储存）。 */
  seen: boolean;
  /** window.location.search。 */
  search: string;
  /** document.referrer（空串＝直接输入网址／书签）。 */
  referrer: string;
  /** navigator.userAgent（微信内建浏览器要在这里认）。 */
  userAgent: string;
}

/**
 * 深链交接进来的访客不是冷启访客：`?agent=1&q=` 是图库卡片交过来的一句话、
 * `?session=` 是别人分享过来的一段工作（见 ImagePlayground 的 D-18 交接）。
 * 对他插播宣传片＝盖掉他被打开的那份东西，所以这里让路。
 */
export function isHandoffLink(search: string): boolean {
  const params = new URLSearchParams(search);
  if (params.get("agent") === "1") return true;
  return params.has("session") || params.has("q");
}

/**
 * 渠道来访：人是被宣传片本身吸引来的（B 站投稿、微信公号/群转发），
 * 对他把同一支片再播一次＝把已经付出的注意力退回去，而且开场先浪费他 49 秒。
 * 2026-09-27 暴君提，同日落地。
 *
 * 三条认定，任一命中即算渠道来访：
 * ①我们自己贴出去的链接带的渠道参数（前提：投放时的链接要真的带参数）
 * ②来源域名是 B 站／微信（browser 预设的 strict-origin-when-cross-origin 会带 origin，
 *   主机名保留得下来）
 * ③微信内建浏览器（MicroMessenger UA）——朋友圈与群里点开一律在这里开，
 *   就算参数被转发链接洗掉也认得出来
 */
const CHANNEL_PARAM_KEYS = ["utm_source", "from", "ref"] as const;
const CHANNEL_TOKENS = ["bilibili", "b23", "weixin", "wechat", "wechat_mp", "wechatmp"] as const;
const CHANNEL_HOSTS = ["bilibili.com", "b23.tv", "weixin.qq.com", "wechat.com"] as const;
const WECHAT_UA = /micromessenger/i;

/** 渠道参数是否命中（值只要含关键词即可，如 utm_source=bilibili-video）。 */
export function hasChannelParam(search: string): boolean {
  const params = new URLSearchParams(search);
  for (const key of CHANNEL_PARAM_KEYS) {
    const value = params.get(key);
    if (!value) continue;
    const lower = value.toLowerCase();
    if (CHANNEL_TOKENS.some((token) => lower.includes(token))) return true;
  }
  return false;
}

/** 来源域名是否命中（含子网域：m.bilibili.com、www.bilibili.com 都算）。 */
export function hasChannelReferrer(referrer: string): boolean {
  if (!referrer) return false;
  let host = "";
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  return CHANNEL_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

export function isChannelArrival(input: Pick<PromoGateInput, "search" | "referrer" | "userAgent">): boolean {
  if (hasChannelParam(input.search)) return true;
  if (hasChannelReferrer(input.referrer)) return true;
  return WECHAT_UA.test(input.userAgent);
}

/**
 * 预览开关：`?promo=1` 无视全部守卫播一次。
 *
 * 为什么需要它：本地 LOCAL_TEST_MODE 一律算已登入、看过的人也不再播，
 * 验收的人就没有一键看到成品的路径。这条只服务验收——不写入「已看过」，
 * 所以预览不会把真正的首次进站体验吃掉。
 */
export function isForcedPreview(search: string): boolean {
  return new URLSearchParams(search).get("promo") === "1";
}

export function shouldPlayPromo(input: PromoGateInput): boolean {
  if (isForcedPreview(input.search)) return true;
  if (input.isLoading) return false;
  if (input.isLoggedIn) return false;
  if (input.seen) return false;
  if (isHandoffLink(input.search)) return false;
  if (isChannelArrival(input)) return false;
  return true;
}

// ── 进站判定只做一次 ────────────────────────────────────────────────────────
// 「进站播一次」是**进站那一刻**的决策，不是「登入态每翻一次就重判一次」。
// 2026-09-27 暴君实锤：登入中的用户按登出，isLoggedIn 由真翻假，判定 effect
// 重跑 ⇒ `?promo=1` 的强制预览又开一次浮层（连不带 promo 的未看过用户也会被
// 补播一段）。使用者只是登出，不是重新进站，不该有任何插播。
//
// 所以把「这页载入的决策已定案」做成显式状态：水合完成前是「还不知道」，
// 既不判也不记；一旦定案（decided），后续任何登入态变动都不再改判。

export interface PromoEntryDecision {
  /** 已对这页载入做出定案（水合完成后才会是 true）。 */
  decided: boolean;
  /** 定案结果：这次载入要不要播。只在 decided 为真时有意义。 */
  play: boolean;
}

/** 未定案的初始值（唯读）：挂载时当起点。 */
export const PROMO_ENTRY_UNDECIDED = { decided: false, play: false } as const;

export function resolvePromoEntry(
  previous: PromoEntryDecision,
  input: PromoGateInput,
): PromoEntryDecision {
  if (previous.decided) return previous;
  // 水合中＝还不知道登入态，不判也不记（记了等于对状态不明的用户定案）。
  if (input.isLoading) return previous;
  return { decided: true, play: shouldPlayPromo(input) };
}

// ── 待补送的试玩那句话 ──────────────────────────────────────────────────────
// 收尾输入框送出的那句话，在「还没登入」时送不出去：对话区会显示「请先登录」
// 与登入钮，而使用者的话已经离开输入框——那正是宣传片的主要观众（未登入访客），
// 掉了就是「一发送马上开新对话」这句承诺当场破功。
// 所以先把它存起来，登入态一翻真就自动补送。存 sessionStorage（不是 localStorage）：
// 这是「这次造访还没做完的动作」，关掉分页就该消失，不该留到下次进站。

export const PROMO_PENDING_KEY = "eimu-promo-trial-pending-v1";

/** 可注入的储存介面：node --test 用假物件验行为，不必碰真 sessionStorage。 */
export interface PromoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function writePendingTrial(store: PromoStorage | null | undefined, text: string): void {
  const trimmed = text.trim();
  if (!store || !trimmed) return;
  try {
    store.setItem(PROMO_PENDING_KEY, trimmed);
  } catch {
    // 私密模式／停用储存：补送这条路失效，但其余流程不该跟著坏。
  }
}

export function readPendingTrial(store: PromoStorage | null | undefined): string | null {
  if (!store) return null;
  try {
    return store.getItem(PROMO_PENDING_KEY);
  } catch {
    return null;
  }
}

/**
 * 结尾那句话送出去时的分流（2026-09-27 暴君第三轮：「发送按钮要产生一个真实的
 * 会话，还要针对大部分用户并没有登录的情形做适配，发送前先弹登录窗」）。
 *
 * 这条分流是纯函式：登入态决定「现在开跑」还是「先登入再开跑」。未登入那条不是
 * 「丢掉」——pending 一定带著那句话，登入态翻真后由呼叫方补送（同一句话，不重打）。
 * 空框按送出＝跑片中那句话（PROMO_TRIAL_PROMPT）。
 */
export type PromoTrialIntent =
  | { kind: "run"; text: string }
  | { kind: "login"; pending: string };

export function resolvePromoTrialIntent(rawText: string, isLoggedIn: boolean): PromoTrialIntent {
  const text = rawText.trim() || PROMO_TRIAL_PROMPT;
  return isLoggedIn ? { kind: "run", text } : { kind: "login", pending: text };
}

export function clearPendingTrial(store: PromoStorage | null | undefined): void {
  if (!store) return;
  try {
    store.removeItem(PROMO_PENDING_KEY);
  } catch {
    // 同上：清不掉不是致命错。
  }
}

/**
 * 主输入区（AI 助理 composer）那句话送不出去时，走与宣传片收尾**同一格**。
 *
 * 2026-09-27 追「登入完成 → 第一次提交」断点时发现：宣传片浮层为了不让那句话掉，
 * 建了「pending + 登入后自动补送」这条路；但**站上真正的入口（首页主输入区）
 * 没有吃到同一条保护**——未登入的人在那里打字送出，`send()` 的 lazy 建号以
 * `not_authenticated` 收场，composer 已经 `setText("")`（onSend 是 async，
 * 同步 throw 那条守卫永远到不了），而 GitHub 登入是同窗口整页跳转回来，
 * 元件状态全死 ⇒ 那句话连痕迹都没有，使用者得重打一遍。
 *
 * 这不是新机制：pending 那一格本来就是「这次造访还没做完的动作」的意思，
 * 主输入区被登入挡下的一句话与宣传片结尾那句话是同一种东西。存同一格＝
 * ImagePlayground 既有的「登入态翻真 → 补送」effect 原样接手（零新补送链）。
 *
 * 回传「补送 effect 将会读到的那个值」（读回同一格验证），呼叫方不必自己再读一次。
 * 空／全空白不上写（不覆盖已存的），但仍回报那一格现在的值。
 */
export function stashBlockedSend(store: PromoStorage | null | undefined, text: string): string | null {
  const trimmed = text.trim();
  if (trimmed) writePendingTrial(store, trimmed);
  return readPendingTrial(store);
}
