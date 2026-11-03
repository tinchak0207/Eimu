---
name: character-consistency
description: 让同一个角色跨镜头、跨图片保持一致：先锁死一份文字外形锚和定妆参考图，交给 eimu_direct 拍，漂移时在同一 job 上用 eimu_job revise 定点回修。适合多镜头短片、系列海报、角色连续出图；不适用于一次性单张插画。
---

# 角色一致性

## 事实边界

- 主路径是导演：**把外形锚与参考图交给 `eimu_direct`，由导演在同一 job 里出定妆、逐镜复用**；回修走同一 `job_id` 的 `eimu_job action=revise`。
- Eimu 的 MCP 没有角色库 API、没有跨工程角色引用。锚点由你在对话与文件里维护：文字外形锚每次原样带上，参考图一律用公网 URL 传（`reference_urls`，最多 8 个）。同一系列要接着做时，用 `eimu_direct` 的 `session_id` 续用同一个导演会话。
- 不要自己用 `generate_image`／`edit_image` 逐镜手拼来替代导演。原子工具只在 `toolset=expert` 里，给专家排障用，不是本技能的步骤。
- 改锚是重大动作：改了就要让导演重新出定妆并把它升级为新锚，旧锚留档。

## 步骤

1. 写外形锚（十行以内，每条都要能画）：年龄段 / 脸型 / 五官 / 发型与发色 / 身形比例 / 服装（面料与配色）/ 配饰 / 惯用表情 / 一到两个标志性细节。之后每次交给导演都原样粘贴，不改措辞、不换同义词。
2. 用户已有角色图：把公网 URL 放进 `reference_urls`，在 prompt 里写明「这张是角色定妆，所有镜头以它为准」。没有：在 prompt 里要求导演先出定妆参考图——水平白底三视图，左正面近景、中正面全身、右背面全身，三格的身份、发型、服装、年龄、体型比例与配色必须完全一致——再以它为锚出后续镜头。
3. 先报价：`eimu_direct`，`mode=quote`；把 `quote.estimated_coins` 与 `quote.balance_coins` 告诉用户。
4. 正式开拍：`eimu_direct`，`mode=full`，`budget_cap` 必带（或用户明确同意时 `confirm=true`）；`prompt` = 外形锚 + 定妆要求 + 逐镜动作与环境；`aspect_ratio` 跟随项目画幅。
5. 用 `eimu_job` `action=wait`／`get` 轮询，勿重提交。`awaiting_input` 时：`questions` 原样转给用户再 `reply`（`answers` 或 `message`，约 3 分钟内）；`confirm_cards` 问用户后 `approve`／`reject`。
6. 终态时逐镜比对（由用户或你）：换脸、改变发色、服装细节丢失、体型比例变化、配饰消失。定妆与逐镜图在 `artifacts.keyframes`／`artifacts.stills`，缺项以 `generated_media` 补。
7. 命中漂移就定点回修：对**同一** `job_id` 用 `eimu_job action=revise`，`message` 写明哪一镜、哪一处改回定妆原样（例如「第 4 镜发色漂成棕色，按定妆改回黑色，其余不动」），不要要求整条重出——重出会引入第二套长相。
8. 需要换装、换年龄或换季节时，在 revise 里说明新锚的外形描述与从哪一镜开始生效；同一段戏里不要混用两个锚。
9. 交付时报告：外形锚原文、定妆图链接、逐镜链接、做过回修的镜号与原因、以及仍然存在的不一致（诚实列出，不要美化）。
