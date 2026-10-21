import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedMediaUrl } from "./media-url";

// 值域独立于实作：以下合法主机字面值是生产 agent 媒体真源（gateway origin），
// 不是从 isAllowedMediaUrl 内部推导出来的，因此能反证「主机比对」的语义。
const OK_IMAGE = "https://store.tinchak0207.xyz/image-data/files/generation/jobs/x.png";
const OK_AUDIO = "https://store.tinchak0207.xyz/agent/v1/audio/tts_mukadd47.mp3";

test("isAllowedMediaUrl：收 agent 媒体真源的 https（图／音频路径皆可）", () => {
  assert.equal(isAllowedMediaUrl(OK_IMAGE), true);
  assert.equal(isAllowedMediaUrl(OK_AUDIO), true);
  // 前后空白 trim 后仍合法。
  assert.equal(isAllowedMediaUrl(`  ${OK_IMAGE}  `), true);
});

test("isAllowedMediaUrl：拒绝明文 http（含同主机）", () => {
  assert.equal(isAllowedMediaUrl("http://store.tinchak0207.xyz/a.png"), false);
});

test("isAllowedMediaUrl：拒绝相对路径与畸形字串", () => {
  assert.equal(isAllowedMediaUrl("/image-data/files/a.png"), false);
  assert.equal(isAllowedMediaUrl("store.tinchak0207.xyz/a.png"), false);
  assert.equal(isAllowedMediaUrl(""), false);
  assert.equal(isAllowedMediaUrl("   "), false);
  assert.equal(isAllowedMediaUrl("not a url"), false);
  assert.equal(isAllowedMediaUrl("://missing-scheme"), false);
});

test("isAllowedMediaUrl：拒绝非白名单主机（含后缀伪装）", () => {
  assert.equal(isAllowedMediaUrl("https://evil.example/a.png"), false);
  // 把白名单主机当子网域前缀的钓鱼主机不得放行。
  assert.equal(isAllowedMediaUrl("https://store.tinchak0207.xyz.evil.example/a.png"), false);
  // 类似但不同的主机。
  assert.equal(isAllowedMediaUrl("https://image.tinchak0207.xyz/a.png"), false);
});

test("isAllowedMediaUrl：拒绝带 userinfo 的 URL（会把真实主机藏在 @ 前后）", () => {
  // 真主机在 @ 后（userinfo 是白名单主机）：仍不得放行。
  assert.equal(isAllowedMediaUrl("https://user:pass@store.tinchak0207.xyz/a.png"), false);
  // 真主机在 @ 后是钓鱼主机（白名单主机当 userinfo）：主机不符。
  assert.equal(isAllowedMediaUrl("https://store.tinchak0207.xyz@evil.example/a.png"), false);
});

test("isAllowedMediaUrl：拒绝非预设埠（hostname 相同但连到别的服务）", () => {
  assert.equal(isAllowedMediaUrl("https://store.tinchak0207.xyz:8443/a.png"), false);
  // 443 是预设埠，new URL 会正规化成空埠 → 放行。
  assert.equal(isAllowedMediaUrl("https://store.tinchak0207.xyz:443/a.png"), true);
});

test("isAllowedMediaUrl：非字串输入安全回落 false", () => {
  assert.equal(isAllowedMediaUrl(undefined as unknown as string), false);
  assert.equal(isAllowedMediaUrl(null as unknown as string), false);
  assert.equal(isAllowedMediaUrl(42 as unknown as string), false);
});
