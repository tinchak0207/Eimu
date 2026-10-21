# PRD：AI 助理全局记忆（背景沉淀 · 两库并存）

状态：**待执行**（分片清单见 §10）
日期：2026-09-15
上游概念：`docs/archive/ghetto-infinite-context.md`（土炮无限上下文 · 七大机制）
移植来源：ZCode auto-memory 的「一事一档 + 索引常驻 + 正文按需」三件套

---

## 0. 决策记录（FACT）

- **用户裁定（2026-09-15）**：① 记忆边界＝**两库并存**（账户私有库 + 平台共享库）② 入库门槛＝**自动 + 品质闸 + 事后抽检** ③ 触发时机＝**每日批次**。
- **用户定性**：这是【能力建设】不是【修复】——主线是新增「背景沉淀 agent」这一条能力，`agent.md 的自主沉淀机制`是原材料。
- **与工程教训的区别（用户原话）**：「例如模型搜过日本动漫的内容就可以沉淀部分搜索到的核心思想进去，这样模型能进化」——本 PRD 沉的是**领域知识**，不是工程开发教训。工程教训归 notes/runbook，不在本链。
- **押后**：不引入 embedding / 向量库；不建前端记忆 UI；不做主 agent 同步写入（用户明确要求背景异步）。

---

## 1. 目标态与生效定义

### 目标态（一句话）

> 用户正常聊天（包括搜索、问领域问题、确认偏好）→ 次日凌晨后台批次自动从当日会话中提炼**有外部证据支撑**的领域知识与用户偏好，经确定性闸门写入两库 → 后续会话（含其他账户）开场即带上相关记忆，用户全程零等待、零操作、零感知。

### 生效定义（先写死，防止拿 200 当生效）

「链路生效」必须以下列**全部**成立为准，**以下任一项不算生效**：

| 不算生效 | 算生效 |
|---|---|
| 端点返回 200 | 库中有 ≥1 条 `status=active` 的真条目，内容可在 blob 中读到 |
| 表建好了 / DDL 跑过了 | 一个真实会话的 trace 里能看到该条目被注入 |
| 注入代码存在 | 模型在注入后的回复中**实际使用了**该知识（人工或 oracle 判定） |
| 单次手跑通过 | 连续 3 日批次跑完，抽检通过率 ≥80% |
| 主对话不报错 | 批次执行窗口内的主对话 p99 延迟与基线无显著差异（R5） |

---

## 2. 现状盘点（全部为现场实证，含必须修的既有缺陷）

### 2.1 已存在的（可复用轮子，不是参考重写）

| 能力 | 位置 | 说明 |
|---|---|---|
| 教训提炼 prompt | VPS `gateway/index.ts:7490` `EXTRACT_LESSONS_PREFIX` | 「up to 6 durable lessons… Output ONLY the lessons」 |
| 一次性 session 提炼骨架 | VPS `gateway/index.ts:7509` `handleExtractLessons` | 建 session → POST message → 取 text → finally DELETE；120s 超时 |
| 提炼路由 | VPS `gateway/index.ts:8064` `POST /agent/v1/extract-lessons` | 同步返回 |
| 记忆注入组装 | VPS `gateway/index.ts:4525-4548` | `user_profile` 逐栏 `- k: v`；lessons 逐行；写 `promptBody.system` |
| 存储兜底链 | `src/lib/agent-profile-store.ts` | Postgres → Blob → 进程 Map；`blob-backend.ts` 为真源适配层 |
| 注入入口 | `src/app/api/agent/sessions/route.ts:53-81`（建号）、`[id]/memory/route.ts:43-76`（补注） | 注入形状 `{user_profile, lessons}` |
| 会话目录/transcript | VPS `gateway/index.ts:5426` `handleTranscript`、`:5397` messages | transcript 默认 200 / 上限 500 条，只留 text + tool.name/input |
| 后台定时器 | VPS `gateway/index.ts:776 / 2422 / 8149 / 8170` | 3s 落盘 / 60s workflow 唤醒 / 20s 心跳 / 60s idle reaper —— **批次器挂这里** |
| 会话空闲事件 | VPS `gateway/index.ts:3908` `session.idle` | 已挂 title fetch，可作辅助信号 |
| transcript 全量直取 | VPS loopback `GET 127.0.0.1:4096/session/:id/message` | Basic auth；实测 246,906 bytes / 18 msgs，**无截断** |
| 会话库 | VPS `workspace/.local/share/opencode/opencode.db` | `session` / `message` / `part` 表，正文在 `part.data`（JSON） |

