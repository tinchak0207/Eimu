# AI 自主后期全包 —— 施工拆片方案（Timeline Post-Production）

日期：2026-08-31｜裁定：暴君「能用的轮子全部用上，所有 REQ 尽量达成，语义层妥协项除外，逐片派 subagent 避免上下文污染」
需求源：《Eimu 创作 Agent · 剪辑体验需求文档 v1.0》（REQ-EDIT-01..08）
轮子源：`/home/lenovo/Desktop/kunpeng-vendor` @ pin **872a58b**（`src/lib/editor/` 8,795 行 + `src/lib/agent/tools/timelineTools.ts` 69 工具 3,997 行 + `src/stores/editorStore.ts` 1,317 行）

## 0. 现状基线（实查，非记忆）

- Kunpeng 桥接片 0-6 **全部完成上线**：VPS `/opt/agent-harness/gateway/editor/` 已挂载，`assembleFilmNode`（gateway/index.ts L1463）真跑成片（08-30 夜 E2E：final.mp4 18.58s 含 AAC 音轨）。
- 已入库轮子（gateway/editor/ 与 image-app src/vendor-bridges/editor/ 同构）：composeEngine.ts、renderGraph.ts、adapter/{editorStore,tauri-adapter,fxRenderStub,artifactsStub}.ts、canvas/videoCompose.ts、aspect.ts、presets/{filterPresets,transitionPresets}.ts、subtitleExport.ts、renderBackends.ts。
- composeEngine 内建：`loudnorm=I=-16:TP=-1.5:LRA=11`、per-clip volume/afade/adelay/amix、xfade 转场、ASS 字幕。**无 ducking（仅静态 volume）、无版本持久化、无时间线 HTTP 面**。
- 白名单记账：`vendor/kunpeng/PATCHES.md`（改轮子必记，供 vendor 升级双向 diff）。

## 1. 架构决策（定死，subagent 不得改）

1. **时间线真源 = gateway 侧 per-session JSON store**：新档 `/opt/agent-harness/gateway/timeline.ts`，与 composeEngine 同进程（setHarnessState 零跳）。存档路径 `$WORKSPACE_DIR/timelines/<session_id>.json`。
2. **Agent 工具面 = VPS `/opt/agent-harness/workspace/.opencode/tools/timeline_*.ts`**：复制现有 `workflow_connect.ts` 轮子模式（站内 HTTP + agentFetch 鉴权头）；**Bun Request body 只能读一次 → session_id 走 query**。
3. **端点族 = `/agent/v1/timeline/*`**（gateway 新增路由，镜像既有 `/agent/v1/tts` 模式）。
4. **轮子纪律**：类型/算法逐行 cp，import 行与注入面白名单改写，偏差进 PATCHES.md。替身（B 类）同签名诚实抛错。
5. **妥协清单（暴君已批准，实作遇之诚实 unsupported，不硬造）**：
   - 情绪曲线硬指标 → 接受 agent 标注的 `emotionTag` 序列作软输入，缺失降级时长/密度分析
   - 越轴/动作连续性/光不一致/角色脸一致性语义 lint → unsupported（研究问题）
   - 运动追踪特效 → 降级为静态/关键帧定位叠层
   - 口型同步 → 不属剪辑层，不做
   - fxComponents（Chromium 花字农场）→ 不做，风格走 ffmpeg 原生子集
   - 音乐/SFX 素材源 → 接受 URL 输入，不建音乐库（PRD 自标非目标）
   - 帧级精度 → 秒级浮点（与轮子 EditorClip 一致）

## 2. 拆片表（串行派发，并发=1；每片档案所有权零交集）

