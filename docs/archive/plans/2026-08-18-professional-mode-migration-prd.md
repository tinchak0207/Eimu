# 专业模式迁移 PRD（LoRA→Agent Skill；队列/批量→画布 Native）

状态：**已确认、待执行（执行清单见 §8）**
日期：2026-08-18
范围：本文件只固化迁移决策、逐节点 origin→target 映射、状态机、验收合同、里程碑与回归清单；执行按 §8 分片进行，每片通过验收后进入下一片。

---

## 0. 决策背景（FACT）

- 用户拍板（2026-08-18）：专业模式（`InvokeInspiredWorkstation` 独立工作站表面）**整体拆解搬家**，不再作为与 AI 助理并列的独立表面。
- 迁移方向（用户指定）：
  - **LoRA / 资源管理 → Agent Skill + Agent LoRA 搜索引擎**；
  - **队列 / 批量 → 画布（CanvasEmbed）Native 特性**；
  - 其余功能节点逐项归位（参考图、历史、模板、品牌包、导出、键盘命令、移动端阶段、教学引导、服务器权威任务血缘），**任何功能不得白白丢失/消失**。
- 用户明确：对专业模式投入很多心血，但这是代差问题（Agent 配上 LoRA 技能 + 工作区管理技能后专业模式的 Edge 荡然无存），忍痛割爱。

### 迁移后目标态（一句话）

> 用户在 AI 助理对话里说一句话即可完成「选模型 / 选 LoRA / 出图 / 批量 / 参考」，所有产出与进度以**画布节点 + 批量子节点**为唯一可见事实；专业模式独立表面、pro 专属样式与独立控件树被移除，对应能力全部由 Agent 工具或画布 Native 承接。

### 迁移铁律

1. **零遗漏**：§4 映射表每一行都必须有明确 target，禁止"待定/先删再说"。回归清单（§9）执行后全量核销。
2. **不建第二套**：不新建第二套队列、历史、能力表、LoRA 偏好存储（继承 `docs/plans/2026-08-01-professional-workflow-product-mainline.md` 与 `docs/agent-native-ultimate-blueprint-zh.md`）。
3. **状态单一权威**：画布项目（`CanvasProject`）+ 服务器任务投影（P0-A）是唯一权威；客户端只做投影。
4. **UI 声明匹配真实能力**：迁移后暴露的按钮/指令必须真有对应动作，不宣称不存在的能力。
5. **先补后拆**：每个功能节点先在其 target 侧达到等价可用（含真实生成验收），才允许移除 origin 侧表面。

---

## 1. 专业模式功能全景盘点（origin 清单）

按 `InvokeInspiredWorkstation.tsx` / `ImagePlayground.tsx` / `PromptInput.tsx` / `CanvasEmbed.tsx` / `src/lib/*` 实际代码逐项清点，共 **8 类 33 节点**：

### C1 入口与外壳
| # | 节点 | 位置 | 现状行为 |
|---|------|------|---------|
| 1 | 专业模式 toggle | `PromptInput.tsx` 底部 `pro-mode-toggle`（`displayMode !== "agent"` 时显示） | 打开/关闭工作站表面，`aria-pressed` |
| 2 | 工作站外壳 | `InvokeInspiredWorkstation` + `.pro-app-shell` + `pro-mode-active` body 类 | 全屏覆盖普通卡片；普通模式下 `hidden` 保留草稿/队列 |
| 3 | 外壳入参 | active / suggestions / referenceImages / images / tasks / onRun / modelId / onModelChange / onExit / loraTourFromGuide / capabilityNotice / externalResultUrl | 父子状态契约 |
| 4 | 布局持久化 | `panelWidths / leftPanelTab / inspectorTab / sectionOpen` → `initialLayout` | localStorage 记忆分栏宽度/tab/折叠 |

