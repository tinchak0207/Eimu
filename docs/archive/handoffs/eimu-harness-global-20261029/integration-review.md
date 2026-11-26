# 接续、上下文、音乐：非作者验收记录

验收者不是 context/continuation/音乐实现作者；曾参与 QC/export，不将自己的 QC 测试算独立通过。隔离树基底 cba3b54b5，期间作者并发改动，以下覆盖不能代替最终锁定候选。

读取中 tracked diff 指纹先后为 `a167f4984c4b6c357f3673e698bf79d96f79f195916c79cbfa9f55c04b8c35ba` 与 `4c4af563b08462b92b5f72f5e0c7b0dd4b7edd4bea9f7a70ba535b8128835b92`。这两个仅指 git diff --binary，均不包含新文件；不宣称是完整发布内容清单。

第一轮目标测试实际结果：

- routes/scheduler/store/context/plugin：111 pass，0 fail，1502 assertions，950ms；日志 `/tmp/eimu-independent-context-continuation-final.log`。覆盖投递前占位、unknown不重投、取消signal、迟到worker、同输入责任不重复唤醒、legacy历史/附件/手艺保全。
- runtime exec-bridge + music/audio + bridge client：56 pass，0 fail，288 assertions，1458ms；日志 `/tmp/eimu-independent-music-final.log`。覆盖真实本地scratch故障、回执落盘后重启回收、跨身份同key拒绝、实际指纹不符拒收、预检失败0上游调用。供应商均为本地假工具，不证明真实出曲。

本轮主动找的三个反例已交原作者：

1. **旧 worker 未 abort 的跨执行代落结果。** 初读 commitNode 只判 signal、finishRun 才判代，存在写新图候选风险。原作者补 activeRun guard 与 deferred旧worker测试；本轮111绿包含新用例。该单例不能推出所有跨进程租约情况已覆盖。
2. **原话有耐久索引却无合法读回入口。** legacy事实投影只列近8条原话ID，冷启动后旧原文可能只在graph.brief，project_get早先无brief视图。已交context作者补按出处读原文；等待最终候选验证，不能把“图里有”冒充“模型能读”。
3. **桥done文件在网关入库前丢失/篡改。** 原POST/GET done缓存未核本地文件，24小时内会一直回缺失路径而不重回收。原作者已加stat/bytes/sha，不符只用持久musicReceipt再取；作者报告新增用例done→删除→GET恢复→同字节数篡改→POST恢复、生成次数始终1。此最新补丁在上述56绿之后，须最终换手复验。

49个旧失败的分类：四电影BAD_REF、custom E3阻断属于本轮真实回归，已修并换手复验；其余I7/I5/I6/arena连带必须在最终整候选复跑后判断。spec签名新增项、QC JSON数值、candidate与publish分阶段属于契约变更，测试必须保留独立业务期望维护；不能删断言让绿。submit-generation旧日志是price_unknown候选；检查时尚未接新journal，不能推断它被新loader阻断。作者随后接factory须按实际输出复验，不绕价格/预算。clip与部分类型错误需对照基底，尚未确认全为存量。

QC/export作者侧最后发现的ZIP误送ffprobe另由非作者换手：实际媒体才解码，工程包仍实算SHA/bytes、ZIP CRC、结构、包内素材引用；不删附件换绿。最终E3解包结论由换手者提供，本记录不替它宣布通过。

后续换手发现ZIP校验超时。对原101510字节剪映ZIP实查：`/usr/bin/unzip -tqq`即时成功、文件无损，而PATH默认`unzip`命中用户目录包装器。改为与既有E3相同系统绝对路径，不安装新工具；按真实builder区分剪映`materials/`和FCPXML`media/`，保持包内引用验证。此修正继续交非作者复验，尚未以作者检查宣称通过。

尚未执行最终锁定内容的全project、相关runtime、gateway bundle与tsc。无付费、无生产操作、未提交发布。


后续非作者与集成（2026-10-29，本地、未发布）：

