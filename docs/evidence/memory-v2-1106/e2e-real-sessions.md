# 真会话验证（线上网关 6830014194ef，2026-11-06 UTC 18:0x，biz key 账号）
- 会话 1（告知）744ee447-8fc0-49d0-8b18-9462e2d85814：“我的品牌叫青禾茶舍，主色是松针绿，以后做图都按这个……” → 回“记下了”。
- 会话 2（新会话，普通）7eca8423-848c-4146-8166-2652dfc302f5：“我上次说我的品牌主色是什么？” → 答“松针绿”，引用原话与日期（来自历史对话检索），并自己 memory_note 补记长期记忆。
- 会话 3（临时对话）476cca1d-7e04-4bb3-883a-680ef0b5293a：同一问题 → 答“查不到，本会话为临时对话”，两个检索工具均返回 memory_disabled，未泄露、未写入。
- 未验证：删除后再问（需站点 `/api/agent/memory/forget` 上线，站点前端构建被本机 docker 未启动阻塞）。

## 终轮（gateway f73ad3988 / site 953a0fa3d+，2026-11-07 09:4x）
- 告知→忘掉→新会话再问→临时会话，真会话（biz key，`/tmp/mem-e2e.mjs s1/s4/s2/s3`）：
  - S1 `70ec931f-3d57-4e47-b914-b51d2b0f52a2` 告知品牌色（memory_note 写入）
  - S4 `fdfd9780-6992-4866-add0-3bc93f376c1f` 「忘掉」→ memory_forget deleted:1，**历史 18 条复述片段同时抹除**，复查 recall/history 均 count:0
  - S2 `0932c4e7-8979-4007-86ed-15027f4ccad0` 新会话再问 → 未答出「松针绿」（has松针绿:false）
  - S3 `fc7052b2-e3a0-4b6b-b7e0-7e6ea7bb8d4d` 临时会话 → 拒答（memory_disabled）
- 此前失败根因：历史索引把网关注入的记忆/历史摘录连用户消息一起入库（检索结果→再入库→删后复活）；遗忘按词重叠匹配对不上模型转述。修复：入库前剥尾、遗忘改字集合+三元组指纹并留墓碑（只存指纹）、memory_forget 增 forget_text（事实只在历史里时也能忘）。

## 赏阅听歌舞台（生产 www.eimu.dev/view，真 Chromium）
- 截图：docs/evidence/viewer-20261107/prod-desktop.png、prod-mobile.png；真点下载 → 浏览器收到 `路灯下的行李.m4a`，3,884,500 字节（= 源站 content-length）。
