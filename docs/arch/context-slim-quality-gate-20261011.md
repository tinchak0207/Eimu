# 质量闸 — context-slim 2026-10-11（需换手验）

**作者 ≠ Hacker**：本档由实施 agent 写验证步骤与证据路径；验收必须换另一个 agent／模型／暴君。

## Brief（建议）

`来一首00年代周杰伦风格的歌`（beast ON；与 2026-10-05 stage-selection 金提示同构）

## 零付费干跑口径（本轮强制）

1. 允许：研究派遣、`subagent_dispatch`、`quote_bundle(balance_only)`、`canvas_get_state`、`workflow_write`（骨架／文本节点）、读 skill／RECIPE。
2. **禁止**：任何付费上游生成 POST（`music_gen`／image／video 真单）。若模型要生成 → TaskStop 并回报暴君。
3. 干跑成功定义：研究先行可见（派 research 或载 research skill）＋ **≥3 路派遣**（或明确并发槽在补派）＋ **成功 workflow_write 非 dry_run**（画布写穿）。

## 步骤

1. 新会话，beast ON，发 brief。
2. 取证：
   - `journalctl -u agent-gateway | grep beast-frame` → `stages=` 须含 `research,creation`（及 dispatch-verify）。
   - sqlite 首条 assistant：`tokens.input`（冷启动 cache.read=0 最佳）写入本目录 `evidence/first-turn-tokens.txt`。
   - 工具调用序：须见 `subagent_dispatch` ≥3（或研究军团并发）；主会话 **不得** 出现 `music_gen`／`image_generate` 等已断路工具成功调用。
   - 画布：`workflow_write` 成功回执（created/updated 节点）。
3. 对比优化前样本：`ses_ed653f1e…` input=61888（见 baseline 文档）。
4. 质量不降判据（全过才可放）：
   - [ ] 研究先行未塌成单 Expert
   - [ ] 能派 ≥3
   - [ ] 能写穿画布
   - [ ] 安全红线仍在（抽查 AGENTS §7／付费／内审不上桌仍注入）
   - [ ] 首轮 tokens.input 较 61888 明显下降（期望 ≥20%；未达则标缺口不硬放）

## 证据路径

- 基线：`docs/arch/context-budget-baseline-20261011.md`
- 优化后：`docs/arch/context-budget-after-20261011.md`
- 本闸：`eval-context-slim-20261011/QUALITY-GATE.md`
- 换手填写：`eval-context-slim-20261011/evidence/`（Hacker 建）

## 标：「需换手验」