| 片 | REQ | 内容 | 轮子源（kunpeng-vendor） | 目标档（所有权） | 时间预算 |
|---|---|---|---|---|---|
| **B1** | 01+05 | 时间线资料对象+ops+版本+决策日志+HTTP 端点 | `src/stores/editorStore.ts` 型别块（EditorClip L54/AudioClip/SubtitleCue/OverlayClip 逐行）；`src/lib/editor/editorHistory.ts` 快照模式；`timelineTools.ts` ops 语义对照 | VPS `gateway/timeline.ts`（新）+ `gateway/index.ts`（挂路由小 diff） | 90min |
| **B2** | 04 | opencode 工具族：timeline_ops/query/versions（9 类指令：插入/删除/移动/拆分/修剪/变速/锁定/分组/改序 + 查询 + 回读 diff + 锁定拦截） | `timelineTools.ts` 对应工具的参数 schema 与返回形态 | VPS `.opencode/tools/timeline_ops.ts`、`timeline_query.ts`、`timeline_versions.ts`（全新档） | 60min |
| **B3** | 02 | 节奏计算器：analyze_rhythm → curve+flags+climax（规则版：avg_shot_len/dialog_ratio/density/鼓点） | `src/lib/editor/waveform.ts`（PCM 峰值）+ `beatDetect.ts`（能量包络踩点）逐行；transcriptOps 密度口径对照 | VPS `gateway/rhythm.ts`（新）+ `.opencode/tools/timeline_rhythm.ts`（新） | 90min |
| **B4** | 03 | 信号层 linter：黑帧/白闪/爆音/静音段/音量跳变/音画时长错位（ffmpeg blackdetect·freezedetect·astats·silencedetect）；must/should 分级；语义层诚实跳过 | `speechAudit/audio.ts` 停顿检测降级版（silencedetect 路径）；其余 ffmpeg 命令新写 | VPS `gateway/lint.ts`（新）+ `.opencode/tools/timeline_lint.ts`（新） | 90min |
| **B5** | 06 | 混音增强：三轨（voice/bgm/sfx）+ **ducking（sidechaincompress 后置 pass，不动 composeEngine 主钉）** + 响度报告 | `composeEngine.ts` 音频图口径对照（不 import 改动）；ffmpeg sidechain 命令 | VPS `gateway/mix.ts`（新）+ `.opencode/tools/timeline_mix.ts`（新） | 60min |
| **B7** | 08 | 风格货架 ffmpeg 子集：apply_style（filterPresets→clip.filter 四滑杆）、转场（transitionPresets 已在库）、字卡（subtitleExport/ASS）；fx/追踪 unsupported | `presets/filterPresets.ts`（已入库）、`presets/textTemplates.ts` 子集 | VPS `gateway/style.ts`（新）+ `.opencode/tools/timeline_style.ts`（新） | 60min |
| **B6** | 07 | 母带检查+导出闸：check(timeline)=时长/解析度/画幅+聚合 B4 lint+B5 响度；must 未清拒导；预设 竖9:16/横16:9/影院2.39:1/封面帧；交付物=URL+报告+版本号+小结栏位 | `composeEngine.ts` `probeRenderedVideo`（已在库）+ `EXPORT_RESOLUTIONS`（已在库） | VPS `gateway/master.ts`（新）+ `.opencode/tools/timeline_master.ts`（新） | 60min |

依赖：B1 → B2 →（B3→B4→B5→B7 串行）→ B6（聚合 B4/B5 结果，最后上）。

## 3. 验收总门（全片完成后）

端到端：agent 在真实 session 用语言完成「建时间线→剪→节奏报告→lint→混音→风格→母带检查→导出」，产物 ffprobe 实测（时长/解析度/响度），版本 diff/restore 可用，决策日志含成本。构造样本（黑帧/爆音片段）must 级检出 100%。

## 4. 部署配方（每片通用，写进 spec）

- 传档：`scp -S "$SSH_BIN" -i /home/lenovo/.ssh/new.pem -P 22443 <本地> ubuntu@43.172.85.76:<远端>`（本机 ssh 用 flatpak 路径 `/var/lib/flatpak/runtime/org.freedesktop.Platform/x86_64/25.08/*/files/bin/ssh|scp`；**scp 必带 `-S $SSH_BIN`**，否则内部 exec `/usr/bin/ssh` 不存在直接失败——0831 B1 实测坑）
- **gateway/index.ts 是 root:root 644**（目录 ubuntu 拥有）：改法＝`cp` 到 /tmp → python 锚点插入 → `mv` 覆盖回原位（rename 只需目录写权）；直接 in-place 写会 PermissionError（0831 B1 实测坑）
- gateway 改动生效：`sudo systemctl restart agent-gateway`；验 `systemctl is-active` + `journalctl -u agent-gateway -n 20 --no-pager` 零错
- opencode 工具新增生效：**必重启 opencode-server**（既有记忆坑）
- 捡核对：改 gateway/index.ts 前先 `grep -n` 锚点行号，VPS 真源比本地 HEAD 新，单向回灌会冲掉修复
- **`.opencode/tools/` 目录 root:root**：scp 直上 Permission denied → `scp` 到 /tmp 再 `sudo install -m 644 <tmp> <dst>`（0831 B2 实测坑）
- **session_id 契约（0831 B2 卡点+B1 修复，后续片必知）**：opencode 工具的 `context.sessionID` 是 **opencode id**（`ses_…`），非 gateway UUID。`handleTimelineRoutes` 已改用 `resolveSession(sid)` 三段解析 + `state.apiKey !== key` 校验 + 收拢 `sid = state.sessionId`（镜像 `canvasKeyFor` 原则）。**后续 B3-B7 新端点一律挂进 `handleTimelineRoutes` 内部**（继承鉴权与 id 收拢），别另起炉灶。gateway↔opencode id 映射可查 `sessions.db` 表 `sessions(id, owner_key, opencode_session_id)`
- 工具面 op 形态映射：agent 发 `{op, clip_id, clip_ids, to_index}`，工具内 `normalizeOp` 转 gateway 原生 `{type, clipId, clipIds, toIndex}`——端点直打冒烟时要发原生形态，勿误打工具形态（0831 B2 实测坑）

