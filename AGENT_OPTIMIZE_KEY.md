# AGENT_OPTIMIZE_KEY 部署指引（隱形提示詞導演）

## 這個變數做什麼
`generate-videos` 進上游前，先呼叫 VPS gateway 的 `/agent/v1/optimize-prompt`
讓 deepseek 優化 prompt。Agent 層需要的服務端 key 從這個 env 讀。

## 值從哪裡來
VPS 上 `/opt/agent-harness/.env` 的 `HARNESS_API_KEY`（`sk-biz-` 前綴，39 字元）。
gateway 驗證任何 `sk-biz-*` key 時打 `image.tinchak0207.xyz/v1/models`，此 key 已在 harness 作業流程中通過該驗證。

## 不設會怎樣
Agent 層直接跳過（回原 prompt），自動降級到規則層（`invisible-prompt-director`）。
**不影響生成，只少一層優化。** 上線前設好即可。

## 設定位置
- Vercel：`image_gen` 專案 → Settings → Environment Variables → `AGENT_OPTIMIZE_KEY`
- 本機開發：`.env.local` 加 `AGENT_OPTIMIZE_KEY=sk-biz-...`

## 驗證（Vercel 部署後）
```
curl -X POST https://store.tinchak0207.xyz/agent/v1/optimize-prompt \
  -H "Authorization: Bearer <AGENT_OPTIMIZE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"一只猫从窗户跳下来落在草地上"}'
```
預期 200 + `{"ok":true,"prompt":"...","model":"deepseek-v4-flash-free"}`。
