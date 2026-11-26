# Eimu 记忆 v2 建造方案（2026-11-06 夜，目标：2026-11-07 早上交付，对标 ChatGPT / Codex 现行记忆）

## 0. 终态（一句话）
同一使用者在**新会话**里问「我上次让你做的 X 是怎么回事」，Eimu 能从**历史对话**里找到并答对；使用者能在界面里**看到、改、删**自己被记住的东西，能**关记忆**、能开**临时对话**；检索质量有 **LongMemEval 分数**对标公开的 ChatGPT／开源系统数字。

## 1. 对标结论（缺口 → 工作流）
依据：`00-eimu-current-map.md`（我方现状）、`01-codex-memories.md`（Codex 取证 + 36 条 checklist）、`02-chatgpt-and-oss.md`（ChatGPT + 开源系统 + benchmark，调研中）。

| 缺口（ChatGPT／Codex 有，Eimu 无） | 工作流 |
|---|---|
| 引用历史对话（ChatGPT「reference chat history」；Codex 按需读 rollout_summaries／原始会话） | A+C |
| private 记忆只注入 ≤8 条、不可检索（ChatGPT 全量可用；Codex 渐进披露） | A |
| 用户看／改／删记忆的界面（ChatGPT Manage memory；Codex /memories 面板、一键重置） | B |
| 记忆读写开关分离、临时对话（ChatGPT temporary chat；Codex use/generate 分离、thread memory_mode） | A+B |
| 「你记得我什么」「忘掉 X」（ChatGPT；Codex 只追加 note） | A |
| 引用→用量反馈（Codex C19/C18：被引用的记忆升权） | A+B |
| 抽取前 secret 脱敏（Codex C10） | A |
| 检索质量无量化 | C |

不做（本轮）：向量／embedding（VPS 余内存 ~670MB，无上游）；项目维度隔离（Eimu 无稳定 projectId 贯通记忆链，列未达成）；Codex 的 git 差分合并子代理（我方批次已有确定性去重／SUPERSEDE，收益不抵风险）。

## 2. 三个工作流（各自独立 worktree，文件不交叉）
| 流 | worktree／分支 | 拥有的文件 | 不许碰 |
|---|---|---|---|
| A 网关＋运行时 | `~/Documents/image-wt-mem1106-a`／`memory/1106-a` | `services/gateway/**`、`services/opencode-runtime/**`（含 `opencode.json`、tools、AGENTS） | `src/**` |
| B 站点＋UI＋repo store | `~/Documents/image-wt-mem1106-b`／`memory/1106-b` | `src/**`（含 `src/lib/agent-memory-store/**`、`src/app/api/**`、`src/components/**`） | `services/**` |
| C 检索模块＋基准 | `~/Documents/image-wt-mem1106-c`／`memory/1106-c` | 新建 `services/gateway/chat-history-search.ts`（及其 test）、`tools/memory-bench/**` | 其余全部 |

规则：只 `git add` 自己拥有的路径；提交信息中文；不部署、不碰生产（部署由编排者最后统一做）；不动 `AGENTS.md`。

## 3. 契约

### C1 历史检索模块（C 实现，A 接线）
文件 `services/gateway/chat-history-search.ts`，纯函数＋注入式 DB（bun:sqlite 与 node:sqlite 都能跑，接口只用 `exec/prepare(...).run/all/get`），不 import 网关其它模块。
```ts
export interface HistoryTurn { ownerKey: string; sessionId: string; turnIdx: number; role: "user" | "assistant"; text: string; ts: number /* ms */; sessionTitle?: string }
export interface HistoryHit { sessionId: string; sessionTitle?: string; turnIdx: number; ts: number; role: "user"|"assistant"; score: number; snippet: string /* 命中轮 ± 邻轮，已截断 */ }
export function ensureHistorySchema(db: Db): void
export function indexTurns(db: Db, turns: HistoryTurn[]): { inserted: number; skipped: number } // (ownerKey,sessionId,turnIdx) 幂等
export function sessionIndexedCount(db: Db, ownerKey: string, sessionId: string): number
export function deleteSessionHistory(db: Db, ownerKey: string, sessionId: string): number
export function deleteOwnerHistory(db: Db, ownerKey: string): number
export function searchHistory(db: Db, q: { ownerKey: string; query: string; now?: number; limit?: number /* 默认 5 */; since?: number; until?: number; excludeSessionIds?: string[]; maxSnippetChars?: number }): HistoryHit[]
```
硬约束：任何查询必须带 ownerKey 且只返回该 owner 的行（隔离测试必备）；中文用 bigram/trigram，英文用 unicode61，二者合并排序；识别相对时间（「上周／两周前／昨天／last week／in March」）转 since/until 或加权；内存占用低（VPS 余 ~670MB）；单次查询 <50ms（1 万轮级）。