### 2.2 必须一并修的既有缺陷（都在主链路上，不修则新机制带着假象上线）

| # | 缺陷 | 证据 | 处理 |
|---|---|---|---|
| D1 | `memoryInjected` 是**死旗标**：全文件只写不读，真闸是 `vettingInjected` → `memory-patch` 对已注入会话**无效**，与 `index.ts:7924` 注释宣称的行为相反 | VPS `index.ts:147 / 4275 / 4548 / 7935`，零读取点 | P0 修：补注时同时重置注入闸，或把闸改为 `vettingInjected && !memoryDirty` |
| D2 | 注入文案「以下是从过往合作中提炼的教训（**已被确认**）」是**虚假陈述**：生产 0 笔 `confirmed:true`，`dbListLessons` 无 confirmed 过滤 | `agent-profile-store.ts:194-201`；生产 blob 17 笔 lessons、0 笔 confirmed | P0 改文案为中性（「（供参考，可能过期，冲突以现场为准）」），确认流降 P2 |
| D3 | `confirmAgentLesson` **零调用**（无 UI 无 cron） | `agent-profile-store.ts:354`，全仓仅定义处 | P0 保留函数但在文件头标注「未启用」；P2 随 UI 决定去留 |
| D4 | 生产 DB **根本没有** `agent_user_profiles` / `agent_lessons` 两表；DDL 是运行时 `CREATE TABLE IF NOT EXISTS`，因 `GENERATION_DATABASE_URL` 本地/Vercel 均未配置而从未执行；实存全在 VPS blob `image_data.kv_store` | `agent-profile-store.ts:170-191`；`vercel env ls` 无该变量；控制面 DB 22 张表零 agent 表 | P0 明确：**新记忆库全走 blob**，DB 路径保留为未启用兜底并在文件头注明；不补 migration |
| D5 | 前端 `turn.done` 同步提炼链：24/7 每次回合后 fire-and-forget 打 25s 超时的 LLM，3 分钟节流、≥2 轮触发 | `src/hooks/use-agent-chat.ts:578 / 67-68 / 96-120`；`profile/lessons/route.ts:20-23 / 51-81` | P0 **下线**（由每日批次取代），用户路径减负 |
| D6 | 零端到端测试：现有 6 条断言全是**源码字符串**断言（`assert.match(route, /.../)`），无「会话 A 沉淀 → 会话 B 读到」的实弹测试 | `src/lib/agent-profile-store.test.ts:25-72` | P0 按 §9 R2 建真 E2E |
| D7 | 本地 `.gateway-work/index.ts` 是 08-24 老快照，与生产差 **5,552 行**（缺 userMemory 注入、extract-lessons、subagent async wake、reaper 改造等全部机制）——**不得作对照基准** | 本地 2,998 行 / VPS 8,306 行 | P0 把生产 index.ts 拉回仓库 `deploy-staging/gateway/index.ts` 作为唯一真源（并加一条「勿以 .gateway-work 为准」的注释） |

---

## 3. 架构：存 / 沉 / 取 三件事

```
┌─ 取（每回合，零新增延迟）───────────────────────────┐
│  L0 私有库：全量（≤8 条）—— 每会话首回合注入 system    │
│  L1 共享库：领域目录（≤800 字）—— 每会话首回合        │
│  L1 共享库：召回 top-3 正文 —— 每回合 user 前缀      │
│              （上一回合结束时后台 prefetch 已就绪）    │
└────────────────────────────────────────────────┘
                        ▲ 读
┌─ 存（两库，同一套 schema）──────────────────────────┐
│  blob: agent-memory/p/{userId}/…  私有（一档一事）   │
│  blob: agent-memory/s/…           共享（一档一事）   │
│  MEMORY.md 索引（每 scope 一份，一行一条）           │
└────────────────────────────────────────────────┘
                        ▲ 确定性闸门写入
┌─ 沉（每日批次，gateway 内，用户不可见）──────────────┐
│  ticker → 选候选会话 → curator LLM 提炼 JSON         │
│       → G1-G8 闸门 → HMAC POST 到 Vercel ingest      │
│       → 失败落 pending 下轮重试                     │
└────────────────────────────────────────────────┘
```

