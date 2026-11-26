# Eimu 全局 harness 原地实施接续点

当前是隔离树本地候选，尚未生产验收。工作树：`/home/lenovo/.codex/worktrees/eimu-film-continuity/image-app`；基底cba3b54b5。没有付费上游探针。

已接线并有局部行为证据：

- 工程run结束→耐久责任→提交后事件消费者→既有父席位唤醒→作者产物写入后原targets接续；投递未知不盲重投，取消作用实际signal与耐久执行代。[接续实施](implementation-continuation.md)
- 音乐桥提交前目录预检、成功回执先落盘、原操作回收、归属和指纹核验；本地EACCES/ENOSPC不再冒充供应商失败。[音乐回收](implementation-music-recovery.md)
- 目标来源、上下文原位重建、最终candidate→QC→publish由其他实施片改造；具体以它们的证据和后续集成报告为准，本入口不代签通过。

独立Hack已指出并修正：每个新runId都制造新责任，会让没有实质变化的作者等待或已完成结果循环唤醒。现按实际待办/输入代/目标生成稳定责任身份，真实runner新增反例回归37/37通过；独立Hacker对最新候选复验仍须由其给结论。不能把作者测试代替换手验收。

明确尚未通过的链路：

- 原工具共同入口已完成本地真实HTTP/SQLite/ArtifactStore夹具15/15、113断言；已由非入口作者换手重跑；真实生产供应商/成片用户路径仍待验证。
- DSL同工程写读执行已在本地真实链验证；站点/网关/runtime匹配生产部署与真实MV使用仍未验证。
- 真实critic感知与生产交付验收；本地fixture critic的返工整链已通过，见下。
- 原始WATERLINE旧会话的真实operation归属回收、实际影片完成与可编辑工程交付。
- 生产进程运行此候选、公开用户路径与账本证据。当前没有发布，也没有宣称无人值守制作全部闭合。

不要从“局部测试绿”跳成“全局问题已完全解决”。下一步从尚未通过的真实链路继续，不重复重跑已证明的局部性质来充当进度。

后续状态更新：

- DSL片实际读写执行链21/21通过，见[DSL实施](implementation-dsl.md)。匹配部署包含站点compile路由；尚未生产。
- 非QC作者独立执行recipes+final-candidate共24/24通过；E3两次发现真实出口问题（zip被误送ffprobe；本机unzip命中交互包装器）。原作者修后，第三次原E3通过1例19断言，实际校验MP4、剪映段身份、draft_meta、FCPXML字幕与相对media。日志`/tmp/eimu-independent-colorbars-final.log`。critic仍测试夹具，不能推出真实模型审片已通过。
- 未abort旧worker越代写节点的独立反例已在commitNode按activeRun/continuation归属挡住，合法恢复复用原租约。scheduler最新38/38。
- 音乐done缓存文件丢失/同字节数篡改已补实际文件核验与原receipt重回收，runtime25/25；消费ACK尚未接通，音乐原文件/receipt不因TTL删除。

最终音乐清理边界已闭合：已接内部ingested ACK；gateway当前代节点与ArtifactStore实际SHA持久后才发送，桥核同归属/原操作/原run及接收文件。未ACK保留；ACK后TTL可清桥tmp，实际工程资产保留。这不是用户下载ACK。窄回归runtime26、scheduler39、真实HTTP client10通过，详见音乐实施文档。作者现冻结等待整候选复验，仍无生产完成声明。

返工整链换手补验发现并修复真实断点：scheduler看到上轮失败依赖，提前把下游发布节点阻断，即使该依赖本轮已计划重做。现先等本轮依赖终态，失败仍阻断，不清锁/pinned/取消状态。实际run→真实qcExecutor失败报告→耐久qc_rework→既有父席位定向通知→仅patch第二镜→run复审→真实MP4发布通过；第一镜SHA不变，执行序列shot_a/shot_b/shot_b，支出0.4→0.6，新候选SHA变化且publish同SHA。critic派发/感知回执是明确夹具，非真实模型审片。E3两例34断言及scheduler39例通过；日志`/tmp/eimu-qc-directed-integration-final.log`。共同生成入口与完整project分类仍在等待其他作者可验冻结。

最新完整project已按55文件独立进程执行，734pass/6fail；6项旧精确契约/clip夹具均已具名维护并定向通过。随后发现并原位修复music/voice与影像的重复预算真源，原tool.execute及真实HTTP同代并发、旧音频回收、混合预算均由非作者换手验证。最后受影响13文件独立进程233pass/0fail/1449断言；这与早先55文件批次分开，未冒称最后同SHA全量全绿。详细时间点、失败分类、最终矩阵、权限发布前置与未验证范围见[候选验收](candidate-verification.md)。

原工具共同入口当前接续：image_generate最终提交已转projectGenerate；确认绑定最终输入/模型/金额并耐久存储。真实tool.execute→HTTP→工程→共享SQLite测试已15/15、113断言通过（日志 /tmp/eimu-image-tool-entry-final.log），已由非作者换手重跑，见[最终候选片](implementation-final-review.md)。不能以接口存在代替入口通过。八个复杂模板的能力去处与未覆盖项见[模板能力表](template-capability-preservation.md)。

最后入口批次还包含跨媒体：音乐/语音→图片合法剩余额度、旧音乐原回执恢复、并行cap1.2不超支。相关runtime桥/音频62/62；gateway bundle成功，tsc仍25条（基底30条，同诊断复现25，本轮新增0），类型闸没有绿。整体受影响文件逐进程验收与最终候选manifest由根侧汇总后才可决定提交，当前未发布。
