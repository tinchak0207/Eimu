# AID 对称差吞并：只做一半的完整审计（2026-09-16）

> 定性：**修复**（审计已交付却未闭环的刀）——保守纪律适用
> 触发：暴君指出「我们之前 AID 并入对称差时只做了一半，你发现的前端缺失只是冰山一角」
> 方法：不找新缺口，而是拿 PRD 自己写的「全链生效定义」逐环对账

---

## 0. 核心发现：这是一个系统性模式，不是个别疏漏

**每一刀都停在「型别 + 清洗 + 单元测试」三件事，消费端一律缺席。**

统一判据：`grep -rln "<资产>" src/components/ src/app/ --include=*.tsx` → 渲染层消费数。

| 刀 | 资产 | 后端写入 | 清洗/型别 | 单元测试 | **渲染层消费** |
|---|---|---|---|---|---|
| 1 | `CanvasEpisode` / `currentStep` | ✅ | ✅ | ✅ 14 绿 | **0** |
| 2 | `storyboardShot` / `storyboardScene` | ✅ 3 处 | ✅ 双白名单 | ✅ 23 绿 | **0** |
| 4 | `masterExport` 产物索引 | ✅ 读取端 | ✅ | ✅ 15 绿 | **0**（且无 producer） |
| 5 | `lens-language-library` | n/a（资料） | ✅ | ✅ 9 绿 | **0** |
| 5 | `agent-prompt-contracts` | n/a（资料） | ✅ | ✅ | **0**（且无 gateway 侧） |
| 5 | `aid-enums`（37 enum） | n/a（资料） | ✅ | ✅ 47 绿 | **0**（无任何 import） |
| 3 | 音色库 | — | — | — | 已由暴君裁定移除 |

---

## 1. 逐刀对账（PRD「全链生效定义」原文 vs 实况）

### 刀 1：作品/剧集实体链

**PRD 定义**（`docs/symdiff-aid-swallow-prd.md:143`）：
> 剧集实体 Blob 可读 + canvas 面板可见 + agent 调用 `canvas_apply_ops` 写入 episode 节点成功 + 重新整理仍在

| 环 | 实况 | 判据 |
|---|---|---|
| Blob 可读 | ✅ | `src/app/api/canvas/projects/route.ts:65` |
| **canvas 面板可见** | ❌ **0** | `grep CanvasEpisode src/components/ --include=*.tsx` → 0 |
| **agent 写入 episode** | ❌ | `CanvasAgentOp` 8 op 全清单：`add_node`/`update_node`/`delete_nodes`/`connect_nodes`/`delete_connections`/`select_nodes`/`set_viewport`/`run_generation` —— **无任何 project 级 op**。而 `CanvasProject.currentStep/episodes` 在 project 顶层，8 op 无一可达 |
| 重新整理仍在 | ✅（Blob） | 持久化通道已验 |

**关键事实**：`use-canvas-chat.ts:515` 已把 `episodes` **导出**，`setProjectMeta` 已是**唯一写入口**——但：
- **无任何 `.tsx` 渲染它**（`episodes`/`currentStep`/`projectType` 在 `.tsx` 消费数皆为 **0**）
- **无任何 UI 呼叫 `setProjectMeta`**（唯一呼叫者是 `CanvasAgentOp`，而它没有对应 op）

即：**通道两端都通了，中间没有界面。**

### 刀 2：分镜实体 + 21 栏契约

**PRD 定义**（`:165`）：
> agent 产出 21 栏分镜 → `storyboard_qc_17` 回 `passed:true` 17/17 → 写入 canvas 节点 → 前端可见 → 刷新后仍在

| 环 | 实况 |
|---|---|
| 21 栏契约 | ✅ `storyboard-contract.ts`（23 测试绿） |
| 双白名单同步 | ✅ `toNodeMetadata` + `compactMetadataForAgent` |
| 写入 canvas 节点 | ✅ 型别可写（`Partial<CanvasNodeMetadata>`） |
| **前端可见** | ❌ **0**（`grep storyboardShot\|storyboardScene src/components/` → 0） |
| **门禁输入 schema 对齐** | ❌ **0**（VPS `storyboard_qc_17.ts` 无 `shotNumber`/`scriptContent` 任何命中） |

**刀 2 自己已诚实声明**（见其交付报告）：
> 门禁 `storyboard_qc_17` 期望的是**成片阶段口径**（`shotId`/`prompt`/`durationSeconds`/`characterCardIds`/`sceneId`/`keyframeId`…），AID 21 栏是**编剧阶段口径**。**两套栏名完全同名者为零**。

即：**21 栏契约与门禁之间缺一个桥接层**。`storyboardQcShots` 已写了桥（缺者回 `missing[]`），但门禁侧没有对应消费。

### 刀 4：成片产物索引