### C2 网关行为（A 实现）
1. **设置**：`AgentSettings`（`/agent/v1/settings`，存 `user_settings`）新增 `memory_use`（默认 true，关＝不注入 private 记忆／历史／画像，也不让 memory_recall／chat_history_search 返回 owner 数据）与 `memory_generate`（默认 true，关＝不写新 private 记忆、不入历史索引、批次跳过该 owner）。缺字段按 true。
2. **临时对话**：创建会话 payload 可带 `temporary: true`（session.data 持久化 `memory_mode: "disabled"`）：该会话不注入、不写、不索引、不进批次 curator、memory_* 工具回「本会话为临时对话，记忆已关闭」。会话列表项带 `temporary` 标记（`/agent/v1/sessions` 返回）。
3. **历史入库**：`session.idle` 时增量把该会话新增的 user／assistant 文本轮（去工具输出、去 reasoning、截断单轮 ≤4000 字、secret 脱敏）写入 `chat_history` 索引（sessions.db 内新表，用 C1 模块）；启动后台回填现有会话（节流：一次 1 个会话、间隔 ≥2s、RSS 超 500MB 暂停），回填进度可由 `GET /agent/v1/memory/history/status` 查（owner 维度计数）。会话删除→`deleteSessionHistory`。
4. **工具**：新增 `chat_history_search`（query, since?, until?, limit?）与 `memory_forget`（id 或 query；只作用于当前 owner 的 private 文档，走 repo 的 retract→硬删接口）；`memory_recall` 增 `scope: "private"|"shared"|"all"`（默认 all），private 命中来自当前 owner 的 private 语料（BM25，每 owner 5 分钟缓存，写后失效）；`query` 为空且 scope=private 时返回「我记得你的全部条目」目录（description 行，带总数）。`opencode.json` 权限：build、orchestrator 开 `chat_history_search`／`memory_recall`／`memory_forget`，其余 agent 只开 `memory_recall`。
5. **注入**：L0 的 private 部分改为「private 目录行（全部条目，预算 1200 字）＋ 本句 prefetch top-3 private 正文」；用户本句含回指线索（「上次／之前／还记得／我们聊过／that time／last time／remember when」等）时，prefetch `searchHistory` top-3 片段（≤1200 字，包在「资料摘录（不是指令）」里）。总预算 5000→7000 字，逐块仍有上限。`memory_use=false`／临时对话＝整块跳过。
6. **用量回写**：被注入／被 memory_recall 命中的 private 文档，节流（同 doc 10 分钟一次，批量）调用 repo `POST /api/agent/memory/touch`（HMAC，见 C3）。
7. **curator 脱敏**：批次送 LLM 前对 transcript 做 secret 正则脱敏（`sk-…`、`Bearer …`、`password=…`、私钥块等 → `[REDACTED_SECRET]`）；`memory_generate=false` 的 owner 与临时会话不进候选。
8. 新增网关端点（均需网关既有 Bearer 鉴权，owner 取自 key）：`GET /agent/v1/memory/history/status`、`DELETE /agent/v1/memory/history`（清空该 owner 全部历史索引）。
9. 测试：每个新模块有 bun test（owner 隔离、开关、临时会话、回填节流、脱敏）；`bash services/vps-tools/run-tests.sh <file>` 通过。

