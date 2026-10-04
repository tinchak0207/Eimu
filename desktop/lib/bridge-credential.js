// device bridge 的凭证存放（主进程侧）。
//
// 为什么是「读磁碟」而不是「由页面注入」：壳载入的是远端页面，若让页面能把
// 凭证交给主进程，等于多开一条 remote→local 的信任路径。凭证改由使用者自行
// 放在 userData 下的档案，页面完全碰不到——攻击面比注入小一级。
//
// fail-closed：档案不存在、JSON 坏、栏位不合法、权限过宽，一律回 null。
// 回 null ⇒ device-bridge-client 停在 credentials_unavailable ⇒ 桥保持 OFF，
// 也就是「没设定的人行为与从前完全相同」。
//
// 档案：<userData>/device-bridge.json
//   { "gatewayBaseUrl": "https://store.tinchak0207.xyz", "apiKey": "sk-biz-…" }
// 权限必须是 0600（只有本人可读）；违反即拒用并回报原因，不静默放行。

const fs = require("node:fs");

/** 只收 http/https：`file:`、`javascript:` 之类的 scheme 不得进 gatewayBaseUrl。 */
function isHttpUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** 凭证物件是否可用（纯函式，可测）。 */
function isUsableCredential(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!isHttpUrl(value.gatewayBaseUrl)) return false;
  if (typeof value.apiKey !== "string") return false;
  if (value.apiKey.trim().length === 0) return false;
  return true;
}

/**
 * 解析存放内容（纯函式，可测）。坏 JSON／形状不符一律回 null。
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

/** 权限是否只开放给档案拥有者（0600 或更严）。非 POSIX 平台不适用，回 true。 */
function isOwnerOnlyMode(mode, platform = process.platform) {
  if (platform === "win32") return true;
  if (typeof mode !== "number") return false;
  return (mode & 0o077) === 0;
}

/**
 * 从磁碟读取凭证。任何异常（不存在、读不到、权限过宽、内容不合法）都回 null，
 * 并可透过 onWarn 回报原因——**原因字串不得包含 apiKey 本身**。
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
    return null; // 不存在＝正常情况（桥本来就该是 OFF），不告警。
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
