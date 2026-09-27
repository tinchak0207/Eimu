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

export function shouldPlayPromo(input: PromoGateInput): boolean {
  if (input.isLoading) return false;
  if (input.isLoggedIn) return false;
  if (input.seen) return false;
  if (isHandoffLink(input.search)) return false;
  return true;
}