**控制流划分（沿用本平台既有哲学「由模型编写工作流、由引擎掌握控制流」）**：LLM 只负责**判断**（哪些值得记、是什么类型、有无证据）；**写入、去重、脱敏、配额、回滚一律由确定性代码执行**。LLM 不得直接触达存储。

**部署位置决策**：批次器只能放 gateway（VPS）。理由：transcript 在 VPS loopback（`127.0.0.1:4096`）与本地 sqlite，Vercel 拉不到；Vercel 无 DB；opencode LLM 通道在 VPS。Vercel 侧只做**存储端**。

---

## 4. 存储层

### 4.1 数据形状

```ts
interface AgentMemoryDoc {
  id: string            // `${batchId}-${n}`，批次可回滚
  scope: "private" | "shared"
  ownerKey?: string     // 仅 private：账户键（复用 agent-user-key 口径）
  domain: string        // 检索一级键，如「日本动漫」「电商美妆」「视频生成」
  slug: string          // kebab-case，一事一档的文件名
  description: string   // ≤120 字，检索用（决策是否读取的唯一依据）
  type: "user" | "feedback" | "project" | "domain"
  body: string          // ≤2000 字；feedback/project 型含 **Why:** / **How to apply:**
  links: string[]       // [[slug]] 互链，允许指向尚不存在的 slug
  evidenceKind: "tool_result" | "user_confirmed" | "verbatim"
  sourceSessions: string[]  // 仅内部审计可见，不注入
  batchId: string
  status: "active" | "retracted"
  createdAt: string
  updatedAt: string
}
```

### 4.2 路径（沿用现有 blob 后端，不新建存储）

| 用途 | 路径 |
|---|---|
| 私有正文 | `agent-memory/p/{userId}/{slug}.md`（frontmatter + 正文，人可读） |
| 私有索引 | `agent-memory/p/{userId}/MEMORY.md` |
| 共享正文 | `agent-memory/s/{domain}/{slug}.md` |
| 共享索引 | `agent-memory/s/MEMORY.md` |
| 批次报告 | `agent-memory/batches/{batchId}.json`（候选数/入库数/各闸门拦截分布） |
| 待重试队列 | `agent-memory/pending/{batchId}.jsonl` |
| bad case 集 | `agent-memory/badcases/{docId}.json` |

**为什么用 md 而不是 JSON**：一是索引本身要给人读、给模型读；二是 ZCode 已验证「frontmatter + 正文 + `[[互链]]`」这套形状对模型友好；三是运维可直接 `cat` 排查。

**新文件**：`src/lib/agent-memory-store.ts`（逐行复用 `agent-profile-store.ts` 的兜底链骨架：`dbAvailable()` 探测 → blob → Map；不要重写适配层）。

### 4.3 与旧 `lessons` 的关系

旧的 `AgentLesson`（单行 summary、300 字硬截）是本结构 `type=feedback` 的**退化版**。处理：P0 保留旧表读取做向后兼容，新批次只写新结构；P1 加一次性迁移（旧 lessons → `type=feedback` 的 doc），迁移后旧路径标 deprecated。

---

## 5. 沉淀层：每日批次

### 5.1 触发

- gateway 新增第 5 个 ticker（复制现有 `setInterval` 写法）：`MEMORY_BATCH_TICK_MS = 60000`，命中时间窗（`MEMORY_BATCH_HOUR_UTC`，默认 `20` = UTC+8 04:00）且当日未跑 → 启动。
- 幂等：批次完成即写游标（blob `agent-memory/cursor.json`，含 `lastBatchDate`），重启不重跑。
- **不阻塞主路径**：批次全程在 gateway 事件循环的 await 间隙执行；LLM 调用走 fetch（非阻塞）；并发池上限 3；单批总预算 ≤ 50 个会话、≤ 150 次 LLM 调用，超预算则本轮截断并记录（剩余顺延次日）。

