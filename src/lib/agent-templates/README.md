# agent-templates/ —— 顯示卡（一個模板一個檔）

2026-09-20 逐模板拆檔。原本 8 個模板擠在 `agent-templates.ts` 一個檔，
平行修改必衝突；現在一個模板一個檔，**改一條流水線只動一個檔**。

## 檔案對應

| 模板 id | 卡面檔（本目錄） | payload 檔（`../agent-templates-payload/`） |
|---|---|---|
| `agent-novel-film-pipeline` | `novel-film-pipeline.ts` | `novel-film-pipeline.ts` |
| `agent-novel-ip-visual-pack` | `novel-ip-visual-pack.ts` | `novel-ip-visual-pack.ts` |
| `agent-ecommerce-launch-pack` | `ecommerce-launch-pack.ts` | `ecommerce-launch-pack.ts` |
| `agent-ecommerce-model-grid` | `ecommerce-model-grid.ts` | `ecommerce-model-grid.ts` |
| `agent-shortdrama-visual-assets` | `shortdrama-visual-assets.ts` | `shortdrama-visual-assets.ts` |
| `agent-shortdrama-poster-line` | `shortdrama-poster-line.ts` | `shortdrama-poster-line.ts` |
| `agent-art-curation-series` | `art-curation-series.ts` | `art-curation-series.ts` |
| `agent-art-style-immersion` | `art-style-immersion.ts` | `art-style-immersion.ts` |

型別在 `types.ts`；匯總與 `AGENT_TEMPLATES` 在 `index.ts`。

## 並行修改契約（重要）

- **一個 agent 只准改自己那一個模板檔**（卡面 + payload 各一個，共兩個檔）。
- **`index.ts` / `types.ts` 是共享檔，由 orchestrator 單獨一趟註冊**，
  不許平行 agent 各自去加 import 行——那正是這次拆檔要消滅的衝突點。
- 新增模板的完整步驟：①本目錄加 `<slug>.ts` ②payload 目錄加同名檔
  ③orchestrator 在兩邊 `index.ts` 各加一行（import + 註冊）。
  兩邊步驟數必須同序同數，`hydrateAgentTemplate` 防呆會拋錯。

## 兩檔分離的理由（不要合併回去）

- 本目錄是**首屏同步載入**的卡面 metadata；payload 目錄是 11.9 萬中文字元
  的執行文案，只能由使用處 `await import()` 動態載入。
- `ImagePlayground.tsx` 的 `handleUseAgentTemplate` 靠這個動態邊界維持
  「首屏消重硬閘」；把執行文案加回本目錄 = 首屏 chunk 直接膨脹。
  `src/lib/agent-templates.test.ts` 有對應硬閘測試（「display file carries
  zero execution payload」）。

## 驗證

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
npx --yes tsx --test src/lib/agent-templates.test.ts
npx --yes tsc --noEmit
```