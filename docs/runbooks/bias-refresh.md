# 渠道 bias 刷新（Channel bias refresh）

> 「agent 只认平台给的」——所以平台对渠道的判定必须是**可刷新**的。渠道从坏变好，
> 平台的旧判词不能继续当真理。

## 问题是什么

平台对渠道的负面判定，全部由**历史证据**推导，而证据在渠道修好的那一刻不会自动失效：

| 层 | 判据 | 由什么推导 | 自然过期 |
|---|---|---|---|
| L0 认知层 | agent 的默认模型／选型／报价文案 | 提示词、工作流模板、工具描述（写死在 harness 里） | 永不（要改码） |
| L1 调度态 | `supplier`/`supplier_account` 的 `health_status=cooldown\|degraded`、`cooldown_until`、`failure_count`、5 分钟窗口、`supplier_health_event` | 调度器写的失败/成功流水 | 分钟级（但反复失败会一直续期） |
| L2 证据层 | 断路器 open（`model-availability-gate`） | `generation_job` 近 72h 终态（≥5 样本 0 成功，或 ≥10 样本 <20%） | 72h |
| L3 交付统计层 | `last_24h` 零交付 → agent 排除该模型（`video-model-select.disprovenRecently`）＋ 网关 M4 `override_zero_delivery` 闸；「渠道欠费」信号 | routing events 近 24h | 24h |

实测后果（2026-10-12，miaowuai 接入）：上游适配器修好、渠道实测 200 出片 54 秒，
agent 仍因「近 24h 3 单零交付」拒绝下单——**好渠道被旧证据锁死一整天**。

## 机制（单一真源）

- 表 `channel_bias_reset(scope, target, reset_at, reason, actor)`：一条**重置水位**。
  某 `model` / 某 `supplier` 在 `reset_at` 之前的负面证据不再计入判定。证据本身留在库里，
  **不删除**、可反查、可审计。
- 代码：`src/lib/bias-reset.ts`（水位读取 + 过滤，fail-open：读不到＝原判据）。
- 读方接线（3 处）：`/v1/model-status`、`/api/internal/model-status`（24h 统计 + 欠费信号）、
  `model-availability-gate`（72h 断路器）。网关的 M4 读的就是 `/v1/model-status`，
  所以对外判定只有这一个收口。
- 写方唯一入口：`tools/refresh-channel-bias.ts`。

**边界（重要）**：L1 的调度态是**状态**，工具直接复位；L2/L3 是**证据**，只能用水位
「重新计时」，不能伪造。工具不会、也不能把「没有交付证据」变成「有交付证据」。

## 怎么用

```bash
cd /opt/image-control-plane            # 控制面（密钥/DSN 不出容器）
sudo docker exec -w /app image-control-worker npx tsx tools/refresh-channel-bias.ts --diagnose

# 刷新（默认 dry-run，先看它打算写什么）
sudo docker exec -w /app image-control-worker npx tsx tools/refresh-channel-bias.ts \
  --model minimax-h3 \
  --reason "上游严格 JSON body 适配器已修 + 容器实测 200 出片 54s" \
  --actor tinchak0207
# 确认后加 --apply
```

`--diagnose` 是只读诊断：逐个视频模型列出渠道、能力健康、24h 统计、断路器状态、
当前水位，`★` 标出该模型正被哪条判据判死。刷新前先跑它，才知道该刷谁。

工具做三件写操作（`--apply` 才落库，全部在一个事务里）：复位 L1 调度态、清理窗口内
`supplier_health_event`、写水位。跑完自己复核一遍「平台现在会怎么判」。

## 什么时候该刷新（判据，不是感觉）

同时满足才刷新，且必须能在 `--reason` 里写成一句可被将来的人复核的话：

1. **有修复动作**：上游故障已排除、我方适配器/路由/参数已改并部署；
2. **有独立于旧证据的验证**：直接用上游 key 打一次真实请求并拿到成品（不是「看起来通了」）；
3. **旧证据确属修复前**：`generation_job`/routing events 里的失败样本时间戳早于修复时刻。

反面：渠道没修就刷新 = **伪造证据**，禁止。供应商被人为 `disabled` 的（人的决定）默认
跳过，要覆盖须显式 `--include-disabled`。

## 刷不掉的：M4「近 24h 影片零交付」闸

它不是偏误，是**花钱前的使用者护栏**：在没有任何真实交付证据时开跑付费生成，必须先向
用户说明并取得明确同意（`override_zero_delivery=true` + `override_reason` 引用用户原话）。

它的唯一解锁方式是**一次真实交付**（真实成片落库 → routing event `outcome=delivered`
→ `last_24h.delivered>0`）。所以渠道晋升的标准流程是：

```
L0 认知改码 → L1/L2/L3 bias 刷新 → 一次授权下的真实成片 → 闸门自然打开 → agent 后续免费跑
```

## 验证（交付判准）

不写测试（`AGENTS.md` 测试纪律）。验收看**真路径**：

1. `/v1/model-status` 里该模型 `availability=available`、无「欠费/断路器/无可用供应商」note、
   `last_24h` 不出现「有单零交付」形态（水位后无样本＝字段缺席，是诚实的）；
2. `--diagnose` 不再给该模型标 `★`；
3. agent 真会话里能对该模型下单（Hacker ≠ 作者：换手跑）。

```bash
sudo docker exec image-control-api sh -c \
  'wget -qO- --header "Authorization: Bearer <biz-key>" http://127.0.0.1:3000/api/v1/model-status' \
  | python3 -c "import json,sys; [print(m['id'], m['availability'], m.get('note',''), m.get('last_24h')) for m in json.load(sys.stdin)['models'] if m.get('media_type')=='video']"
```

注意缓存：水位读取 30s、model-status 事件 60s、断路器快照 60s、`/v1/model-status` 探测 60s。
刷新后最多等 1 分钟再判「没生效」。
