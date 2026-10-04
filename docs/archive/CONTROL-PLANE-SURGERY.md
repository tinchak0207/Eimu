# 中控外科手术计画：new-api 稳定内核替换自研屎山

> 2026-08-28 暴君指令：「中控 new-api 化不够彻底，必须大刀阔斧把屎山替换掉，使用 new-api 的稳定内核」。
> 依据：R4 评测 5.4/10 + h3 视频死因链（磁盘满→自研 reserve 执行器卡死→24 job 永远 pending_billing→gateway 误判超时）+ 189 refunded / 3 succeeded 的历史帐 + 域 E 修复时撞上的 reconcile 屎山。

## 终局（可测量）

一句话：**暴君的订单（B 端 API / agent 画布）→ new-api 唯一内核受理、relay、计费、记日志 → 控制面只剩薄壳（鉴权/契约/回调/遥测）。任务路径上零自研状态机。**

验收硬指标：
1. `pending_billing` 不再存在于任务路径（提交即执行，计费是记帐不是闸门）
2. 自研 reserve 执行器与 reconcile 收编逻辑代码删除
3. 图像/视频/TTS 三类任务 100% 经 new-api（渠道桥：pixai/adobe2api/sub2api/metaso-hailuo/hublinuxdo…）
4. B 端对外契约一字不变（错误码/栏位/幂等/callback_url——承诺永不变）
5. 端到端：B 端 key 提一条 h3 视频，从提交到出片 URL，全链路只出现 new-api 一个任务内核

## 原则

- **对外契约永不变，内部自由演进**——B 端 OpenAI 相容端点、Idempotency-Key、callback_url、错误码原样保留
- **new-api 做它稳定的事**：relay、渠道管理、配额扣减、请求日志。我们不再平行维护第二套
- **计费语义升级**：原「计费留自研」的合理内核（B 端对帐、退款、成本感知）保留为**异步记帐层**（从 new-api 消费日志投影），自研的**阻塞式 reserve 闸门拆除**——计费不许再挡任务路径
- 每阶段可独立回滚；部署顺序：先影子验证再切流量

## 现状解剖（已实锤）

