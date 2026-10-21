# 3D 导演台接入 Spec（方向 A：服务端预渲染 SVG + 全屏按需 three.js）

> 2026-09-02 成稿。暴君裁定：方向 A（小卡显示服务端预渲染 SVG 示意，three.js 只在二期全屏路由载入）。
> 轮子真源：`/home/lenovo/Desktop/kunpeng-vendor`（commit 872a58b，MIT）。

## 0. 端状态（一句话）

AI 助理在聊天中调用 `director_*` 工具规划分镜 → 用户即时在聊天小卡与画布小卡看到白模预演 SVG 示意图与镜头/动作参数 → 数据落 VPS 会话文档存储 → 二期新分页全屏 three.js 导演台。

## 1. 轮子现状清点（vendor 实测，PRD 过时声明）

`docs/kunpeng-bridge-prd.md` 包 C 写 15 工具/27 运镜/57 动作；**vendor 实测已是 16 工具/28 运镜/58 动作/12 姿势**，以现场为准：

- `src/lib/director/types.ts`（264 行，纯）：v2 序列化 schema 全集（DirectorSceneFile/DirectorPlan/DirectorSequenceShot/DirectorActionClip/元素四型/28 CameraMove/58 ActionId/ASPECT_RATIOS）
- `src/lib/director/playback.ts`（302 行，纯）：`evaluateDirectorFrame`/`inspectDirectorPlan`（越轴/入地/碰撞健康检查）/`planDuration`/`shotAtTime`/`animatedJoints`；type-only 依赖 engine 的 `CameraPose`
- `src/lib/director/poses.ts`（81 行，纯）：12 姿势 + JOINT_SLIDERS
- `src/lib/director/pathCurve.ts`（96 行，纯）：cubicBezier/sampleMotionPath/smoothPathFrame
- `src/lib/director/cameraTemplates.ts`（111 行，纯）：28 运镜模板 + `createCameraKeyframes`/`cameraPatchFromTemplate`
- `src/lib/director/motionTemplates.ts`（78 行，纯）：58 动作模板 + `createMotionKeyframes`
- `src/lib/director/presetCameras.ts`（70 行，纯）：预设机位；type-only 依赖 `@/lib/canvas/cameraPresets`
- `src/lib/director/shotDescription.ts`（94 行，纯）：**NDC pinhole 投影数学**（camDir/right/camUp 基、zDepth 深度三分类前景/中景/背景、九宫格位置、朝向判定）——方向 A SVG 渲染的数学真源
- `src/lib/director/agentPlanning.ts`（524 行，混合）：纯核 `parseJson/alignRawPlanToPrompt/ensurePlanActions/buildPlans/fallbackPlans/preserveLockedEdits/inferPromptActions*`；`quickChat`（Tauri LLM）不搬
- `src/lib/agent/tools/directorTools.ts`（857 行）：16 个 `director_*` 工具，schema + 两段式确认守卫照搬，zustand 存取改 GATEWAY loopback
- `stores/directorStore.ts`（698 行）：~20 个 mutation（含 normalizeShotTimes/upgradePlanKeyframes/undo-redo JSON 快照）改写为纯文档操作
- **不搬**：engine.ts/mannequin.ts/export.ts/DirectorStage.tsx/DirectorChatPanel.tsx/runtimeControl.ts（二期 C6）

隐式依赖：`nanoid`（vendor 未声明，实际 3.3.11）——image-app 必须显式安装。

## 2. 架构（方向 A 分层）

