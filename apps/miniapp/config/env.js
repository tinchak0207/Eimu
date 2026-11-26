// 零依赖 .env 读取（不引入 dotenv）：先读 apps/miniapp/.env，再让真实 process.env 覆盖。
const fs = require('fs')
const path = require('path')

// TARO_APP_* 的 URL 默认值；归一化后为空时回退到这里（单一真源）。
const DEFAULT_URLS = {
  TARO_APP_API_BASE_URL: 'https://www.eimu.dev',
  TARO_APP_AGENT_ORIGIN: 'https://store.tinchak0207.xyz',
  TARO_APP_WEB_ORIGIN: 'https://www.eimu.dev',
}

// URL 值归一化：trim → 去掉末尾所有 '/'；结果为空则回退默认值。
// 不做协议校验（协议可省也算合法），只保证拼接形状干净：
// 尾斜杠会让 `AGENT_ORIGIN + '/image-data/...'` 变成 `xyz//image-data`，
// 媒体白名单 regex 于是静默不命中（图片/音频不渲染），同理 `BASE_URL + '/api/...'`。
function normalizeUrl(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed || fallback
}

function loadEnv() {
  const out = {}
  try {
    const text = fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
      if (key) out[key] = value
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value
  for (const [key, fallback] of Object.entries(DEFAULT_URLS)) {
    out[key] = normalizeUrl(out[key], fallback)
  }
  return out
}
module.exports = { loadEnv, normalizeUrl }
