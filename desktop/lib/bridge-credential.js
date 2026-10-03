// device bridge 的憑證存放（主進程側）。
//
// 為什麼是「讀磁碟」而不是「由頁面注入」：殼載入的是遠端頁面，若讓頁面能把
// 憑證交給主進程，等於多開一條 remote→local 的信任路徑。憑證改由使用者自行
// 放在 userData 下的檔案，頁面完全碰不到——攻擊面比注入小一級。
//
// fail-closed：檔案不存在、JSON 壞、欄位不合法、權限過寬，一律回 null。
// 回 null ⇒ device-bridge-client 停在 credentials_unavailable ⇒ 橋保持 OFF，
// 也就是「沒設定的人行為與從前完全相同」。
//
// 檔案：<userData>/device-bridge.json
//   { "gatewayBaseUrl": "https://store.tinchak0207.xyz", "apiKey": "sk-biz-…" }
// 權限必須是 0600（只有本人可讀）；違反即拒用並回報原因，不靜默放行。

const fs = require("node:fs");

/** 只收 http/https：`file:`、`javascript:` 之類的 scheme 不得進 gatewayBaseUrl。 */
function isHttpUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** 憑證物件是否可用（純函式，可測）。 */
function isUsableCredential(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!isHttpUrl(value.gatewayBaseUrl)) return false;
  if (typeof value.apiKey !== "string") return false;
  if (value.apiKey.trim().length === 0) return false;
  return true;
}

/**
 * 解析存放內容（純函式，可測）。壞 JSON／形狀不符一律回 null。
 * @returns {{ gatewayBaseUrl: string, apiKey: string } | null}
 */
function parseCredentialStore(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isUsableCredential(parsed)) return null;
  return { gatewayBaseUrl: parsed.gatewayBaseUrl.trim(), apiKey: parsed.apiKey.trim() };
}

/** 權限是否只開放給檔案擁有者（0600 或更嚴）。非 POSIX 平台不適用，回 true。 */
function isOwnerOnlyMode(mode, platform = process.platform) {
  if (platform === "win32") return true;
  if (typeof mode !== "number") return false;
  return (mode & 0o077) === 0;
}

/**
 * 從磁碟讀取憑證。任何異常（不存在、讀不到、權限過寬、內容不合法）都回 null，
 * 並可透過 onWarn 回報原因——**原因字串不得包含 apiKey 本身**。
 * @param {string} filePath
 * @param {{ readFileSync?: typeof fs.readFileSync, statSync?: typeof fs.statSync, platform?: string, onWarn?: (reason: string) => void }} [deps]
 */
function readCredentialStore(filePath, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const statSync = deps.statSync || fs.statSync;
  const warn = typeof deps.onWarn === "function" ? deps.onWarn : () => {};
  if (typeof filePath !== "string" || filePath.length === 0) return null;

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null; // 不存在＝正常情況（橋本來就該是 OFF），不告警。
  }
  if (!isOwnerOnlyMode(stat.mode, deps.platform)) {
    warn("credential_file_permissions_too_open");
    return null;
  }

  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    warn("credential_file_unreadable");
    return null;
  }

  const parsed = parseCredentialStore(raw);
  if (!parsed) {
    warn("credential_file_invalid");
    return null;
  }
  return parsed;
}

module.exports = {
  isHttpUrl,
  isUsableCredential,
  parseCredentialStore,
  isOwnerOnlyMode,
  readCredentialStore,
};
