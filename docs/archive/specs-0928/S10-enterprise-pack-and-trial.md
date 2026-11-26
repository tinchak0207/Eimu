# S10 企业币包＋「用你的小说试拍 30 秒」成交流程（预期 60 分钟）

先读 `_common.md`（同目录）。另外必读：`/home/lenovo/.claude/memory/price-no-change-0928.md`（不改正价）、`/home/lenovo/.claude/memory/kunpeng-film-assembly-sharding.md`（成片拼接已可用）。

## 做什么
1. **企业币包**：在 `src/lib/plans.ts` 新增 `ENTERPRISE_PLANS`，**单价与梦虹完全一致**（¥69 / 1500 币），只放大金额：¥2,000、¥5,000、¥10,000，币数按梦虹单价换算并取整。
   - **不放进** `PLANS` 阵列；定价页底部加一个「企业 / 工作室」区块。
   - 查清 mapay 单笔金额上限（读 `src/lib/mapay.ts` 和 `/home/lenovo/.claude/memory/mapay-fee-rejection-fix-0920.md`）。超过上限的档位改为「联系我们」，走人工收款后用 `tools/issue-promo-code.ts` 发兑换码（写清操作步骤）。
2. **试拍申请页 `/studio`**（简体中文、B 端语气、零 emoji）：
   - 首屏：《大明最后的十七年》成片直接播放（`public/showcase/agent-templates/novel-film-3.mp4`），旁边一句话「整本小说丢进去，出来就是成片」。
   - 三行事实：全程真视频｜角色同脸｜约 ¥14 / 分钟（由 ENTERPRISE_PLANS 单价实时计算，不写死）。
   - 表单：工作室名称、联系方式（微信或手机）、每月出片量、上传一章小说或剧本（txt/docx/pdf，≤2MB）→ 写入控面新表 `studio_lead`（仿照 `api_rejection` 的 ensureSchema 写法）。
   - 提交后显示「24 小时内我们用你的故事拍 30 秒试看片」。
   - 要有内部通知：新 lead 写入时发一封 Resend 邮件到 `.env.resend` 里 RESEND_FROM 对应的收件地址（或暴君指定的地址；**不在代码里写死任何个人邮箱**）。
3. **/admin 加 lead 列表**：状态流为 new → 试拍中 → 已交付 → 已成交／流失，可手动改状态。

## 验收
- `ENTERPRISE_PLANS` 单价与梦虹一致有测试锁住；`PLANS` 无 diff
- lead 写入、状态流转的单元测试
- `/studio` 在手机宽度可用（只跑构建，不做 UI 截图）