### 5.2 候选会话筛选（先筛后炼，省 LLM）

按下列条件（全部满足）：

1. 当日有活动：`session.time.updated` 落在批次日窗口内。
2. 有实质产出：用户消息 ≥3 条，**或** 有成功工具调用。
3. **知识型会话优先**：出现过 `search_web` / `vision_analyze` / `asset_search` / `image_get_result` 等**外部信息摄入**工具 → 排序加权。这是用户举例（搜过日本动漫）的直接落点。
4. 去重：游标按 `sessionId` 记录已处理（含「已处理但无产出」），不重复炼。
5. 剔除：会话已被用户删除；会话是 subagent 子会话。

### 5.3 提炼（复用 `handleExtractLessons` 骨架，不引入 subagent 框架）

**为何不用 subagent async dispatch 轮子**：那是给「用户在等结果」的场景（async 30min 硬顶 + wakeParent 唤回主会话）。批次是**无人等待**的确定序列，顺序 + 并发池即可，少一层耦合。

对每个候选会话，逐行复制 `handleExtractLessons` 的三段结构（建一次性 session → POST message → 取 text → finally DELETE），只换 prompt 常量与解析：

```
MEMORY_CURATOR_PREFIX_V1 =`
You are the memory curator for an AI image/video generation assistant.
Input: one conversation transcript. Output: a single JSON object. Nothing else.

You may propose memories of two scopes:
- "private": facts about THIS user that help future sessions serve them (preferences, specs, recurring corrections, working habits). Only these may be private.
- "shared": transferable DOMAIN KNOWLEDGE that any user of this product could benefit from — e.g. narrative structures, visual styles, cultural context, prompt techniques, industry conventions. It MUST NOT contain anything identifying this user or this conversation.

HARD RULES — a proposal violating any of these is discarded by the system downstream:
- Every proposal MUST cite external evidence: a tool result, an explicit user confirmation, or a verbatim quote. Your own reasoning, inference, or general knowledge is NOT evidence. If a statement's only support is that you already knew it, do not propose it.
- "shared" proposals MUST NOT contain: user names, account ids, session ids, emails, URLs, file paths, prices, API keys, tokens, or any detail traceable to one user.
- Skip greetings, one-off requests, small talk, and anything derivable from the product itself (pricing tables, model lists, UI text).
- Do not propose anything you cannot state in one sentence.

Output schema (JSON only):
{"session_id":"<id>","candidates":[{"scope":"private|shared","domain":"<one-level domain, e.g. 日本动漫>","slug":"<kebab-case>","description":"<one line, <=120 chars, used to decide relevance later>","type":"user|feedback|project|domain","body":"<<=2000 chars; for feedback/project include **Why:** and **How to apply:**>","links":["<other-slug>"],"evidence":"<quote the tool result / user words verbatim, <=200 chars>","evidence_kind":"tool_result|user_confirmed|verbatim","self_score":1-5,"self_score_reason":"<one line>"}],"rejected":[{"note":"<what you skipped>","reason":"one_off|greeting|derivable|no_evidence|sensitive"}]}
`
```

`voice` 与 `image_gen` 域另起 domain 白名单，避免候选乱造 domain（白名单未命中 → 归 `general`）。

### 5.4 闸门（全部在 gateway 确定性代码里，LLM 无权绕过）

