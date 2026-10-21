---
name: editor
description: 剪辑域 Expert 配方库总入口。触发时机：时间线编排／剪切／转场／节奏卡点／混音 ducking／调色／母带质检导出／时间线回退（taskTypes editing / timeline / cut / film_assembly）。剪辑任务必载本库，禁止凭记忆手搓 ffmpeg 或臆测时间线状态。
---
<!--
来源（轮子）: 自有配方（非第三方轮子）。内容依据我方后期制建设既有盘面，非凭空编写：
              docs/timeline-post-production-plan.md §2 拆片表（B1-B7）与 §7 全役完结；
              记忆 2026-08-31-b1-timeline-lifecycle-layer、timeline-post-production-buildout-0831、
              timeline-b1-b3-harness-training-e2e。
工具真源: VPS /opt/agent-harness/workspace/.opencode/tools/timeline_*.ts（本地
           src/lib/harness-tool-registry.ts 只登记 id，handler 不在本 repo）。
入库批次: 2026-09-27 剪辑域 Agent 能力面活化（补 editor-persona skillPaths 待补项）。
-->

# Editor — 剪辑师配方库（时间线后期全链）

本目录是剪辑域 Expert 的 must-load 配方库。优先用 timeline 高级工具完成素材入轨、剪切、混音、质检与导出。高级工具出现已记录的不可恢复原始错误时，只有实际持有合法现存底层工具才可具名降级；记录工具名、失败原因、输入产物与输出验证，不新增通用run_py权限绕过领域工具面。无合法降级入口则如实回报阻塞。

## 硬规则（先于一切）

1. **状态唯一真源 = 时间线 JSON（per-session）**。任何变更前先 `timeline_query(what=state)` 摸底，变更后回读 diff；**禁止凭记忆猜剪辑点或剩余时长**。
2. **多步变更同批原子**：`timeline_ops` 一次带整批指令，整批先验证后套用；分批乱发会造成中间态与版本错乱。
3. **`timeline_lint` 是闸门不是可选项**：must 级未清**不得交付、不得导出**。`timeline_master` 的 export 会被 must 级 block 直接 400 拒，这是机器层硬闸（VPS `gateway/master.ts`）——先过 lint 再谈交付。
4. **语义层诚实 unsupported**：越轴／动作连续性／光不一致／角色脸一致性／口型同步／运动追踪特效／fxComponents 花字农场 = 本链不支援，遇之如实标注，禁硬造结果。
5. **一次一变更意图**：工具是分钟级上游（TTS／导出）时禁连发；单次 `timeline_ops` 内聚合，不开并发。

## 十件套路由表（什么场景 → 调哪支 → 输入什么 → 交付什么）

| 场景 | 工具 | 输入 | 交付 |
|---|---|---|---|
| 素材进入剪辑（视频／音频上传进 gateway 会话） | `video_upload` | 本地档或 URL + session | 素材可在后续 ops 中引用的引用 |
| 生成剪辑清单（EDL／manifest，语义层交底） | `editing_manifest` | 素材引用清单 + 剪辑意图 | manifest（素材→镜头→顺序的显式清单） |
| 摸底时间线状态 | `timeline_query` | `what=state` | clips／时长／版本号／决策日志 |
| 落轨与批量编排 | `timeline_ops` | 整批 op（add/remove/reorder/trim/split/speed/lock/unlock/group/ungroup/set_transition/set_meta/add_audio/add_subtitle/set_aspect） | 新版本 + diff |
| 旁白／解说先行（先定音轨，再对齐画面） | `audio_first_timeline` | 逐行文稿或音频 | 真 TTS + ffprobe 实测时长 + 累计 offset_ms 锚点时间线 |
| 节奏体检与卡点 | `timeline_rhythm` | 时间线（可带情绪曲线软输入） | curve + flags（must/should）+ climax |
| 信号层质检（黑帧／白闪／爆音／静音段／音量跳变／音画时长错位） | `timeline_lint` | 时间线 | must/should 分级报告（**闸门**：must 未清不得交付） |
| 混音层（voice/bgm/sfx 三轨 + ducking + 响度报告） | `timeline_mix` | 时间线 + 分轨笔记 | 混音后时间线 + 响度报告 |
| 风格层（滤镜四滑杆／转场／字卡 ASS） | `timeline_style` | 时间线 + 风格档 | 套用风格后时间线 |
| 母带质检与成片导出 | `timeline_master` | 时间线 + 预设（9:16／16:9／2.39:1／封面帧） | check 报告；must 未清 export 拒；过闸后成片 URL + 版本号 + 小结 |
| 时间线回退 | `timeline_restore` | 目标版本号 | 内容回退该版本（版本号单调递增，历史不删） |

## 四条标准链路（照走，勿自拼）

1. **素材平剪成片**：`video_upload` →（`editing_manifest`）→ `timeline_query` 摸底 → `timeline_ops` 落轨与剪切 → `timeline_lint` 过闸 → `timeline_rhythm` 节奏修正 → `timeline_mix` → `timeline_style` → `timeline_master` check → export。
2. **旁白先行**：`audio_first_timeline` 定音轨与 offset 锚点 → `timeline_ops` 依锚点对齐画面 → `timeline_lint` → `timeline_master`。
3. **节奏卡点**：`timeline_query` → `timeline_rhythm` 取 flags/climax → `timeline_ops` 依 flags 修（只修 clip_id 明确的 must/should）→ `timeline_rhythm` 复验。
4. **返工回退**：`timeline_restore` 回目标版本 → `timeline_query` 确认 → 重编。

## 隔离条款（回传契约）

最终格式以网关注入的expert-delivery-contracts.json为准，保留timeline_ops / duration_sec / qc。timeline_ops携带实际剪辑点（素材、入出点、时间线位置、转场）和真实成片引用（导出URL或实际文件路径），不能只写泛泛操作日志；edit_summary概述改了什么。duration_sec注明真实测量来源；qc引用timeline_lint/master原始结论及独立审片证据范围。字段存在或lint通过不等于视觉/听觉质量已通过，缺独立感知证据标未验。失败/降级时交回原始错误和已保留产物，不伪造成片引用。

## 子配方索引

| 子目录 | 主题 | 对应工具链 |
|---|---|---|
| `assembly/RECIPE.md` | 素材入轨与时间线编排 | `video_upload` → `editing_manifest` → `timeline_query` → `timeline_ops` → `timeline_restore` |
| `audio-first/RECIPE.md` | 旁白先行时间线 | `audio_first_timeline` → `timeline_ops` → `timeline_lint` |
| `rhythm/RECIPE.md` | 节奏卡点与体检 | `timeline_query` → `timeline_rhythm` → `timeline_ops` → `timeline_rhythm` |
| `look/RECIPE.md` | 风格与调色 | `timeline_style` → `timeline_lint` |
| `mix/RECIPE.md` | 混音与 ducking | `timeline_mix` → `timeline_lint` |
| `qc-master/RECIPE.md` | 质检闸与母带导出 | `timeline_lint` → `timeline_master` |

## 授权

自有配方，无第三方授权义务。工具链执行码真源在 VPS `/opt/agent-harness`（`gateway/timeline.ts` + `gateway/lint.ts` + `gateway/mix.ts` + `gateway/style.ts` + `gateway/master.ts` + `.opencode/tools/timeline_*.ts`）。
