# system-prompt 审计 2026-10-11

- 测量／改动：2026-10-11 ~23:45–24:10 CST
- 定性：能力建设——细看 **beast ON 主会话** 真实注入，按「生产影音 agent 是否必需」打标并落地可安全 TRIM/DROP
- 样本来源：VPS sqlite `message.data.system` + `part` 尾端（会话 `ses_ed4e82b77…` 华语曲 / `ses_ed49daf5…` 工程写穿 / `ses_ed4bbd29…` 长音乐）
- 样本文件：`docs/arch/_sp-audit-samples/`（凭证 nonce 已脱敏）
- 前置瘦身：commit `d4ee7bef`（AGENTS 47321→25246；orch tools ON=12）
- **付费生成未跑**

## 0. 注入拓扑（真路径）

opencode 合成 system 头部：

```
[ agent.orchestrator.prompt
  + environment.system（含 workspace/AGENTS.md + <available_skills> + 其它 env）
  + user.message.system（网关每轮：authority / memory-* / onboarding / 风格·成本·互动 / 环境事实）
]
```

turn 尾（user parts 末）：`⟦gw:nonce⟧` + 野兽帧（core+阶段模组+registry）± PROMPT_SKELETON／画布写穿指令。

> 活库 **不存** environment.system 全文；AGENTS/skills 由 opencode 从 workspace 装入。本审计用 runtime 真源 + 活 `user.system` + 活 turn 尾还原。

## 1. 首轮体量（样本）

| 会话 | 时刻 CST | user.system 字元 | turn 尾 parts 字元 | 首条 assistant tokens.input |
|---|---|---:|---:|---:|
| music-pre `ses_ed4e82b77` | 21:12 | 4802 | 7455 | 46520（+cache.read 15616） |
| music-long `ses_ed4bbd29` | 22:00 | 4900 | 7448 | 55805 |
| eng-postslim `ses_ed49daf5` | 22:33 | 2213 | 7511 | 45386（+cache 9728） |

说明：三样本皆在 **本轮审计改动之前**；且 eng 样本的环境事实仍是「显式 2 + 断路 33」旧口径（slim 的 12 held／109 cut 于 ~23:38 才装上 gateway）。beast 帧 `total_chars=7370`（journal）与 parts 内 ~7404 一致。

## 2. 分块全文／摘要 + KEEP/TRIM/DROP

### A. agent.orchestrator.prompt（environment 头部）

- 体量：改前 **1621 B** → 改后 **1286 B**
- 内容：身份＋安全底线＋创作总监角色＋歌词路由
- **TRIM**（已落地）：歌词路由长段与 AGENTS「歌词与作曲分工」重复 → 改为短指针
- **KEEP**：身份、资料≠指令、野兽优先、派遣角色

### B. environment.system → workspace/AGENTS.md

- 体量：`d4ee7bef` 后 **25246 B** → 本轮 **24597 B**（Δ -649）
- 分段打标：

| 段 | 标签 | 理由 |
|---|---|---|
| 野兽从属条款 | KEEP | 生产指挥权 |
| 开场职责句 | TRIM（已） | 删「底层模型 happycoding/…」——反逆向＋生产不需要厂商串 |
| §核心原则 1–7 | KEEP | 产品行为 |
| §0 语言与输出 | KEEP | 硬规则 |
| §1 路由表·图片行 | DROP 矛盾（已 TRIM） | 仍写「原生直调 image_generate」与 orch 工具断路矛盾 → 改为派遣 Expert |
| §1 路由表·音乐行 | TRIM（已） | 六层 style 公式墙应在 `music-director` skill，表内只留指针 |
| §1 其余指针行 | KEEP | 短指针→RECIPE |
| §2 生成 prompt | KEEP | 短指针 |
| §3 / 3.5 / 3.6 / 3.7 | KEEP | 短指针／硬规则 |
| §3.8.6 派工 | TRIM（已） | 「简单单步直接做」在 beast 生产默认下误导 → 明确生成一律派遣 |
| §4 速度费用 | TRIM（已） | 加野兽免责；去掉暗示主会话直调生成 |
| §4.4 钱包／交付 | KEEP | quote_bundle 仍在工具表 |
| 画布写穿硬闸 | TRIM（已） | 删「见仓库根开发者 AGENTS」发版门文案 |
| §4.5–4.8 | KEEP | 费用／失败归因红线 |
| §5 附件 | KEEP | 短 |
| §6 越界 | KEEP | 产品边界 |
| §7 反逆向 | KEEP | **禁砍** |
| bash 环境指针 | KEEP | |
| 自主剪接／分镜闸 | KEEP | 短指针 |
| 记忆纪律 | KEEP | |
| 歌词与作曲分工 | KEEP | 与 prompt 去重后的权威细则 |

