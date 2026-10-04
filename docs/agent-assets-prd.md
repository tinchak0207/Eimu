# PRD：AI 助理 × 资产持久化与活化（Asset Packs）

> 定性：能力建设。参考竞品 filmera.ai，映射到 Emu 既有栈，不造轮子。
> 状态：待暴君裁定 → 按本档 SPEC 表格机械执行。
> 语言：正体中文（与代码注释一致）；站点 UI 文案仍走简体（PRODUCT.md 品牌规则）。

---

## 0. 一句话目标（可测量终态）

用户在任意过去产物（对话出图 / 历史 / 画布 / 工作流）上**一键提取资产** → 落入统一的**帐号级资产包（Asset Pack）** → 新会话或进行中会话中，Agent 能**搜寻并活化**该包（提示词 / 配方 / LoRA / 参考卡）→ 生成的任务参数与 `job_events.detail` 实际带上该包引用（可查证），全程**不重复扣费**。

**判定成功（全部为可验证证据，非 HTTP 200）：**

1. 用户在历史/画布/聊天各有一个「存为资产」入口，保存后可在「我的资产」看到，跨会话、跨重新整理仍在。
2. Agent 对话中说「用我上次那个角色风格」→ 工具 `asset_search` 返回该包 → `asset_activate` 解析出 prompt/LoRA/参考图 → 生成任务 `job_events.detail` 含 `asset_pack_id`，实弹出图且参数与资产一致。
3. 活化前后用户额度余额除正常生成扣费外**零额外扣除**（计费真源仍是控制面排帐）。
4. 旧「存图库」假存档（prompt 写死 `AI 助理生成 · 第 N 张`）消失，取而代之的是带真实语境的资产保存。

---

## 1. 现状（事实标签）与主瓶颈

### 现状盘点（2026-08-30 Explore 全库盘点）

| 现有孤岛 | 位置 | 状态 |
|---|---|---|
| 画布素材（text/image） | `src/lib/canvas/asset-store.ts`（Blob `canvas-assets/{userId}/`，500/户） | ✅ 最接近「资产库」，upsert-by-id |
| 角色/场景/风格卡 | `src/lib/character-card-store.ts`（Blob，100/户） | ✅ 已存在，无 prompt |
| 配方模板（六槽） | `src/lib/recipe-template-store.ts`（Blob，50/户） | ✅ 已存在 |
| LoRA 收藏/最近 | `src/lib/lora-user-state.ts`（Postgres `lora_user_state` / Blob） | ✅ 已存在 |
| 帐户画像+教训 | `src/lib/agent-profile-store.ts`（Postgres `agent_user_profiles`/`agent_lessons`） | ✅ 已存在，**已注入 sessions L0** |
| 帐号级「提示词库」 | ❌ 不存在（`/api/canvas/prompts` 是公共远端，只读无用户保存） | ❌ |
| 统一资产包抽象 | ❌ 五个孤岛互不相通，无 collections/pack | ❌ |
| 从对话提取资产 | ❌ 唯一机制 `fireAndForgetLessonDigest`（提炼教训，非资产）；`AgentChatSurface.tsx:298-320` 存图库是假存档 | ❌ |
| Agent 读取用户资产 | ❌ 本地工具契约（`agent-tool-contract.ts:122-234`）只有 image_generate/edit/upscale + canvas + lora，**无任何工具读 canvas-assets / character-cards / recipe-templates** | ❌ |
| 前端拿完整 transcript | ❌ 只有 SSE 回放，无 GET transcript 端点（gateway 侧 7 天 DB row） | ⚠️ 阻碍「对话精确提取 prompt」 |
| 历史→Agent 交接 | `HistoryClient.tsx:195-200` 只传一句 prompt 文本，丢 model/size/lora/参考图 | ⚠️ 与资产复用无关 |

### 主瓶颈（FACT）