## 5. 派工纪律

- 每片 spec 开头「预期 N 分钟」，超 2x orchestrator TaskStop 接管
- 同一错误重试 2 次未过 → 停，回报事实
- secret 不落 log/commit；验收要 ffprobe/curl 实证，HTTP 200 ≠ 可用

## 6. 外部高 star 轮子调研结论（08-31 暴君纠偏后补扫，GitHub API 实查）

| 仓库 | 星数/授权 | 对照结论 |
|---|---|---|
| OpenCut-app/OpenCut | 88k/MIT 活跃 | UI 轮子（CapCut 替代），P1 明确不做 UI；且会造成第二套时间线真源打架 → **不引入** |
| remotion-dev/remotion | 57.8k/NOASSERTION 活跃 | React 程序化视频=字卡/花字动画正解路线（补 fxComponents Chromium 缺口）；授权对商业有约束+VPS 2 核算力 → **增强片 B9 候选（记档不落地）** |
| WyattBlue/auto-editor | 5.1k/Unlicense 活跃 | 自动剪静音/dead space 成熟决策器，可 `--export` 时间线 XML 不渲染 → **增强片 B8：dead_air 自动修复**（B4 检出→auto-editor 出切割点→timeline_ops 落地），主链闭环后做 |
| adefossez/demucs | 3.1k/MIT | 音源分离 4 轨/`--two-stems=vocals`——成品素材侧链分离的杀手锏；VPS 2 核 4G RAM 推理吃紧 → **增强片 B10 候选** |
| soCzech/TransNetV2 | 1k/MIT 2023 停更 | 镜头边界 AI 检测；无 GPU 环境 → 记档不落地 |
| LUT 集合库 | 搜索无高 star 干净库 | B7 风格库走 ffmpeg 内建 eq/curves/colorbalance + filterPresets 手调曲线（kunpeng 原路），LUT 文件后续人工收集 |

**纪律**：B1-B5 已闭环上线不重做（接续攻坚）；增强片 B8/B9/B10 排在 B6/B7 之后，暴君点名才派。

## 7. 全役完结（2026-08-31 凌晨）

**B1-B7 七片全部上线闭环，PRD 8 REQ 对账达成**（语义层五项 lint + fxComponents 花字 + 口型同步 = 诚实 unsupported，见 §4 妥协清单）。

- 工具面 8 个：`timeline_query / ops / lint / rhythm / mix / style / restore / master`
- 端点族：`/agent/v1/timeline/*`（ops/get/versions/restore/lint/rhythm/mix/style/style/subtitles.ass/master check+export）
- 终验：B5 mix 13/13、B7 style 14/14、B6 master 14/14（含负向闸：声明>源实测 → av_mismatch must → export 400）+ 三片真 agent E2E 自主调用成功；六档 md5 本地/VPS 一致
- 派工事故：subagent 三连死 "Model request failed"（配额）→ B5/B6/B7 内联接管完成
- 关键坑沉淀：ffmpeg filtergraph（link label 带冒号=stream specifier／label 单次消费 asplit／-map 逐输出）、ebur128 只解析 lastIndexOf("Summary:") 后、duck 基准窗扫无人声区、视频链禁 apad（→trim=duration）、**opencode 工具新增必 restart opencode-server**（transcript 含工具名 = 假阳性，真判据 = `"tool":"<名>"` 调用 part）
