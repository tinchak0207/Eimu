---
name: editor-qc-master
description: 剪辑质检闸与母带导出配方。触发时机：成片导出、交付、质检、QC、检查后导出、竖屏／横屏／影院画幅、封面帧、交付规格、导出被拒排障。任何「把片子交出来」的请求必载——lint 是闸门不是可选步骤。
---
<!--
来源（轮子）: 自有配方（非第三方轮子）。依据 docs/timeline-post-production-plan.md §2 片B4+B6
              （B4 信号层 linter：黑帧/白闪/爆音/静音段/音量跳变/音画时长错位，ffmpeg blackdetect·freezedetect·
              astats·silencedetect，must/should 分级；B6 母带 check+export 闸，must 未清拒导，预设
              9:16/16:9/2.39:1/封面帧）与 §7（master 14/14 含负向闸：声明 > 源实测 → av_mismatch must → export 400）。
工具真源: VPS .opencode/tools/{timeline_lint,timeline_master}.ts 与 gateway/{lint,master}.ts。
入库批次: 2026-09-27 剪辑域 Agent 能力面活化。
-->

# 质检闸与母带导出（qc-master）

## 铁律

**`timeline_lint` 是闸门：must 级未清不得交付、不得导出。** 不是建议、不是可选步；`timeline_master` 的 export 对 must 未清时间线直接 400 拒（机器层硬闸）。

## 工具链

```
timeline_query（摸底）→ timeline_lint（信号层质检，must/should 分级）→（清 must）→ timeline_master check（聚合质检：时长／解析度／画幅 + lint + 响度）→ timeline_master export（过闸才出片）
```

## 逐步配方

1. **摸底**：`timeline_query` 取当前版本号与时长。
2. **信号层 lint**（闸门）：`timeline_lint` 检 8 类信号项：
   - 视频：黑帧（`blackdetect`）、白闪、冻结（`freezedetect`）
   - 音频：爆音、静音段（`silencedetect`）、音量跳变（`astats`）、音画时长错位（`av_mismatch`）
   - 分级：**must / should**；语义层（越轴／动作连续性／光不一致／角色脸一致性／口型同步）**诚实跳过如实 unsupported**。
   - **must 未清 → 停**：回 `timeline_ops` 修（黑帧 → trim／换素材；静音 → trim 气口；av_mismatch → 修时长），再重跑 lint。
3. **母带 check**：`timeline_master` 的 `check` 聚合：时长／解析度／画幅 + B4 lint + B5 响度；回报 must/should。
4. **导出**：`timeline_master` 的 `export`，预设画幅 `portrait_916`（竖 9:16）／`landscape_169`（横 16:9）／`cinema_239`（影院 2.39:1），可含封面帧。
   - **blockers 非空 → 400 拒**（含 `av_mismatch`：声明时长 > 源 ffprobe 实测时长）。
   - 过闸产物：成片 URL + 质检报告 + **版本号** + 小结栏位。

## 负向闸（交付验收必知）

- **宣告时长必须 ≤ 源实测**：`声明 5s 但源只有 3s` 会被 `av_mismatch` must 拦下，export 400。不要为了符合 `duration_hint` 而虚报时长——回报真实实测值。
- **时长／解析度以 ffprobe 实测为准**，模型自报不算。
- `check ok:true` 只代表 check 过，**不代表 export 过**；交付前的判据是 export 真的产出 URL 且 URL 可取。

## 交付契约（三栏钉死）

回执 JSON 顶层必须带：
- `ok: true`
- `url`：成片公网 URL（未上传 gateway 即 `missing_deliverables`）
- `duration_seconds`：成片实测秒数（>0；缺失即 `missing_deliverables`）
- `qc`：**lint／master 的真实质检结论**（缺失即 `missing_deliverables`——站点侧 `editor-delegate.ts` collect 闸门直接判未交付）
- 可选：`timeline_ops_echo`（实际执行操作）、`video_bytes`

**`qc` 空 = 未交付**，不是「先交再补」；成片 URL 有了但 qc 空，交付物组装闸门照样拒。
