# system-prompt 审计（beast OFF / creator）2026-10-11

- 测量／改动：2026-10-11 ~23:47–24:30 CST
- 定性：能力建设——补看 **beast OFF**（主会话 `agent=creator`）注入；对照 ON 审计 `system-prompt-audit-20261011.md` + commit `b54eef48`
- 样本：活库 `ses_ee0aaec29…` / `msg_11f5519ef…`（2026-10-09 14:23 CST，小说影视化模板卡；**pre-slim**，拓扑仍有效）
- 样本文件：`docs/arch/_sp-audit-samples/beast-off-msg0-user-system.txt`（nonce 已脱敏）
- **付费生成未跑**；未全量 `opencode-release`

## 0. 注入拓扑对照（ON vs OFF）

opencode 合成 system 头部同形：

```
[ agent.<name>.prompt
  + environment.system（workspace/AGENTS.md + <available_skills> + 其它 env）
  + user.message.system（网关：authority / memory-* / onboarding / 风格·成本·互动 / 环境事实）
]
```

| 注入点 | beast ON（orchestrator） | beast OFF（creator） |
|---|---|---|
| `promptBody.agent` | `orchestrator` | `creator` |
| agent.prompt | 创作总监＋短歌词指针（~573–1286 B，视部署） | 创作助理全能＋歌词路由（**664 B**） |
| 工具表（opencode.json） | **held 12 / cut 109** | **仅 `task:false`**（其余未列＝默认开 → Expert 域 schema **灌回主会话**） |
| 野兽帧（turn 尾） | 注入 core＋阶段模组＋registry（~6.5–7.4k chars） | **不注入一字** |
| 研究先行／派遣手册／Expert digest | 在野兽帧内 | **无** |
| PROMPT_SKELETON／画布写穿指令 | 有（首条影音意图） | **旧码无**（绑 `beast_mode`）→ **本轮解绑后有** |
| AGENTS.md 全文 | 整份常驻（~24.6 kB） | **同样整份常驻** |
| available_skills（含 beast-*×4） | ~22–24 条目录 | **同样整份**（beast-* 对 creator 多为噪音目录） |
| memory / onboarding / adapt | 同管线 | 同管线 |
| 环境事实 plane | orchestrator；报 12 held + 109 cut | creator；**旧：工具面未知**（`opencode-agents.json` 无 creator）→ **本轮补条目后：默认开放／仅禁 task** |

## 1. 真实会话样本（beast OFF）

| 项 | 值 |
|---|---|
| session | `ses_ee0aaec29ffekH4NU87sT8RXJR` |
| message | `msg_11f5519ef0010f9dE80cSehx2t` |
| agent | **creator** |
| user.system | **2285–4828 B**（含模板偏好＋环境事实；本 dump 4828 B） |
| turn 尾 parts | **仅用户正文**（无 `⟦gw:⟧` 野兽帧／无画布写穿块） |
| 首条 assistant `tokens.input` | **54648**（+cache.read 14080） |

与 ON 音乐样本（~45–55k input）同量级——OFF **省掉野兽帧 ~7k chars**，但 **工具 schema 回灌 109 个域工具** 把省下的吃回去甚至更多。

环境事实（样本原文摘要）：

```
- 本回合挂载 agent：creator
- 工具表：未能在真源 … 找到 agent=creator 的条目（工具面未知，勿断言）。
- 能力断路：未知（工具表条目缺失）。
```

（改前活态；改后见 §3。）

## 2. KEEP / TRIM / DROP（按生产必需）

### A. agent.creator.prompt — KEEP

身份＋资料≠指令＋全能直做＋歌词必派 lyricist。与 OFF 产品定位一致。

### B. 工具面 — KEEP 开放（禁套 ON 断路）

| 项 | 标签 | 理由 |
|---|---|---|
| creator 仅禁 `task` | **KEEP** | OFF＝用户关野兽＝要主会话直调；误套 109 cut＝断生产 |
| Expert 域 schema 进主会话 | **KEEP 现状**（接受成本） | 代价是 tokens；收益是直调。另轮可做「按意图动态工具面」 |
| `opencode-agents.json` 缺 creator | **DROP 空洞（已修）** | 环境事实说「未知」误导；已补 `{task:false}` |

### C. 野兽帧 / 研究先行长文 / 派遣规 — OFF 路径已不注入 — KEEP 现状

代码 `beastMode === true` 才拼帧。OFF **不会**灌 stage-research 等。无需再砍帧。

### D. AGENTS.md 常驻 — TRIM 路由矛盾（已落地）

`b54eef48` 按 ON 把图片行改成「只派遣 Expert」，**伤到 OFF**：creator 有工具却被路由表禁止直调。

