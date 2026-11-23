# 04 · LongMemEval 评测（2026-11-07）

## 结论
- **检索（零 LLM，全量 470 题，不含弃权题）**：答案会话全部进 top-5 的比例 **87.0%**，top-10 **92.3%**。
- **端到端（reader＋judge，分层抽样 60 题＝6 类各 10）**：**51/60 = 85.0%**（标准误约 ±4.6pp），其中 1 题因 reader 渠道返回空内容按错计。
  - single-session-user 10/10 · single-session-assistant 9/10 · knowledge-update 9/10 · single-session-preference 8/10 · temporal-reasoning 8/10 · multi-session 7/10。
- 对照（公开数字，口径各异，均为厂商或论文自报，未经第三方复现）：GPT-4o 全上下文 60.2%、Zep 71.2%（GPT-4o）、Supermemory 81.6%（GPT-4o，Hindsight 论文转引）、Hindsight 83.6%（OSS-20B）／91.4%（Gemini-3 Pro）。来源：[Hindsight 论文](https://arxiv.org/pdf/2512.12818)、[Supermemory research](https://supermemory.ai/research/longmembench/)。
- 诚实口径：我们的 reader 是 deepseek-v4-flash（便宜档），judge 是独立的 gpt-5.6-sol；官方是 GPT-4o 判分；抽样 60 题方差大；**不能宣称“超过”任何一家，只能说与公开的开源记忆系统处在同一档**。ChatGPT／Codex 自身没有公开 LongMemEval 分数。

## 复现
1. 第 1 段（本机，零 LLM）：`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools/memory-bench/lme-e2e-prepare.mjs --per-type 10 --topk 5 --out /tmp/lme-e2e-input.json`
2. 第 2 段（只在 VPS，渠道配置现场读取，不打印密钥）：`LME_READER=a6api:deepseek-v4-flash LME_JUDGE=shuai-gpt:gpt-5.6-sol node lme-e2e-run.mjs in.json out.json`
3. 检索全量：`tools/memory-bench/lme-retrieval.mjs`。
4. 原始结果：`docs/evidence/memory-v2-1106/lme-e2e-result*.json`、`lme-e2e-merged.json`（含每题 hypothesis 前 600 字与判分）。

## 方法
- 检索＝gateway 线上同一份 `chat-history-search.ts`（SQLite FTS5＋CJK bigram＋相对时间软加权），每题现建内存库、只入该题 haystack。
- reader 看到 top-5 命中会话的原文（每会话 ≤9000 字，按时间升序），提示词与官方一致（逐步抽取再推理）。
- judge 沿用官方分类型判分提示（temporal 容忍差一天；knowledge-update 允许含旧信息；preference 按 rubric）。
- 抽样：每类型在非弃权题中等间隔取 10，确定性。
- 开销：reader 约 54 万 prompt tokens；reader 渠道 happycoding 全程 524，换 a6api 后正常。