```
agent LLM ──调用──> director_* 工具 ×16（VPS /opt/agent-harness/workspace/.opencode/tools/）
                        │ loopback HTTP（timeline_* 同款：resolveKey Bearer + ok()/fail()）
                        ▼
        gateway/director.ts（VPS /opt/agent-harness/gateway/，本地镜像 src/vendor-bridges/gateway/director.ts）
          ├─ 文档存储 $WORKSPACE_DIR/director/<sid>/project.json + versions/ + log.jsonl（timeline.ts 同款：last 20 + 每第 10 个里程碑）
          ├─ ~20 个纯文档操作（directorStore mutation → JSON 操作）
          ├─ SVG 示意渲染（svgSchematic.ts：shotDescription 投影数学 → 俯视图 + 镜头框图）
          └─ emitToSession("director.done", …) ＋ canvas.node.created/updated（autoCreateCanvasUnit 同款拦截）
                        │ SSE
                        ▼
        聊天小卡 AgentDirectorCard ＋ 画布 Director 节点卡（同一事件双消费）
```

## 3. gateway HTTP 路由契约（钉死，片4/片5 据此并行）

挂进 gateway index.ts 既有 handler（继承 `resolveSession` 会话鉴权，timeline 路由同款）：

| 路由 | 方法 | 入参 | 出参 |
|---|---|---|---|
| `/agent/v1/director/:sid/state` | GET | — | `{ok, project: DirectorSceneFile, active_plan_id, active_shot_id, health}` |
| `/agent/v1/director/:sid/op` | POST | `{op, …payload}`（文档操作联合，见 §4） | `{ok, project, revision}`；副作用：重算 SVG → emit `director.done` |
| `/agent/v1/director/:sid/proposals` | POST | `{instruction}` | `{ok, proposal_ids[], plans[]}`（每案带 `requires_user_confirmation: true`） |
| `/agent/v1/director/:sid/apply_proposal` | POST | `{proposal_id}` | 无确认记录 → `{ok:false}`（守卫照搬）；成功 → replacePlans + emit |
| `/agent/v1/director/:sid/schematic` | GET | `?plan=&shot=` | `{ok, top_view_svg, camera_view_svg}` |
| `/agent/v1/director/:sid/reset` | POST | — | 清空会话导演工程 |

工具侧错误形状统一 `fail(code, human_message)`；store 未初始化（未 manage_plan 建 project）→ `fail("director_not_initialized", …)`。

## 4. SSE `director.done` 事件契约（钉死）

```ts
{
  session_id: string;
  revision: number;              // project.json 版本号，单调递增
  action: string;                // 触发本次变更的操作名（director_upsert_action 等）
  plan: { id; name; summary; shot_count } | null;
  active_shot: { no; name; duration_frames; camera_move; shot_scale } | null;
  schematic: {
    top_view_svg: string;        // <svg …> 俯视图，≤32KB
    camera_view_svg: string;     // <svg …> 镜头框图，≤32KB
  };
  health: { ok: boolean; issues: Array<{ code; message; shot_id? }> };
  counts: { shots; elements; actions };
}
```

canvas 侧：每次变更后 gateway 同步发 `canvas.node.created`（首次）/ `canvas.node.updated`，`node.type: "director"`，`metadata: { pipelineCard: "director", directorSessionId, planName, shotCount, healthOk, topViewSvg, cameraViewSvg }`。SVG 合计 >48KB 时 canvas metadata 省略 SVG（前端卡改走 Vercel 代理抓示意图），`director.done` 内的 SVG 不省。

## 5. 分片派工

### 片1+片2 纯函数层移植 + SVG 渲染器（合并一片派遣；片2 import 片1 产物，不可并行）【预期 100 分钟，2x 杀线】

**轮子复制**（逐行 cp，禁精简复制）：

| 源（kunpeng-vendor/src/lib/director/） | 复制到（image-app/src/vendor-bridges/director/） |
|---|---|
| types.ts (264) | types.ts ＋白名单：`CameraPose`、`ElementSnapshotForDesc` 从 engine.ts 移入 |
| playback.ts (302) | playback.ts（import 改 ./types） |
| poses.ts (81) / pathCurve.ts (96) | 原样 |
| cameraTemplates.ts (111) / motionTemplates.ts (78) | 原样（nanoid 依赖） |
| presetCameras.ts (70) | 原样＋cameraPresets type-only 依赖处理（见白名单） |
| shotDescription.ts (94) | 原样＋拆 engine type-only import |
| agentPlanning.ts (524) | planning-core.ts：只搬纯核（§1 清单），quickChat 不搬 |

