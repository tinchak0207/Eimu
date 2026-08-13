# Image Studio 专业工作流产品主线

状态：已确认、待实施
日期：2026-08-01
本文件范围：只固化产品决策、责任边界、实施顺序与验收合同；本轮不修改业务代码、不部署。

## 1. 可衡量终点

登录用户在桌面或手机发起一次真实生成后，即使刷新或换设备，也能沿同一个任务 ID 查看进度与结果；结果自动成为当前画布资产，并能一键复用为下一次生成的参考图。模型参数、LoRA 找回、移动端阶段切换和键盘操作都围绕这条闭环服务。

最短因果链：

```text
准备输入
  -> 提交带稳定 ID 的生成任务
  -> 服务器保存任务状态与结果血缘
  -> 队列、画布、图库读取同一份任务投影
  -> 结果自动可见
  -> 一键转成参考图
  -> 下一次生成继续携带来源血缘
```

主瓶颈不是缺少更多面板，而是队列、当前成片、图库、历史和参考图仍未完全由同一份服务器权威状态串起来。

## 2. 已确认取舍

| 原编号 | 决定 | 产品边界 |
|---|---|---|
| 1 | 不做 | 暂不解决两/三栏切换时保持画布视觉中心；当前收益不足以进入本轮。 |
| 2 | 不做 | 暂不继续压缩或隐藏右侧工具轨；保留现有可发现入口。 |
| 3 | 做 | 队列、当前成片、图库形成连续工作流。 |
| 4 | 做 | 队列与历史跨刷新、跨设备持久化。 |
| 5 | 做 | 生成结果一键复用为参考图，并保留来源血缘。 |
| 6 | 做 | LoRA 收藏、最近使用和大图预览。 |
| 7 | 明确排除 | 多 LoRA 组合及权重控制是当前伪需求；继续保持单选，不为它预埋复杂交互。 |
| 8 | 做 | 参数根据模型真实能力自动重组、清理并重新计价。 |
| 9 | 做 | 移动端按准备、生成、结果阶段自动聚焦，不复制桌面三栏。 |
| 10 | 做 | 专业模式全面键盘化，但不得干扰输入法、文本编辑和无障碍焦点。 |

任何新增候选必须先证明它比这七项中的当前主瓶颈有更高的结果杠杆，否则进入停车场而不是插队。

### 七项问题的证据与瓶颈

| 项目 | 证据等级 | 受影响阶段与摩擦 | 单一主瓶颈 | 排序理由 / 取舍 |
|---|---|---|---|---|
| P0-A / 原 4 | `FACT + INFERENCE` | 生成中与返回后；刷新或换设备可能失去任务连续性 | 客户端投影与服务器任务/历史尚未以稳定 ID 完全收敛 | 是 3、5、9 的数据前置，先做可减少三处重复状态修补 |
| P0-B / 原 8 | `FACT` | 参数准备；切模型后可能残留不支持字段或旧价格 | 模型能力虽有 catalog，但 UI、请求与计费尚未完全共享同一归一化合同 | 先稳定动作语义，再做键盘化，避免快捷操作错误状态 |
| P0-C / 原 3 | `FACT + INFERENCE` | 生成到查看；用户需在队列、画布、图库间寻找同一结果 | 三个表面没有共同的 active task/result identity | 直接缩短主创作闭环，依赖 P0-A 的稳定 ID |
| P0-D / 原 5 | `FACT` | 查看结果到下一次创作；现有入口未形成全表面统一血缘 action | “设为参考”能力存在，但来源、角色和入口没有统一合同 | 与 P0-C 同批可复用现有 action，不另建资产系统 |
| P1-A / 原 6 | `FACT + HYPOTHESIS` | LoRA 探索；难以找回已验证风格 | 缺少稳定用户偏好与真实使用时间 | 单选加找回能力先验证价值；明确拒绝多 LoRA 复杂度 |
| P1-B / 原 9 | `FACT + INFERENCE` | 手机准备、生成、结果切换；当前主要靠手动面板 | 移动主表面没有稳定任务阶段输入 | 依赖 P0-C 的阶段投影，后做可避免第二套移动状态机 |
| P1-C / 原 10 | `FACT + INFERENCE` | 高频专业操作；只有生成与教学存在零散键盘逻辑 | action 尚未通过统一命令注册表暴露 | 最后接入稳定 action，避免快捷键反向固化临时 UI |

## 3. 当前世界模型

### FACT