1. **Agent 活化面是 0 读**：资产存了，但 agent 工具链读不到、注入面（L0）只带画像+教训，不带资产 → 「从过去提取资产并复用」的**复用半环完全缺失**。
2. **提取面是假出口**：唯一号称「存图库」的按钮存的是假历史条目，不带对话中的 prompt/LoRA/参数（`agent-chat-persistence.ts:61-79` sanitize 把 prompt 丢掉）。

### 因果链（最短主线）

用户过去生成资产 → 资产散落五孤岛可存不可聚 → Agent 生成时读不到（活化=0）→ 用户只能手动复制贴上 → 无法「从过去提取→复用」

### 最小干预（每格推一格）

1. 造统一**资产包抽象**（引用层，不搬资料）→ 2. 打通**提取**（历史/画布/聊天三个 1 键入口）→ 3. 打通**活化**（站内 agent 工具 asset_search/activate + L0 active pack 注入）→ 4. 给**可见面**（我的资产）。

---

## 2. 竞品对照：filmera.ai → Emu（2026-08-30 官网抓取）

filmera 的资产复用范式**不是泛泛的「提示词库」**，而是：

> **「Characters and sets locked as reference cards — stay locked across every generation.」**
> 角色/场景锁定为参考卡，跨每次生成保持；take-based 非破坏性（每次生成留底，VFX 施加在已爱上的那一版，不是重掷骰子）；agent 布线节点并排队出片；每次生成事前明码计价。

**映射到 Emu（取可用、改白名单、不整建）：**

| filmera | Emu 对应 | 落地 |
|---|---|---|
| 参考卡跨生成锁定 | **资产包（Asset Pack）**：参考卡/配方/LoRA 包成为帐号级可激活集合 | 本 PRD 核心 |
| take-based 非破坏 | 历史重跑/微调变体（已有 `history-rerun.ts`） | 不动，只是资产来源之一 |
| agent 布线节点 | agent 工具面扩 `asset_search`/`asset_get`/`asset_activate`（站内实现，同 `agent-lora.ts` 模式） | P0 |
| 三房 Canvas/Media/Edit | 画布 / 历史 + 我的资产 / 工作站 | 我的资产 = 新入口（P0） |
| 事前明码计价 | 确认卡先行（已有） | 不动 |

> filmera 是 video-first 单一工作流；Emu 是全能中转 + 批量场景。**只借「参考卡锁定 + 可激活集合」这一核心心智，不复制三房布局。**

---

## 3. 核心设计：资产包 = 参考卡集合

### 原语

- **资产包（AssetPack）**：帐号级集合，含
  - `references[]`：参考卡（角色/场景/风格）→ 引用 `character-cards` 孤岛物件 id
  - `prompts[]`：提示词/六槽配方 → 引用 `recipe-templates` id **或** 自由文本提示词（自带）
  - `loraBundle[]`：`{versionId, title, weight}` → 引用 `lora_user_state` 收藏的 versionId
  - `images[]`：素材图引用 → 引用 `canvas-assets` image 的既有 URL（**不复制位元组**）
  - `digest`：包的语义摘要（≤500 字，模型注入用，agent 用语义搜寻）
- **提取（Extract）**：从历史/画布/聊天把「用过的配方」固化成资产条目 → 一键入包
- **活化（Activate）**：包被指定为 active / agent 依语义命中 → 解析出 `{prompt, loraModelVersionIds, referenceImageUrls}` → 喂给既有 `image_generate` / `image_edit` 参数面；L0 注入 digest 让模型「跨生成记住」

### 真源与不重造轮子

- **资料仍留在各自孤岛**（extend existing owner：不建第二套 canvas-assets / character-cards / recipe-templates）；**资产包只存引用 + digest + 排序**，是「我的资产」的单一聚合入口。
- **储存模式逐行复制** `asset-store.ts`（新路径 + 修剪世代 + 写入伫列 + cache TTL + normalize 白名单），新命名空间 `asset-packs/{userId}/`。
- **Agent 工具模式逐行复制** `agent-lora.ts`（站内实现、读站内 API、宽松 payload 解析、明确错误码）。
- **注入通道扩展** `agent-profile-store.ts` + `sessions/route.ts` L0（现有 profile+lessons 注入）→ 增加 active pack digest。
- **UI 不造新面板**：扩 `CanvasLibraryPanel` 四 tab、`AgentChatSurface` 工具列、`HistoryCard` 动作列。

