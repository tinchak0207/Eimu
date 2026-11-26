# S1 API 拒绝遥测＋首调审计（预期 40 分钟）

先读 `_common.md`（同目录）。

## 为什么
23 个外部用户建了 biz key，其中 16 人一次调用都没成功过。被拒的请求（鉴权、余额、参数）根本不会进 generation_job，我们完全看不见流失在哪一步。

## 做什么
1. 新表 `api_rejection(id bigserial, user_id bigint null, key_prefix text null, path text, model text null, status int, reason text, created_at timestamptz default now())`
   - 写 migration `db/migrations/029_api_rejection.sql`
   - 同时用 `ensureSchema`，首次使用时自动建表（仿照 src/lib/referral-reward.ts）
2. 在 B 端 `/v1/*` 入口（`src/app/api/v1/images/generations`、`edits`、`[id]`、`src/app/api/v1/models`，以及它们共用的鉴权、计费闸；用 grep 找 `authenticateBizKey`、biz key 验证函数），每一个「回非 2xx」的出口都写一行。
   - `key_prefix` 只取前 8 位
   - 不记 prompt，不记完整 key
   - 写入失败静默吞掉，不能影响请求本身
3. 出一份唯读报告，写到 `docs/specs-0928/S1-report.md`：23 个 key 持有者（排除 117/82/253/4）的历史 generation_job，每人列出：
   - 首单时间、模型、状态、失败原因
   - 从没调用过的人，列出建 key 时间
   - 同时查 new-api 日志：`sudo sqlite3 /opt/imagesite/new-api-data/one-api.db`，`logs` 表按 user_id 看他们有没有打过 new-api、错在哪
   - VPS 连线：`ssh -i /home/lenovo/.ssh/new.pem -p 22443 ubuntu@43.172.85.76`；Postgres：`sudo docker exec image-control-postgres psql -U image_control -d image_control`

## 验收
- 单元测试：拒绝记录器对 401、402、400 各写一行，且不含完整 key
- 报告按原因分组，给出人数