| 层 | 现状 | 判决 |
|---|---|---|
| B 端契约 /v1/* | OpenAI 相容，正常 | **保留** |
| biz-key 鉴权 | 自研表 biz_api_key | **保留**（与 new-api token 建映射） |
| 自研计费闸 | billing_operation reserve/commit/refund 阻塞式执行器，会卡死不自愈 | **拆除**（计费改异步记帐投影） |
| 任务状态机 | generation_job + 自研 submit/poll + worker 迭代 | **拆除双头**：任务语义归 new-api 原生 task；控制面只做状态同步与回调 |
| 上游适配器 | metaso-upstream.ts 等自研协议层 vs new-api 渠道 8 | **拆除重复**：渠道桥只作为 new-api channel 存在 |
| 调度/lease/supplier gate | 换血后已名存实亡 | **拆除**（残骸清扫） |
| 遥测 /v1/model-status、/admin | 正常 | **保留**（数据源改投影） |
| 工件存储/URL、callback 投递 | 正常 | **保留** |

## 阶段

### P0 止血（域 E，进行中）
reserve 自愈修复 + 24+14 僵尸清帐 + 诚实超时话术 + 视频提交路径侦查（是否已走 new-api 渠道 8）。
→ E 的侦查结论直接喂 P1 施工图。此阶段产物在手术后全部退役，但让生产先不流血。

### P1 单内核切换（核心刀）
1. **计费闸拆除**：任务提交路径的 pending_billing 阻塞删除；改为——提交前仅做 new-api token 配额原子检查（无状态、无执行器、不可能卡）；提交后从 new-api 消费日志异步投影记帐（billing_operation 保留表结构做对帐投影，新增 reconcile 从 new-api logs 读真实消耗）
2. **任务语义归一**：video/image/tts 三类提交与轮询全部走 new-api 原生语义；generation_job 降级为「投影表」（同步 new-api 任务状态，供 B 端 GET /v1/{images,videos,tts}/{id} 与 callback 用），不再自己驱动上游
3. **biz-key ↔ new-api token 映射**：每把 biz key 对应 new-api token（配额执法在 new-api 内核）；映射表入 control DB；/v1/quota 已读 new-api users.quota，映射已有基础
4. 验收：三类各一条真实任务端到端 + 僵尸零增长 + B 端契约回归测试全绿

### P1.5 事件账本 + probe 侦查面（与 P1 同刀口，暴君 2026-08-28 点名）

> 暴君原话：「现在每次生成失败都要追溯整整一个小时深入 vps 绕过中控的谎言」。

**一小时侦查的三宗罪（本轮 h3 实锤）**：①真相散落六处（gateway journald／控制面 DB／容器日志／new-api sqlite／渠道桥日志／opencode 日志）②中控会撒谎——假超时话术、花费数据暂缺、健康检查假阳性（诊断查询与执行门槛不一致旧案）③generation_job 无事件史（连 last_error 栏位都没有，每次都是 SQL 考古）。

**手术后的答案：一条 probe 命令，30 秒出死因。**

1. **job_events append-only 账本**（根治撒谎的结构手段）：
   - 表：`job_events(job_id, at, event, actor, upstream_raw, detail)`，每次状态迁移追加一行
   - 铁律：generation_job 状态栏位**只能由事件写出**（写状态必写事件，无事件的状态=bug）；上游错误**原文入库不改写**；话术只许存在于展示层
   - 随 P1 投影表改造一起建（同一战场，同步 new-api 状态时顺手埋点）
2. **probe 查询面**（admin key 门禁；biz key 只许查自己名下 job）：
   - `GET /v1/jobs/{id}/timeline`：一条查询 join 投影表+job_events+billing_operation+new-api logs/tasks+渠道桥末次回应 → 完整时间线（建单→配额预检→受理（new-api task id）→上游受理→轮询→终态+上游原文）
   - `probe --stuck`：滞留 >N 分钟 job 名单+死因分类（未受理／上游无回应／轮询断／记帐投影断）
   - 健康真相：/v1/model-status 已真产物驱动（R3-A）；补 probe/health 报真实链路（worker 存活/DB 可写/new-api 可达/每渠道 last-success 时间戳），自检**永不模拟成功**
3. **验收**：任意一笔失败 job，probe 一条命令 30 秒内给出死因+上游错误原文，全程不开 `docker exec`、不进 VPS。

### P2 拆除与清扫
- 删：reserve/commit/refund 执行器、reconcile 收编、supplier lease/capability 门禁、metaso-upstream 自研协议层（若 P1 证实冗余）、worker 的 submit/poll 重复实现
- worker 瘦身为：new-api 任务状态同步 + callback 投递 + 遥测聚合三个纯函数循环
- 验收：`grep reserve` 任务路径零命中；全量 smoke；前端生图/画布/agent 全链路实测

### P3 总验收
- R5 评测：同一本《大明最后的十七年》整本 PDF 重放（同 R4 姿势），对比 5.4 分
- 死线对帐：暴君三死线逐项勾销
- 记忆沉淀 + 中控新架构图入 MEMORY

## 风险与回滚

- P1 是心脏手术：影子期双写（新旧路径并行跑一轮对比帐），B 端契约测试锁死
- new-api token 配额若与现有 biz key 余额不一致 → 以 new-api users.quota 为唯一真源，一次性对帐迁移
- 回滚点：每阶段 git tag + 镜像 tag（沿用 rollback-YYYYMMDD 惯例）

## 执行纪律

- 每阶段派 subagent，orchestrator 统一部署；白名单式改动（指定档案指定函数），禁止顺手重构
- 计费金额语义（amount/500000、commit/refund 数学）原样保留，只拆「阻塞」不拆「帐本」
- KEY 永不入 log/memory/commit
