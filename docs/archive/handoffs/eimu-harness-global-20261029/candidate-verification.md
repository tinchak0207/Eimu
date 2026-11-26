# 本地候选的换手验收与失败分类

本轮仅隔离树本地、零付费、无发布。2026-10-29 15:06:47 +08:00记录开始候选diff SHA `69164d4a044be4e49027f27dc6f6c4cc9dafb1a5e140dad5ea9d45bdb7436c35`。这是一份开始时快照，路由/旧回执作者仍有已知小片收口，最终受影响文件另补验；不能把开始快照当最后发布清单。

完整project共55个测试文件，各自独立Bun进程、WORKSPACE/DB/journal；外部平台和OpenCode地址强制loopback，具体测试中的provider也是本地夹具。原始结果734 pass、6 fail、0 skip。日志、每文件exit码和临时目录：`/tmp/eimu-project-final-isolated/{files.txt,results.tsv,*.log}`。历史同进程51文件643 pass/49 fail只是旧快照，文件与场景数有变化，不能宣传成46项真实生产故障已修。

失败分类及定向复验：

| 文件 | 全批失败 | 独立契约判断 | 定向结果 |
| --- | ---: | --- | --- |
| arena-batch | 1（120个user_changes_mind场景） | 三镜与后处理不变，新增candidate/export_machine/export_critic也必须随被改镜头重做；原手写闭包缺这3项 | 600局全部通过，1测试/4断言 |
| i6-incremental-rerun | 1 | 旧精确13节点应16；7必要重跑应10，5复用和第一镜pinned仍保留，非任意放宽下限 | 7测试/48断言通过 |
| i7-recipes-executable | 1 | 最终完整candidate评审替代片段评审；原本节点regenerate自审必须删，具体缺陷转作者返工；研究、角色、渲染unsupported检查保留 | 5测试/625断言通过 |
| executors/generation | 3 | context作者维护：提交/入库单元夹具补真实session入口；主体检查用明确fixture，识别正反例仍另测；保留动作prompt并核追加禁字约束，默认15秒不变 | 换手补验该文件24/24；作者与另一clip约束文件合计31/31 |

其余51文件本轮通过，包含I5逐节点账本、最终候选同SHA、真实E3合成/工程包、QC、音频、规格、研究、S5与SQLite journal。通过各自只证明夹具覆盖的业务性质，没有真实付费供应商、视觉模型、浏览器或生产服务验收。

## QC缺陷到局部返工的整链

新增真实run→qcExecutor失败报告→耐久qc_rework→既有父席位定向通知→仅patch第二镜→run复审→实际ffmpeg MP4发布。首次发现真实缺陷：scheduler按旧轮依赖failed提前杀下游，即使依赖本轮正要重做；修为等本轮已入队依赖终态，仍失败则阻断。没有在测试主动清节点状态绕过。

实际调用为shot_a/shot_b/shot_b，第一镜SHA保留；支出0.4→0.6；新candidate SHA变化；publish SHA等于新candidate。缺陷含第二镜node/timecode/原消息来源，父qc_rework通知只1次。原E3解码及剪映/FCPXML真实内容断言保留。2测试34断言通过，日志`/tmp/eimu-qc-directed-integration-final.log`。critic派发与连续帧感知回执是明确夹具，非真实模型看过视频。

## 同代独立节点并发

仍用runProject/executePlan，未新造执行器。activeRunAdmission先耐久登记工作代与joinedNodes；主轮先关接收窗再等已接入工作，并汇总费用和接续targets。无依赖、未运行、未锁/pinned、服务端prepared节点才可接入；相同node/op去重，取消共用实际signal。

本域42测试252断言通过，含A未释放时B已执行、同节点去重、主等B/.6汇总、双abort/迟到不采用、finish关闭窗口拒旧代且B可下一轮执行、拒绝有依赖节点不污染主轮责任。非本实现作者execution_anatomy又补真实HTTP并发3/3，A的provider尚悬挂时B已POST；取消/finish边界保留，最终包括在入口15例中，由本验收者独立重跑通过。provider仍localhost夹具。

## 共同生成账本

共享journal7测试22断言通过；原image_generate.execute→HTTP→production routes/default executor→SQLite/store/runner已独立抽验HD n4、unknown不重投、精确确认隔离3测试21断言。S5 completed旧成功不因矛盾failed回执退款的独立反例修后仍保原费用，见[共享journal审计](independent-journal-audit.md)。最终入口其余新增回归需随作者冻结补验。

独立实际SQLite窄场景：graph cap=.5下label-A已用.4，切label-B再.2被拒；explicit project cap=.5下跨graph .4+.2被拒；另一可信owner同标签/request独立放行。SQL仅3行，总额1.2，无拒绝订单残留。`/tmp/eimu-independent-dualcap-B12qMx/journal.sqlite`实际目录2770、DB/WAL/SHM0660。

