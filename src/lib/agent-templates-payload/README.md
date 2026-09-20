# agent-templates-payload/ —— 執行文案（一個模板一個檔）

2026-09-20 逐模板拆檔。原本 8 個模板的執行文案擠在
`agent-templates-payload.ts` 一個檔（11.9 萬中文字元）；現在一個模板一個檔。

檔名與模板 id 對應、與 `../agent-templates/` 同名。**只改文案找這裡，
只改卡面找那裡**；兩邊步驟數必須同序同數。

## 並行修改契約

- **一個 agent 只准改自己那一個模板檔**。
- **`index.ts` / `types.ts` 是共享檔，由 orchestrator 單獨一趟註冊**。
- 每個檔匯出 `<camelCase>Payload: AgentTemplatePayload`；`index.ts` 把它
  收進 `AGENT_TEMPLATE_PAYLOADS`（鍵 = 模板 id）。

## 為什麼不能靜態 import

本目錄是 11.9 萬中文字元的重資產，**禁止被模組頂層靜態 import**——
那會把它灌進 `app/page` chunk，首屏直接膨脹。唯一許可的客戶端入口是
`ImagePlayground.tsx` 裡的 `await import("@/lib/agent-templates-payload")`；
SSR 路由與 node tools 可直接靜態 import。
`src/lib/agent-templates.test.ts` 有硬閘測試盯著這件事。

## 驗證

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
npx --yes tsx --test src/lib/agent-templates.test.ts
```