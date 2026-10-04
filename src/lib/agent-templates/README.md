# agent-templates/ —— 显示卡（一个模板一个档）

2026-09-20 逐模板拆档。原本 8 个模板挤在 `agent-templates.ts` 一个档，
平行修改必冲突；现在一个模板一个档，**改一条流水线只动一个档**。

## 档案对应

| 模板 id | 卡面档（本目录） | payload 档（`../agent-templates-payload/`） |
|---|---|---|
| `agent-novel-film-pipeline` | `novel-film-pipeline.ts` | `novel-film-pipeline.ts` |
| `agent-novel-ip-visual-pack` | `novel-ip-visual-pack.ts` | `novel-ip-visual-pack.ts` |
| `agent-ecommerce-launch-pack` | `ecommerce-launch-pack.ts` | `ecommerce-launch-pack.ts` |
| `agent-ecommerce-model-grid` | `ecommerce-model-grid.ts` | `ecommerce-model-grid.ts` |
| `agent-shortdrama-visual-assets` | `shortdrama-visual-assets.ts` | `shortdrama-visual-assets.ts` |
| `agent-shortdrama-poster-line` | `shortdrama-poster-line.ts` | `shortdrama-poster-line.ts` |
| `agent-art-curation-series` | `art-curation-series.ts` | `art-curation-series.ts` |
| `agent-art-style-immersion` | `art-style-immersion.ts` | `art-style-immersion.ts` |

型别在 `types.ts`；汇总与 `AGENT_TEMPLATES` 在 `index.ts`。

## 并行修改契约（重要）

- **一个 agent 只准改自己那一个模板档**（卡面 + payload 各一个，共两个档）。
- **`index.ts` / `types.ts` 是共享档，由 orchestrator 单独一趟注册**，
  不许平行 agent 各自去加 import 行——那正是这次拆档要消灭的冲突点。
- 新增模板的完整步骤：①本目录加 `<slug>.ts` ②payload 目录加同名档
  ③orchestrator 在两边 `index.ts` 各加一行（import + 注册）。
  两边步骤数必须同序同数，`hydrateAgentTemplate` 防呆会抛错。

## 两档分离的理由（不要合并回去）

- 本目录是**首屏同步载入**的卡面 metadata；payload 目录是 11.9 万中文字元
  的执行文案，只能由使用处 `await import()` 动态载入。
- `ImagePlayground.tsx` 的 `handleUseAgentTemplate` 靠这个动态边界维持
  「首屏消重硬闸」；把执行文案加回本目录 = 首屏 chunk 直接膨胀。
  `src/lib/agent-templates.test.ts` 有对应硬闸测试（「display file carries
  zero execution payload」）。

## 验证

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
npx --yes tsx --test src/lib/agent-templates.test.ts
npx --yes tsc --noEmit
```