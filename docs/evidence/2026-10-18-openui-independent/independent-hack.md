# OpenUI 独立真实路径验收

Hacker：independent_hack（非作者）。Oracle：Chromium 1248，deviceScaleFactor 2，真实 AgentMarkdown → AgentOpenUIBlock → 官方 Renderer → onSend 回执；未运行或编写测试脚本，未调用付费生成。

- 原始完整/精简 DSL 逐字回放均显示所有内容，0 fallback，0 partial，最终刷新0 pageerror。带历史错误前缀与悬空尾 fence 的精简消息仍渲染。
- 真实控件 subject 中文、style 多选、ratio 单选、seconds 滑杆、extras 多选提交正确。原始完整 payload：subject=独立验收：雨夜霓虹街口，旅人回头；style=cinematic、editorial；ratio=9:16；seconds=10；extras=typography、music。
- 稳定 /openui-demo 三页签均真实可用；默认演示 payload：subject=能力展示：暮色山谷中的玻璃剧场；style=cinematic、anime；ratio=9:16；seconds=15；extras=typography、music。精简按钮 payload=把完整的交互界面再渲染一次，包含表单和滑杆。
- 手机390：document390/390，稳定页 sections358/358、356/356；桌面1280：document1280/1280，原始完整块832/832。截图已实际目视，表格/表单/回执完整，无横向溢出。
- Hack：空输入无假成功；41k字符原文折叠降级；未知组件保留原文字并提示；半截流式不显示fallback，补齐后立即显示；javascript动作点击0 popup / 0 dialog；全程0 pageerror。
- 独立Hack发现并已作者修复：长表单字段静默截断、默认参数未登记。修复后400字符完整回传；44k字符明确阻止提交且不产生新回执，原表单保留，缩短后恢复。默认提交回传16:9/8秒/typography；取消选择与显式subject空值准确回传，重置恢复默认。
- 已知边界：整体提交40000字符安全限额；超限诚实提示，不声称任意输入100%。额外双表单隔离因共享dev新增路由404未验。

此报告只证明本地行为；生产待发布后的独立一次提交。

## 生产最终独立验收

最终deployment dpl_zhUfW5ffdPzU33XuNmxnwN1HgJqx / https://eimu.dev/openui-demo。三页签真实渲染，默认及修改后两次提交成功，无生成调用。默认参数16:9/8/typography完整；修改参数subject中文、style=cinematic、ratio=9:16、seconds=15、extras=music，取消typography未反弹。手机document390/390，sections358/358及356/356；0pageerror。详细真回执production-results.json，截图production-demo-{desktop,mobile}.png。
