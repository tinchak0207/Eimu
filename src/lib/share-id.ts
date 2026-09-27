// 分享 id 的產生與形狀檢查（server-only）。
//
// 為什麼單獨一檔：`randomBytes` 來自 node:crypto，而分享功能有好幾個 client 元件
// （分享對話框、做同款按鈕）——那些元件 import 的是 share-remix.ts（純函式，
// 頂層絕不碰 node 內建模組）。把 crypto 擺在這一檔，client bundle 才不會被拖進來。
//
// 不可枚舉是硬需求：能從 artifact/entry id 推得 shareId ＝ 別人整櫃作品被掃走。

import { randomBytes } from "node:crypto";

/** 128-bit 隨機（不是「隨便給個 uuid」）。 */
export const SHARE_ID_BYTES = 16;

/** base64url(16 bytes) 固定 22 字；畸形 id 不必查存儲就能擋掉。 */
export const SHARE_ID_LENGTH = 22;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function generateShareId(): string {
  return randomBytes(SHARE_ID_BYTES).toString("base64url");
}

/** 形狀合法 ≠ 存在（存在性由存儲回答）。只擋畸形輸入，不當授權。 */
export function isShareId(value: unknown): value is string {
  return typeof value === "string" && SHARE_ID_PATTERN.test(value);
}