**PRD 定义**（`:216`）：
> 分镜 → 时间线（clips 有 sceneId/shotSize）→ `check` `ok:true` → `export` 出 mp4 → `ffprobe` 解析度/时长/音轨符合 preset

| 环 | 实况 |
|---|---|
| 时间线 | ✅ `timeline.ts` op DSL（VPS 活跃） |
| master 闸 | ✅ `master.ts` + `MASTER_PRESETS` + `probeRenderedVideo` |
| 产物索引读取端 | ✅ `master-artifact-index.ts`（15 测试绿） |
| **producer（写入端）** | ❌ **无呼叫者**（`grep buildMasterArtifactMetadata` 排除自身 → 0） |

**刀 4 自己已诚实声明**：
> VPS gateway **全档零 DB 存取** → 导出链不回写 DB，**今日 DB 里不可能有索引行**。

即：**索引端建好了，没有任何东西会写进去。**

### 刀 5：方法论资产

**PRD 定义**（`:237`）：
> 词库可搜寻（≥143 条）→ 选中词条注入分镜 prompt → 生成结果可见；契约修改后 agent 实际调用行为改变（可 grep VPS）

| 资产 | 实况 |
|---|---|
| `lens-language-library.ts`（142 条） | ✅ 入库；**唯一 import 者是自己的测试**；前端选词入口 **0** |
| `agent-prompt-contracts.ts`（8 Expert 契约） | ✅ 入库；**唯一消费者是 `agent-prompt-contract-check.ts`**，而后者本身无生产呼叫者；**gateway 侧 0** |
| `aid-enums`（37 enum / 1670 行） | ✅ 入库；**全仓 0 import**（刀 5 自己声明「本目录尚无消费端」） |

刀 0 已部分补救：`lens-language` 已做成 skill 并在 VPS 拉起（调用 0→1），但**那是 agent 侧**，**前端仍无选词入口**。

---

## 2. 已验证成功的接线先例（证明我方会做，不是不会）

**`director` 元数据是真接完整的**：
- `AgentDirectorCard.tsx` + `director-mini/DirectorMiniViewport.tsx` 真的渲染 `topViewSvg`/`cameraViewSvg`
- 记忆档 `canvas-snapshot-compressor-director-whitelist-fix.md` 记载：该栏位族曾因白名单漏同步而空壳，修好后**有前端消费**

**对照**：刀 1/刀 2 的新栏位族**只做了白名单，没做渲染元件**。同一个 repo，同样的栏位族机制，一个接完整、一个接一半。

---

## 3. 根因（不是「忘了」，是流程缺一环）

审视五刀的交付报告，共同的完成标准是：
> 「tsc 0 + N 例测试绿 + 双白名单同步」

而 PRD 写的全链生效定义是：
> 「…→ **前端可见** → 刷新后仍在」

**两者差了「前端可见」与「消费端」两段。** 各刀把「型别可写 + 测试绿」当成了完成，因为那是**可机器验证的**；「前端可见」需要真的开浏览器看，**不可机器验证**，于是被系统性跳过。

**这与刀 0 的发现同源**：刀 0 是「货架长草」（工具装了没人用），这里是「资产入库了没人读」。同一个病：**只建供给侧，不建需求侧。**

---

## 4. 缺口清单（按修复成本排序）

| # | 缺口 | 修法 | 成本 | 依赖 |
|---|---|---|---|---|
| **G1** | `CanvasAgentOp` 无 project 级 op | 加 `set_project_meta` op | 小 | 无 |
| **G2** | 剧集面板（渲染 `episodes` + `currentStep`） | 新元件挂 canvas-workstation | 中 | G1 |
| **G3** | 分镜节点渲染（`storyboardShot`） | 扩 `NodeBody.tsx` | 小 | 无（有先例） |
| **G4** | `masterExport` producer | gateway 或控制面写入 | 中 | 需跨服务设计 |
| **G5** | 21 栏 ↔ 门禁栏名桥接 | 门禁侧吃 21 栏，或前端补 `production.*` | 中 | 需先定口径 |
| **G6** | `aid-enums` 消费端 | 让生成管线/前端真吃这些值 | 中 | 需逐个定用途 |
| **G7** | 前端词库选词入口 | canvas 面板加词库选择器 | 小 | 无（skill 已通） |
| **G8** | agent 契约接 gateway | 契约文字入 VPS 提示词 | 中 | VPS 改动 |

---

## 5. 未观察项声明

- 本审计为**静态 grep 对账**，未逐刀跑真实端到端（如真开浏览器看 canvas 面板是否存在但隐藏）
- `src/components/**` 的 glob 在某些 shell 下不展开，已用 `grep -rln` 递回方式复验（结论一致）
- 刀 3 音色库已按暴君裁定移除，不在本审计范围
- 未审计 `deploy-staging/` 与 `src/vendor-bridges/`（前者 gitignore，后者 VPS 执行码本地副本）