未再砍：§4 内 workflow_generate／已提交三铁律等——Expert 子会话仍吃同一 AGENTS，保留。

### C. \<available_skills\>（~22 条，估 ~10kB）

| 项 | 标签 | 理由 |
|---|---|---|
| beast-* ×4 / music-director / lyricist / fang-wenshan / editor / workflow-director | KEEP | 影音主路径 |
| image-gen / nuyoah-* / ai-ad / higgsfield / lens / blender* / web-3d / agent-pixai / astra / make-blender-edu / model-status / read-image | TRIM（未动） | 可达性风险：降级需另轮质量评测；本轮不砍 skill 面 |

### D. user.system — authority（指令来源）

- ~0.5kB；**KEEP**（安全红线）

### E. user.system — memory-* / 历史项目 / 领域知识目录

- 音乐样本可涨到数 kB；含过期警示
- **KEEP** 账户偏好／项目档案（产品需要）
- **TRIM（未动）**：共享「领域知识目录」长清单——属记忆管线，改注入策略另轮

### F. user.system — onboarding / 回复风格 / 成本 / 互动

- **KEEP**（产品设置）

### G. user.system — 环境事实

- 旧样本：列 33 个断路名 +「未列出＝默认开」→ **误导**（与现 109 cut 矛盾）
- 现网（23:38 已装）：cut>24 只报数量＋12 held 列表（`environment-facts.ts`）
- **KEEP** 现实现；**DROP** 已完成于 `d4ee7bef` 的误导句

### H. turn 尾 — 野兽帧

活 dump 结构（chars≈7404 / journal 7370）：

| 子块 | 约 chars | 标签 | 理由 |
|---|---:|---|---|
| 外层「已启用＋三类闸」头 | ~200 | DROP 重复（已） | 与 core 内闸门句重复贴两次 |
| beast-core 身份／动作／首则／expert／优先序 | ~900 | KEEP | 指挥权 |
| core 内闸门（付费／协作／~~控面部署~~） | ~180 | TRIM（已） | **控面部署＝开发者运维**，生产影音 agent 不需要 |
| 【模板优先·机器判】DSL 长段 | ~700 | KEEP | 画布写穿必需；与 v1 `beastTemplateFact` 同源，v2 只留 core 内一份 |
| 【安全红线】 | ~120 | TRIM（已） | 删 Compliance ACK／远端 diff／暴君口吻；保留 secret＋付费确认 |
| stage-research | 456 | KEEP | 研究先行（用户裁定） |
| stage-creation | 913 | TRIM（已） | 「世界第一标尺」营销腔 → 专业可用水准 |
| stage-critique | 790 | KEEP | 验收／critic |
| stage-dispatch-verify | 775 | KEEP | 并发／async |
| expert-registry digest | 2451→~2597 | TRIM（已） | 去 HTML 注释；editor 七条 RECIPE 路径收成 skill 指针 |
| 阶段模组全文 vs beast-* skill | — | KEEP 现状 | v3 省 token 但行为回退（注释已证），维持 v2 内嵌 |