**白名单全量**：①CameraPose/ElementSnapshotForDesc 移入 types.ts ②import 路径修正 ③presetCameras/shotDescription 的 `@/lib/canvas/cameraPresets` type-only 依赖→读 vendor 源档，将所需类型 verbatim 复制进本目录 cameraPresets.ts ④agentPlanning 拆纯核（LLM 呼叫点切除）。**除此之外一行不许动**——每档 cp 后跑 `diff`，delta 超出白名单即返工。

**新胶水（非轮子，标注清楚）**：`svgSchematic.ts`——`renderTopViewSvg(plan, elements, shot)`（俯视：元素框+sampleMotionPath 路径贝塞尔+摄影机位置与视野扇形）与 `renderCameraViewSvg(...)`（shotDescription.ts 投影数学逐行取用：NDC→viewport、深度三分类上色、画家算法 zDepth 降幂）；输出 `<svg>` 字串 ≤32KB；白模线框美学（深底白线）。附注：此档为新写代码，投影数学的轮子锚是 shotDescription.ts。

**依赖**：`npm install nanoid@^3`（显式钉）。

**测试**（node:test 惯例，`src/vendor-bridges/director/director-wheel.test.ts`，跑法 `npx tsx --test src/vendor-bridges/director/director-wheel.test.ts`）：CAMERA_TEMPLATES=28 且逐一 createCameraKeyframes 非空；MOTION_TEMPLATES=58 且逐一 createMotionKeyframes 非空；POSE_PRESETS=12；fixture plan（追逐戏：2 mannequin + walk/run 动作）跑 planDuration/shotAtTime/evaluateDirectorFrame(t=0/中/末)；inspectDirectorPlan 对缺陷 plan 至少报一项；fallbackPlans/inferPromptActions 对中文 prompt 产案；describeShot 非空；renderTopViewSvg/renderCameraViewSvg 输出含 `<svg` 且 ≤32KB 且 XML 可解析。

**验证闸**：测试全绿；`npx tsc --noEmit` 对 director 档零新错（repo 有既有脏改动，先取 baseline 再比对）。**禁 git commit**。

### 片3 gateway director 模组【预期 90 分钟，2x 杀线】

本地写 `src/vendor-bridges/gateway/director.ts`（VPS 真源镜像，timeline.ts L29-34/L650-709 文档存储范式）：会话锁 withSessionLock、版本保留（last 20 + 每第 10 个里程碑）、log.jsonl、§3 路由全部实现、§4 事件发射（emitToSession + canvas.node 拦截）、svgSchematic 渲染调用、~20 文档操作（directorStore mutation 语义逐一等价，含 normalizeShotTimes/undo-redo 快照）。路由挂进 VPS gateway/index.ts（root:root → /tmp + python 锚点补丁 + mv 回，锚点前先 grep -n）。部署：sftp-put-443.js（验 MATCH）→ `sudo systemctl restart agent-gateway` → journalctl 零错 → curl 实弹 §3 每条路由（原生形状，非工具规格化形状）。

### 片4 agent 工具 16 档【预期 90 分钟，2x 杀线】

16 档 `src/vendor-bridges/opencode-tools/director_*.ts` 本地镜像（VPS 落位在片3 完成后）：`director_get_state/transport/select/update_element/create_element/upsert_action/set_motion_keyframe/set_camera_keyframe/manage_shot/manage_plan/project_control/set_lock/delete/prepare_export/propose_plans/apply_proposal`。schema 逐字段照搬 directorTools.ts；存取层白名单：zustand→GATEWAY loopback fetch（session_id 入 query，resolveKey(context.sessionID, context.abort) Bearer，ok()/fail() 形状）。守卫照搬：propose_plans 附 `requires_user_confirmation`；apply_proposal 无确认拒绝；prepare_export 只开工作区「不会开始导出」。本地 `harness-tool-registry.ts` HARNESS_TOOL_ID_LIST 加 16 id + 日期注释（惯例照 L60-67）。片3 部署完成后落 VPS：/tmp + `sudo install -m 644` → **`sudo systemctl restart opencode-server`（新增工具必做）** → `/experimental/tool/ids` 验 16 id + 实弹 call part（转录出现工具名 = 假阳性）。