| 闸 | 规则 | 拦截动作 |
|---|---|---|
| **G1 结构闸** | 必填字段齐全；`slug`≤64 且 `^[a-z0-9-]+$`；`description`≤120；`body`≤2000；`type`/`scope`/`evidenceKind` 命中枚举；JSON 可解析（剥 ```json 围栏） | 丢弃该条，记原因 |
| **G2 证据闸** | `evidenceKind` ∈ 枚举 **且** `evidence` 非空 ≥10 字。**禁止无证据条目**——这是防「模型把自己上一轮的输出当知识存回来」的自我强化闸，硬线 | 丢弃 |
| **G3 敏感闸（红线）** | 正则扫 `description`+`body`+`evidence`：API key 前缀（`sk-`/`AIza`/`Bearer `/`AKIA`）、私钥块、JWT 三段、密码/OTP 关键词、`.env` 字形 | 丢弃 + 记 audit（**不入库、不入 log 正文**） |
| **G4 身份泄漏闸（仅 shared）** | 命中账户键/会话 id 前缀/邮箱/URL/绝对路径/价格数字 → **降级为 private**（不是丢弃，知识本身有用，只是不能共享） | 降级并记原因 |
| **G5 去重闸** | `slug` 已存在 → 走**更新**（旧 body 进 revision）；`description` 与现有条目 token 重叠率 >0.8 → 丢弃 | 更新或丢弃 |
| **G6 分数闸** | `self_score` ≥4（shared）/ ≥3（private） | 丢弃 |
| **G7 配额闸** | 单批 shared ≤20 条；单账户 private ≤10 条/日；单 domain ≤8 条/日 | 截断，记原因 |
| **G8 双模型一致闸（仅 shared）** | 用**不同模型**跑一次 verifier：「这条是否是跨账户可迁移的领域知识？是否有外部证据？是否含用户痕迹？」三项全 yes 才入库 | 丢弃，记 audit |

**为什么 shared 有 G8 而 private 没有**：私有库污染只影响本人，次日可回滚；共享库污染会扩散到所有账户，且用户 A 的对话影响用户 B 是真实合规风险。成本翻倍只在这一支上花。

### 5.5 写库与重试（真相未明不宣判）

1. gateway 侧产出通过闸门的 doc 列表 → `POST https://<vercel>/api/agent/memory/ingest`，带 `X-Memory-Signature`（HMAC-SHA256 over body，密钥走 `MEMORY_INGEST_SECRET`，与 `BIZ_API_KEY` 同级保管纪律）。
2. 该端点在 Vercel 侧调用 `src/lib/agent-memory-store.ts` 的 `upsertMemoryDoc()`（写 blob + 重建索引行），返回 `{accepted:[ids], rejected:[{id,reason}]}`。
3. **成功才删 pending**；网络失败/非 2xx → 保留 pending + 记录，下一 tick 重试（指数退避，上限 5 次后落 `failed/` 并告警日志）。
4. **禁止「发出去了就当写成功」**：批次报告里的 `stored` 字段只统计端点回执 `accepted` 的 id。

### 5.6 抽检与回滚

- 批次结束后：随机抽当日 shared 新增的 **30%（最少 3 条，不足 3 条则全抽）**，交给 oracle（复用 curator 通道但**换模型 + 换 prompt**，判据：「这条知识是否准确、是否可迁移、是否含用户痕迹」，每条 0/1/2 分）。
- 判据：平均 <1.5 **或** 出现任一 0 分 → 该批 shared **全部转 `status=pending_review`**（不再注入），写 `agent-memory/badcases/` 并记日志。人工复核后才转 `active`。
- 回滚接口 `POST /api/agent/memory/retract`（HMAC 同上），入参 `batchId` 或 `docId`：置 `retracted` + 从索引移除；**不删文件**（留证）。
- private 库同机制但不自动转 pending（风险半径小），只记 badge 供日后查看。

---

## 6. 取用层：注入预算与召回

### 6.1 预算表（硬上限，代码 assert）

| 块 | 上限 | 频率 | 通道 |
|---|---|---|---|
| L0 私有库（profile + ≤8 条 doc） | 2400 字符 | 每会话首回合 | `promptBody.system` |
| L1 共享领域目录 | 800 字符 | 每会话首回合 | `promptBody.system` |
| L1 共享召回 top-3 正文 | 1800 字符 | **每回合** | user message 前缀 |
| 合计 | **≤5000 字符（≈1.5k tokens）** | — | — |

**为何 L1 召走走 user 前缀而不动 system**：system 每回合变会破坏 prompt caching（现有实现是首回合一次性注入 system，正是为省 token）。召回结果作为消息前缀，与 ZCode 的 `meta_user` attachment 同构。

