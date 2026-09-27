// 新人禮首登彈窗的「彈／不彈」判準（行為斷言）。
//
// 這條閘門有兩層，測的就是這兩層各自說「彈」與「不彈」：
//   ①服務端權威：/api/auth/me 的加法欄位。pending=true 且幣數/張數/文案齊全＝彈；
//     「未發放」與「已回執（ack 後）」都回 pending=false → 不彈。
//   ②本機輔助：localStorage 只擋同一台設備的重複彈；換設備（新 store）不得生效，
//     否則是拿本機狀態冒充服務端權威。

import assert from "node:assert/strict";
import test from "node:test";

import {
  WELCOME_GIFT_MODAL_SEEN_KEY,
  markWelcomeGiftModalSeenLocally,
  parseWelcomeGiftModal,
  welcomeGiftModalSeenLocally,
  type WelcomeGiftModalStorage,
} from "./welcome-gift-modal";

function fakeStorage(seed?: string): WelcomeGiftModalStorage & { value: string | null } {
  return {
    value: seed ?? null,
    getItem(key: string) {
      assert.equal(key, WELCOME_GIFT_MODAL_SEEN_KEY);
      return this.value;
    },
    setItem(key: string, value: string) {
      assert.equal(key, WELCOME_GIFT_MODAL_SEEN_KEY);
      this.value = value;
    },
  };
}

test("有待展示（pending=true＋币数/张数/文案齐全）→ 回非 null＝要弹", () => {
  const modal = parseWelcomeGiftModal({
    pending: true,
    coins: 5,
    images: 5,
    title: "新人礼已到账",
    body: "已送你 5 币，够生成约 5 张图",
  });
  assert.ok(modal, "齐全的待展示必须弹");
  assert.equal(modal.coins, 5);
  assert.equal(modal.images, 5);
  assert.equal(modal.title, "新人礼已到账");
});

test("未发放的用戶 → 回 null＝不弹", () => {
  assert.equal(parseWelcomeGiftModal(null), null);
  assert.equal(parseWelcomeGiftModal(undefined), null);
  assert.equal(parseWelcomeGiftModal({ pending: false }), null, "沒有新人礼就是 pending=false");
  assert.equal(parseWelcomeGiftModal({}), null, "缺欄位一律當不彈");
  assert.equal(parseWelcomeGiftModal("新人礼已到账"), null);
});

test("ack 後（服务端改说 pending=false）→ 回 null＝不再弹", () => {
  // 回执写进 modal_seen_at 之后，服务端不再說「待展示」——形狀與「未發放」同義。
  assert.equal(parseWelcomeGiftModal({ pending: false, coins: 5, images: 5 }), null);
});

test("形状不对一律不弹（宁可少弹一次，也不弹半截数据）", () => {
  const good = { pending: true, coins: 5, images: 5, title: "新人礼已到账", body: "已送你 5 币" };
  assert.equal(parseWelcomeGiftModal({ ...good, coins: 0 }), null);
  assert.equal(parseWelcomeGiftModal({ ...good, coins: "五" }), null);
  assert.equal(parseWelcomeGiftModal({ ...good, images: 1.5 }), null);
  assert.equal(parseWelcomeGiftModal({ ...good, title: "   " }), null);
  assert.equal(parseWelcomeGiftModal({ ...good, body: "" }), null);
});

test("本机辅助闸门只挡同一台设备；换设备不得因此不弹", () => {
  const deviceA = fakeStorage();
  assert.equal(welcomeGiftModalSeenLocally(42, deviceA), false, "没看过＝false");

  markWelcomeGiftModalSeenLocally(42, deviceA);
  assert.equal(welcomeGiftModalSeenLocally(42, deviceA), true, "看过＝true");
  assert.equal(welcomeGiftModalSeenLocally(43, deviceA), false, "换账号各看各的");

  // 换设备＝另一份空存储：本机标记不得冒充服务端权威。
  assert.equal(welcomeGiftModalSeenLocally(42, fakeStorage()), false);
  // 存储不可用（私密模式／配额满）不炸，也不误判成「看过」。
  assert.equal(welcomeGiftModalSeenLocally(42, null), false);
  markWelcomeGiftModalSeenLocally(42, null);
});