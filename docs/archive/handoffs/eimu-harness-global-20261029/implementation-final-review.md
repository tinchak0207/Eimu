# 最终候选片段：作者回报与未复验范围

候选基底 cba3b54b5，工作树 `/home/lenovo/.codex/worktrees/eimu-film-continuity/image-app`；未提交、未部署、无付费调用。下述不是独立验收通过结论。

已改现有 export 的 candidate/publish 两阶段、四电影配方、同字节 SHA 与制作目标版本绑定、独立 critic 原话账本版本绑定。已有片段/图片能力保留，候选不发最终卡。候选本身有真实审阅 URL，供既有感知轮子读取。

独立 Hack 发现的配方 BAD_REF 已修：candidate 必须在 QC 声明之前。作者真实 store.apply_recipe 与 recipes.test 的四电影入口已经通过。旧图升级不再要求 templateId；合法定制图原位新增候选与评审，保留原 export 身份、制作节点与人工锁。未经过来源确认不得覆盖被锁节点。

export 不再按 brief[0] 剥音或验旧时长。技术闸按当前 targets；原话和后续纠正带出处交 critic。生产版本与原话账本分离：追加状态询问不会重渲候选，但新增原话仍须复核，不能伪装已采纳语义。作者真实60秒静音→2秒有声修订测试已经通过。

最新作者验证：本轮第三次目标测试合计38 pass/1 fail。通过范围包含四电影真实配方创建、QC真实数值与缺陷JSON、2秒候选真实合成、制作目标/账本变化保护、静音合法放行、已有制作节点锁保全。失败 E3 已从被全盘拒绝推进到真实视频发布，但剪映/FCPXML附件缺失。

失败根因：调度器默认输入仅传主输出口，候选其余工程port没有接入publish。最后已补新配方与旧图升级的jianying/fcpxml显式边、specs的package端口声明，以及publish汇总相同候选附件。这三处补口已由接续作者换手验证：recipes+final-candidate 24/24；原E3 1/1、19断言，实际解包核验MP4、剪映shot_a/shot_b、draft_meta、FCPXML字幕与相对media路径。日志 /tmp/eimu-independent-colorbars-final.log。评审仍为夹具，不代表真实模型审片。

另外修了真实scratch来源漂移：projectScratchDir改从store.workspaceDir实时取值，不扩大allowed roots。测试夹具QC判决现在也经真实artifact入库，避免只回一个未登记id造成publish签名不稳定。此E3使用夹具判决，仅验证真实合成与工程包，不能证明真实critic动态观看/听觉。

尚未验证真实付费供应商、线上用户路径、用户消费ACK或主观艺术质量。独立critic的媒体感知仍须真实通路验收；报告措辞、媒体SHA、工程清单的依赖分离也不得仅靠单元测试推广成全局保证。


最新集成边界（2026-10-29，尚未锁定最终候选）：接续作者已完成真实QC失败→耐久qc_rework→实际父席位唤醒→只改shot_b→新candidate→fixture critic复审→同SHA publish，2/2、34断言。shot_a SHA不变，制作调用[a,b,b]，spent .4→.6，critic两次，父唤醒一次。本片非作者复核scheduler修复仍待最后受影响回归，不能将作者结果记独立通过。

原image_generate末段已改为projectGenerate，保留参数/参考图/角色tag/报价/锁/逐帧预处理，移除本地prepare/accept/finish与直接生成POST；旧task仅经legacy_ref原位关联。确认现保存最终payload签名、模型、金额和session/凭证归属至同sessions SQLite。真实tool→HTTP→工程runner→SQLite测试正在接入，尚未运行通过；服务端原prepared dataURL参考支持和video n批量仍由共同入口作者收口。


共同入口作者自动回归最新结果：`bun test deploy-staging/gateway/project/image-generate-entry.test.ts`，8 pass / 0 fail / 57断言 / 15.28秒，日志 `/tmp/eimu-image-tool-entry.log`。真实tool.execute→HTTP→productionDeps/defaultExecutor→同runner→真实SQLite/ArtifactStore。仅provider/owner映射API是本地fake，ArtifactStore使用已有测试选项允许本地fixture，不放宽生产SSRF。覆盖HD n4/STYLE LOCK/canonical data URL、原单并发1POST1SQL、成功回放spend不增、工程child唯一lane与越界、旧专家无lane两次独立生成/恢复/停止、video n4/audio/resolution完整批价、unknown同ID不重投、确认耐久与身份/输入/金额/模型隔离。

额外旧caller最小修复：client.ts edits/upscale检查prepareSubmission.created；同key非创建者返回原request_id未知状态，不再直接POST。实际工具HTTP夹具中各自并发双入口1POST、unknown重复0新增通过。它们仍是既有编辑/放大入口，**未声称已转工程runner**。

前两轮真实入口失败来源：本地fake产物URL被生产默认SSRF拒绝，改用现成ArtifactStore仅测试注入；child fixture缺status=running，补真实存活委派状态。未修改生产门来迎合夹具。

本片非作者验证scheduler当前39/39、229断言，日志 `/tmp/eimu-scheduler-independent-latest.log`，覆盖现存失败/skip上游不误放下游、旧worker代隔离等。QC返工作者最新2/2仍是作者证据。整体候选尚待冻结后的完整内容清单、gateway bundle与tsc分类，以及非作者入口/财务边界复核。未提交、未发布、未付费。


最终入口与跨媒体补验（当前source freeze，等待根侧整体候选锁定）：原工具整文件15 pass / 0 fail / 113断言 / 36.69秒，日志 `/tmp/eimu-image-tool-entry-final.log`。新增并发独立prepared节点同代join、取消/旧回调隔代、finish竞态、同参数新ID重拍、仅task_id旧单恢复。

跨媒体最初实际反例是music完成后.5币图片被错误要求影像receipt；已由共同factory作者修复。非该factory作者在同一实际HTTP/原executor/本地bridge/TTS/SQLite夹具反证：

- 音乐1→图.5在cap1.5完成；删仅测试的音乐journal行模拟升级前旧账，凭真实ledger、bridge.result同归属/chargeRef/文件SHA恢复导入，音乐provider仍1次，增图才新增费用。
- 同activeRun音乐在途1、图片.5而cap1.2：图片0POST/0journal行，音乐done、账本实扣1、SQLite只有音乐completed预留1。汇总run因加入被拒图片返回failed，不能误说音乐失败；核查目标节点与账本。
- 原voiceExecutor通过本地TTS真MP3和ffprobe后接图，spent=.503；未把音乐通过外推给语音。

相关runtime exec-bridge、audio和bridge HTTP client共62 pass / 326断言 / 1.52秒，日志 `/tmp/eimu-runtime-audio-integration-final.log`。独立实际供应商、艺术质量、真实MV交付与生产版本仍未验证。
