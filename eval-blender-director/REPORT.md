# REPORT — 3D 导演工作站（Blender Director）顶位模型实战评测（片AB）

- 日期：2026-09-06 22:40 ~ 09-07 00:30（约 110 分钟，提前收口裁定于 00:25）
- 评测执行：片AB subagent，按 agent-evolve 完整流水线（阶段一评测，阶段二三映射/派工以建议清单形态随附）
- 被评测系统：blender_* 三工具（blender_exec / blender_render / blender_export_gltf）+ skills/blender-director SKILL（五阶段管线 + 12 配方）+ blender-bridge（Blender 5.2.1 headless EGL）+ 反向隧道（VPS 127.0.0.1:8765 → 笔电桥）
- 驱动方式：gateway 会话真实驱动（POST /agent/v1/sessions → messages → SSE 取证），4 任务并发，零外部渠道成本，评测花销 0 币（T4 报价未执行即中断）
- 证据目录：`eval-blender-director/evidence/`（frames/ SSE+会话快照、T1/ T2/ 真帧、T3/ blend 探针、T4/ 分镜全文）

---

## 0. 结论先行

**双轨总分 54/100（A 轨任务完成度 54 + B 轨轮子利用度 54），低于 60 分红線 → 判决：罚俸整改（需反馈回路）。**

一句话总评：**顶位模型在 Blender 轮子上的真实能力是「工程自愈型高手」而非「管线执行者」——T2 证明它能穿透部署级故障交付真产物，T3 证明它能自抓轮子上游从未记录的真 bug；但 T1 的产物滞留桥主机、T4 的完全脱离 3D 链暴露出：轮子的「交付通路」和「任务路由」两个环节是断的，模型越强越会把断点显形。**

---

## 1. 用户旅程时间线

| 时刻 | 事件 |
|---|---|
| 22:40 前 | 环境三缺口补齐：隧道服务安装+启动、blender 三工具 VPS 部署、SKILL 部署；全链 smoke PASS（vps_smoke_diag.json） |
| 22:4x | T1（静物 lookdev）开跑；T2/T3/T4 相继并发 |
| T1 过程 | 渲染成功产真帧，但 agent 沙箱（VPS）摸不到桥主机 PNG → 6+ 轮 ls/find 空手 → 读 environment-notes 仍无法取回 → turn idle 终止，**无最终交付** |
| T2 过程 | blender_render 部署版报「Couldn't create directory」→ 模型定位部署版相对路径死 → 改用 blender_exec 绝对路径+烧进 .blend → 10 帧全出 → turn done，交付话术完整 |
| T3 过程 | syntax 错自愈 → 发现「桥接是共享实例，场景被其他任务重置」→ 发现 5.2 API fcurves 雷区 → 自抓两真 bug（装配矩阵乘序反了 / pose_at 没逐骨刷新）→ 修复重建 dev_max=0 → 发现关键帧没生效，诊断中被打断（最后一条助手消息为空） |
| T4 过程 | 交出高质量分镜方案（S01/S02 + teal/magenta anamorphic 机位表）→ 报预算单 **gpt-image-2 ×2（2D 图像模型）** → 发 question 卡等确认 → **全程零 blender 工具调用** → 挂起至收口 |
| 00:16 | mannequin_sit.blend 最后一次存档（T3 整链重建） |
| 00:2x | 收口裁定：停 T4 SSE 单元，快照终态，提前写报告 |

模型渠道事实：b-ai/qwen3.8-flash 首延迟 90s+ 常态，watchdog 75s 重投与 N1 心跳实测自愈有效（T3 dry-run 两次零输出后重投成功）。

---

## 2. 逐任务记录与产物验真

### T1 静物 lookdev「木桌上的老式打字机，黄昏窗光」（易）— A 60 / B 65

- 工具调用 13 次（blender_exec 为主），事件 4319。
- 产物：`tw_dusk_f0001.png` 1600×900，**PIL 亮度方差 1081 > 500 = REAL**（证据 evidence/T1/）。
- 断点：产物写 `$BLENDER_WORK/out/`（笔电桥主机），agent 沙箱在 VPS 摸不到——模型 6+ 轮 ls/find 全空手，turn 终止无最终交付。**全链交付断点，假成功未发生但交付链死亡**。
- 归因：轮子设计（无产物回传通路），非模型能力。

### T2 相机运动序列「仓库 dolly-in 10 帧」（中）— A 92 / B 75