- `InvokeInspiredWorkstation.tsx` 已有 `queue / gallery / history` 检查器、当前画布结果、任务槽位、两/三栏阶段状态和“设为参考”入口。
- `ImagePlayground.tsx` 与 `use-image-generation.ts` 是生成提交、结果回传和参考图请求的前端主链。
- `/api/generation-jobs/[id]`、`generation-core/job-repository.ts` 与 Postgres migration 已提供服务器任务责任边界；不得再建第二个客户端任务系统。
- `/api/history`、`history-client-store.ts`、`server-history-store.ts` 已提供历史读取与客户端投影；客户端缓存只能加速，不可成为跨设备权威来源。
- `generation-model-catalog.ts` 已描述模型的媒体类型、比例、分辨率、时长、参考图能力和价格，并已有参数归一化函数；它应继续是能力真相源。
- `LoraLibraryPanel.tsx` 已支持搜索、排序、分页与单选，但收藏、最近使用和跨设备偏好尚无权威数据模型。
- 工作站已有 `Ctrl/Cmd + Enter` 生成快捷键，教学引导也有独立键盘处理；当前不存在覆盖整个专业工作流的命令注册表。

### INFERENCE

- 第 3、4、5 项必须共享稳定的 `task_id / generation_id / result_id`，否则只能得到三个看似连通、实际会漂移的界面。
- 第 8 项必须先于大规模键盘化完成，否则快捷键会操作当前模型并不支持的隐藏参数。
- 第 9 项应由任务阶段驱动，而不是由视口宽度单独驱动；视口只决定布局，任务阶段决定当前主表面。
- 第 6 项的“最近使用”应记录真实选择或成功生成，而不是仅记录卡片浏览，否则排序会被误触污染。

### HYPOTHESIS

- 服务器权威任务投影与结果血缘打通后，刷新丢状态、成片找不到和复用路径长三个问题会同时下降；实施时以跨设备验收决定该假设是否成立。
- 单选 LoRA 加收藏/最近/大预览足以覆盖当前检索痛点；在真实使用证据推翻前，不开放多 LoRA。

## 4. 权威状态与字段合同

禁止以组件局部 state 作为跨页面或跨设备真相。建议在现有 owner 上补齐以下投影，而不是另建 store：

```ts
type GenerationTaskProjection = {
  taskId: string;
  userId: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "refunded";
  modelId: string;
  submittedConfig: NormalizedGenerationConfig;
  resultIds: string[];
  primaryResultId?: string;
  createdAt: string;
  updatedAt: string;
  retryOfTaskId?: string;
  errorCode?: string;
};

type ResultLineage = {
  resultId: string;
  taskId: string;
  sourceResultId?: string;
  sourceGenerationId?: string;
  referenceRole?: "general" | "character" | "product" | "style" | "composition";
};
```

命名可在实现时适配现有 schema，但这些关联不能省略。不得在日志、文档或客户端投影中持久化私密上游凭证。

## 5. 分项实施合同

### P0-A：跨刷新、跨设备任务与历史（原 4）

结果：服务器是任务、进度、结果索引和用户历史的唯一权威来源；刷新页面或第二台设备只需重新拉取，不依赖原浏览器内存。

现有 owner：

- `src/lib/generation-core/job-repository.ts`
- `db/migrations/001_generation_control_plane.sql`
- `src/app/api/generation-jobs/[id]/route.ts`
- `src/app/api/history/route.ts`
- `src/lib/server-history-store.ts`
- `src/lib/history-client-store.ts`

最小改动：

1. 为历史结果补齐任务关联和主结果字段；任务与结果写入保持幂等。
2. 提供“当前用户最近活动任务”查询，覆盖 queued、running、succeeded、failed。
3. 客户端登录、刷新、重新聚焦页面时合并服务器投影；本地条目只能作为未确认的乐观状态，并在服务器响应后收敛。
4. 继续使用现有 VPS Postgres/数据后端与现有图片存储适配层，不引入 Supabase 或第二套数据库。

验收：

- 同一账号在浏览器 A 提交真实任务，浏览器 B 能看到相同 `taskId`、状态和最终结果。
- A 在 queued/running 时刷新，任务不消失、不重复扣费、不产生第二任务。
- 历史条目可追溯到任务和结果；失败任务保留稳定错误码与重试入口。

### P0-B：模型能力驱动参数（原 8）

结果：切换模型后只显示且只提交该模型支持的字段；失效字段被明确清理，客户端预计费用与服务端计费一致。

现有 owner：

- `src/lib/generation-model-catalog.ts`
- `src/lib/generation-workflow.ts`
- `src/components/ModelPicker.tsx`
- `src/components/pro-workstation/InvokeInspiredWorkstation.tsx`
- `src/hooks/use-image-generation.ts`
- 生成 API 的服务端参数归一化与计费路径

