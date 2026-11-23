# Eimu 记忆系统现状地图（2026-11-06，分支 image，HEAD e24852efe）

来源：Explore 子代理逐档取证（以代码为准）。行号以 e24852efe 为准。

## 结构
- store：`src/lib/agent-memory-store.ts`（76 行 barrel）＋ `src/lib/agent-memory-store/` 17 模块（types/validation/keys/store/blob-io/ingest/reconcile/history/validity/read-api/index-md/mutate/normalize/reports/text/db/constants）。
- gateway：`deploy-staging/gateway/memory-wiring{,-inject,-recall,-batch}.ts`、`memory-recall.ts`（BM25）、`memory-gate.ts`、`memory-http.ts`（`/internal/memory/note` 回环）、`memory-note.ts`、`memory-batch*.ts`、`memory-trigger.ts`、`memory-queue.ts`、`agent-memory-write.ts`（文件式记忆 memory_save/list/read，不注入）。
- runtime 工具：`deploy-staging/opencode-runtime/tools/memory_{note,recall,save,list,read}.ts`、`lib/memory_recall_impl.ts`。memory_note 开给 12 个 agent；memory_recall 只开 build、orchestrator（`opencode.json`）。
- 注入组装：`src/lib/agent-memory-injection.ts:144-175`（建会话 `src/app/api/agent/sessions/route.ts:62-94`、恢复 `src/app/api/agent/sessions/[id]/memory/route.ts:83-108`）；gateway 每回合注入 `memory-wiring-inject.ts:89-223`，注入点 `messages-gw-admission.ts:362-381`。

## 数据模型
- AgentMemoryDoc（types.ts:22-71）：id/scope(private|shared)/ownerKey/domain/slug/description(≤120)/type(user|feedback|project|domain|workflow)/body(≤2000)/links/evidence/evidenceKind/selfScore/promptVersion/batchId/status(active|retracted|pending_review|superseded)/revision/contributors/proposed + validFrom/validTo/observedAt/referenceTime/supersedes/sourceSessionId/sourceMessageIds/lastConfirmedAt/lastUsedAt/lastOperation。
- id 确定性 `mem-<sha256(scope|owner|domain|slug)[0:16]>`（keys.ts:27-45）。ownerKey＝hash12(正典 key)（agent-memory-injection.ts:105-133；gateway router.ts:551-558、auth-gw.ts:187 hashKey）。
- 后端：VPS image-data-api（IMAGE_DATA_BASE_URL+KEY）或 Vercel Blob，失败退进程内 Map；无 CAS。路径 keys.ts:56-104：`agent-memory/p/{owner}/{domain}/{slug}.json`、`agent-memory/s/{domain}/{slug}.json`、`p/{owner}/INDEX.md`、`s/INDEX.md`、`catalog.json`、`catalog/{sha16}.json`、`revisions/{id-hash}-r{n}.json`。catalog TTL 60s。
- 画像/教训：`src/lib/agent-profile-store.ts`（`agent-profile/p/{userId}.json`、`l/{userId}/{lessonId}.json`）——画像无写入方（实际为空）；`listAgentLessons` 只读进程内 Map（读不回 Blob）；`confirmAgentLesson` 零调用。
- gateway SQLite：`/opt/agent-harness/state/sessions.db`（bun:sqlite 3.53，FTS5 trigram 可用）。`sessions(id, owner_key, opencode_session_id, created_at, updated_at, data)`、`user_settings(owner_key, data, updated_at)`（persistence-schema.ts:109-130）。生产 1080 会话 / 35 owner。

## 写入
- memory_note（agent 主动写，无 LLM）→ gateway gates（memory-gate.ts:226-383：G1 结构/G2 证据/G3 密钥/G6 分数/G7 注入检测(shared)/G4 身份泄漏降级）→ HMAC → `/api/agent/memory/ingest`；store 侧 G5 去重（Jaccard>0.8）、配额（private 60/owner/日、50/domain/日）。
- 每日批次（生产 `MEMORY_BATCH_ENABLED=true`，UTC20＝北京 04:00），curator prompt v3，走 opencode 默认模型；失败信号队列优先；G8 双模型默认跳过。
- reconcile（reconcile.ts:24-80）：SUPERSEDE/NOOP 确定性启发式；跨 domain 不 supersede。
- 其他写入者：workflow-completion（type=workflow）、user-skill（slug 前缀 user-）。

## 读取
- 注入块：L0 2400 字（画像、教训≤8、private 正文≤8 偏好优先）；L1 800 字（shared INDEX 截断——字母序截断，技术债）；平台状态 600；热语料 ≤1800（只 shared）；连续性 900（首回合）；总 5000 硬帽。
- prefetch：上回合按用户句算 top-k，TTL 5 分钟；首回合仅在 shared 语料缓存热时有召回。
- BM25（memory-recall.ts:61-83）k1=1.2 b=0.75，desc×2 body×1 domain×1.5 observedAt×0.5，CJK bigram，minScore 1，top3/上限5；时间衰减、两跳链接；**无向量**。
- **召回语料只有 shared**（memory-wiring-recall.ts:410、memory-wiring.ts:91）；memory_recall 工具也只搜 shared。

## 用户控制（全部缺）
- 无记忆管理 UI（只有 MySkillsDialog 管 user-* skill）。ingest/retract/export/review/history 全 HMAC 内部端点，用户用不了。
- retract 不删文件；无硬删除；无记忆开关、无临时会话；「你记得我什么」只能答 L0 那 ≤8 条。
- 不引用历史会话正文（只有 H17 连续性：12h 同题标题相似 + 72h 资产清单）。
- 无项目维度（type=project 只是分类）。

## 测试
- repo：`npx tsx --test <file>`；记忆相关 78/78 绿（agent-memory-store、injection、memory-hmac、workflow-memory、workflow-recall、api/agent/memory/routes、agent-profile-store、user-skill、skills/mine）。
- gateway：`bash deploy-staging/vps-tools/run-tests.sh <file>`（bun）；memory-recall 12/12；memory-gate 30/35（5 红为夹具缺 ownerKeyHint，被 4af310238 回滚撤掉了修正，测试过时非回归）；memory-http/note/write/trigger/queue 零测试。

## 技术债
L1 截断；private>8 不可见且被 skill/workflow 文档抢位；lessons 读不回；lastUsedAt 不回写；sourceMessageIds 无生产者；无 CAS；会话累计字节未接 teardown。
