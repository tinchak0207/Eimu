/**
 * nanoid 同构 shim（片4，2026-09-02）：opencode 工具 runtime（.opencode/node_modules）无 nanoid 依赖，
 * 而 motionTemplates/cameraTemplates 轮子原始码 `import { nanoid } from 'nanoid'`。
 * 本 shim 与 nanoid v3 行为一致：64 字元字母表（A-Za-z0-9_-）+ size 预设 21 + mask 63 无浪费位，
 * 随机源 crypto.getRandomValues。gateway 侧真源仍是 npm nanoid@3.3.18（director-engine），两侧 id 同形。
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"

export default function nanoid(size = 21): string {
  const bytes = new Uint8Array(size)
  globalThis.crypto.getRandomValues(bytes)
  let id = ""
  for (let i = 0; i < size; i++) id += ALPHABET[bytes[i]! & 63]
  return id
}
