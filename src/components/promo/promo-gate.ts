/**
 * 未登入新訪客「進站播一次宣傳片」的判定。
 *
 * 2026-09-27 暴君裁定落地（原始決策見記憶 manju-relay-objection-and-demo-onboarding-0922：
 * 「進站 cookie/session 未自動登入＝判定新用戶 → 直接播影片」）。落地時暴君補兩條：
 * ①頻率＝每瀏覽器只自動播一次（回訪的未登入用戶不被反覆擋在門外）
 * ②收尾＝全屏浮層播完直進試玩（把震撼接上真實產線，不是看完就散）
 *
 * 判定鏈不碰 DOM，抽成純函式以便 node --test 直接做行為斷言：
 * 任何一條守衛被拿掉（例如漏掉 isLoading 就對水合中的已登入用戶插播），
 * 這裡的測試必須變紅。
 */

/** 每瀏覽器一次：看過就記住，登出後回訪也不再自動播。 */
export const PROMO_SEEN_KEY = "eimu-promo-seen-v1";

/**
 * 「开始试玩」要預填進輸入框的那句話：片中那部《始皇帝的北境征途》的原始許願，
 * 逐字來自一次真實會話（2026-08-29），不是文案。
 */
export const PROMO_TRIAL_PROMPT = "生成秦始皇骑北极熊的电影";

export interface PromoGateInput {
  /** 登入態水合中（useAuth().isLoading）。水合完成前一律不播。 */
  isLoading: boolean;
  isLoggedIn: boolean;
  /** localStorage 已記住看過（判定留給呼叫方，純函式不碰儲存）。 */
  seen: boolean;
  /** window.location.search。 */
  search: string;
  /** document.referrer（空串＝直接輸入網址／書籤）。 */
  referrer: string;
  /** navigator.userAgent（微信內建瀏覽器要在這裡認）。 */
  userAgent: string;
}

/**
 * 深鏈交接進來的訪客不是冷啟訪客：`?agent=1&q=` 是圖庫卡片交過來的一句話、
 * `?session=` 是別人分享過來的一段工作（見 ImagePlayground 的 D-18 交接）。
 * 對他插播宣傳片＝蓋掉他被打開的那份東西，所以這裡讓路。
 */
export function isHandoffLink(search: string): boolean {
  const params = new URLSearchParams(search);
  if (params.get("agent") === "1") return true;
  return params.has("session") || params.has("q");
}

/**
 * 渠道來訪：人是被宣傳片本身吸引來的（B 站投稿、微信公號/群轉發），
 * 對他把同一支片再播一次＝把已經付出的注意力退回去，而且開場先浪費他 49 秒。
 * 2026-09-27 暴君提，同日落地。
 *
 * 三條認定，任一命中即算渠道來訪：
 * ①我們自己貼出去的鏈接帶的渠道參數（前提：投放時的鏈接要真的帶參數）
 * ②來源域名是 B 站／微信（browser 預設的 strict-origin-when-cross-origin 會帶 origin，
 *   主機名保留得下來）
 * ③微信內建瀏覽器（MicroMessenger UA）——朋友圈與群裡點開一律在這裡開，
 *   就算參數被轉發鏈接洗掉也認得出來
 */
const CHANNEL_PARAM_KEYS = ["utm_source", "from", "ref"] as const;
const CHANNEL_TOKENS = ["bilibili", "b23", "weixin", "wechat", "wechat_mp", "wechatmp"] as const;
const CHANNEL_HOSTS = ["bilibili.com", "b23.tv", "weixin.qq.com", "wechat.com"] as const;
const WECHAT_UA = /micromessenger/i;

/** 渠道參數是否命中（值只要含關鍵詞即可，如 utm_source=bilibili-video）。 */
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

/** 來源域名是否命中（含子網域：m.bilibili.com、www.bilibili.com 都算）。 */
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
 * 預覽開關：`?promo=1` 無視全部守衛播一次。
 *
 * 為什麼需要它：本地 LOCAL_TEST_MODE 一律算已登入、看過的人也不再播，
 * 驗收的人就沒有一鍵看到成品的路徑。這條只服務驗收——不寫入「已看過」，
 * 所以預覽不會把真正的首次進站體驗吃掉。
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

// ── 進站判定只做一次 ────────────────────────────────────────────────────────
// 「進站播一次」是**進站那一刻**的決策，不是「登入態每翻一次就重判一次」。
// 2026-09-27 暴君實錘：登入中的用戶按登出，isLoggedIn 由真翻假，判定 effect
// 重跑 ⇒ `?promo=1` 的強制預覽又開一次浮層（連不帶 promo 的未看過用戶也會被
// 補播一段）。使用者只是登出，不是重新進站，不該有任何插播。
//
// 所以把「這頁載入的決策已定案」做成顯式狀態：水合完成前是「還不知道」，
// 既不判也不記；一旦定案（decided），後續任何登入態變動都不再改判。

export interface PromoEntryDecision {
  /** 已對這頁載入做出定案（水合完成後才會是 true）。 */
  decided: boolean;
  /** 定案結果：這次載入要不要播。只在 decided 為真時有意義。 */
  play: boolean;
}

/** 未定案的初始值（唯讀）：掛載時當起點。 */
export const PROMO_ENTRY_UNDECIDED = { decided: false, play: false } as const;

export function resolvePromoEntry(
  previous: PromoEntryDecision,
  input: PromoGateInput,
): PromoEntryDecision {
  if (previous.decided) return previous;
  // 水合中＝還不知道登入態，不判也不記（記了等於對狀態不明的用戶定案）。
  if (input.isLoading) return previous;
  return { decided: true, play: shouldPlayPromo(input) };
}

// ── 待補送的試玩那句話 ──────────────────────────────────────────────────────
// 收尾輸入框送出的那句話，在「還沒登入」時送不出去：對話區會顯示「请先登录」
// 與登入鈕，而使用者的話已經離開輸入框——那正是宣傳片的主要觀眾（未登入訪客），
// 掉了就是「一发送马上开新对话」這句承諾當場破功。
// 所以先把它存起來，登入態一翻真就自動補送。存 sessionStorage（不是 localStorage）：
// 這是「這次造訪還沒做完的動作」，關掉分頁就該消失，不該留到下次進站。

export const PROMO_PENDING_KEY = "eimu-promo-trial-pending-v1";

/** 可注入的儲存介面：node --test 用假物件驗行為，不必碰真 sessionStorage。 */
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
    // 私密模式／停用儲存：補送這條路失效，但其餘流程不該跟著壞。
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
 * 結尾那句話送出去時的分流（2026-09-27 暴君第三輪：「发送按钮要产生一个真实的
 * 会话，还要针对大部分用户并没有登录的情形做适配，发送前先弹登录窗」）。
 *
 * 這條分流是純函式：登入態決定「現在開跑」還是「先登入再開跑」。未登入那條不是
 * 「丟掉」——pending 一定帶著那句話，登入態翻真後由呼叫方補送（同一句話，不重打）。
 * 空框按送出＝跑片中那句話（PROMO_TRIAL_PROMPT）。
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
    // 同上：清不掉不是致命錯。
  }
}
