/**
 * nanoid 同構 shim（片4，2026-09-02）：opencode 工具 runtime（.opencode/node_modules）無 nanoid 依賴，
 * 而 motionTemplates/cameraTemplates 輪子原始碼 `import { nanoid } from 'nanoid'`。
 * 本 shim 與 nanoid v3 行為一致：64 字元字母表（A-Za-z0-9_-）+ size 預設 21 + mask 63 無浪費位，
 * 隨機源 crypto.getRandomValues。gateway 側真源仍是 npm nanoid@3.3.18（director-engine），兩側 id 同形。
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"

export default function nanoid(size = 21): string {
  const bytes = new Uint8Array(size)
  globalThis.crypto.getRandomValues(bytes)
  let id = ""
  for (let i = 0; i < size; i++) id += ALPHABET[bytes[i]! & 63]
  return id
}
