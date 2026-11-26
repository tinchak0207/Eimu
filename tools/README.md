# 维护工具

从仓库根目录执行命令。工具按维护职责归属，修改产品行为仍回到 `src/` 或对应的 `services/<服务>/`，这里不保留第二份业务实现。

| 谁负责这一类工作 | 入口 | 边界 |
| --- | --- | --- |
| 账号与商业运营 | `ops/accounts/` | 签发密钥、兑换码、开商业账户、查 mPay 订单；不修改计费规则 |
| 数据库与 worker 启动 | `ops/database/` | SQL 迁移和启动自举；结构真源是 `db/migrations/` |
| 供应商与资产供给 | `ops/suppliers/` | 接入渠道、播种、刷新渠道状态、资产进货 |
| Agent 记忆维护 | `ops/agent-memory/` | 由输入清单导入共享记忆；会话覆盖率取证仍在 `qa/` |
| 发布维护 | `ops/releases/` | 检查部署新鲜度、清理桌面发行 Blob；发布切换仍归 `deploy/` |
| 代码生成 | `codegen/` | 从产品登记表机械导出 runtime/专家配置/提示词；不得反过来编辑真源 |
| 对话取证与发布探针 | `qa/` | 真实会话驱动、SSE 调试、覆盖率与 schema 检查；不作为业务依赖 |
| 宣传视频制作 | `promo-video/` | 独立制作链，输入和输出不进入应用运行路径 |
| 插件集成 | `plugins/` | 对外工具适配，遵循各插件自身说明 |
| 历史参考 | `archive/` | 冻结的事故复测、校准实验、旧 Windows 操作；不列为当前操作入口 |

## 已有命令

`package.json` 中的命令名保持不变：

| 命令 | 实际文件 | 作用与副作用 |
| --- | --- | --- |
| `npm run bizkey:issue -- <参数>` | `ops/accounts/issue-biz-key.ts` | 签发客户密钥，会写入 |
| `npm run bizkey:list` | 同上 | 只读列表，输出按原工具规则处理 |
| `npm run promo:issue -- <参数>` | `ops/accounts/issue-promo-code.ts` | 发行兑换码；`--dry-run` 不提交 |
| `npm run generation:bootstrap` | `ops/database/control-plane-bootstrap.ts` | 迁移、播种，再启动 worker，会写入 |
| `npm run generation:migrate` | `ops/database/migrate-generation-db.ts` | 执行 SQL 迁移，会写入 |
| `npm run generation:seed` | `ops/suppliers/seed-generation-suppliers.ts` | 同步供应商登记，会写入 |
| `npm run ops:migrate -- --dry-run` | `ops/database/apply-migrations.ts` | 预览；去掉 `--dry-run` 会执行 |
| `npm run ops:deploy-freshness` | `ops/releases/check-deploy-freshness.ts` | 只读比较生产版本 |
| `npm run ops:mapay-order -- <订单号>` | `ops/accounts/inspect-mapay-order.ts` | 只读订单取证 |

直接入口：

- `node tools/qa/human-conversation-e2e.mjs --only=<语料ID> --no-spend`：使用真实用户语料，仍会创建真实会话。语料在同目录 `human-conversation-corpus.json`，音频原始样本在 `fixtures/`。
- `npx tsx tools/codegen/export-expert-agents.ts`：专家登记导出。源为 `src/lib/agent/expert-registry.ts`；目的为 `services/expert-gateway/` 与发布副本。
- `npx tsx tools/codegen/gen-openui-prompt.mts --check`：只比较网关提示词是否与组件登记一致。
- 其余渠道、资产与生成器参数以对应文件开头的用法为准，不额外包装统一 runner。

## 文件放在哪里

- `fixtures/`：稳定、非凭证的原始输入样本，不放运行日志。
- `seed-manifests/`：供记忆导入工具消费的输入清单及其原始来源说明。
- `generated/`：由 `codegen/` 产生的落位稿。修改真源后使用原导出器；不要在这里修业务。
- `lib/`：账号和数据库操作复用的远端连接辅助，不直接运行。
- `dev-scripts/`：Codex 本机诊断；`memory-bench/`：已有记忆实验工作集。它们不进入站点和 worker 生产入口。
- `vendor/`：第三方输入，保留许可证和来源，不混入自产工具。
- 新运行证据写入 `.local/outputs/<任务>/` 或工具原有的 `/tmp/` 目录；凭证留在环境变量或 `.local/state/secrets/`，不进工具源码、fixtures 或 manifest。

分工时按这张表认领一个职责目录。跨职责共享的 `lib/remote.ts`、根 `package.json` 和 `deploy/` 接线由整合者统一修改，避免多个执行者同时更改启动入口。

## 不能直接覆盖的导出稿

`generated` 表示来源关系，不表示当前生产副本可随时重建。下面两条在本轮整理前已存在逻辑差异；`--check` 只报告差异，不能通过直接重导出消除。路径迁移与这些逻辑差异分开处理。

| 源与导出器 | 当前消费与保护规则 | 是否允许直接覆盖 |
| --- | --- | --- |
| `src/lib/agent/blender-tools.ts`；`codegen/export-blender-tools-staging.ts` | 网站从源模块消费；Agent 从 `services/opencode-runtime/tools/blender_*.ts` 经 adapter 消费 `services/opencode-runtime/lib/blender-tools-impl.ts`。导出器的 `IMPORT_LINE`/`REEXPORT_LINE` 白名单只保证环境适配，不证明两边已同步；基线中源有 runtime 尚无的 Eevee 画质逻辑 | 否，先评审并保全当前消费行为，不能为检查通过直接覆盖 |
| `src/lib/generation-core/music-lyria.ts`；`codegen/export-music-tools-staging.ts` | 网站音乐工具消费源；Agent `services/opencode-runtime/lib/music-tools-impl.ts` 消费同目录 `music_lyria.ts`。`tools/generated/music-tools/music_lyria.ts` 是中间稿；导出器 `FAMILIES` 的 sync/known-drift/preserve 区别必须保留，sync 标签也不豁免现有差异审核；基线源有中间稿尚无的 `beforeSubmit` 准入回调 | 否，先确认准入/取消语义及运行时依赖，不能整批重导出其他保护族 |