| 段 | 标签 | 动作 |
|---|---|---|
| 野兽从属条款（有标记才生效） | KEEP | 条件句正确 |
| §1 图片／TTS 行 | **TRIM（已）** | 恢复「非野兽直调／野兽派遣」双路径 |
| §1 音乐行 | **TRIM（已）** | 非野兽 `music_gen`；野兽派 music |
| §1 剪辑行 | **TRIM（已）** | 非野兽可直调 timeline_* |
| §3.8.6「非野兽可直调」 | KEEP | 已与 OFF 对齐 |
| §4 野兽免责头 | KEEP | 条件句 |
| 成片／分镜／附件里「一律派遣」 | **TRIM（已）** | 改为按模式分流 |
| 全文体量 | 24597→**24605**（+8） | 双路径略增，不砍安全红线 |

### E. 环境事实 — TRIM 误导（已落地）

| 项 | 标签 | 动作 |
|---|---|---|
| creator 未知工具面 | DROP | 补真源条目 |
| 对开放面套「Expert 唯一通路」 | DROP | `isOpenToolSurface`：creator 话术＝可直调 |
| orchestrator 109 省略名单 | KEEP | 与 ON slim 一致 |

### F. PROMPT_SKELETON／画布写穿 — 解绑 beast（已落地）

修画布裁定是产品硬闸，与野兽无关。旧码 `skeletonTask = beastOn && …` 导致 OFF 永不弹骨架、也不注入改 DSL 指令。

- skeleton：改为 `!userTemplateAttached` 即建
- `pendingAvCanvasDirective`：移出 beast ON 专属块，ON/OFF 皆注入

### G. available_skills 含 beast-*×4 — TRIM（未动）

目录常驻 ~数 kB；降级需评测可达性。记未做。

### H. memory / authority / §7 — KEEP

安全红线禁砍。

## 3. 已落地改动

1. `deploy-staging/gateway/expert/opencode-agents.json` — 增 `creator: { tools: { task: false } }`
2. `deploy-staging/gateway/environment-facts.ts` — `isOpenToolSurface`；creator 渲染「默认开放／可直调」
3. `deploy-staging/gateway/environment-facts.test.ts` — 对齐 slim 断言 + creator 用例（17 pass）
4. `deploy-staging/gateway/messages-gw.ts` — PROMPT_SKELETON／画布写穿与 beast 解绑
5. `deploy-staging/opencode-runtime/AGENTS.md` — 路由表与成片／分镜／附件恢复 OFF 直调路径

## 4. 体量差

| 块 | 改前 | 改后 | Δ |
|---|---:|---:|---:|
| runtime AGENTS.md | 24597 | **24605** | **+8**（双路径） |
| creator 环境事实（估） | 「未知」误导段 | 开放面短句 | 语义修正，非大省 |
| 野兽帧 OFF | 0 | 0 | 0 |
| 工具 schema OFF | ~全量（109 域在） | 同 | **未砍**（刻意） |
| OFF 首轮 tokens.input | ~54k（样本） | 需新会话复测 | — |

## 5. 未做项

- 不把 ON 的 12/109 断路套到 creator
- 不删／降级 beast-* skill 目录（可达性）
- 不改记忆「领域知识目录」注入
- 不跑付费生成；无 **post-fix** beast OFF 冷启动 tokens 复测
- RECIPE.md 内仍有若干「经 Expert 报价／断路」句偏 ON 口吻——按需载入，本轮未改
- 开发者仓库根 `AGENTS.md`（工匠／研究先行）本就不进生产 runtime——勿覆盖 workspace

## 6. 复算

```bash
# creator 真源
python3 -c "import json;d=json.load(open('deploy-staging/gateway/expert/opencode-agents.json'));print(d['creator'])"
# 环境渲染
cd deploy-staging/gateway && bun -e 'import {collectRuntimeEnvironment,renderEnvironmentSection,renderCapabilityCutoffFact} from "./environment-facts.ts"; const e=collectRuntimeEnvironment({plane:"creator"}); console.log(renderEnvironmentSection(e)); console.log(renderCapabilityCutoffFact(e));'
bun test environment-facts.test.ts
# VPS 新会话后：
journalctl -u agent-gateway --since "5 min ago" | grep -E "PROMPT_SKELETON|beast-frame|agent：creator" | tail
```

## 7. VPS 外科手术同步（CST ~23:52）

- 装入：`gateway/messages-gw.ts`、`gateway/environment-facts.ts`（+test）、`gateway/expert/opencode-agents.json`、`workspace/AGENTS.md`＋`.opencode/AGENTS.md`（24605 B）
- 备份：`/opt/agent-harness/backups/sp-beast-off-20261011T235249`
- `systemctl restart agent-gateway opencode-server` → 皆 active；gateway `:8081`，opencode `:4096`
- 校验：creator 环境事实＝「默认开放／仅禁 task／可直调」；orch 仍 cut **109** held **12**；AGENTS 含「非野兽：直调」
- **未**跑全量 `opencode-release.sh`
