# 前端层面对称差报告（2026-09-16）

> 定性：**能力建设**（探索 + 找差，不是修复）
> 方法：真部署两边前端 → 同源结构提取（DOM 几何 + 交互元素）→ 逐条 grep 验证存在性
> 铁律遵守：**列缺口前必 grep 验证**（PRD §9 更正五教训：曾把「我方已有」误判为缺口）

---

## 0. 部署与取证（可复验）

| 项 | AID | 我方 |
|---|---|---|
| 源码 | `/tmp/aid-deploy`（`git clone --depth 1`，128MB） | `/home/lenovo/Desktop/image-app` |
| 起法 | `next dev --port 4100`（Next 16.3 / Turbopack） | `next dev --port 3200`（Next 15.5.15，LOCAL_TEST_MODE + 真 gateway） |
| 依赖 | `npm install` 594 包 | 既有 |
| 截图 | `/tmp/aid-shots/0*.png`（12 页） | `/tmp/aid-shots/ours-*.png` |
| 结构 | `/tmp/aid-shots/aid-dom-report.json` | `/tmp/aid-shots/ours-dom-report.json` |
| 轮子 | `eval-visual-replay/aid-dom.mjs`、`aid-shot.mjs` | `eval-visual-replay/ours-dom.mjs` |
| 过登入闸 | `localStorage.token` 预置（前端守卫） | `NEXT_PUBLIC_LOCAL_TEST_MODE` |

**尺度说明（诚实边界）**：AID 后端未部署 → 其页面资料区全空（「案例列表加载失败」「暂无分镜」）。故本报告比的是**版面骨架与交互结构**（不依赖后端），不比资料态内容。我方页面走真 gateway，但多数页面同样无资料态，同尺度。

---

## 1. 一句话结论

**AID 前端强在「流程的空间化」——把 7 步生产流程做成常驻导航骨架，每一步配一个专业工作台，使用者永远知道「我在哪、下一步是什么、这一步还差什么」。我方强在「能力的表达」——3D 导演台 39,251 行 vs AID studio 5,150 行、45 个 agent 模板 vs AID 无对应物。两者不是同一维度。**

**真正的单向对称差只有一项且很明确：AID 有流程空间化，我方没有。**

---

## 2. AID 前端骨干（实测结构）

```
create-page (0,0 1600x1000)
├── 左侧全域导航 80px（案例广场 / 我的作品 / 资产库 / 新手教程）
└── create-main (80,0 1520x1000)
    ├── 7 步流程条（常驻，每一页都带）
    │   项目配置 → 剧本创作 → 素材准备 → 分镜设计 → 视频生成 → 音画同步 → 成品预览
    └── preview-panel (104,118 1448x860)  ← 每步的工作台
```

**7 步流程条实测命中率**：`05~11` 共 **7 页全带 7/7**；`works/assets/series-episode-list` 不带（不同层级）。这是**常驻骨架**，不是单页元件。

各步工作台（实测类名 + 交互元素）：

| 步 | 页 | 工作台类名 | 关键交互 |
|---|---|---|---|
| 1 项目配置 | `/create/global-setting` | `left-panel 340px` + `right-panel 1064px` | 作品类型 / 6 种比例 / 风格库 / 模型策略 / 创作模式 |
| 2 剧本创作 | `/create/story-script` | `rich-text-editor ql-editor`（Quill 1448x800） | 撤销/重做/复制/清空 + **AI写剧本** + 导入 + **历史版本** + 右侧 Agent 对话 |
| 3 素材准备 | `/create/scene-character` | `scp-content` + `asset-section` | 场景/角色/道具三分页 + **自动提取场景** |
| 4 分镜设计 | `/create/storyboard-script` | `storyboard-step-shell` | **列表/卡片双视图** + 添加分镜 + 自动生成 + **完成进度 0/0** |
| 5 视频生成 | `/create/storyboard-video` | 同构 | 列表/卡片 + **批量操作** |
| 6 音画同步 | `/create/dubbing` | `dubbing-wrap` | 列表/卡片 + 批量操作 |
| 7 成品预览 | `/create/preview` | `preview-player-area 1448x582` + **`timeline-wrap 1448x238`** | 播放器 + **时间轴轨道**（`track-row-video` 72px）+ 导出/发布 |

**体量**：`components/studio` 50 个 tsx / 5,150 行；`hooks/studio` 13 个 hook。

---

## 3. 我方前端（实测结构）

```
page-shell (80,0 1440x62)  顶栏
└── page-shell xl:flex (80,102 1440x834)
    ├── 生成区 892px（PromptInput + 模型/比例/风格 chips）
    └── 右栏 460px
```

- **首页 = 单一生成器**（prompt + 45 个模板卡 + 模型/比例/风格选择器）
- **agent 面**（`?agent=1`）= `canvas-ws-overlay 1156x1000` + `agent-template-carousel` + 45 个模板按钮 + 输入框「描述新需求，或要求修改上一轮的图…」
- 路由 17 页：`/ /agent /pricing /history /status /docs/* /admin /settings/api-keys /review /wechat-login`
- **无 7 步流程条、无时间轴轨道、无作品列表页、无案例广场**

