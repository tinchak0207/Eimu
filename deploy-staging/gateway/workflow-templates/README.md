# workflow-templates/ —— 后端工作流模板（一个模板一个档）

2026-09-20 逐模板拆档。原本 6 个模板挤在 `workflow-templates.ts` 一个档；
现在一个模板一个档，**加一条流水线只动一个档**。

## 档案对应

| 模板 id | 档案 |
|---|---|
| `single_image` | `single_image.ts` |
| `character_sheet` | `character_sheet.ts` |
| `scene_setup` | `scene_setup.ts` |
| `single_video` | `single_video.ts` |
| `feature_film` | `feature_film.ts` |
| `novel_film` | `novel_film.ts` |

型别在 `types.ts`；`WORKFLOW_TEMPLATES` 与 `getWorkflowTemplate` /
`templatePlaceholderContent` / `listWorkflowTemplates` 在 `index.ts`。
消费者（`workflow-service.ts`、`messages-gw.ts`、`subagent.ts`）一律
`from "./workflow-templates"`，解析到本目录的 `index.ts`。

## 并行修改契约

- **一个 agent 只准改自己那一个模板档**。
- **`index.ts` 是共享档，由 orchestrator 单独一趟注册**（import + 阵列一行）。
- 节点 `kind` 用 `text | config | image | video | audio | film`；
  节点 `role` 是模板内唯一键，连线用 `{ fromRole, toRole }`。

## 部署警告（拆档后首度部署必读）

部署机制是**逐档 SFTP**（`.gateway-work/sftp-put-443.js`），没有任何递回同步。
目录结构不会被自动带上去，VPS 上必须：

1. `mkdir -p /opt/eimu-harness/gateway/workflow-templates`
2. 逐档上传（每个档一次 SFTP 调用，上传后比对 md5 `MATCH`）
3. **删除或改名旧的 `/opt/eimu-harness/gateway/workflow-templates.ts`**——
   extensionless 的 `./workflow-templates` 会优先命中 `.ts` 档而非目录，
   旧档留著会静默掩蔽整个新目录。
4. 跑 `sudo /opt/eimu-harness/deploy.sh`（内含 `bun build` 语法闸；
   缺档会在闸就失败，不会带病重启）。

## 验证

```bash
cd deploy-staging/gateway
~/.local/bin/bun build index.ts --target=bun --outfile /tmp/gate.js && rm -f /tmp/gate.js
```