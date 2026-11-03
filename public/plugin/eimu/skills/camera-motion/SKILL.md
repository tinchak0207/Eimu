---
name: camera-motion
description: 把运镜写成导演能执行的需求：镜别、机位角度、运动方向与速度、结束时画面落点怎么写，交给 eimu_direct 拍、在同一 job 上用 eimu_job revise 改。适合给已有分镜补运镜、把静帧变成有镜头感的视频；不适用于剪辑节奏设计或多机位拼接。
---

# 运镜与镜头运动

## 事实边界

- Eimu 默认 MCP 面是导演工具（`eimu_direct`／`eimu_job`／会话三件）。运镜的主路径是：**把运镜写进交给 `eimu_direct` 的 `prompt`，由导演拆镜、出关键帧、生成视频**；改运镜走同一 `job_id` 的 `eimu_job action=revise`。
- 没有独立的摄影机轨道／关键帧／预置运镜库 API。不要向用户承诺「套用某个运镜预置」或「调用运镜参数 API」。
- 不要自己用 `generate_image`／`generate_video` 逐镜手拼来替代导演。原子工具只在 `toolset=expert` 里，给专家排障用，不是本技能的步骤。

## 运镜四段式（写进 prompt，每镜一段，顺序固定）

1. **镜别**：大远景 / 全景 / 中景 / 近景 / 特写。
2. **机位与角度**：平视 / 俯拍 / 仰拍 / 过肩 / 主观视角；机位在人物的哪一侧。
3. **运动**：推进(track in) / 拉远(track out) / 摇镜(pan) / 平移(truck) / 跟随(follow) / 环绕(orbit) / 升降(crane) / 手持(handheld)。写清方向、幅度与快慢，例如「缓慢右摇约 30 度」「匀速推进到近景」。
4. **落点**：运动停止时画面停在哪（停在面部特写 / 停在招牌上），以及这段时间里主体在做什么。

镜头之间的运镜要有变化：连续三镜不要用同一个运动方向与速度；相邻镜头反向运动能强化衔接。时长按运动幅度给参考——缓推 3-5 秒、环绕 5-8 秒、快速甩镜 1-2 秒——写进该镜描述，交给导演定稿。

## 步骤

1. 和用户对齐：总时长、画幅、风格、预算上限。
2. 先报价：`eimu_direct`，`mode=quote`，`prompt` = 用户原话 + 逐镜四段式。把 `quote.estimated_coins` 与 `quote.balance_coins` 告诉用户。
3. 正式开拍：`eimu_direct`，`mode=full`，`budget_cap` 必带（或用户明确同意时 `confirm=true`）；`aspect_ratio` 取项目画幅（如 `16:9`）、`duration_seconds` 取总时长；已有分镜图或静帧作为起点时，把公网 URL 放进 `reference_urls`（最多 8 个），并在 prompt 里写明哪张图对应哪一镜、运动从这张图开始。
4. 拿到 `job_id` 后用 `eimu_job` `action=wait`／`get` 轮询，勿重提交。`awaiting_input` 时：`questions` 原样转给用户再 `reply`（`answers` 或 `message`，约 3 分钟内）；`confirm_cards` 问用户后 `approve`／`reject`。
5. 终态时播放成片确认三件事：方向对不对、中途有没有莫名变向、主体有没有跑出画。静态帧看不出来，必须看动起来的成片。
6. 只有确实不符时才改：对**同一** `job_id` 用 `eimu_job action=revise`，`message` 只写要改的那一镜与那一处（例如「第 3 镜把『自右向左』改成『自左向右』，其余不变」），不要整段重写需求——整段重写会让镜别、光线、人物调度一起漂移，等于重做一条。
7. 交付时给出：成片链接（`artifacts.film`）、各镜首尾帧（`artifacts.keyframes`）、`artifacts` 缺项时以 `generated_media` 补；以及每镜的四段式原文、改过哪几镜与原因。