- 工具调用 10 次，事件 4739，turn_done=1（唯一完整闭环任务）。
- 产物：`warehouse_dolly_0001..0010.png` 10 帧全 REAL；首尾像素差分 **76.8% > 1% = 相机真移动**（证据 evidence/T2/）。
- 亮点：模型理解「桥主机与我沙箱不同机」的拓扑，把绝对路径烧进 .blend 绕开部署版 blender_render 的相对路径死，交付话术完整诚实。
- 揭露的轮子缺陷：**部署漂移**——部署版 blender-tools-impl.ts 滞后于真源 `src/lib/blender-tools.ts`（缺 makedirs + 相对路径 `_f%04d`），blender_render 首跑即死；模型被迫弃用正规工具走 exec 旁路（B 轨扣分点：工具选择被轮子缺陷扭曲）。

### T3 骨架动画「mannequin 站→坐 3 秒」（中）— A 45 / B 70

- 工具调用 16 次 blender_exec + 2 次 todowrite，事件 8916；turn 中断时最后一条助手消息为空（评测收口截断，非模型死亡）。
- 产物：`mannequin_sit.blend`（00:16 存档）。**评测员只读探针**（evidence/T3/blend-probe.txt）：
  - 骨架 Character 19 骨、36 物体、CharacterAction **133 条 fcurves 存在**；
  - 但帧采样 1/18/36/54/72 的 hips_z 恒 0.950、knee_z 恒 1.336——**fcurves 全恒值，动画几何死亡，坐姿动作未发生**；
  - 与模型自诊完全一致（「装配修正成功 dev_max=0，但关键帧没生效——三帧探针全是站姿」）。
- 亮点：模型自抓两个轮子文档从未记录的真 bug——①装配修正矩阵乘序写反（应为 `basis @ w⁻¹ @ target`）②pose 写入缺逐骨刷新（父骨陈旧求值）——并自建探针验证 dev_max=0 后才宣布装配成功（诚实自审）。
- 断点：关键帧恒值根因修复未完成即被收口截断；零取证渲染帧。**如实标注：interrupted（收口裁定），非模型宣称失败**。

### T4 多镜 previz「雨夜屋顶追逐 2 镜」（难，对照人肉基线）— A 20 / B 5

- 工具调用：**2 次 quote_bundle，0 次 blender 工具**。交付仅分镜方案（S01 大远景俯拍长焦 / S02 近景横移起跳，teal+magenta anamorphic，质量上乘）。
- **重罪级发现：预算单报价 `gpt-image-2 ×2 张`——3D previz 任务被模型路由到 2D 图像生成链，blender-director 工作站全程未进入**。若评测员确认，交付将是 2D 图像冒充 3D previz（假成功风险在确认门被拦下）。
- 随后发 question 卡挂起等确认，直到收口。如实标注：interrupted（挂起无响应 + 收口），**未跑部分绝不记为已跑**。
- **对照人肉基线**：片F 人肉 smoke 走同一桥产出 `.blender-work/e2e-evidence/` 6 张 e2e-*.png（镜1 两机位 / 镜2 mannequin 5-KF）+ 60 帧 turntable mp4——证明轮子本身能出真 previz；T4 模型得分差距（人肉真帧 vs 模型 0 调用）不在轮子能力，在**任务路由与确认闸门把 turn 引离了 3D 链**。

---

## 3. 双轨记分表

| 任务 | A 轨（完成度） | B 轨（轮子利用度） | 主扣分点 |
|---|---|---|---|
| T1 | 60 | 65 | 交付断点（产物滞留桥主机）；未用 blender_render |
| T2 | 92 | 75 | 唯一完整闭环；扣：正规工具死于部署漂移被迫旁路 |
| T3 | 45 | 70 | 动画几何死亡 0 取证帧（interrupted）；自审诚实加分 |
| T4 | 20 | 5 | 完全脱离 3D 链 + gpt-image-2 错路由 + question 挂起 |
| **均分** | **54** | **54** | **总分 54 < 60 → 需反馈回路** |

假成功检查结论：T1/T2 产物 PIL/差分全 REAL；T3 模型在宣称成功前自抓恒值动画（无假成功，诚实自审成立）；T4 假成功风险（2D 冒充 3D）被确认门拦截，未遂。

---

## 4. 三分法归因

**轮子设计（约占 55%）：**
1. 交付通路缺失：产物写桥主机 `$BLENDER_WORK/out/`，agent 沙箱零回传通路——`src/lib/blender-tools.ts` 产物 payload 只给路径无取回通道，`bridge/blender-bridge/server.py` 无 artifact HTTP 端点。
2. 部署漂移：`deploy-staging/blender-gateway/blender_tools.ts`（staging 稿）滞后真源 `src/lib/blender-tools.ts`（真源已含 makedirs + `out/` 结构），部署版 blender_render 首跑必死。
3. 共享桥实例无场景隔离：多任务并发互踩（T3「场景被其他任务重置」），`bridge/blender-bridge/server.py` 无 per-session 隔离或单飞锁。

