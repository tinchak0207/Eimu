# S2 开发者激活：建 key → 10 分钟内首调成功（预期 60 分钟）

先读 `_common.md`（同目录）。可与 S1 并行。

## 做什么
1. **建 key 成功的那一刻**（用 grep 找 `src/components` 里调用 `/api/user/biz-keys` POST 的元件），直接显示两段可一键复制的 curl，里面代入真实 key：
   - gpt-image-2：`POST https://eimu.dev/v1/images/generations`，body 为 `{"model":"gpt-image-2","prompt":"一只橘猫趴在窗台上，水彩风格","size":"1024x1024"}`
   - PixAI 二次元：model 用 catalog 里实际存在、且目前可用的 pixai id（从 `src/lib/generation-model-catalog.ts` 取，不许写死猜测）
   - 两段下面加一句：「新人礼额度可直接调用；余额用完返回 402，附充值链接。」
2. **余额不足统一回 402**。找出 `/v1/*` 所有余额不足的出口，统一返回：
   `{"error":{"message":"余额不足，本次未扣费。充值：https://eimu.dev/pricing","type":"insufficient_balance","code":"insufficient_balance"}}`
   现有的错误码契约若有测试锁定（`contract-lock.test.ts`），**不许破坏**；冲突时停下并回报。
3. **OpenAI 兼容性核对**（只写报告，不改代码）：比较 `/v1/images/generations` 和 OpenAI Images API 的差异，重点看同步或异步、`data[].url` / `b64_json`、`response_format`、`n`、`size`。结果写到 `docs/specs-0928/S2-compat-report.md`，并逐条标注酒馆（SillyTavern）、Cherry Studio、NextChat 能不能直接接入。

## 验收
- 402 的响应体有单元测试
- curl 范例里的 model id 由 catalog 生成（有测试）