### C2 左栏（prompt / settings / assets）
| # | 节点 | 位置 | 现状行为 |
|---|------|------|---------|
| 5 | 提示词区 | 左栏 prompt tab | 提示词、标题、篇幅 |
| 6 | 参考图上传 | `ReferenceImageUpload variant="prompt"` | 上传 + `onWorkflowDetected=restoreProvenanceConfigFromPng`（PNG 血缘恢复） |
| 7 | 创作资源（场景预设） | `CreatorResourcePanel` | `applyCreatorResource`（模板/资源一键套用，32 张资源卡） |
| 8 | 服务端配方模板 | `TemplatePanel` | `POST /v1/template-generations`，批量，走自己的计价与队列，结果经 `externalResultUrl` 回画布 |
| 9 | 风格 preset | `StylePresets` + `handleStyleChange` | 套用风格文本；「已套用」chip 可清除 |
| 10 | 品牌包 | `brandKit` + `handleSaveBrandKit` | 保存品牌信息（hasBrandKit 徽标），随提示词注入 |
| 11 | 模型选择 | `ModelPicker` | 换模型归一化参数（P0-B：清理不支持字段 + 费用重算 + warn 通知） |
| 12 | 尺寸/比例/解析度/时长/音频 | settings tab `sectionOpen.size` 等 | 模型能力驱动参数归一化 |
| 13 | LoRA 风格 | settings tab + `LoraLibraryPanel`（`pro-tour-lora`） | 搜索/排序/分页/收藏/最近/大图预览/单选；`/api/lora-models` + `/api/lora-preferences`；换模型保留或 warn 清理 |
| 14 | 数量（copies） | settings tab `sectionOpen.count` | 批量张数；进度 n/N + ETA 外推 |
| 15 | 参考图文件夹 | assets tab | `FolderShot` 导入、参考图角色（general/character/product/style/composition）、上限替换（`MAX_REFERENCE_IMAGES`） |