---

## 4. 单向对称差清单（逐条 grep 验证）

### 4.1 真缺口（我方确实没有）

| # | 缺口 | AID 座标 | 我方验证 | 严重度 |
|---|---|---|---|---|
| **D1** | **7 步流程常驻导航骨架** | 7 页全带 `项目配置→…→成品预览` | `grep currentStep src/components/ src/app/` → **仅 1 命中且是 API route**；`creation-flow-steps.ts` 被 import 处只有 `use-canvas-chat.ts`(型别) 与 `project-store.ts`(清洗) | **高** |
| **D2** | **分镜「完成进度 N/M」可见化** | `分镜完成进度：0/0` | `grep 完成进度\|完成进度` → **0 档** | 中 |
| **D3** | **成品预览的时间轴轨道 UI** | `timeline-wrap` + `track-row-video` | `grep timeline-track\|TimelineTrack` → **0 档**（后端 `timeline.ts` 有 op DSL，前端无呈现） | 中 |
| **D4** | **作品列表页（专案为单位的入口）** | `/works` + `新建作品` | 路由无 `/works`；`grep 我的作品` → 仅 1 档（非页面） | 中 |
| **D5** | **案例广场（公开作品浏览）** | `/` 首页 + 全部/电影/电视剧集 tabs | `grep 案例广场` → **0 档** | 低（涉运营） |

### 4.2 假缺口（我方已有，**不得重造**）

| 概念 | 我方实作 | 判据 |
|---|---|---|
| 资产库 | `assets/route.ts` + `CanvasLibraryPanel` + `LoraLibraryPanel` | 23 档命中 |
| 批量操作 | `batch-select` 系列 | 6 档命中 |
| 历史版本 | 版本树 + `timeline_restore` | 5 档命中 |
| 分镜双视图 | 2 档命中 | — |
| 3D 导演台 | `director-engine` + `director-mini` + `canvas-workstation` | **39,251 行**（AID studio 5,150 行的 7.6 倍） |
| 生成模板 | 45 个 agent 模板 | AID 无对应物 |
| 时间轴后端 | `timeline.ts` op DSL（拆分/修剪/变速/重排/锁定/分组/转场/加轨 8 op） | 已在 VPS 上线且活跃 |

---

## 5. 根因：为什么我方「有 7 步状态机却没有流程条」

刀 1 已交付 **7 步状态机后端**（`creation-flow-steps.ts` + `CanvasProject.currentStep/episodes` + 三处还原点），但：

1. **`currentStep` 的唯一写入口 `setProjectMeta` 无 UI 呼叫者**（刀 1 遗留，已知）
2. **前端无任何元件渲染 `currentStep`**（本轮实测：`grep currentStep src/components/` → 0 命中）
3. `CanvasAgentOp` 8 op 无 project 级操作 → agent 也无法驱动

即：**状态机能存能读，但没有任何界面把它显示出来，也没有任何入口把它写进去。** 这是「后端能力已建、前端未接线」的典型缺口，与刀 0 的「货架长草」同型。

---

## 6. 建议（待暴君裁定，不擅自开工）

| 选项 | 内容 | 工作量 | 对齐宗旨 |
|---|---|---|---|
| **A** | 做 7 步流程条（D1）+ 进度可见化（D2） | 中 | ✅ 直接复用刀 1 已交付的后端，补前端接线 |
| **B** | 做时间轴轨道 UI（D3） | 大 | ⚠️ 用户已裁定「不做在线剪辑」（Eimu 卖 one-shot）——此项**与宗旨冲突**，除非只做**唯读回放**（agent 剪好的结果给人看懂，不给人剪） |
| **C** | 做作品列表页（D4） | 中 | ✅ 与「作品/剧集实体链」（刀 1）同源，是其自然入口 |
| **D** | 做案例广场（D5） | 中 | ❌ 涉运营配套，用户已裁定「配套不要」 |
| **E** | 全部不做，只补 B 的唯读版 | 小 | ✅ 最小原创 |

**B 的关键区分**：AID 的时间轴是**可编辑**（人在剪片）；若只做**唯读回放**（agent 产出的 timeline 给人看：哪几段、多长、什么转场），那不违 one-shot 宗旨，且能补上「流水线透明度」——用户能看懂 agent 剪了什么。这是**产品语义不同**的同一元件，值得单独裁定。

---

## 7. 未观察项声明

- AID 后端未部署 → 未能观察：真实资料态的版面（列表密度、长文本处理、大图载入）、错误态、载入态
- AID 登入后的真实互动（含 confirm 门禁、扣费提示）未观察
- 我方 `/canvas` `/playground` `/assets` 在本轮 3200 埠上渲染为空壳（2 boxes / 0 btns），**原因未查明**——可能是该埠实例的环境差异，非本轮结论基础。列为未观察项。
- 未做像素级视觉审核（read-image 遇 gemini 429；改用 DOM 结构提取，精度更高但看不到色彩/质感/字型质地）
