# AGENT_OPTIMIZE_KEY 部署指引（隐形提示词导演）

## 这个变数做什么
`generate-videos` 进上游前，先呼叫 VPS gateway 的 `/agent/v1/optimize-prompt`
让 deepseek 优化 prompt。Agent 层需要的服务端 key 从这个 env 读。

## 值从哪里来
VPS 上 `/opt/agent-harness/.env` 的 `HARNESS_API_KEY`（`sk-biz-` 前缀，39 字元）。
gateway 验证任何 `sk-biz-*` key 时打 `eimu.dev/v1/models`，此 key 已在 harness 作业流程中通过该验证。

## 不设会怎样
Agent 层直接跳过（回原 prompt），自动降级到规则层（`invisible-prompt-director`）。
**不影响生成，只少一层优化。** 上线前设好即可。

## 设定位置
- Vercel：`image_gen` 专案 → Settings → Environment Variables → `AGENT_OPTIMIZE_KEY`
- 本机开发：`.env.local` 加 `AGENT_OPTIMIZE_KEY=sk-biz-...`

## 验证（Vercel 部署后）
```
curl -X POST https://store.tinchak0207.xyz/agent/v1/optimize-prompt \
  -H "Authorization: Bearer <AGENT_OPTIMIZE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"一只猫从窗户跳下来落在草地上"}'
```
预期 200 + `{"ok":true,"prompt":"...","model":"deepseek-v4-flash-free"}`。