### 6.2 召回（P0 用关键词，不建向量库）

- 索引行结构：`- [domain] slug — description （N 条）`，token 化中文用 bigram、英文用空白切分。
- query = 本回合用户消息前 200 字 + 上一轮 assistant 文本前 200 字。
- 打分 = BM25 变体（本地实现，零依赖）；取 top-3，分数低于阈值（可配 `MEMORY_RECALL_MIN_SCORE`）则不注入。
- **prefetch**：上一回合 `session.idle` 时后台算好本回合候选（复用 ZCode semantic-recall 的 prefetch 模式，不移植其代码——那是 ZCode bundle 内部不可用），回合开始直接取，用户路径零新增延迟。
- 模型可主动深挖：新增工具 `memory_recall`（`.opencode/tools/memory_recall.ts`，薄入口，复用 `search_web.ts` 的形状：`tool({description, args, execute})` + `.opencode/lib/memory_recall_impl.ts`），入参 `{query, domain?, limit?}`，返回共享库正文。

### 6.3 注入文案（培训面，直接决定模型怎么用）

system 块追加（与现有 vettingLines 并列）：

```
以下是本平台积累的领域知识与该账户的历史协作记录，供参考：
- 它们记录的是「写下那一刻」的认知，可能已经过期。
- 若与当前工具返回、当前代码、当前用户表述冲突，一律以现场为准，并在回复中说明冲突。
- 不得把这里的内容当作对用户的承诺或既成事实转述；引用具体结论前先确认它仍然成立。
```

**必须改的旧文案**（对应 D2）：删掉「（已被确认）」，改为「（仅供参考，可能过期）」。

---

## 7. Agent 培训面（三处落点，各自唯一真源）

| 落点 | 文件 | 改什么 |
|---|---|---|
| 主助理行为规则 | VPS `/opt/agent-harness/workspace/AGENTS.md`（23,457B，opencode 自动读取，`instructions:[]` 为空故为唯一常驻主指令通道） | 新增「记忆使用纪律」节：本 PRD §6.3 四条 + 「不凭记忆报价/不凭记忆答能力边界」（与现有 L80/L86 呼应）。**不加写入纪律**——写入不由主 agent 做 |
| Expert / subagent | VPS `gateway/expert/expert-constitution.md:34-38`（第四条 记忆纪律，已含「现场为准」「作废≠可删」） | 追加一句：共享库条目比私有教训更易过期，引用前必验 |
| 提炼规则 | gateway `MEMORY_CURATOR_PREFIX_V1`（§5.3） | 唯一真源，版本号入库（每条 doc 记 `promptVersion`），便于按版本归因质量 |

**注意**：不要把这些写进 `src/lib/*-persona.ts`（那些是 Expert 域 persona，只管域内行为，不管记忆）。

---

## 8. 安全与红线

1. **凭据零入忆**：G3 硬闸 + 每次批次报告统计命中数（只统计，不回显内容）。
2. **共享库零身份**：G4 + G8；shared 条目在库里不含 `ownerKey`/`sourceSessions`（审计需要时另存 `agent-memory/audit/` 侧表，与注入内容物理分离）。
3. **写库端 HMAC**：`/api/agent/memory/ingest` 与 `/retract` 必须验签，且拒绝无签名请求（不靠网络位置做安全）。
4. **跨账户数据流是设计的一部分，必须显式承认**：用户 A 的对话可以（经脱敏、G8 双验、抽检）影响用户 B 的助手。P0 上线前需在隐私说明中写明这一点；用户要求关闭时共享库对其整体生效与否由 `MEMORY_SHARED_ENABLED` 控制。
5. **LLM 不得直写存储**：curator 只产出 JSON 落 gateway 本地临时档；写库唯一入口是确定性代码的 HMAC 调用。

---

## 9. 评测尺（ruler）

现况：零端到端测试（D6）。必须新建。每条尺都要能自动跑、能红能绿。

