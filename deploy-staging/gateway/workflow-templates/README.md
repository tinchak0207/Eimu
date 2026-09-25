# workflow-templates/ —— 後端工作流模板（一個模板一個檔）

2026-09-20 逐模板拆檔。原本 6 個模板擠在 `workflow-templates.ts` 一個檔；
現在一個模板一個檔，**加一條流水線只動一個檔**。

## 檔案對應

| 模板 id | 檔案 |
|---|---|
| `single_image` | `single_image.ts` |
| `character_sheet` | `character_sheet.ts` |
| `scene_setup` | `scene_setup.ts` |
| `single_video` | `single_video.ts` |
| `feature_film` | `feature_film.ts` |
| `novel_film` | `novel_film.ts` |

型別在 `types.ts`；`WORKFLOW_TEMPLATES` 與 `getWorkflowTemplate` /
`templatePlaceholderContent` / `listWorkflowTemplates` 在 `index.ts`。
消費者（`workflow-service.ts`、`messages-gw.ts`、`subagent.ts`）一律
`from "./workflow-templates"`，解析到本目錄的 `index.ts`。

## 並行修改契約

- **一個 agent 只准改自己那一個模板檔**。
- **`index.ts` 是共享檔，由 orchestrator 單獨一趟註冊**（import + 陣列一行）。
- 節點 `kind` 用 `text | config | image | video | audio | film`；
  節點 `role` 是模板內唯一鍵，連線用 `{ fromRole, toRole }`。

## 部署警告（拆檔後首度部署必讀）

部署機制是**逐檔 SFTP**（`.gateway-work/sftp-put-443.js`），沒有任何遞迴同步。
目錄結構不會被自動帶上去，VPS 上必須：

1. `mkdir -p /opt/agent-harness/gateway/workflow-templates`
2. 逐檔上傳（每個檔一次 SFTP 調用，上傳後比對 md5 `MATCH`）
3. **刪除或改名舊的 `/opt/agent-harness/gateway/workflow-templates.ts`**——
   extensionless 的 `./workflow-templates` 會優先命中 `.ts` 檔而非目錄，
   舊檔留著會靜默掩蔽整個新目錄。
4. 跑 `sudo /opt/agent-harness/deploy.sh`（內含 `bun build` 語法閘；
   缺檔會在閘就失敗，不會帶病重啟）。

## 驗證

```bash
cd deploy-staging/gateway
~/.local/bin/bun build index.ts --target=bun --outfile /tmp/gate.js && rm -f /tmp/gate.js
```