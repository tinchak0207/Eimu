# S7 「key 建了没用」召回信（预期 40 分钟）

先读 `_common.md`（同目录）。另外必读：`/home/lenovo/.claude/memory/lifecycle-email-system-0927.md`，以及 `src/lib/lifecycle-email.ts` 全档（这次是加模板，不是重写）。

## 事实（S1 报告）
23 个外部 key 持有者中，14 人建 key 后一次都没调用。12 人是在注册当下顺手建的，之后再也没回来。他们不是被拒绝，是没有下一步。

## 做什么
1. `lifecycle-email.ts` 新增模板 `key_idle`：
   - 触发条件：建了第一把 biz key 满 24 小时；该用户没有任何 source=biz 的 job；没有退订营销邮件；有已验证的 email
   - 每人只发一次（沿用 `email_send_log` 的 PK）
2. 文案（简体中文，版式沿用现有模板）：
   - 标题：「你的 API key 还没出过第一张图」
   - 正文放一段 curl，**key 位置写 `$EMU_API_KEY` 占位符，绝不嵌入真实 key**
   - 模型用 `src/lib/dev-quickstart.ts` 已经生成的 gpt-image-2 范例（复用，不另写）
   - 标明余额：「新人礼 X 张可直接调用」，X 从 WELCOME_GIFT 常量取
   - CTA 按钮：「查看我的 key」→ `/settings?tab=api-keys`（先 grep 确认实际路由）
   - 附退订链接
3. 在 `runLifecycleEmailsOnce` 的候选查询里加上这个模板，沿用 claim → send → settle 流程。

## 验收
- 单元测试：没建 key → 不发；建了未满 24 小时 → 不发；已有 biz job → 不发；已退订 → 不发
- 渲染出的 HTML 不含任何 `sk-` 开头的字串