最小改动：

1. 从 catalog 暴露一个 UI 与服务端共同消费的 capability projection，覆盖媒体类型、参考图、比例、分辨率、时长、音频、LoRA 和质量档。
2. 模型切换时通过一个纯函数归一化当前配置；删除不支持字段，并对被清理的用户输入给一次可见反馈。
3. 价格计算只接收归一化配置；请求体和费用摘要使用同一投影。
4. 服务端再次归一化并拒绝无法安全降级的组合，不能信任客户端隐藏控件。

验收：

- 在图片、视频、PixAI 与不支持参考图的模型之间切换，界面无残留无效参数，请求体也不包含它们。
- 模型切换后的费用立即更新，客户端与服务端最终扣费一致。
- catalog contract test 覆盖每个已上线模型，不用 UI 特判表复制能力。

### P0-C：队列—画布—图库连续工作流（原 3）

结果：用户从提交到查看结果只跟随一个任务；成功结果自动成为当前画布资产，队列和图库点击均回到同一结果，失败原位重试。

现有 owner：

- `src/hooks/use-image-generation.ts`
- `src/components/ImagePlayground.tsx`
- `src/components/pro-workstation/InvokeInspiredWorkstation.tsx`
- `src/app/api/generation-jobs/[id]/route.ts`
- 历史/结果投影 owner

状态机：

```text
idle -> submitting -> queued -> running -> succeeded -> reviewing -> reusing
                            \-> failed -> retrying -> queued
```

最小改动：

1. 工作站维护 `activeTaskId` 与 `activeResultId`，而不是仅按 `images[index]` 推断当前任务。
2. 提交成功立即选中队列任务；首个可显示结果到达时自动进入画布，但不打断用户正在操作的旧结果，需定义一次性自动切换阈值。
3. 队列卡、画布与图库卡使用同一个结果选择 action。
4. 重试记录 `retryOfTaskId`，默认继承原配置但创建新任务；原失败记录不被覆盖。

验收：

- 一次真实生成从队列到画布再到图库始终显示相同任务/结果关联。
- 多张并发逐张完成时不跳错图；用户手动选择旧图后不会被后续轮询反复抢焦点。
- 失败任务原位可重试，原错误仍可查看，账单不会因为 UI 重试产生无法解释的重复扣费。

### P0-D：结果一键复用为参考图（原 5）

结果：当前画布、图库、历史或已完成队列中的图片，都能一键加入下一次创作的参考图，并保留来源与用途。

现有 owner：

- `InvokeInspiredWorkstation.tsx` 中现有 `sendResultToAssets` 与参考图角色
- `ImagePlayground.tsx` 的 `referenceImages`
- `use-image-generation.ts` 的 `referenceImages / referenceImageRoles`
- 历史与结果 lineage 字段

最小改动：

1. 把现有“设为参考”收敛成一个 action，供画布、图库、历史和队列结果复用。
2. 默认角色为 `general`，允许在加入前或加入后选择人物、商品、风格或构图。
3. 保存 `sourceResultId / sourceGenerationId`；不得仅把远程图片重新命名成无来源的临时文件。
4. 达到参考图上限时提供替换选择，不静默失败。

验收：

- 用户从真实成片点击一次即可在左栏看到参考图缩略图与来源；下一次真实请求确实携带该参考资产。
- 刷新后来源关系仍在，删除参考不会删除原成片。

### P1-A：LoRA 收藏、最近使用与大图预览（原 6）

结果：用户能快速找回用过或收藏的单个 LoRA，并在选择前看清大图与核心元数据。

现有 owner：

- `src/components/pro-workstation/LoraLibraryPanel.tsx`
- `src/app/api/lora-models/route.ts`
- `InvokeInspiredWorkstation.tsx` 的单个 `selectedLora`
- 现有 VPS Postgres 用户数据边界

最小改动：

1. 以稳定 `modelVersionId` 作为偏好主键，新增用户级 favorite 与 lastUsedAt；不要用标题或图片 URL 做主键。
2. “最近使用”只在实际选择并提交成功后更新；浏览预览不计入。
3. 增加收藏/最近筛选和大图预览层，保留当前搜索、排序、分页与单选。
4. 记住最近筛选和滚动位置，但服务器偏好仍是跨设备真相。

验收：

- 收藏在刷新和第二设备可见；最近使用顺序由成功使用时间决定。
- 大图预览不改变当前选择，明确确认后才替换单选 LoRA。
- 不出现权重、多选或多 LoRA 冲突 UI。