### 诚实能力宣告（PRODUCT.md「UI 宣称必须匹配真实能力」）

- LoRA 包**只**在模型 `capabilities.lora` 为真时激活（沿用 `loraToGenerationParam` 单选铁律 `slice(0,1)`）。
- 参考卡图**只**走支援参考图/edits 的通道（`image_edit`、画布 reference 节点）；不支援处明确标 `unsupported`。
- LoRA 训练/自存模型**维持 `unsupported`**，不因本 PRD 假装存在。

---

## 4. SPEC（轮子钉 | 复制到 | 白名单 | 判定）

> 铁律：白名单以外的交互逻辑/物理参数/事件监听/生命周期 hooks 一行不许动（AGENTS.md「禁止造轮子」）。

### P0-A 资产包真源 + API

| 栏 | 内容 |
|---|---|
| 轮子钉 | `src/lib/canvas/asset-store.ts`（整体）；`src/app/api/canvas/assets/route.ts`（API 骨架） |
| 复制到 | `src/lib/asset-pack-store.ts`；`src/app/api/assets/route.ts`（GET/PUT/DELETE，`requireVerifiedUser`） |
| 白名单栏位 | `CanvasAsset.kind` 枚举改为 `prompt / reference / lora_bundle / recipe / image`；新增 `prompts[]/references[]/loraBundle[]/images[]/digest`；上限 100 包/户。**其余（upsert-by-id、写入伫列、新路径修剪、cache TTL 3s、normalize 白名单、limit 错误类）逐行等价** |
| 判定 | 单元测试：normalize 白名单/上限拒绝；API E2E：PUT→GET→DELETE 跨重新整理仍在（expected-pass） |

### P0-B 提取：三个一键入口

| 入口 | 轮子钉 | 复制到/改 | 白名单 | 判定 |
|---|---|---|---|---|
| 历史→资产 | `src/lib/history-card-anchor.ts:47-67` `cardFromHistoryEntry` | 扩充为「存为资产」：除图 URL 外带入 history 条目的 prompt/model/size/lora（这些栏位 history 条目已有），存成 `reference` 或 `recipe` 资产 | 只加栏位映射与保存呼叫；转换逻辑原样 | 历史卡「存为资产」保存后，资产包内 title/prompt 与历史一致（非 `AI 助理生成 · 第 N 张`） |
| 画布→资产 | `src/components/canvas/CanvasLibraryPanel.tsx:309-338` 「存入素材」 | 存入目标由 `/api/canvas/assets` 改为 `/api/assets`（打包），带上节点完整配方（已有 `parseWorkflowRecallConfig` 可用） | 只换 API 路径与 payload 栏位；面板交互零动 | 画布节点存为资产后，配方六槽与节点一致 |
| 聊天→资产 | `src/components/agent-chat/AgentChatSurface.tsx:298-320` `onSaveToLibrary`（假存档） | 改为存 `reference` 资产（图 URL + 会话 id + 时间 + 语境句）；**不宣称带 prompt**（前端无 prompt，见 P1） | 只改 body 与目标 API；disabled 态/幂等 `savedIds` 保持 | 点「存为资产」→ `/api/assets` 出现 reference；原 `/api/history` 假条目不再产生 |

### P0-C Agent 活化（站内工具 + L0 注入）