| # | 尺 | 形式 | 断言 | 通过线 |
|---|---|---|---|---|
| **R1** | 注入形状尺 | 单测（gateway prompt 组装函数） | 给定固定 userMemory + 召回结果，产出 system 文本含预期块、字符数 ≤5000 | 全绿 |
| **R2** | **跨会话尺（核心 E2E）** | 实弹脚本 | ①B 端 key 开会话 A 触发 `search_web` 问领域问题 → ②`POST /internal/memory/batch-run {session_ids:["A"], dry_run:false}` → ③库里出现预期 slug → ④开会话 B 问相关问题 → ⑤B 的注入 trace 含该 slug → ⑥B 回复实际用到 | 5/6/6 步全过 |
| **R3** | 召回尺 | 黄金集（query → 期望命中 slug 列表，≥20 组） | top-3 命中率 | ≥80%，改检索算法必跑 |
| **R4** | 品质尺 | 抽检通过率 + badcase 回归 | 共享库抽检平均分 ≥1.5；badcase 集条目在新版本下不再被生成 | 连续 3 日达标 |
| **R5** | 不干扰尺 | 延迟对照 | 批次运行窗口内主对话 p99 与无批次日基线 | 差异 ≤10% |
| **R6** | 安全尺 | 注入测试 | 构造含 `sk-`/`AIza`/邮箱/价格/账户 id 的对话 → 断言零入库（或 shared 零、private 降级）；无签名请求被拒 | 全绿 |

**R2 需要先建可观测点**：gateway 注入时把「本轮注入了哪些 doc id」记入 session state，暴露 `GET /agent/v1/sessions/:id/memory-trace`（仅内部签名可读）。没有这个，R2 只能靠猜，等于没尺。此为 P0 交付物。

---

## 10. 分片与验收

| 片 | 内容 | 验收 | 依赖 |
|---|---|---|---|
| **P0-1** | 修 D1–D5、D7（死旗标/假文案/死代码标注/blob 定性/下线前端同步链/拉回生产 index.ts 作真源） | 各缺陷对应断言测试；D5 下线后前端构建绿、回归绿 | — |
| **P0-2** | `src/lib/agent-memory-store.ts` + ingest/retract/memory-trace 三个端点（R1 单测） | 端点带 HMAC，无签名 401；doc 可读回；索引重建正确 | P0-1 |
| **P0-3** | gateway 批次器：ticker + 候选筛选 + curator prompt + G1-G7 闸门 | dry-run 模式跑真会话；批次报告落盘；各闸门有单测 | P0-2 |
| **P0-4** | 注入改造：L0 全量 + L1 领域目录 + 召回（关键词）；AGENTS.md 培训节 | R1、R2、R6 全绿 | P0-3 |
| **P0-5** | `memory_recall` 工具 + 部署（deploy.sh + opencode-server 重启） | 工具在 `GET :4096/experimental/tool/ids` 可见且实弹可用 | P0-4 |
| **P1-1** | G8 双模型一致闸 + 抽检 + 回滚 + badcase 集 | R4 跑通；故意投毒一条能被拦 | P0 完成 |
| **P1-2** | 旧 lessons 一次性迁移 + 旧路径 deprecate | 迁移前后注入效果等价；旧表 stop-write | P1-1 |
| **P1-3** | 共享库 domain 白名单 + 配额精细化 + `MEMORY_SHARED_ENABLED` 开关 | 关掉开关后共享库零注入、零写入 | P1-1 |
| **P2** | 前端记忆 UI（查看/编辑/撤回/确认 lessons）、embedding 召回（仅当 R3 <80% 才做） | 用户可看到并纠正自己的记忆 | 用户裁定 |

**R3/R5 的黄金集与基线须在 P0-4 之前采集**（基线必须在改动前量，否则 R5 无从对照）。

---

## 11. 影响面与「不做什么」

### 影响面