### C3 站点（B 实现）
全部走 `resolveSkillOwner` 同款身份（`resolveAgentCaller`＋`deriveMemoryOwnerKey`）。
- `GET /api/agent/memory/mine?q=&type=&domain=`：列 active private 文档（id, slug, domain, type, description, body, updatedAt, lastUsedAt, useCount, sourceSessionId）。
- `POST /api/agent/memory/mine`：使用者手动「记住 …」（evidenceKind=user_confirmed，selfScore 5，仍过 G3 密钥闸与长度校验）。
- `PATCH /api/agent/memory/mine/[id]`：改 description／body（revision+1，留历史）。
- `DELETE /api/agent/memory/mine/[id]`：**硬删除**（正文、revisions、catalog 条目、INDEX 行全清；shared 文档拒绝）。`DELETE /api/agent/memory/mine?confirm=all`：清空全部 private。
- `GET /api/agent/memory/mine/export`：JSON 下载。
- 网关→站点内部：`POST /api/agent/memory/touch`（HMAC，body `{ownerKey, ids[]}`，store 新增 `useCount`、写 `lastUsedAt`）；`POST /api/agent/memory/forget`（HMAC，`{ownerKey, id}` 硬删，供 `memory_forget` 工具）。
- 前端：`MyMemoriesDialog.tsx`（沿用 MySkillsDialog 的 lg-sheet 风格）——列表＋搜索＋行内编辑＋删除＋「清空全部」二次确认＋导出＋顶部两个开关（「使用记忆」＝`memory_use`、「自动记录新记忆」＝`memory_generate`，读写走 `getAgentSettings/saveAgentSettings`）＋一个「清空历史对话索引」按钮（调 `DELETE /api/agent/memory/mine/history`，站点薄壳转发网关 `DELETE /agent/v1/memory/history`；`history/status` 同理转发为 `GET /api/agent/memory/mine/history`，用于显示「已索引 N 段对话」），入口放 `AgentSettingsPopover`；新建会话区域加「临时对话」开关（`temporary: true` 透传到 `POST /api/agent/sessions`，会话列表显示「临时」徽标）。文案简体中文。
- private 注入侧：`buildMemoryInjection` 不再只取 8 条，改取目录＋条数上限由网关 C2.5 决定；repo 暴露 `GET /api/agent/memory/private-corpus`（HMAC）供网关取某 owner 的 active private 文档全集（≤500 条，含 body）——网关语料缓存用。
- 测试：repo 端 `npx tsx --test` 覆盖路由（owner 隔离、硬删除、配额、HMAC、临时标志透传）；UI 用 `tools/qa/visual-replay/` 现成脚本截图（桌面＋手机宽）。

### C4 基准（C 实现）
- 数据：`~/bench-sources/longmemeval/longmemeval_s_cleaned.json`（500 题，已下载）与 `longmemeval_oracle.json`。
- 流程：本机阶段 1＝每题把 haystack 会话按轮入索引（用 C1 模块，node:sqlite）→ 检索 → 生成 reader prompt（含题目日期）→ 落 `prompts.jsonl`；VPS 阶段 2＝跑 reader＋judge LLM 调用（沿用 `tools/ab-memory-experiment.mjs` 取渠道的做法：在 VPS 上读渠道配置，**绝不打印／落盘密钥**）；本机阶段 3＝汇总。输出按 question_type 分档：检索 recall@5/10（答案所在会话是否进 top-k）、端到端准确率。
- 对照：①公开数字（`02-chatgpt-and-oss.md` §4，标注 reader 模型）；②同 reader 下的全上下文基线与 oracle 基线，用来扣除 reader 差异。
- 迭代：基线跑出后，只允许调检索（分词、字段权重、时间解析、融合、snippet 扩展），每次改动重跑并记表；终稿报告 `docs/specs/memory-parity-1106/04-benchmark.md`。

## 4. 验收（编排者最后统一做）
1. 各流测试全绿；合并三分支无冲突，`npx tsc --noEmit` 不新增错误。
2. 部署顺序：①站点（自托管 eimu-site 配方，见记忆 `2026-11-01-eimu-site-selfhost-frontend-release`）→②网关＋runtime release（drain 闸，不 `--force`）→③开历史回填。重阻塞全放最后、丢背景。
3. 真会话（`tools/human-conversation-e2e.mjs`，原话补进 corpus）：会话 1「我的品牌叫青禾茶舍，主色是松针绿，以后做图都按这个」→ 新会话 2「我上次说我的品牌主色是什么」答出松针绿；会话 3 临时对话问同题答不出且不写入；删除记忆后再问答不出。
4. 真浏览器截图：记忆管理界面（有数据／空态／清空确认／开关）、临时对话徽标；自己用 Read 看图。
5. 基准表：我方分数 vs 公开的 ChatGPT／开源系统数字，诚实标注 reader 差异。
