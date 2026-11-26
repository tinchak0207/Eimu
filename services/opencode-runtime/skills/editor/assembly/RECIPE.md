---
name: editor-assembly
description: 剪辑素材入轨与时间线编排配方。触发时机：把素材加入时间线／剪切／合并／排序／修剪／拆分／变速／锁定／分组／设转场／多轨音频字幕／回退版本。时间线结构有任何变更（add/remove/reorder/trim/split/speed/lock/group/transition）时必载。
---
<!--
来源（轮子）: 自有配方（非第三方轮子）。依据 docs/timeline-post-production-plan.md §2 B1/B2 拆片表
              （时间线资料对象 + ops 9 类指令 + 版本 + 决策日志）与 §7；记忆
              2026-08-31-b1-timeline-lifecycle-layer（版本/锁定/幂等语义）。
工具真源: VPS /opt/agent-harness/workspace/.opencode/tools/{timeline_ops,timeline_query,
          timeline_restore,editing_manifest,video_upload}.ts 与 gateway/timeline.ts。
入库批次: 2026-09-27 剪辑域 Agent 能力面活化。
-->

# 素材入轨与时间线编排

## 工具链

```
video_upload → editing_manifest → timeline_query → timeline_ops（整批原子）→ timeline_query（回读 diff）→ timeline_lint（过闸）→（必要时）timeline_restore
```

## 逐步配方

1. **素材进入**：`video_upload` 把视频／音频素材上传进 gateway 会话，拿到后续可引用的素材引用。**禁把超过 `video_upload` 限制的原片直接用 `run_py` 读本机路径**（gateway 会话外不可见）。
2. **交底剪辑清单**：`editing_manifest` 生成 manifest（素材 → 镜头 → 顺序的显式清单）。它是**语义层交底**：把「哪个素材放第几、意图是什么」显式化，后续 ops 依它落轨，不靠记忆。
3. **摸底真状态**（强制）：`timeline_query(what=state)` 取现有 clips／时长／版本号／决策日志。**动手前必须有这一读**——猜状态＝必错。
4. **批量落轨**：`timeline_ops` 一次带整批 op，形如 `{op, clip_id/clip_ids, to_index, ...}`：
   - 插入／删除：`add` / `remove`（remove 带 `reason`，会进决策日志）
   - 排序／移动：`reorder`（`to_index`）
   - 精度：`trim`（`in`/`out`）、`split`、`speed`
   - 守卫：`lock` / `unlock`（locked clip 被改 → 409 `{blocked,reason:"locked"}` **整批拒**，不是部分套用）；`group` / `ungroup`
   - 叠层：`set_transition`、`set_meta`、`add_audio`、`add_subtitle`、`set_aspect`
   整批先验证后套用；有任一非法 → 整批不动、版本号不变。
5. **回读 diff**：`timeline_query` 再读一次，确认实际结果（版本号 +1、clip 数与时长如预期）。**禁止跳过回读直接回报完成**。
6. **过 lint 闸**：任何交付前必须 `timeline_lint`；must 未清不得往下走。
7. **回退**（仅在需要时）：`timeline_restore` 回目标版本。语义：内容 = 该版本内容，但**版本号单调递增**、历史不删；回退本身也进日志。

## 不可违反的语义（来自 B1 生命周期层）

- 有效时长 = `(out - in) / speed` 逐 clip 求和，与轮子 `clipLength` 一致——不要自算一套时长口径。
- `split` 后半段**不继承** `costCoins`（生成成本属源镜头，拆分不翻倍计帐）。
- 幂等 op（无实际 diff）**不 bump 版本、不写日志**；不要用「版本号有动」当成操作成功的唯一判据，回读 diff 为准。
- `unlock` 是唯一对 locked clip 开放的变更 op。
- 部分失败不存在的：整批原子，要嘛全成、要嘛全不动。

## 交付

payload 三栏之一：`timeline_ops`（回执 `timeline_ops_echo` 为实际执行操作；无回显时回退委托单清单，两处皆空才落「（剪辑师自主编排，未显式指定）」占位——占位是诚实标记，非交付）。成片交付另需 `duration_sec` + `qc`。