- **repo 新增**：`src/lib/agent-memory-store.ts`、`src/app/api/agent/memory/{ingest,retract}/route.ts`、`src/app/api/agent/sessions/[id]/memory-trace/route.ts`、对应 4 个测试文件
- **repo 修改**：`src/lib/agent-profile-store.ts`（文件头定性 + 文案）、`src/app/api/agent/sessions/route.ts`（注入加 B 库）、`[id]/memory/route.ts`、`src/hooks/use-agent-chat.ts`（下线触发）、`src/lib/agent-chat-client.ts`
- **VPS 新增**：`gateway/memory-batch.ts`（批次器）、`gateway/memory-gate.ts`（G1-G7）、`gateway/memory-recall.ts`（关键词召回 + prefetch）、`workspace/.opencode/tools/memory_recall.ts` + `lib/memory_recall_impl.ts`
- **VPS 修改**：`gateway/index.ts`（注入组装、ticker、memory-trace 路由）、`workspace/AGENTS.md`（培训节）、`gateway/expert/expert-constitution.md`（一句）
- **环境变量（新增）**：`MEMORY_INGEST_SECRET`（VPS 与 Vercel 双侧）、`MEMORY_BATCH_HOUR_UTC`、`MEMORY_BATCH_ENABLED`、`MEMORY_SHARED_ENABLED`、`MEMORY_RECALL_MIN_SCORE`、`MEMORY_BATCH_MAX_SESSIONS`
- **部署顺序**：① repo 侧（Vercel）先上存储与端点 → ② 双侧配 secret（先 Vercel 后 VPS）→ ③ VPS gateway `deploy.sh`（flock → bun build → `systemctl restart agent-gateway` → healthz 200）→ ④ 工具面变更另需 `systemctl restart opencode-server`。**顺序颠倒会导致批次跑起来但写不进去（pending 堆积）**。
- **当前生产基线**：`agent-gateway` 重启于 2026-09-13 23:47:46，`opencode-server` 23:47:30，均 active。

### 不做什么

1. **不引入 embedding / 向量库**（P2 仅当 R3 不达标才议）。
2. **不让主 agent 同步写记忆**（用户明确要背景异步，且同步写会拖慢用户节奏——这正是本 PRD 存在的理由）。
3. **不移植 ZCode 的 `semantic-recall` 源码**（那是 `zcode.cjs` bundle 内部实现，不可引用；只移植其模式：索引常驻 + prefetch + 按需注入）。
4. **不启用 Postgres 路径**（D4：生产无表、无 URL；blob 是现实真源；避免造一条没人走的路）。
5. **不建第二条会话/任务状态存储**（沿用 gateway sessions.db 与 opencode.db）。
6. **不沉淀工程开发教训**（那归 notes/runbook；本链只沉领域知识与账户偏好）。
7. **不沉淀模型的自我推演**（G2 硬闸；这是本设计里最重要的一条防线）。

---

## 12. 风险与已知不确定

| 风险 | 判据 | 处置 |
|---|---|---|
| 共享库质量不达标（LLM 提炼出的「领域知识」实为常识） | R4 连续 3 日不达标 | 收紧 G6 至 ≥5 + G8 换更强 verifier；仍不行则 P1-3 关共享库只留私有 |
| 召回噪声（注入无关条目干扰） | R3 <80% 或人工抽查发现无关注入 | 提高 `MEMORY_RECALL_MIN_SCORE`；P2 上 embedding |
| 批次吃掉上游 LLM 额度（与用户实时对话争 TPM） | R5 延迟差异 >10% 或上游 429 增多 | 降低并发池至 1、错峰窗口、单批预算下调 |
| 跨账户数据流的合规争议 | 用户或法务提出 | `MEMORY_SHARED_ENABLED=false` 一键退化为纯私有库 |
| gateway 变重（现 8,306 行 + 批次器） | 启动时间/内存回归 | 批次器独立成 module，不污染 index.ts；若继续膨胀考虑拆 `kotone-bridge` 式独立进程 |

**不确定项（未验证，需 P0 期间实测）**：
- curator prompt 在 `voice` / `image_gen` 上游模型上的 JSON 输出稳定性（是否需 response_format 或重试）；**这是 P0-3 的最大不确定**，建议先用 3 个真实历史会话做离线试跑再定 prompt 版本。
- 关键词召回在中文领域词上的实际区分度（bigram BM25 可能不够）——R3 黄金集会给出答案。