### P1-B：移动端按任务阶段聚焦（原 9）

结果：手机端准备时显示创作，生成时显示进度，完成时显示结果；它是任务阶段界面，不是缩小的桌面三栏。

现有 owner：

- `InvokeInspiredWorkstation.tsx` 的 `MobilePanel`
- `workstation.css` 的移动单工作面规则
- P0-C 的任务状态投影

最小改动：

1. 增加纯函数 `mobilePanelForTaskStage`：prepare -> create，queued/running -> output/queue，succeeded -> canvas/result，failed -> output/error。
2. 自动切换只发生在任务阶段边界；用户手动切换后，在同一阶段内不得被轮询抢回。
3. 完成新结果时提供一次明确提示；不要通过缩小字体或卡片容纳更多内容。

验收：

- 390×844 与 320×844 下完成一次真实生成，不出现横向溢出、焦点跳动或桌面面板叠层。
- 用户在 running 阶段手动回创作区后，普通轮询不抢屏；成功事件到达时才进入结果或给可见提示。

### P1-C：专业模式全面键盘化（原 10）

结果：高频创作、LoRA 检索、结果查看和模板撤销可通过一致快捷键完成，同时不破坏输入框、中文输入法和无障碍焦点。

现有 owner：

- `InvokeInspiredWorkstation.tsx` 现有 `Ctrl/Cmd + Enter`
- `src/lib/tour-keyboard.ts` 仅负责教学引导，不扩成业务命令中心
- 各工作站 action 与可聚焦元素

最小改动：

1. 新建一个工作站 command registry，命令只调用现有 action，不复制业务逻辑。
2. 首批命令：生成、聚焦画面描述、打开 LoRA 搜索、上下选择 LoRA、切换队列/图库/历史、设为参考、撤销模板、关闭当前浮层。
3. 当焦点在 input/textarea/select/contenteditable、IME composing 或 modal 内时按命令规则抑制全局快捷键。
4. 在按钮 tooltip 与一个可搜索快捷键面板中公开绑定；不得要求用户记忆隐藏组合。

验收：

- 纯键盘可完成“聚焦提示词 -> 选 LoRA -> 生成 -> 打开结果 -> 设为参考”。
- 中文输入法组合期间不触发生成或导航；Tab 顺序、Escape 与可见焦点符合既有无障碍语义。
- 教学快捷键与业务快捷键没有双重监听冲突。

## 6. 实施顺序

| 里程碑 | 内容 | 进入条件 | 完成证据 |
|---|---|---|---|
| M0 | P0-A 服务器权威任务/历史 + P0-B 能力合同 | 现有 schema 与 catalog owner 核对完成 | 两设备看到同一任务；能力 contract test 与计费一致 |
| M1 | P0-C 连续工作流 + P0-D 一键参考复用 | 稳定 task/result ID 可用 | 一次真实生成完成队列—画布—图库—参考图闭环 |
| M2 | P1-A LoRA 找回 | 用户偏好存储 owner 明确 | 收藏跨设备、最近使用准确、大预览不误选 |
| M3 | P1-B 移动阶段聚焦 | P0-C 暴露稳定任务阶段 | 320/390px 真实生成过程无抢屏与溢出 |
| M4 | P1-C 全键盘化 | 主要 action 与参数能力稳定 | 纯键盘真实闭环 + IME/焦点回归 |

每个里程碑完成后再进入下一个。禁止同时重写队列、历史、LoRA store 和快捷键系统。

## 7. 验证策略

1. 先实现经过证据支持的改动，再运行预期通过的 contract/component tests；不故意制造红测。
2. 类型检查和生产构建是每个实现里程碑的基础门槛。
3. P0-A/P0-C/P0-D 必须使用真实账号与真实生成任务验证稳定 ID、结果文件和参考复用；mock、HTTP 200 或页面可打开都不算闭环证明。
4. P0-B 必须比较客户端预计费用、服务端归一化请求和最终账单。
5. P1-B/P1-C 的浏览器验证只覆盖会改变决策的交互；如果用户明确接管视觉验收，部署 READY 后停止并标注待用户验收。

## 8. 明确不做

- 不实施原编号 1、2、7。
- 不新建第二套生成队列、历史存储、模型能力表或 LoRA 多选状态。
- 不因本计划迁移数据库供应商、重写计费、替换现有工作站视觉体系。
- 不把 UI/单元测试成功写成生产生图成功。
- 不在本轮文档任务中修改业务代码或触发 Vercel 部署。
