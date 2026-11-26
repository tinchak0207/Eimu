// 分享 id 的产生与形状检查（server-only）。
//
// 为什么单独一档：`randomBytes` 来自 node:crypto，而分享功能有好几个 client 元件
// （分享对话框、做同款按钮）——那些元件 import 的是 share-remix.ts（纯函式，
// 顶层绝不碰 node 内建模组）。把 crypto 摆在这一档，client bundle 才不会被拖进来。
//
// 不可枚举是硬需求：能从 artifact/entry id 推得 shareId ＝ 别人整柜作品被扫走。

import { randomBytes } from "node:crypto";

/** 128-bit 随机（不是「随便给个 uuid」）。 */
export const SHARE_ID_BYTES = 16;

/** base64url(16 bytes) 固定 22 字；畸形 id 不必查存储就能挡掉。 */
export const SHARE_ID_LENGTH = 22;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function generateShareId(): string {
  return randomBytes(SHARE_ID_BYTES).toString("base64url");
}

/** 形状合法 ≠ 存在（存在性由存储回答）。只挡畸形输入，不当授权。 */
export function isShareId(value: unknown): value is string {
  return typeof value === "string" && SHARE_ID_PATTERN.test(value);
}
