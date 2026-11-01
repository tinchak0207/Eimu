---
name: film-production
description: 把模糊需求交给 Eimu 导演，拿到成片与中间产物。适合「给我做一条 30 秒短片」「把这段故事拍出来」这类从零到成的请求；不要用于单张出图或单次改图。
---

# 一句话到成片（导演主路径）

Eimu 是 **Vibe Directing / Cursor of video**。口号：**不用学提示词设计和分镜，现在你也是导演。**

你的工作不是手拼分镜原子工具，而是把需求交出去、盯进度、把成片与中间产物交回用户。

## 铁律

- **主路径只有一条**：`eimu_direct` → 轮询 `eimu_job` → 交付成片与中间产物（分镜／brief／首尾帧／配音等）。
- **禁止**教用户或自己用 `generate_image` / `generate_video` / `tts` 等原子工具逐镜手拼来「替代导演」。原子工具在 `toolset=expert` 里，只给专家排障，不是成片主路径。
- 付费前先说清预算：`eimu_direct` 的 `mode=quote` 只报价；`full` 建议带 `budget_cap`。用户对上一镜的授权不等于对整片重跑的授权。
- 同一任务**勿重提交**；续查、改片、批准、取消一律走 `eimu_job`。
- 成片与中间产物是导演 job 的终态交付；禁止把交付说成「只到素材、用户自己拼片」。

## 步骤

### 0. 对齐一句目标

用用户的话确认：总时长、画幅、风格、预算上限。缺硬事实再问；能猜的别问卷。

### 1. 派给导演

调用 `eimu_direct`：

- `prompt`：用户原话 + 你对齐过的约束（时长／画幅／风格／参考 URL）
- `mode`：先 `quote`（若用户要先看价）或直接 `full`
- `budget_cap`：`full` 时带上
- `reference_urls`：用户给的参考素材公网链接

拿到 `job_id` 后立刻进入下一步。若工具回 `not_ready`（并行路尚未合入），按回执里的 `interim` 过渡：`toolset=expert` + `run_agent` 派工，再用 `get_agent_session` 取产物——**仍然按「交出去 → 拿成片」叙事交付**，不要改回逐镜手拼。

### 2. 轮询与协作

循环调用 `eimu_job`：

- `action=get`：看阶段、进度、待回答问题、已产出的中间产物
- `action=wait`：有界等待（≤45s），超时继续 get，不要空转重提 `eimu_direct`
- `action=reply` / `approve`：回答导演补问或批准预算
- `action=revise`：对同一 job 追加改片意见
- `action=cancel`：用户明确叫停

也可用 `list_agent_sessions` / `get_agent_session` 回读会话与产物链接；需要中止时用 `abort_agent_session`。

### 3. 交付

终态时向用户交付：

1. **成片**链接（mp4 等）
2. **中间产物**：brief／分镜表／世界观或美术设定／各镜首尾帧／配音或 BGM（有则给）
3. 本次花费与是否触碰 `budget_cap`
4. 若要改一版：对**同一** `job_id` 走 `eimu_job action=revise`，不要新开一条无关任务重烧整片

## 明确不做

- 不把「拆镜 → 逐镜 generate_* → 用户自己拼片」写成标准流程
- 不把交付降级成「只交素材」
- 不把画布节点编排界面塞给普通用户当主路径
