# S2 開發者激活：建 key → 10 分鐘內首調成功（預期 60 分鐘）

先讀 `_common.md`（同目錄）。可與 S1 並行。

## 做什麼
1. **建 key 成功的那一刻**（用 grep 找 `src/components` 裡調用 `/api/user/biz-keys` POST 的元件），直接顯示兩段可一鍵複製的 curl，裡面代入真實 key：
   - gpt-image-2：`POST https://eimu.dev/v1/images/generations`，body 為 `{"model":"gpt-image-2","prompt":"一只橘猫趴在窗台上，水彩风格","size":"1024x1024"}`
   - PixAI 二次元：model 用 catalog 裡實際存在、且目前可用的 pixai id（從 `src/lib/generation-model-catalog.ts` 取，不許寫死猜測）
   - 兩段下面加一句：「新人礼额度可直接调用；余额用完返回 402，附充值链接。」
2. **餘額不足統一回 402**。找出 `/v1/*` 所有餘額不足的出口，統一返回：
   `{"error":{"message":"余额不足，本次未扣费。充值：https://eimu.dev/pricing","type":"insufficient_balance","code":"insufficient_balance"}}`
   現有的錯誤碼契約若有測試鎖定（`contract-lock.test.ts`），**不許破壞**；衝突時停下並回報。
3. **OpenAI 兼容性核對**（只寫報告，不改代碼）：比較 `/v1/images/generations` 和 OpenAI Images API 的差異，重點看同步或異步、`data[].url` / `b64_json`、`response_format`、`n`、`size`。結果寫到 `docs/specs-0928/S2-compat-report.md`，並逐條標註酒館（SillyTavern）、Cherry Studio、NextChat 能不能直接接入。

## 驗收
- 402 的響應體有單元測試
- curl 範例裡的 model id 由 catalog 生成（有測試）
