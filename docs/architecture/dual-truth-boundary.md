# 双真相边界（W5）

> 2026-09-29 文件化。**本档只描述，不改码**——裁定来源＝`eimu-competition-report/Dramagic对称差-决策表-0928.md:63`：
> 「W5：DSL 只管 world1、world2 另一套真相 → **P2：双真相边界文件化**（写文件，不改码）」。
> 现场原话（`Eimu能力审视-工业化盘点-0928.md:81`）：「world2 执行图（模板＋素材注入＋成片）仍走后端原子铺
> ——两套真相并存，是设计取舍也是认知负担」。

## 0. 一句话

**画布图（world1）是运行时唯一真相；产线执行图（world2）是铺图的真相。**
两者在「SSE 事件把节点写进画布」这一条缝上相接：world2 的产物是节点，节点之后归 world1 管。

判准（拿这句话回答 90% 的问题）：**问「画布上有什么」→ world1；问「一次产线要跑几步、每步用什么模型／门禁／素材」→ world2。**

## 1. world1 ＝ 画布多步生产链

| 角色 | 权威位置 | 说明 |
|---|---|---|
| 契约真源 | `src/lib/canvas/types.ts` 的 `CanvasAgentOp` | 8 op：`add_node`／`update_node`／`delete_nodes`／`connect_nodes`／`delete_connections`／`select_nodes`／`set_viewport`／`run_generation`；2026-09-16（G1）加第 9 个 `set_project_meta`（专案级栏位补丁，唯一能改 `CanvasProject` 顶层的 agent 入口）；2026-10-03 加第 10 个 `revert_node`（节点版本回退＝人机共笔回滚面，执行端＝adapter agent_ops → reducer 既有 `revert_node`；闸道白名单另在 `deploy-staging/gateway/canvas-op-types.ts`） |
| 执行语义 | `src/lib/canvas/reducer.ts`、`src/lib/canvas/layout.ts` | **执行语义全在前端 reducer**（types.ts 注记）；`layout.ts` 另负责节点／metadata 的白名单清洗 |
| AI 的笔 | `src/lib/workflow-dsl/schema.ts` → `compile.ts` → `decompile.ts` | 暴君裁定 2026-09-02：**AI 不直接吐 `CanvasAgentOp`**，只吐 `WorkflowDslSource`，由 `compile.ts` 确定性编译成 op；`decompile.ts` 支援回读（round-trip 幂等）。**2026-10-03 读改回滚三件接通**：读面＝前端 `src/hooks/canvas/canvas-agent-snapshot.ts` 从全量 state 反推 `dsl`＋`node_versions` 塞快照（gateway `canvas-flow.compactCanvasState`／`canvas-state-summary.buildCanvasReceipt` 透传）；写面＝harness `deploy-staging/opencode-runtime/tools/workflow_write.ts`（站点 `/v1/workflow/compile` → `canvas_apply_ops` 通道）；回滚面＝`workflow_history`＋`workflow_rollback`（`revert_node` op） |
| agent 入场 | gateway 工具 `canvas_apply_ops` → SSE `canvas.ops` → `src/hooks/use-canvas-chat.ts` 的伫列（`canvas-agent-ops-queue.ts`）→ reducer | ops 一到即自动落 reducer（画布操作自动化）；`applyAgentOps` 仍负责 dispatch＋`postCanvasOpsResult` 回报，让工具调用拿到明确结果而非超时 |
| 失败语义 | `compile.ts` 的教学式报错、环路整份拒绝、`layout.ts` 逐栏白名单 | 非法值**省略该键**（＝不动该栏），不写预设值冒充用户设定 |

## 2. world2 ＝ 后端执行图（模板＋素材注入＋成片）

| 角色 | 权威位置 | 说明 |
|---|---|---|
| 模板真源 | **VPS** `/opt/agent-harness/gateway/workflow-templates/` | 13 模板、一个模板一个档（`single_image`／`character_sheet`／`scene_setup`／`single_video`／`feature_film`／`novel_film`／`novel_ip`／`ecom_launch`／`ecom_model`／`shortdrama_visual`／`shortdrama_poster`／`art_curation`／`art_style`）＋`index.ts`（共享注册）＋`types.ts`；节点 `kind` ∈ `text｜config｜image｜video｜audio｜film`，节点 `role` 是**模板内唯一键**，连线写 `{fromRole, toRole}` |
| 展开与执行 | **VPS** `gateway/workflow-engine.ts`／`workflow-service.ts`／`workflow-gw.ts` 的 `expandTemplate` | **活本在 VPS**（`/opt/agent-harness/gateway/`）。`src/` 内 grep `expandTemplate` 只会命中注释——但 repo **另有一份可跑的镜像**：`deploy-staging/gateway/`（见下） |
| repo 镜像 | `deploy-staging/gateway/`（含 `workflow-engine.ts` 与 `workflow-templates/`） | 这是**测试与建置用的第二份拷贝**：`src/lib/agent-output-cards.test.ts:29` 直接 `import { expandTemplate } from "../../deploy-staging/gateway/workflow-engine"` 跑真引擎（不重写它的 merge）。AGENTS.md 明记此目录「勿当真源」。**2026-09-29 实查**：15 个模板档（13 模板＋`index.ts`＋`types.ts`）与 VPS 逐档 md5 **全等**，VPS 另多一支 `workflow-templates.test.ts`（W6 常驻回归）⇒ 此刻两份一致，但**一致是状态、不是契约**（逐档 SFTP 部署、无递回同步 ⇒ 随时可漂） |
| 站点侧资料面 | `src/lib/agent-templates.ts`（`AgentPipelineStep`）、`recipe-templates.ts`、`scenario-templates.ts` | 是产线的**资料镜像与 UI 面**，不是执行引擎 |
| 铺图排版 | `src/components/canvas-workstation/agent-template-canvas.ts`（`pipelineToCanvasLayout`） | 模板 → 画布版面（节点位置／型别徽章），**只排版，不改产线语义** |
| 落图事件 | `canvas.plan`／`canvas.node.created`／`canvas.node.updated`（`src/lib/agent-chat-types.ts`、`src/lib/canvas/reducer.ts`） | 「首讯 8 秒建骨架」就是这条：模板展开后节点以事件落进画布，之后归 world1 |