- scheduler 39/39、229断言，`/tmp/eimu-scheduler-independent-latest.log`。
- 实际原tool共同入口最初8/8、57断言，含真实HTTP/生产runner/共享SQLite（provider为本地fixture）。
- join新增非作者3/3、26断言，`/tmp/eimu-tool-join-independent-final.log`：A悬挂B仍提交同activeRun；共同取消收到实际夹具退款回执，旧回调不写新代、C可执行；根A结束而join B仍运行时保留同代，B结束后才清activeRun；旧journal+owned receipt成功恢复真实图中reference产物0新POST。
- retry_task_id省略request_id的合法旧调用1/1、9断言，`/tmp/eimu-tool-legacy-id.log`；服务端核实真实旧operation，wrapper不覆盖。
- 同参数新request_id主动重拍1/1、6断言，`/tmp/eimu-tool-new-take.log`；两次生成返回不同node/task，未把输入hash当operation身份。
- compile/decompile/真实DSL写读执行相关31/31，`/tmp/eimu-compile-integration-final.log`。

第一轮join取消fixture端点404只证明上游取消未知时隔离仍有效；最新3/3使用真实本地取消响应200/previous queued/refund .5。没有将它说成实际付费供应商取消。

类型检查分类：`bun node_modules/typescript/bin/tsc --project deploy-staging/gateway/tsconfig.json --pretty false` 当前退出2，25条诊断；从git cba3b54b5原样提取gateway与其静态依赖sandbox.ts到临时基底，用同一编译器/依赖运行，基底退出2、30条。按文件+TS码+完整消息的多重集比较，当前25条均在基底复现，本轮新增0；本轮消除了旧export3、qc1、patch1。不能写tsc绿。

| 当前仍红的文件 | 条数 | 分类 |
|---|---:|---|
| device-bridge-types.ts | 1 | 基底复现 |
| project/completion-admission.ts | 1 | 基底复现 |
| project/executors/sentence-constraints.ts | 1 | 基底复现 |
| project/lanes.ts | 1 | 基底复现 |
| project/ledger.ts | 3 | 基底复现 |
| session-generation-http.ts | 18 | 基底复现 |

日志 `/tmp/eimu-gateway-tsc-final.log`、`/tmp/eimu-gateway-tsc-baseline.log`。最初调用bunx/tsc shebang受本机无node PATH影响，是命令环境故障；改用现有Bun运行同TypeScript编译器。第一次临时基底只提取gateway导致sandbox依赖缺失1条，补齐原基底sandbox.ts后再比较，上表不包含该临时归档环境错。

Gateway本地bundle已成功：`bun build deploy-staging/gateway/index.ts --target=bun --packages external --outfile /tmp/eimu-gateway-final.js`，305 modules、3.23MB，日志 `/tmp/eimu-gateway-bundle-final.log`。bundle在最后旧ref小修前，待根侧freeze后补一次受影响bundle/tsc并记录包含untracked源码的完整manifest；本报告不把分散diff hash称为最终候选。


最终受影响复验：入口整文件15/15、113断言，`/tmp/eimu-image-tool-entry-final.log`；runtime bridge/audio/client62/62、326断言，`/tmp/eimu-runtime-audio-integration-final.log`。最后common factory/music/voice修复后gateway bundle再成功305 modules/3.24MB，tsc再次退出2、25诊断，仍与同编译器的基底30诊断逐项比较无新增。运行命令与日志路径同上；初次脚手架与中间候选的数字由这组覆盖的最新结果替代。

跨媒体真实HTTP顺序阻断已复现并交原作者消因，最新同例音乐→图cap1.5成功；音乐在途1+图.5在cap1.2只允许音乐1，图0POST0新journal row；原voiceExecutor真MP3/ffprobe→图spent=.503。真正旧音乐恢复通过删测试journal行模拟无新表历史，由原ledger/bridge归属与SHA/chargeRef原位导入，不再生成音乐。该夹具没有真实付费供应商；不是生产费用或艺术质量结论。
