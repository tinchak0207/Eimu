# context-budget 优化后量测 2026-10-11

接 `context-budget-baseline-20261011.md`。改动落地时间 2026-10-11 ~23:50 CST。

## 体量前后差（可复算，部署前工作树）

| 块 | 优化前 | 优化后 | Δ |
|---|---:|---:|---:|
| AGENTS.md（runtime） | 47,321 B | **25,246 B** | **−22,075（−46.7%）** |
| orch custom tools 仍开放 | 87 | **12** | −75 |
| orch tools schema 代理 | ≈91,932 B | **≈12,100 B** | **≈−79,832** |
| top-level SKILL.md | 22 | 22 | 0（无升格） |
| nested SKILL.md | 0 | 0 | 0 |
| beast 帧（本轮未改模组） | 7,370 chars | 7,370 | 0 |
| 环境段断路名单 | 列全 cut 名 | cut>24 时只报数量＋held 列表 | 防反涨 |

估首轮常驻节省（粗）：AGENTS −22kB + tools schema −80kB ≈ **−100kB 量级**；折 token（÷3.4）约 **−30k**，冷启动 input 从 ~62k 有望降到 ~30–40k 量级（**需换手验活会话 tokens.input**）。

## 改了什么（文件＋要点）

1. `deploy-staging/gateway/expert/opencode-agents.json`  
   - orchestrator.tools：显式保留 12（派遣3＋画布4＋quote_bundle＋question＋local_files×2＋memory_recall）；其余 custom **false**（109）。
2. `deploy-staging/opencode-runtime/opencode.json`  
   - 与上表物理同步（真闸门）。
3. `deploy-staging/gateway/environment-facts.ts`  
   - cut 名单 >24 时环境段只报数量＋显式 held，避免断路名单反灌上下文；删「image_generate 等仍可直调」误导句。
4. `deploy-staging/opencode-runtime/AGENTS.md`  
   - 拆薄为总导演短规；细则外移 `_prompt-routing/*`（非 SKILL.md，不进注入面）。  
   - **未砍**安全红线：§7 反逆向、绕过计费／凭证、资料≠指令、内审不上桌、画布写穿、付费纪律、野兽从属条款。
5. 新建按需载体（均非 SKILL.md）：  
   `orchestrator-wallet-and-delivery.md`、`orchestrator-dialogue-discipline.md`、`orchestrator-language-full.md`、`generation-prompt-rules.md`、`bash-environment.md`、`lyrics-music-division.md`

## 事故修复（同轮）

VPS `/opt/agent-harness/workspace/AGENTS.md` 在 21:54 被错写成 **开发者** AGENTS（22,184 B）。本轮 `opencode-release` 把瘦身后的 runtime AGENTS 写回 workspace 根。

## 未做／缺口

- 未改 beast 帧模组正文（已较精简；再砍需单独质量评测）。
- 未降级 0 命中 top-level skill（mem 候选 read-image／astra-ad-studio 等）——可达性风险，另轮。
- Expert 子会话工具表本轮未再收窄（任务要求 Expert 域工具进子会话；物理断路在 **主会话** 侧完成）。
- 活会话冷启动 tokens.input **需换手验**（见质量闸）。
- 付费生成未跑（按暴君令先停）。

## 质量闸（需换手验）

见 `eval-context-slim-20261011/QUALITY-GATE.md`。