生产只读stat证明原DB/WAL/SHM仍0644，ACL命令缺失；这是明确发布前置，未修改生产。两个同UID Bun进程不是跨服务UID实测；本机未取得可用跨UID权限。最终站点/网关/runtime匹配发布、真实WATERLINE旧片制作和用户交付仍未验。

## 全批后新增的跨媒体财务断点

根侧抽查发现music/voice仍用旧内存reserve，而影像用共同SQLite。原musicExecutor经真实run、ArtifactStore、本地bridge成功回执与ledger独立复现：done、spent1、1产物、1次bridge，随后影像的实际reconcileJournalOperations因音乐没有影像receipt阻塞。证据`/tmp/music-image-proof-Ud5EqJ`。这是新发现真实缺陷，不能归为旧夹具。

原music与voice调用点现共用context作者提供的generationOperation port；生产组合根必提供，同graph_scope同SQLite单预留/结算，原bridge、speech、scratch和ingested ACK保留。新完成回执先耐久保存原文件及outputs/SHA，再结算；completed恢复实核字节后cost0，矛盾失败不释放已实扣。音乐未知只查原bridge result；配音无幂等证明且无已存rawSpeech时保持unknown，不再合成。旧音频按真实ledger、bridge/原sha与ArtifactStore证据逐单导入；旧voice缺key但原project/signature/take/attempt齐整时按原helper恢复，缺事实不抹账。

本域audio新增3个实际SQLite场景，原23项保留，26/26通过；与作者最新journal9项合跑35/35、205断言，日志`/tmp/eimu-crossmedia-audio-journal.log`。已验music1后image.5合法、换标签追加.1在同graph cap1.5被拒；unknown保1币、原bridge恢复调用1次、completed再回放0；voice按原字符价.004、回放0、未知不重合成。没有第二份reserve计数mock。

非音频作者execution_anatomy再以真实HTTP生产组合根验3条：music1完成→image.5合法（cap1.5）；删除仅fixture音乐journal行后靠原ledger/真实bridge result归属、实扣chargeRef、SHA恢复，无新音乐提交；音乐在途1+image.5在cap1.2时拒图且无第二预留；voice真实MP3/ffprobe→image总spent.503。本验收者随后独立重跑含这3条的入口完整15例，通过；没有真实付费调用。

网关tsc仍有session-generation-http等其他错误；本轮music/voice/run/scheduler新增代码未在日志中报错，不能因此宣称全网关类型检查成功。`git diff --check`通过。

## 最后受影响补验矩阵（与完整55文件批次分开）

2026-10-29 15:18:55–15:19:32 +08:00，开始diff SHA `ed9601fc4fc46501a5d42c4470cd5f5fda1e6f56661e526e054d767b2b04e44b`。按根代理要求不重跑无关55文件，只独立进程补受影响13文件。233 pass / 0 fail / 1449断言；日志、时间与清单`/tmp/eimu-affected-final-isolated`。最终交付清单由execution_anatomy汇总；后续任何源码变动须对应补验，此处不签尚未产生的最终SHA。

| 实际测试文件 | pass |
| --- | ---: |
| scheduler（含run与join） | 42 |
| store / store-restart | 19 / 1 |
| routes | 31 |
| generation-journal / project-ledger-index | 9 / 3 |
| submit-generation | 24 |
| executors/audio / executors/generation | 26 / 24 |
| exec-bridge-client / runtime exec-bridge/server | 10 / 26 |
| image-generate-entry（原tool.execute、同代join、旧CAS、混合链） | 15 |
| I5 ledger node id | 3 |

原55全批的734/6是一次真实历史结果；后续6项均已具名分类并定向通过，但本轮没有在最后同一个冻结SHA上重跑55文件，不称“全量同候选全绿”。最终仍无生产权限初始化、部署、真实模型感知、WATERLINE成片及用户交付证明。


最后恢复修订的定向补验（不重写前述批次身份）：generation-journal.ts修复accepted音乐已被真实recoverProject回收后仍停预留价的状态；已用原submitted身份、bridgeOperation、实际文件SHA与chargeRef/actual cost推进同一row completed。execution_anatomy换手journal10/10、45断言，S5 24/24、135断言，实际入口混合链3/3、23断言。日志 `/tmp/eimu-recovery-journal-final.log`、`/tmp/eimu-s5-frozen-final.log`、`/tmp/eimu-recovery-cross-media-final.log`。源码此后仅同域TS窄化，不改行为；最后bundle/tsc以candidate-content.tsv所列源为准。tsc退出2的25条均在原cba3b54b5基底30诊断中逐项复现，新增0；不是类型绿灯。