**SKILL 缺陷（约占 25%）：**
1. `skills/blender-director/SKILL.md` 执行环境契约未覆盖：共享实例互踩警告、桥主机≠沙箱的产物取回语义、pose 逐骨刷新陷阱（T3 bug② 属 bpy 语义雷，配方库零记录）。
2. 任务路由缺防护栏：previz/3D 类委托单无「必须走 blender_* 三工具、禁止二维生成顶替」的硬规则，T4 被 harness 通用 quote_bundle→question 流程整个拐走。
3. question 卡无默认动作语义：无人值守跑批会在确认门前无限挂起（T4 挂死 15+ 分钟）。

**模型能力（约占 20%）：**
- 正面：T2 拓扑理解与工程自愈、T3 探针式自审与两真 bug 的代数定位——顶位模型的工程能力足以穿透轮子的部署级故障。
- 负面：T4 任务理解跑偏（previz≠2D 出图）且未先验工具清单就报价——但对「3D 工作站专属任务」缺防护栏时，通用流程的引力占上风，归因主要仍在上游。

---

## 5. 反馈回路建议清单（Top 3，带档案：位置）

1. **补产物回传通路 + 重同步部署稿（轮子）**
   - `src/lib/blender-tools.ts`：产物 payload 增加 agent 可达取回 URL（如桥 `GET /v1/artifact?path=` 返回文件字节，或 gateway 侧代理读桥 out/）；同步更新 `deploy-staging/blender-gateway/blender_tools.ts` 整份对齐真源（makedirs + out/ 已在真源）。
   - `deploy-staging/blender-gateway/PATCH-PLAN.md` §0 落位表补「产物回传」一行。
   - 预期：blender_render 首跑通过率 0→100%，T1 类交付断点根除。约 30 分钟。

2. **SKILL 增补执行环境铁律 5/6/7（SKILL 文案）**
   - `skills/blender-director/SKILL.md` 执行环境铁律节追加：⑤ 桥实例共享，开工前 `save_as` 快照、并发任务会互踩场景；⑥ 桥主机与 agent 沙箱不同机，产物路径仅桥本地有效，取回走工具产物字段；⑦ pose_bone.matrix 写入后必须逐骨刷新求值（父骨陈旧陷阱），装配修正矩阵乘序为 `basis @ w⁻¹ @ target`（T3 实弹结论直接入档）。
   - 预期：T3 类 API/语义雷从 Runtime 考古变配方直读。约 15 分钟。

3. **3D 任务路由防护栏 + question 默认动作（工具 schema / harness 提示词）**
   - `skills/blender-director/SKILL.md` 头部加硬规则：「委托单含 previz/3D 场景/机位/运镜/骨架 关键词时必须走本 SKILL 的 blender_* 三工具，禁止以 gpt-image-2 等二维生成顶替 3D previz」；harness 侧 AGENTS.md（VPS /opt/agent-harness/workspace/AGENTS.md）§3.8 报价节同步。
   - question 卡语义：确认卡必须携带「不回复则按方案继续」的默认动作或超时继续策略，否则跑批挂死。
   - 预期：T4 类零调用错路由根除，无人值守可推进。约 20 分钟。

其余候补（记档不派）：桥单飞锁（server.py）；部署稿生成脚本化（staging 稿从真源机械导出，杜绝手工漂移）；模型渠道首延迟治理（b-ai 90s+ 常态，建议主备轮换探测）。

---

## 6. 视觉证据索引

- `evidence/T1/tw_dusk_f0001.png` — 1600×900 REAL（var=1081）
- `evidence/T2/warehouse_dolly_0001..0010.png` — 10 帧全 REAL，首尾差分 76.8%
- `evidence/T3/blend-probe.txt` — 133 fcurves 恒值探针（动画几何死亡实锤）
- `evidence/T4/t4-storyboard-full.txt` — 分镜全文（含 gpt-image-2 预算单原话）
- `evidence/frames/` — t1/t2/t3 SSE 日志 + t3/t4 会话终态快照
- 人肉基线：`.blender-work/e2e-evidence/` e2e-*.png ×6 + `out/` e2e_tt_*.png/turntable.mp4

## 7. 判决

**罚俸整改（需反馈回路）**：双轨 54/100。整改靶心不在模型（T2/T3 已证其能力上限），在轮子的交付通路、部署纪律、任务路由三处断点。按第 5 节 Top 3 派工执行后复测，复测只需 2 任务（T2 完整闭环验证 + T4 路由验证），预计 40 分钟。
