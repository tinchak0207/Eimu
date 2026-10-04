# agent-templates-payload/ —— 执行文案（一个模板一个档）

2026-09-20 逐模板拆档。原本 8 个模板的执行文案挤在
`agent-templates-payload.ts` 一个档（11.9 万中文字元）；现在一个模板一个档。

档名与模板 id 对应、与 `../agent-templates/` 同名。**只改文案找这里，
只改卡面找那里**；两边步骤数必须同序同数。

## 并行修改契约

- **一个 agent 只准改自己那一个模板档**。
- **`index.ts` / `types.ts` 是共享档，由 orchestrator 单独一趟注册**。
- 每个档汇出 `<camelCase>Payload: AgentTemplatePayload`；`index.ts` 把它
  收进 `AGENT_TEMPLATE_PAYLOADS`（键 = 模板 id）。

## 为什么不能静态 import

本目录是 11.9 万中文字元的重资产，**禁止被模组顶层静态 import**——
那会把它灌进 `app/page` chunk，首屏直接膨胀。唯一许可的客户端入口是
`ImagePlayground.tsx` 里的 `await import("@/lib/agent-templates-payload")`；
SSR 路由与 node tools 可直接静态 import。
`src/lib/agent-templates.test.ts` 有硬闸测试盯著这件事。

## 验证

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
npx --yes tsx --test src/lib/agent-templates.test.ts
```