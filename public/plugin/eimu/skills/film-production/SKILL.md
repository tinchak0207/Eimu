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
- 付费前先说清预算：`eimu_direct` 的 `mode=quote`（或 `preflight=true`）只报价、不建任务、不扣费；正式跑（`full`／`plan`）**必须**带 `budget_cap`（币，与余额同单位）或 `confirm=true`，否则回 `needs_confirmation`＋`code=budget_required`、不提交。用户对上一镜的授权不等于对整片重跑的授权。
- 同一任务**勿重提交**（回执 `do_not_resubmit=true` 时尤其）；续查、作答、改片、批准、拒绝、取消一律走 `eimu_job`。
- 成片与中间产物是导演 job 的终态交付；禁止把交付说成「只到素材、用户自己拼片」。

## 步骤

### 0. 对齐一句目标

用用户的话确认：总时长、画幅、风格、预算上限。缺硬事实再问；能猜的别问卷。

### 1. 派给导演

调用 `eimu_direct`：

- `prompt`：用户原话 + 你对齐过的约束（时长／画幅／风格／参考 URL）
- `mode`：先 `quote`（若用户要先看价）；`plan`＝只出方案／brief／分镜计划不开拍；`full`＝开拍成片（默认）
- `budget_cap`：正式跑必带（或用户明确同意不设上限时用 `confirm=true`）。带了 `budget_cap`，轮询中上限内（单卡与累计）的扣费确认卡会自动批准
- `aspect_ratio`／`duration_seconds`／`style`：画幅、目标时长（秒）、风格关键词（可选）
- `thinking_level`：用户说「极限模式／野兽模式／最高质量」时带 `extreme`（＝极限＝野兽模式，开拍前写入账号设置，对之后的会话也生效）；`low|medium|high` 对应站内低／中／高。也可只给 `beast_mode=true`。报价（quote/preflight）不写设置
- `reference_urls`：用户给的参考素材公网链接（最多 8 个）
- `session_id`：要接着同一个导演会话做（续集、系列）时传入；省略＝新建

按回执 `status` 处理：

- `quoted`：把 `quote.estimated_coins`、`quote.balance_coins` 与 `quote.note`（粗估、非计费真源）告诉用户；用户同意后再调一次 `eimu_direct`（`full`＋`budget_cap`），这是首次提交，不算重提交
- `needs_confirmation`（`code=budget_required`）：补 `budget_cap` 或 `confirm=true` 再调
- `insufficient_quota`：余额低于粗估，未提交；请用户充值或降 mode，用户明确要硬闯才 `confirm=true`
- `processing` 或其他带 `job_id` 的状态：进入下一步

### 2. 轮询与协作

循环调用 `eimu_job`：

- `action=get`：看阶段、进度、待回答问题、已产出的中间产物
- `action=wait`：有界等待（`timeout_seconds` ≤45），超时仍 `processing`；按 `poll_after_seconds` 再 wait/get，不要空转重提 `eimu_direct`
- `action=revise`：对同一 job 追加改片意见（`message`）
- `action=cancel`：用户明确叫停

`status=awaiting_input` 时导演停下等人，分两种：

- **`questions`（导演请示卡）**：把每张卡的 `header`／`question`／`options[].label` 原样转给用户，拿到选择后 `action=reply`，`answers` 依 `questions[]` 顺序每题给一个选项 `label`；用户要自由回答就放 `message`。约 3 分钟内未作答，网关按超时拒绝，导演会停下——所以轮询要勤，别让请示卡过期
- **`confirm_cards`（扣费确认卡，含 `id`／`amount_coins`／`model`／`description`）**：`code=budget_exceeded` 表示超出 `budget_cap`、没有自动批准。问用户后 `action=approve` 或 `action=reject`，`confirm_ids` 取 `confirm_cards[].id`（省略＝当前全部）；`reject` 无卡时需带 `message`

`status=stalled`：会话 idle、回覆称仍在生成却无产物且久无活动。用 `eimu_job reply` 追问进度，或 `get_agent_session` 看完整记录；仍然勿重提交。

也可用 `list_agent_sessions` / `get_agent_session` 回读会话与产物链接；需要中止时用 `abort_agent_session`。

### 3. 交付

终态时向用户交付：

1. **成片**链接（mp4 等，`artifacts.film`）
2. **中间产物**：brief／分镜表／世界观或美术设定／各镜首尾帧（`artifacts.keyframes`）／配音或 BGM（有则给）；电商套图、海报等成品静帧在 `artifacts.stills`，按每项 `label`（主图／卖点／细节／包装…）交付，不要当首尾帧
3. `artifacts` 由导演回覆分类得出，可能漏项；终态的 `generated_media`（本会话全部成功生成的公开 URL，含返工稿）是网关回执真源，缺项时从这里补。`generated_media=null` 时看 `generated_media_note`
4. 本次花费与是否触碰 `budget_cap`（`budget` 记账、`auto_approved`）
5. 若要改一版：对**同一** `job_id` 走 `eimu_job action=revise`，不要新开一条无关任务重烧整片

## 明确不做

- 不把「拆镜 → 逐镜 generate_* → 用户自己拼片」写成标准流程
- 不把交付降级成「只交素材」
- 不把画布节点编排界面塞给普通用户当主路径