### 片5 前端双轨小卡【预期 90 分钟，2x 杀线】

①`src/lib/agent-chat-types.ts`：AGENT_EVENT_NAMES（L36-68）加 `director.done` + payload interface + parseAgentSseEvent case；②`src/lib/agent-chat-reducer.ts`：`AgentDirectorItem`（会话内唯一活卡，revision 新者替换旧者，不堆积）；③`src/components/agent-chat/AgentTranscript.tsx` 加 case → 新组件 `AgentDirectorCard.tsx`：SVG 用 `data:image/svg+xml;base64` img（免 dangerouslySetInnerHTML）+ 方案名/镜头数/健康徽章 + 「全屏开启（即将上线）」disabled 钮；④画布：`CanvasNodeType` 加 `director` + TYPE_LABEL + CANVAS_NODE_DEFAULT_SIZE + NodeBody case + CanvasNodeView typeBadge（既有惯例照抄，SVG 消费 metadata）；⑤Vercel 代理 `src/app/api/agent/sessions/[id]/director/route.ts`（GET/POST → callAgentGateway，512KB 上限同 canvas-state 惯例，二期全屏用）。验证：`npm run build` 零错 + director 相关 tsc 干净。

## 6. 标准操作配方（贴进每个 subagent spec，不许现场考古）