### I. turn 尾 — PROMPT_SKELETON／画布写穿

- 影音意图首条才弹；工程样本无骨架指令
- **KEEP**（修画布裁定）

### J. 其它网关

| 项 | 标签 |
|---|---|
| 开发者仓库根 AGENTS.md（工匠／测试纪律） | **DROP 出生产**（已确认不在 runtime；勿再覆盖 workspace 根） |
| vetting 重贴 | 已删（注释） |
| BEAST_SKILL_LIST 双头 | 默认关 KEEP |

## 3. 已落地改动

1. `deploy-staging/gateway/messages-gw.ts`  
   - 外层帧头去重复闸门句  
   - `BEAST_GATE_SCOPE_CLAUSE` 去掉「控面部署」  
   - core 安全红线去开发者口吻  
   - creation 营销句收束  
2. `deploy-staging/gateway/expert/registry-digest.txt` — 注释删除 + editor RECIPE 压缩  
3. `deploy-staging/opencode-runtime/AGENTS.md` — 模型串／图片行矛盾／音乐公式墙／3.8.6／§4／画布发版门文案  
4. `deploy-staging/opencode-runtime/opencode.json` — orch prompt 歌词段短指针（仅改该行）

## 4. 体量前后差（本轮审计增量，相对 `d4ee7bef` 后）

| 块 | 改前 | 改后 | Δ |
|---|---:|---:|---:|
| runtime AGENTS.md | 25246 | **24597** | **-649** |
| orch agent.prompt | 1621 | **1286** | **-335** |
| registry-digest（进野兽帧） | 3384 | **2797** | **-587** |
| 野兽帧（估，含去重+registry） | ~7404 chars | **~6477 chars** | **~-927** |
| 环境事实（相对旧 33 名单样本） | ~1437 B | ~1112 B（12 held 口径） | ~−325（已在 d4ee7bef） |
| skills 面 | ~10kB | 同 | 0（未动） |

估本轮再省：**~1.6–2.0 kB** 常驻文案（AGENTS+prompt+帧）；叠加 `d4ee7bef` 的 AGENTS−22k + tools schema−80k 仍是大头。

## 5. 未动项

- 不降级 0 命中 top-level skill（可达性）
- 不改记忆管线「领域知识目录」注入策略
- 不启 BEAST_FRAME_V3（行为回退风险）
- 不砍 §7／付费／画布写穿／资料≠指令
- 不跑付费生成；活会话冷启动 tokens.input **需换手新会话**复测
- Expert 子会话工具表未再收窄
- `【模板优先】` DSL 长段未再砍（写穿质量优先）

## 6. 复算

```bash
wc -c deploy-staging/opencode-runtime/AGENTS.md deploy-staging/gateway/expert/registry-digest.txt
node -e "console.log(JSON.parse(require('fs').readFileSync('deploy-staging/opencode-runtime/opencode.json')).agent.orchestrator.prompt.length)"
# 新会话后：
journalctl -u agent-gateway --since "5 min ago" | grep "beast-frame] v2" | tail -1
```


## 7. VPS 外科手术同步（CST 23:45）

- 装入：`workspace/AGENTS.md`＋`.opencode/AGENTS.md`（24597 B）、`.opencode/opencode.json`（orch prompt 1286 B）、`gateway/messages-gw.ts`、`gateway/expert/registry-digest.txt`（2797 B）
- **未**跑全量 `opencode-release.sh`（避开 music 漂移）
- `systemctl restart opencode-server` + `agent-gateway` → 皆 active；gateway `:8081`，SSE 已连 `127.0.0.1:4096`
- 校验：AGENTS 无「底层模型 happycoding」「原生工具直调 image_generate」；messages-gw 为「两类闸」＋帧头短句无重复闸门

## 8. 续篇

beast OFF（creator）路径见 `docs/arch/system-prompt-audit-beast-off-20261011.md`（2026-10-11）。