## 3. 边界（哪一格归谁）

| 问题 | 归属 |
|---|---|
| 画布上有哪些节点／连线／选中／视窗 | world1（reducer） |
| 一次生成要跑几步、每步的模型／门禁／素材注入／成片合成 | world2（gateway 模板＋engine） |
| 产物（图／影片／音讯／音乐）本身 | 生成平面（`/api/generation-jobs`＋artifact），两边都只是**引用**它的节点 metadata |
| 专案级栏位（作品类型／剧集／风格绑定…） | world1 的 `CanvasProject` 顶层；agent 唯一写入口＝`set_project_meta` |

## 4. 为什么这是取舍，不是缺陷

- **好处**：两边可各自演进——产线可只动模板档（VPS 逐档部署、`index.ts` 单独一趟注册），画布 DSL 可只动前端编译器。多数改动**只需落在其中一边**。
- **代价**：同一个「步骤」在两边各表达一次（模板档的节点 ↔ 画布节点），两者的节点 metadata 靠**双白名单**同步；漏一处＝键**静默消失**（实例见 `mem show 2026-09-24-ws10-emits-entity-whitelist-strip-fix.md`：`emitsEntity` 被白名单剥除，自动落卡链整条失效）。
- **代价二（世界2 自己有两份）**：产线的活本在 VPS `/opt/agent-harness/gateway/`，repo 另有一份 `deploy-staging/gateway/` 供测试直接跑真 `expandTemplate`。两份靠**逐档 SFTP**（`.gateway-work/sftp-put-443.js`，无递回同步）维持一致，2026-09-29 实查 15 档 md5 全等——但「一致」只是当下状态，改模板时**两份都要动**，否则测试验的是旧真相、线上跑的是新真相。
- **代价三**：只读站点 repo 会误判「这功能没实作」。查产线**实际行为**必须上 VPS 看 `gateway/`；站点侧的 `agent-templates.ts` 只是资料面。

## 5. 铁律（改动前先读本节）

1. 要改「画布上有什么」⇒ **只动 world1**：`CanvasAgentOp` 契约 → `reducer.ts` → `layout.ts` 清洗 → 前端。禁把产线图硬编进 DSL。
2. 要改「产线怎么跑」⇒ **VPS 模板档＋engine 与 repo 镜像 `deploy-staging/gateway/` 两份同批改**；部署走逐档 SFTP（无递回同步），改完比对 md5。禁在别的目录另抄第三份 `expandTemplate`。
3. 节点 metadata 出现新键 ⇒ **双白名单同批改**（漏一处＝静默丢键）：
   `src/lib/canvas/node-metadata-fields.ts`（`DURABLE_METADATA_FIELDS` / `AGENT_METADATA_FIELDS`）
   ＋ `src/lib/canvas/layout.ts`（`DURABLE_FIELD_CLEANERS`）
   ＋ `src/hooks/canvas/canvas-chat-types.ts`（`applyAgentFieldTransform`）
   ＋ 对应测试样本。
4. `CanvasProject` 出现新栏位 ⇒ 逐栏白名单**七处同批**（先例：2026-09-15 的 `projectType`／`currentStep`／`episodes`）：
   型别（`types.ts`）→ `normalizeProject`（`project-store.ts`）→ `CanvasProjectMetaPatch`（`types.ts`）→ `canvasProjectMeta` 与 `normalizeProjectMetaPatch`（`layout.ts`）→ 专案 PUT 透传（`src/app/api/canvas/projects/route.ts`）→ hook 的 `setProjectMeta` 与还原点（`src/hooks/use-canvas-chat.ts`）→ 汇出／汇入。
5. 事故判准：**当同一个事实需要在两个地方各写一次，先问它属于哪一边，再写**——写在两边就是下一次漂移的起点。

## 6. 复核用命令

```bash
# world1 契约与执行语义
grep -n "export type CanvasAgentOp" -A 20 src/lib/canvas/types.ts
grep -n "export function compileWorkflowDsl\|环路\|教学" -A 5 src/lib/workflow-dsl/compile.ts

# world2：活本在 VPS，镜像在 repo（2026-09-29 实查 md5 全等；仅 VPS 多一支回归测试）
ls /opt/agent-harness/gateway/workflow-templates/
ssh -i ~/.ssh/new.pem -p 22443 ubuntu@43.172.85.76 \
  "cd /opt/agent-harness/gateway && find workflow-templates -name '*.ts' | sort | xargs md5sum"
cd deploy-staging/gateway && find workflow-templates -name '*.ts' | sort | xargs md5sum   # 逐档比对

# 双白名单三处
grep -rn "DURABLE_METADATA_FIELDS\|AGENT_METADATA_FIELDS" src/lib/canvas/node-metadata-fields.ts
grep -rn "DURABLE_FIELD_CLEANERS" src/lib/canvas/layout.ts
grep -rn "applyAgentFieldTransform" src/hooks/canvas/canvas-chat-types.ts
```