- SSH：`bash .pixai-refresh/start-ssh443.sh` → `node .dsh-ssh/exec-443.js "<cmd>"`；备援 `ssh -i ~/.ssh/new.pem -p 22443 ubuntu@43.172.85.76`
- 传档：`node .gateway-work/sftp-put-443.js <local> <remote>`（内建 md5 验 MATCH）；或 `scp -S "$SSH_BIN" -i ~/.ssh/new.pem -P 22443 <local> ubuntu@43.172.85.76:/tmp/`（SSH_BIN=/var/lib/flatpak/runtime/org.freedesktop.Platform/x86_64/25.08/*/files/bin/scp；漏 -S 必失败）
- root 档安装：scp 到 /tmp → `sudo install -m 644 /tmp/<f> /opt/agent-harness/…/<f>`
- 重启：`sudo -n systemctl restart opencode-server agent-gateway`；验 `systemctl is-active` + `journalctl -u agent-gateway -n 20 --no-pager`
- gateway index.ts 编辑前先 `grep -n` 锚点行（VPS 源常比本地 HEAD 新）；改前备份 `cp .env .env.bak-*` 惯例适用于所有 VPS 修改

## 7. 必读记忆节（每个 subagent spec 必含）

1. `/home/lenovo/.codex/memories/extensions/ad_hoc/notes/memory_summary.md`（总索引）
2. `/home/lenovo/.zcode/cli/memories/projects/image-app-63c110217f682752/memory/no-reinvention-copy-verbatim.md` — 禁精简复制：wheel 每个函数/枚举/常量逐行保留，砍一行=埋雷
3. `/home/lenovo/.zcode/cli/memories/projects/image-app-63c110217f682752/memory/prd-spec-wheel-anchor.md` — 轮子钉源档判定法
4. `/home/lenovo/.codex/memories/extensions/ad_hoc/notes/timeline-post-production-buildout-0831.md` — gateway 工具部署配方真源（scp -S / sudo install / 双重启 / /experimental/tool/ids 验证）
5. `/home/lenovo/.zcode/cli/memories/projects/image-app-63c110217f682752/memory/agent-gateway-copy-rules.md` — VPS 工具文案一律简体；root 档 sudo+重启生效
6. 冲突指令：记忆与现场证据冲突时以现场为准并回报冲突。
7. 片1+2 已知遗留（2026-09-02）：vendor `ACTION_KEYWORDS` 词表全简体，繁体 prompt 会静默零动作（inferPromptActions 返回空）——片3/4 工具文案用简体，二期 quickChat 前加简繁正规化。

## 8. 验证闸门（总）

- 片1+2：测试全绿 + tsc 对新档零错
- 片3：VPS curl §3 全路由实弹 + 版本档案落盘 ls 验证 + journalctl 零错
- 片4：`/experimental/tool/ids` 含 16 id + 实弹 `"tool":"director_get_state"` call part
- 片5：`npm run build` 零错
- E2E：真实会话 agent 建方案 → SSE `director.done` → 聊天小卡 + 画布卡同现 SVG
- 暴君总验收：www.eimu.dev 对话「规划一个雨夜追逐戏分镜」目视两卡——视觉结果 pending 暴君

## 9. 二期留桩（2026-09-03 暴君裁定升级为施工队列）

方向 A 一期上线后，暴君视觉复测裁定「SVG 工程图不合格，要 3D 建模和打光」→ 拍板**前端 three.js 小卡**（C6 引擎层提前）。二期队列（自主渐进完成）：

| 波次 | 片 | 内容 | 档案域 | 量级 |
|---|---|---|---|---|
| 1 | 片B | three.js 小卡：engine.ts/mannequin.ts 逐行移植（白名单：Tauri convertFileSrc→URL、import 路径）+ DirectorMiniViewport 新胶水（动态 import/ResizeObserver/播放循环照 export.ts 轮子用法/WebGL 降级 SVG fallback/context 伫列≤2）+ 聊天/画布双卡接线 + CanvasNodeView director 状态徽章隐藏 | vendor-bridges/director/{engine,mannequin}.ts、components/director-mini/、AgentDirectorCard.tsx、NodeBody.tsx、CanvasNodeView.tsx、package.json(three@^0.184) | ~120 分 |
| 1 | 模板接入 | agent-templates.ts novel_film/shortdrama 两线「锁定分镜」→「渲染关键帧」之间插「3D 白模预演」步骤（outputKind "director"→CanvasNodeType.Director，GEN_NODE_TYPE+kindToNodeType+STEP_KINDS+requiredTools director_*+directive 一行）+ 测试 | agent-templates.ts、agent-template-canvas.ts、workflow-dsl/{schema,compile}.ts、测试 | ~半天 |
| 1 | 简繁正规化 | planning-core.ts ACTION_KEYWORDS 加繁体变体（加法白名单，档头声明）+ 繁体 prompt 测试 | planning-core.ts + 测试 | ~30 分 |
| 2 | C6 全屏 | `/director` 路由：zustand store + DirectorStage.tsx 2625 行 Tauri→web + DirectorChatPanel；数据走既有 Vercel 代理路由 | app/director/、stores、components/director/ | 2-3 周 |
| 2 | C4 生成闭环 | finalRender 白模 ref#1 → 我方生图渠道 + confirm 门禁 + 写回画布；previs 视频导出 | gateway+finalRender+export 白名单移植 | ~1 周 |
| 2 | LLM 方案 | planning-core LLM 呼叫点接 LLM（vendor quickChat 对应物），替换启发式 fallback 的创意上限 | planning-core + gateway | ~1 天 |

## 10. 原二期备忘（历史）

C4 生成闭环（finalRender 白模 ref#1 → 我方生图渠道）、C6 全屏 `/director` 路由（three@^0.184 + zustand@^4.5 显式安装；DirectorStage.tsx 2625 行 Tauri→web 白名单改写：工程 JSON 读写走片5 的 Vercel 代理路由；禁精简复制——gizmo/键盘/时间轴/健康徽章全保留）。片5 代理路由与 director.done payload 已为此预留。
