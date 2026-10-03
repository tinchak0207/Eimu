import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedMediaUrl } from "./media-url";

// 值域獨立於實作：以下合法主機字面值是生產 agent 媒體真源（gateway origin），
// 不是從 isAllowedMediaUrl 內部推導出來的，因此能反證「主機比對」的語義。
const OK_IMAGE = "https://store.tinchak0207.xyz/image-data/files/generation/jobs/x.png";
const OK_AUDIO = "https://store.tinchak0207.xyz/agent/v1/audio/tts_mukadd47.mp3";

test("isAllowedMediaUrl：收 agent 媒體真源的 https（圖／音頻路徑皆可）", () => {
  assert.equal(isAllowedMediaUrl(OK_IMAGE), true);
  assert.equal(isAllowedMediaUrl(OK_AUDIO), true);
  // 前後空白 trim 後仍合法。
  assert.equal(isAllowedMediaUrl(`  ${OK_IMAGE}  `), true);
});

test("isAllowedMediaUrl：拒絕明文 http（含同主機）", () => {
  assert.equal(isAllowedMediaUrl("http://store.tinchak0207.xyz/a.png"), false);
});

test("isAllowedMediaUrl：拒絕相對路徑與畸形字串", () => {
  assert.equal(isAllowedMediaUrl("/image-data/files/a.png"), false);
  assert.equal(isAllowedMediaUrl("store.tinchak0207.xyz/a.png"), false);
  assert.equal(isAllowedMediaUrl(""), false);
  assert.equal(isAllowedMediaUrl("   "), false);
  assert.equal(isAllowedMediaUrl("not a url"), false);
  assert.equal(isAllowedMediaUrl("://missing-scheme"), false);
});

test("isAllowedMediaUrl：拒絕非白名單主機（含後綴偽裝）", () => {
  assert.equal(isAllowedMediaUrl("https://evil.example/a.png"), false);
  // 把白名單主機當子網域前綴的釣魚主機不得放行。
  assert.equal(isAllowedMediaUrl("https://store.tinchak0207.xyz.evil.example/a.png"), false);
  // 類似但不同的主機。
  assert.equal(isAllowedMediaUrl("https://image.tinchak0207.xyz/a.png"), false);
});

test("isAllowedMediaUrl：拒絕帶 userinfo 的 URL（會把真實主機藏在 @ 前後）", () => {
  // 真主機在 @ 後（userinfo 是白名單主機）：仍不得放行。
  assert.equal(isAllowedMediaUrl("https://user:pass@store.tinchak0207.xyz/a.png"), false);
  // 真主機在 @ 後是釣魚主機（白名單主機當 userinfo）：主機不符。
  assert.equal(isAllowedMediaUrl("https://store.tinchak0207.xyz@evil.example/a.png"), false);
});

test("isAllowedMediaUrl：拒絕非預設埠（hostname 相同但連到別的服務）", () => {
  assert.equal(isAllowedMediaUrl("https://store.tinchak0207.xyz:8443/a.png"), false);
  // 443 是預設埠，new URL 會正規化成空埠 → 放行。
  assert.equal(isAllowedMediaUrl("https://store.tinchak0207.xyz:443/a.png"), true);
});

test("isAllowedMediaUrl：非字串輸入安全回落 false", () => {
  assert.equal(isAllowedMediaUrl(undefined as unknown as string), false);
  assert.equal(isAllowedMediaUrl(null as unknown as string), false);
  assert.equal(isAllowedMediaUrl(42 as unknown as string), false);
});
