# 共通规则（四份 spec 都适用，先读）

## 必读记忆
- 总索引：`/home/lenovo/.codex/memories/extensions/ad_hoc/notes/memory_summary.md`
- `/home/lenovo/.claude/memory/control-plane-billing-paradigm.md`：帐本（account_ledger）是余额权威，入帐只准走 recordRecharge / recordAdjustment
- `/home/lenovo/.claude/memory/product-reality-funnel-0927.md`：真实漏斗；内部用户 117/82/253/87/90（及计费身分 4）要剔除
- `/home/lenovo/.claude/memory/referral-loop-0928.md`：最新的「占位 → 动上游 → 记帐本」范例（src/lib/referral-reward.ts）
- `/home/lenovo/.claude/memory/price-no-change-0928.md`：**禁止改正价**
- 记忆与现场冲突时，以现场代码为准，并在回报里写明冲突。

## 红线
- 禁止发起真实支付；禁止任何付费上游生成调用（只准 GET /models 之类的唯读端点）。
- secret、key 明文、email 一律不进日志、commit、回报。
- 同一个错误重试 2 次仍失败 → 停下，回报事实。
- 不部署。完成后只做这些：`npx tsc --noEmit -p .`、`npx next lint --file <改过的档>`（**控面连测试档也 lint**）、`npx tsx --test <相关 *.test.ts>` 全绿 → `git commit`（讯息结尾加 Co-Authored-By 行）→ 回报 commit hash、改动档清单、测试输出摘要。
- 风格：跟随周边代码（注释密度、正体注释＋简体用户文案，与现有档案一致）。