### C3 右侧检查器
| # | 节点 | 位置 | 现状行为 |
|---|------|------|---------|
| 16 | 队列检查器 | inspectorTab=queue | 任务列表、状态、失败原因、**原位重试**（`retryOfTaskId`，继承原配置不覆盖原记录）、失败保留稳定错误码 |
| 17 | 图库检查器 | inspectorTab=gallery（images/assets 两 mode） | 成片列表、**保存到文件夹**（BoardsPanel）、**设为参考** |
| 18 | 历史检查器 | inspectorTab=history + `HistoryInspectorPanel` | 搜索/收藏/设为参考/**恢复参数**（撤销快照 `captureTemplateState`，可撤） |

### C4 中栏画布态
| # | 节点 | 位置 | 现状行为 |
|---|------|------|---------|
| 19 | workspaceMode | canvas / viewer | 画布多图台 vs 灯箱单图 |
| 20 | 灯箱 | viewer | 上一张/下一张、计数 n/N、下载 |
| 21 | 标注设参考 | annotation 笔迹层 + `setAnnotationAsReference` | 「原图+笔迹」或「仅笔迹」设为参考图（annotationOnly） |
| 22 | 选区/多图 | canvas 态 | 多张并排比对 |

### C5 队列速览与进度
| # | 节点 | 位置 | 现状行为 |
|---|------|------|---------|
| 23 | 顶部队列速览 chips | `pro-topbar-chips`（done/running/failed） | 计数按钮 → open_gallery / open_queue |
| 24 | 整批进度 + ETA | `runProgress / runEtaLabel` | 已完成+失败占总批比例外推剩余时间；秒级心跳只在生成期存在 |

### C6 键盘命令（P1-C 注册表）
| # | 节点 | 位置 | 现状行为 |
|---|------|------|---------|
| 25 | 命令注册表 | `src/lib/workstation-commands.ts`（`open_lora` L / `open_queue` / `open_gallery` / `generate` / `focus_prompt` / 设为参考 / 撤销模板 / 关闭浮层 / `undo_annotation`） | 只调用现有 action，不复制业务逻辑；输入框/IME/modal 抑制 |

### C7 移动端
| # | 节点 | 位置 | 现状行为 |
|---|------|------|---------|
| 26 | 移动阶段聚焦 | `mobilePanelForTaskStage` + `MobilePanel`（create/settings/output/canvas） | 任务阶段驱动主表面，手动切换在同阶段内不被轮询抢回 |
| 27 | 移动抽屉/rail | 工作站底部抽屉 + rail 收纳 | 320/390px 无溢出 |

### C8 服务器任务与血统
| # | 节点 | 位置 | 现状行为 |
|---|------|------|---------|
| 28 | 服务器权威任务投影 | P0-A：`task_id/generation_id/result_id`，`GenerationTaskProjection` | 跨刷新/跨设备；客户端乐观状态收敛 |
| 29 | 结果血缘 | `ResultLineage`：sourceResultId/sourceGenerationId/referenceRole | 「设为参考」保留来源，不重命名无源文件 |
| 30 | 图库/历史/任务 owner | `/api/generation-jobs`、`/api/history`、`history-client/server-store` | 已有责任边界，不建第二套 |
| 31 | 教学引导 | `lora-tour-content.ts` + pro LoRA 引导（`PRO_LORA_TOUR_ARMED_KEY`） | 新手「前往专业模式」末步 → 武装 token |
| 32 | 导出 | 导出图片（Blob+objectURL 跨源下载）、导出 JSON（含配置/参考/品牌） | 保存到文件夹/下载 |
| 33 | 能力警告 | `capabilityNotice` / `lostParams` | 模型切换致字段丢失时非静默提示 |

---

## 2. Target 侧现状（画布 Native / Agent 通道已具备的基础）

> 迁移大量复用既有能力，不是从零造。以下为已核实（FACT，代码路径）：

### 画布（CanvasEmbed）已具备
- **8-op DSL**：`CanvasAgentOp`（add_node / update_node / delete_nodes / connect_nodes / delete_connections / select_nodes / set_viewport / **run_generation{prompt,model,size,count}**）——`src/lib/canvas/types.ts`。
- **节点元数据已含**：`model / size / quality / count / kind / source_image / status / errorDetails / cost_coins / imageTaskId / progress / workflow_id / session_id / referenceNodeIds / batchIndex / batchTotal / storageKey`——`CanvasNodeMetadata`。
- **批量子节点已含**：`CanvasNode.batchChildren / batchExpanded / batchPrimaryImageId` + `createBatchChildNode`（`src/lib/canvas/batch-utils.ts`，CanvasEmbed `handleBatchChild` 已按 b64 大小取真实图落子节点）。
- **确认闸已含**：`canvas.ops` 先弹卡（允许/拒绝/本次会话自动允许）——`CanvasEmbed.tsx` 头部注释 + `pendingOps`。
- **Agent「看画布」已含**：`canvas-state` 压缩快照上行（`/api/agent/sessions/[id]/canvas-state`）。
- **预算事件已含**：`canvas.budget.updated`（used/remaining）。
- **画布项目云持久化已含**：`CanvasProject`（nodes/connections/viewport/budget）。
- **工作区画布形态已含**：`inCanvasWorkstation`（画布全场、聊天左侧浮动面板 expanded|rail、拖宽记忆）——`ImagePlayground.tsx`。

### Agent 通道已具备
- **参数已展示**：`AgentParamCard` 进阶层 LoRA/权重/sampler/steps/seed（折叠）——`src/lib/agent-tool-params.ts`。
- **同批判定已含**：`agent-batch-anchor.ts`（model/seed/lora/lora_id/lora_weight…）。
- **交接已含**：`/history` → `?agent=1&q=` 落地 agent 面（D-18）——`ImagePlayground.tsx`。
- **画像/教训已含**：L0 账户级记忆（`agent_profile_store`，见 Mnemon doc `9be495b4`）。

### Target 缺口（迁移需新做，不是已存在）
| 缺口 | 说明 |
|------|------|
| G1 | Agent LoRA 搜索引擎工具：`lora_search(query, view, sort)` / `lora_get(versionId)`（含预览、收藏/最近、PixAI-only 能力约束），挂到网关工具集 |
| G2 | 画布批量进度/重试反馈：批量子节点已有，但「整批 ETA」「失败节点原位重试入口」「顶部速览 chips 等价物」需在画布态补齐 |
| G3 | 参考图角色设置入口在画布：referenceNodeIds 已有，但「普通成片一键设为参考并选角色」的画布局部动作未暴露 |
| G4 | 历史在画布态的可见入口：画布项目 + /history 页 + 交接已存在，需把「恢复历史参数」等价动作接到 Agent/画布 |
| G5 | 移除专业模式表面后的清理：pro toggle、工作站外壳挂载、`.pro-*` CSS 遗产、`lora-tour` 教学指向 |

---

## 3. 任务状态机（迁移后唯一权威）

### 一级：画布节点状态（既有）
```
idle → (node.plan) → generating(progress) → success | failed(errorDetails, cost)
       ├─ failed → retry（run_generation 重发 / 新节点继承原配置，保留原失败节点）
       └─ success → derive（改该节点：canvas.derive.started）| batch-child 追加 | 设为参考
```

### 二级：批次（画布 Native，替代 pro 队列）
```
batch-parent(node, count=N)
  ├─ 子节点逐个 generating(progress) → success/failed
  ├─ 整批进度 = 子节点 success+failed / N（ETA 由已结算子节点推外推）
  └─ 单个失败 → 就地重试该子节点（不重跑整批、不重复扣费，账单幂等）
```

### 三级：会话/项目（持久化）
```
agent session ⇄ canvas project（CanvasProject 云存储）
  ├─ 用户刷新/换设备 → 从项目 + 服务器任务投影恢复
  └─ 历史归因 = node.workflow_id / session_id / imageTaskId（血缘链）
```

---

## 4. 逐节点迁移映射表（origin → target，零遗漏）

> 图例：**[画布]**=画布 Native；**[Agent]**=Agent 工具/Skill；**[保留]**=原地不动（非专业模式专属，属普通模式/全局）；**[停用]**=功能终止（必须在 §6 登记理由，本表不允许出现无理由停用）。

| # | 节点 | origin | target | 迁移动作（最小改动） | 验收锚点 |
|---|------|--------|--------|---------------------|---------|
| 1 | 专业模式 toggle | PromptInput | **[停用]**（表面移除） | 删除 toggle 按钮与其模式状态；入口由 AI 助理 toggle + 画布工作站承担 | 无 pro toggle 残留；agent 面可用 |
| 2 | 工作站外壳 | InvokeInspiredWorkstation | **[停用]**（表面移除） | 停止挂载工作站组件树；独有能力先迁（见下） | 组件树无残留引用；build 通过 |
| 3 | 外壳入参契约 | InvokeInspiredWorkstation | **[画布]** | 父层状态（referenceImages/images/tasks/modelId/externalResultUrl）改由画布态既有通道承载（prompt 卡 → 画布 flow） | 普通模式↔画布态状态不回丢 |
| 4 | 布局持久化 | initialLayout | **[画布]** | 画布工作站已记忆面板态/宽度；删除 pro 专属持久化键，不迁移 | 刷新后画布面板态保持 |
| 5 | 提示词区 | 左栏 prompt | **[保留]**（普通模式既有） | 不迁移；普通卡片始终有提示词输入 | 普通模式出图正常 |
| 6 | 参考图上传（PNG 血缘恢复） | ReferenceImageUpload | **[保留+画布]** | 上传动作保留在 prompt 卡；同时暴露为画布节点 `source_image` 入口（G3） | 上传→生成携带参考；PNG 血缘恢复仍可用 |
| 7 | 创作资源（场景预设） | CreatorResourcePanel | **[Agent]** | 资源库搜索/套用封装为 Agent 工具（`resource_apply`），普通模式入口保留 | Agent 一句话套用场景预设并出图 |
| 8 | 服务端配方模板 | TemplatePanel | **[Agent+画布]** | `POST /v1/template-generations` 保留为 Agent 工具（`template_generate`），结果回落画布节点 | Agent 调模板出图、结果在画布可见 |
| 9 | 风格 preset | StylePresets | **[保留]**（普通模式既有 chip 清除逻辑保留） | 不迁移 | 普通模式风格套用/清除正常 |
| 10 | 品牌包 | brandKit | **[Agent]** | 品牌信息作为用户画像/会话上下文注入（`user_profile` 通道已存在），Agent 生成时自动带 | Agent 生成结果带品牌约束 |
| 11 | 模型选择 | ModelPicker | **[Agent+保留]** | 普通模式 ModelPicker 保留；Agent 通过 `generate_image.model` 传值；P0-B 归一化契约不变 | 双入口模型参数归一化一致、计费一致 |
| 12 | 尺寸/比例/解析度/时长/音频 | settings tab | **[保留]**（普通模式控件已有；agent 面 `agentTouched` 回流已存在） | 不迁移 | agent 改参数回流控件（D-12 契约保持） |
| 13 | **LoRA 风格** | LoraLibraryPanel | **[Agent Skill]** | **核心迁移**：`LoraLibraryPanel` 的搜索/排序/分页/收藏/最近/大图/单选 → Agent 工具 `lora_search` + `lora_get`（G1）；`/api/lora-models` + `/api/lora-preferences` 后端复用；生成时 `loraModelVersionIds`（单选、PixAI-only 约束由 catalog 归一化强制）由 Agent 携带 | 对话里「找一张赛博朋克 LoRA 试试」→ Agent 搜→选→出图；收藏/最近跨会话保留 |
| 14 | 数量（copies） | settings tab count | **[画布]** | 批量张数 → `run_generation.count` 批量子节点（已具备）；pro 进度 n/N+ETA 逻辑迁为画布批次反馈（G2） | 一次「20 张」在画布生成 20 个子节点，进度/失败逐个可见 |
| 15 | 参考图文件夹 | assets tab | **[画布]** | 参考图集合 → 画布节点 `referenceNodeIds` + `source_image`；角色选择暴露为节点动作（G3）；上限替换逻辑沿用 | 画布内一键「设为参考」并选角色，下次生成携带 |
| 16 | 队列检查器 | inspectorTab=queue | **[画布]** | 任务列表语义由批量子节点 + 服务器任务投影承接；失败原因 = 子节点 errorDetails；**原位重试** = 子节点重试按钮（G2） | 20 张中 1 张失败 → 仅重试该节点，账单不重复 |
| 17 | 图库检查器 | inspectorTab=gallery | **[画布]** | 「保存到文件夹」→ 画布项目归档/导出（BoardsPanel 逻辑迁画布项目）；「设为参考」→ G3 动作 | 成片在画布内可导出、可设参考 |
| 18 | 历史检查器 | HistoryInspectorPanel | **[画布+Agent]** | 历史页 + `?agent=1&q=` 交接保留（D-18 已实现）；「恢复参数」→ Agent 工具 `history_recall`（带撤销快照语义，还原为节点配置） | 历史图一键「交给 AI 助理继续做」→ Agent 恢复参数再生成 |
| 19 | workspaceMode canvas/viewer | 中栏 | **[画布]** | 已是画布工作区形态的默认能力，无迁移动作 | — |
| 20 | 灯箱 | viewer | **[保留]**（普通模式结果画布已有查看/下载） | 不迁移 | 普通模式查看/下载正常 |
| 21 | 标注设参考 | annotation 笔迹层 | **[画布]** | 标注笔迹层作为画布节点的一种（`source_image` + annotation），「原图+笔迹/仅笔迹」动作迁画布 | 画布内标注→设参考→生成，模型只看到正确输入 |
| 22 | 选区/多图 | canvas 态 | **[画布]** | 已具备，无迁移动作 | — |
| 23 | 队列速览 chips | pro-topbar-chips | **[画布]** | 等价物 = 画布工具栏运行中计数 + 失败角标（G2），点击定位到对应节点 | 批处理中一眼看到进行中/失败计数并可点击定位 |
| 24 | 整批进度+ETA | runProgress/runEta | **[画布]** | 批次父节点展示子节点进度条 + ETA（G2） | 真实批生成显示进度与剩余时间 |
| 25 | 键盘命令注册表 | workstation-commands.ts | **[画布]** | 注册表保留为全局命令（agent 面+画布态可用）：focus_prompt / run_generation / open_lora / 设参考 / 撤销 / 关闭浮层；IME/输入框抑制规则沿用 | 纯键盘在画布态完成「提示词→选 LoRA→生成→查看→设参考」 |
| 26 | 移动阶段聚焦 | MobilePanel | **[画布]** | `mobilePanelForTaskStage` 语义并入画布工作站（rail/底部抽屉按任务阶段自动聚焦，已有雏形） | 320/390px 真实生成的画布态无抢屏/溢出 |
| 27 | 移动抽屉/rail | 工作站抽屉 | **[画布]** | 画布工作站已具备 expanded/rail/拖宽，无迁移动作 | — |
| 28 | 服务器权威任务投影 | P0-A | **[画布]** | **不动**（是全局 owner，画布节点 imageTaskId 与之一致） | 跨设备任务一致（延续 P0-A 验收） |
| 29 | 结果血缘 | ResultLineage | **[画布]** | 血缘字段已映射到 `CanvasNodeMetadata.workflow_id/session_id/imageTaskId` + `source_image`；「设为参考」保留来源语义延续 | 参考链可回溯到源任务 |
| 30 | 图库/历史/任务 owner | 各 API/store | **[保留]** | 责任边界不变，不建第二套 | 既有契约测试全绿 |
| 31 | 教学引导 | lora-tour-content.ts | **[Agent Skill]** | LoRA 教学内容并入 Agent Skill 文档；pro 专属武装 token（`PRO_LORA_TOUR_ARMED_KEY`）随表面移除 | Skill 内包含 LoRA 使用说明与示例 |
| 32 | 导出 | 导出图片/JSON | **[画布]** | 下载/导出逻辑迁画布节点动作（跨源 Blob 下载已有），JSON 导出含配置/参考 | 画布内可下载单图、整批、导出 JSON |
| 33 | 能力警告 | capabilityNotice/lostParams | **[保留+画布]** | 归一化警告逻辑保留（P0-B），在 Agent 参数卡与画布节点提示中复用 | 模型切换致字段丢失有可见提示 |

**未列入本表的功能 = 不存在；任何遗漏请按 §9 回归清单核销并回报。**

---

## 5. Agent Skill 设计（LoRA，核心交付物之一）

### 5.1 Skill 名称与定位
`agent-lora` — 给 AI 助理的 LoRA 选型技能：搜索、预览、收藏、选型、约束判断与生成参数装配。

### 5.2 工具合约（网关 + 站内 API）
| 工具 | 入参 | 出参 | 后端 owner |
|------|------|------|-----------|
| `lora_search` | query, view(全部/收藏/最近), sort, page, limit | models[{versionId,title,previewUrl,tags,author}], total, capabilities.lora 约束 | 复用 `/api/lora-models` |
| `lora_get` | versionId | model 详情 + 大图预览 + 是否已收藏 | 复用 `/api/lora-models?id=` + `/api/lora-preferences` |
| `lora_favorite` | versionId, favorite(bool) | 最新收藏态 | 复用 `/api/lora-preferences`（favorite） |
| （续）`generate_image` | model, prompt, size, count, **lora/lora_id/lora_weight** | 节点/图片 | 既有 `generate_image`，参数归一化 `loraModelVersionIds.slice(0,1)` 保持单选铁律 |

### 5.3 Agent 行为规则（写进 Skill 文档）
1. 用户想叠风格 → 先 `lora_search`，有收藏/最近优先展示；只给 1 个 LoRA（单选铁律）。
2. 当前模型非 PixAI 时不得选 LoRA（catalog `capabilities.lora` 约束），要提示先换模型。
3. 所选 LoRA 必须显式传给 `generate_image`，不得仅文字提到「用赛博朋克 LoRA」。
4. 收藏/最近由真实成功使用更新（`last_used_at` 只在成功生成后写），沿用 P1-A 纪律。
5. 教学引导内容并入 Skill（`lora-tour-content.ts` 消化为 Skill 内使用说明）。

### 5.4 验收（真实）
- 对话：「找一张赛博朋克 LoRA 配 PixAI 模型，生成 2 张 4:5 图」→ Agent 搜索→选定→生成→画布 2 子节点，请求体含 `loraModelVersionIds:[<id>]`。
- 对话续：「再来 3 张但别用 LoRA」→ 新一轮生成不带 lora 字段，同批判定正确分桶。
- 收藏的 LoRA 在另一个会话可见（服务端 lora_user_state）。

---

## 6. 停用登记表（唯一允许线性的功能终止）

| 项 | 理由 | 替代 |
|----|------|------|
| 专业模式 toggle + 工作站外壳（#1/#2） | 表面迁移而非能力终止；独有能力全部迁走后才拆 | AI 助理 toggle + 画布工作站 |
| `PRO_LORA_TOUR_ARMED_KEY` 武装流（#31 尾） | 引导终点「前往专业模式」不再存在 | LoRA 教学并入 agent-lora Skill |
| pro 专属 CSS（`.pro-*`）/组件树遗产 | 表面移除后的样式孤儿 | 画布工作站样式（`.canvas-ws-*`） |

> 除以上 3 项外任何功能都不允许消失；若执行中发现必须终止某项，需追加到本表并给理由，再进入 §9 核销。

---

## 7. 验收合同（里程碑级，真实证据优先）

1. **真实生成**：每个里程碑至少一次真实账号真实生成走通新路径（mock/HTTP 200/页面可开不算闭环）；延续 P0-A/P0-C/P0-D 的「真账号真任务」纪律。
2. **零遗漏核销**：§9 回归清单全量勾选，每个 origin 功能都有已验收的 target 行。
3. **契约测试**：既有测试全绿（当前 43/43 + pro 相关），新增 `agent-lora` 工具与画布批次的契约测试预期通过。
4. **类型检查 + production build**：每片通过（tsc 0 error；`vercel build` 通过）。
5. **计费一致**：客户端期望费用 = 服务端归一化请求 = 最终账单（P0-B 合同不因迁移破坏）。
6. **无第二套**：grep 确认无新建的 queue/history/LoRA 偏好存储。

---

## 8. 执行清单（分片顺序，每片独立验收）

| 片 | 内容 | 进入条件 | 完成证据 |
|----|------|---------|---------|
| **S0** | agent-lora Skill + 工具合约（站内 API 复用 + 网关工具注册 + 契约测试） | 网关工具挂载路径核实 | `lora_search/lora_get/lora_favorite` 端到端可调；真实对话选 LoRA 生成成功 |
| **S1** | 画布批量 Native 闭环（G2）：批次父节点进度条/ETA、失败节点原位重试、速览计数定位 | S0 完成（Agent 出多张即画布多子节点） | 20 张真实批：进度/失败定位/单节点重试/账单幂等 |
| **S2** | 画布参考图动作（G3）+ 模板/资源/历史 Agent 工具（#7/#8/#18） | S1 完成 | 画布内设参考并选角色→生成携带；Agent 调模板/资源/历史恢复出图 |
| **S3** | 键盘命令 + 移动端阶段并入画布（#25/#26）+ 导出迁画布（#32） | S2 完成 | 纯键盘画布闭环；320px 真实流程无抢屏 |
| **S4** | 表面拆除与清理（#1/#2/#31pro 部分）：删 toggle、停止挂载工作站、`lora-tour` 教学指到 Skill、DNS/样式遗产清理 | S0-S3 全绿 | 无 pro toggle/组件树引用；build 通过；回归核销 33/33 |
| **S5** | 线上部署（vercel --prod + `vercel alias set` 归位 image.tinchak0207.xyz，记忆中的部署纪律） | S4 验收 | 生产可用；CF 缓存 ?cb= 核验新 build hash |

> 每片完成即进行用户验收节点；用户接管视觉验收时，部署 READY + 别名归位后停止并标注待验收。

---

## 9. 回归清单（功能零遗漏核销表）

> 执行 S4 时逐行核销：勾选 origin 节点 → 已在 target 侧手动/自动验证 → 留证据路径。

- [ ] #1 入口移除无残留（grep `pro-mode-toggle` / `openProfessionalMode`）
- [ ] #2 工作站组件树无引用（grep `InvokeInspiredWorkstation`）
- [ ] #3 状态通道（参考图/模型/结果 URL）普通↔画布不回丢
- [ ] #4 画布面板态跨刷新记忆
- [ ] #5 普通模式提示词出图正常（回归）
- [ ] #6 参考图上传 + PNG 血缘恢复
- [ ] #7 场景资源 Agent 套用（真实出图）
- [ ] #8 服务端模板 Agent 生成（真实出图 + 计价）
- [ ] #9 风格 preset 套用/清除
- [ ] #10 品牌约束随会话注入（可验证）
- [ ] #11 模型归一化（双入口一致 + 计费一致）
- [ ] #12 比例/解析度/时长/音频归一化
- [ ] **#13 LoRA Skill：搜/选/收藏/最近/单选/PixAI 约束**
- [ ] **#14 批量=画布批量子节点（含进度/ETA）**
- [ ] **#15 参考图角色 + 上限替换（画布局部动作）**
- [ ] **#16 失败节点原位重试，账单幂等**
- [ ] #17 图库导出/设参考迁画布
- [ ] #18 历史交接 + 恢复参数（Agent）
- [ ] #19/#22 画布/多图（默认能力）
- [ ] #20 查看/下载（回归）
- [ ] #21 标注设参考（原图/仅笔迹两态）
- [ ] #23 运行计数/失败角标定位
- [ ] #24 批次进度/ETA
- [ ] #25 键盘命令（画布态全流程）
- [ ] #26/#27 移动端阶段聚焦 + 抽屉
- [ ] #28 服务器任务跨设备一致
- [ ] #29 参考血缘可回溯
- [ ] #30 历史/图库/任务 owner 无第二套
- [ ] #31 教学并入 Skill；pro 武装 token 移除
- [ ] #32 导出单图/整批/JSON
- [ ] #33 能力警告可见（含 Agent 参数卡）

---

## 10. 明确不做（Out of Scope）

- 不迁移专业模式的「两/三栏布局」本体（原 P0 决策 #1/#2 已不做）。
- 不开放多 LoRA（单选铁律不变，含 Agent）。
- 不新建第二套队列/历史/偏好存储；不做数据库迁移（除既有 006_lora_user_state 复用）。
- 不因迁移更改计费通道、生成路由、上游渠道（image.tinchak0207.xyz 模型接入矩阵不变）。
- 不在画布态复制 pro 的 CSS 美学；沿用画布工作站既有 Liquid Glass 纪律。

---

## 11. 关联文档

- Mnemon doc `98a3fbe2`：迁移决策与能力清点（本 PRD 的输入）。
- `docs/plans/2026-08-01-professional-workflow-product-mainline.md`：P0-A..P1-C 契约（继承）。
- `docs/agent-native-ultimate-blueprint-zh.md`：workflow 是产品单位（继承）。
- Mnemon doc `9be495b4`：L0 账户级记忆（品牌/画像注入通道）。