| 栏 | 内容 |
|---|---|
| 轮子钉 | `src/lib/agent-lora.ts`（工具模式）；`src/app/api/agent/sessions/route.ts` L0（注入通道） |
| 复制到 | `src/lib/agent-assets.ts`（`asset_search`/`asset_get`/`asset_activate`）；sessions route 扩 active pack 注入；`agent-profile-store.ts` 加 `buildAssetPackInjection` |
| 白名单 | 工具命名/错误码沿用 lora 模式；`asset_activate` 输出契约 `{prompt, loraModelVersionIds, referenceImageUrls}` 可直接进 `image_generate`/`image_edit` 参数；L0 注入 digest ≤500 字、只注入 active pack；**LoRA 单选铁律 `slice(0,1)` 与 `capabilities.lora` 门不变** |
| 判定 | 契约测试：`asset_search` 搜到用户包；`asset_activate` 解析出的 lora versionId 进生成参数；E2E：对话「用我上次那个风格」→ 生成任务 `job_events.detail` 含 `asset_pack_id` + 真实 LoRA/prompt，实弹出图；额度仅扣正常生成费 |

### P0-D UI：我的资产 + 使用入口

| 栏 | 内容 |
|---|---|
| 轮子钉 | `src/components/canvas/CanvasLibraryPanel.tsx`（四 tab 面板）；`AgentChatSurface` 工具列 |
| 复制到 | 画布资源库「我的素材」tab 扩为资产包视图（列表 + 包详情 + 设为 active）；聊天加「我的资产」入口（沿用 Liquid Glass，禁 emoji 图示） |
| 白名单 | 只加一个 tab 内容与「设为 active」动作；面板外壳/交互原样 |
| 判定 | 用户设 active 包 → 新开会话 L0 带 digest（服务端可查）；我的资产列表与 `/api/assets` 一致 |

### P1（不阻塞核心闭环）

| 项 | 内容 |
|---|---|
| E1 对话精确提取 | gateway 增 GET transcript 端点（7 天 DB row 已有）→ 前端读 `generate_image` 工具 args 的 prompt/lora → 聊天「存为资产」带真 prompt；**gateway 在 VPS /opt/agent-harness，需本地/远端双向 diff 后合并（见 AGENTS.md 基底合并规则）** |
| E2 交接带配方 | `HistoryClient.tsx:195-200` 只传一句话 → 改带完整配方（model/size/lora/参考图 URL）给 agent |
| E3 聚合搜寻 | 全站搜「我的资产」（跨 pack 标题/tags/digest 关键字） |
| E4 LoRA 包编辑 | 工作站 `LoraLibraryPanel` 支持把收藏打包成 loraBundle |

---

## 5. 范围外（Out of Scope）

- LoRA 训练 / 用户自训模型（upstream `unsupported`，不假装）
- 资产市场 / 跨帐号分享 / 团队协作
- 把五个孤岛资料一次性迁入 pack（pack 只引用；「打包即快照」属后续）
- filmera 式 take-based 三房布局（Emu 已有历史重跑闭环）

## 6. 计费 / 运行时 / 卫生（暴君-9 / -10）

- **活化不重复扣费**：活化是元资料解析 + 注入，不碰额度；生成一次扣费走既有控制面排帐（记忆 `control-plane-billing-paradigm` 唯一真源）。验收回归：活化前后额度只被正常生成扣。
- **资产包不复制位元组**：图片一律引用既有 URL（history/canvas URL），无储存放大；Blob 包档案很小。
- **秘密不入档**：资产包无任何凭证；`requireVerifiedUser` 全程看守。
- **不宣称未验证能力**：reference/LoRA 路由未达能力处标 `unsupported`（例：`generate_images` 不支援参考卡的通道，agent 活化时明示改用 `image_edit`）。

## 7. 验收总表（上线前 Gate）

| 证据 | 手段 |
|---|---|
| 资产包 CRUD 跨刷新持久 | 契约测试 + E2E API |
| 三个提取入口保存内容真实 | 契约测试（title/prompt 非假文） |
| Agent 活化带真实参数 | E2E：对话指令 → `job_events.detail` 含 pack id + 实弹出图 |
| 零重复扣费 | 额度余额比对（活化前后） |
| 旧假存档消失 | 前端回归：无 `AI 助理生成` 假条目 |