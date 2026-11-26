# 工程事实原路径增补

候选基底 cba3b54b5，隔离工作树 `/home/lenovo/.codex/worktrees/eimu-film-continuity/image-app`。未提交、未发布、未调用付费上游。

已实现：`project/context.ts` 新增 `projectFactsResponse`，复用 brief 目标卡和 digest。legacy 席位通过原 `/internal/project/context` 返回 append 模式，包含工程版本/事件游标/目标来源版本、原话来源、状态阻塞、在途未知、人工锁与工件索引。`eimu-guard.ts` 只追加该投影，保留原历史、工具回执、附件，并继续原有目标卡历史水合。原有 lean 窗口不变。投影失败明确 unknown；无图返回 absent、不创建假工程、不负缓存以免藏掉本轮新建工程。每步去掉上轮自己的投影再读，撤销后不残留旧状态。

`digest.ts` 导出 `effectiveGoalRevision`，以真实 brief、targets、decisions 内容计算 SHA256，不受 graph seq/version、节点执行、文档和 QC 状态变化影响。候选/评审作者复用此函数。

修改范围：context.ts/context.test.ts、digest.ts、routes.ts 的 handleContext 与必要 import、routes.test.ts、runtime plugin/eimu-guard.ts、vps-tools/eimu-guard-context.test.ts。

验证：

```
bun test deploy-staging/gateway/project/context.test.ts deploy-staging/gateway/project/routes.test.ts deploy-staging/vps-tools/eimu-guard-context.test.ts
49 pass
0 fail
1110 expect() calls
Ran 49 tests across 3 files. [583.00ms]
```

实际日志 `/tmp/eimu-context-tests.log`。`git diff --check` 无输出。首次测试有 2 项环境失败：隔离树缺 `@opencode-ai/plugin/tool`；复用主树 runtime node_modules 后通过，无安装。测试中原有 fake SessionState 缺 sseReplayBuf 会打印 canvas bridge 警告，未扩展修复。

回归来自 WATERLINE/NIGHTBLOOM 事实要求：保留原始 MV 委托与后续修订、submitUnknown、现存工件；新 legacy endpoint 可读；插件保留所有旧消息和附件并幂等更新投影；网关超时明确工程未知。

局限：这不是完整艺术目标解释器。brief 仍使用现有折叠；所有真实原话追加都会保守改变目标来源版本。没有验证真实长任务多次压缩、重启与实际成片交付；49 个测试不能替代该路径。

# 第二片：目标字段来源

已修两处自动配方入口（messages-gw-types.ts projectIngressStore 与 context.ts acceptProjectIngress）：系统套配方用 engine actor。patch.ts 的 apply_recipe 在内层也强制 default 来源，即使外层来自真人点击，也不把模板三镜伪装成用户要求。默认只填空，不覆盖现有导演规划或真人值。

Targets 新增逐字段 sources（default/agent/user、真实消息引用、解释候选标志、revision/supersedes）。set_targets 合并字段，代理只可修改非真人锁字段；保留旧版没有 sources 的真人锁，并在首次增量修改时为所有旧字段恢复来源，避免其他字段更新把旧锁意外洗掉。真人60→90的结构操作能覆盖并记录替代关系；代理引用真实 messageId 仍是解释候选，不能借引用升格为真人身份或越过真人锁。

project_patch 的可选 sourceMessageId 贯穿工具schema与PatchOp；必须引用本工程实际brief，evidence从brief取，不接受模型传入的所谓证据。digest显示字段来源、候选标记与替代索引；目标内容版本纳入来源kind/messageId/interpretation，但不含来源时间戳和文档/QC状态。

第二片验证：

```
bun test deploy-staging/gateway/project/patch.test.ts deploy-staging/gateway/project/context.test.ts deploy-staging/vps-tools/eimu-guard-context.test.ts
85 pass
0 fail
1217 expect() calls
Ran 85 tests across 3 files. [173.00ms]
```

日志 `/tmp/eimu-target-focused-tests.log`。共享树另一次包含 routes.test 的批次得到115 pass/1 fail，唯一失败是另一作者正在修改的恢复语义：routes.test.ts:730期望done而返回manual，已交还恢复作者分类，未盲重跑或修改无关实现。完整日志 `/tmp/eimu-target-tests.log`。

剩余边界：未自动解析复杂口语、授权和艺术目标。普通用户纠正仍在brief和原话投影中保留；agent解释候选不能替代原话。旧工程已经错误标user、又无来源的默认值，无法凭“默认恰好也是3”安全自动解锁（可能确为真人点过3），本片保守保留旧锁；真实历史恢复应凭具体入库事件和原始要求处理。supersedes指向耐久工程旧版本中的来源revision，未增加另一份手工目标账本。

收口修订：legacy 工程投影不再重复 renderGoalCard，原话只由旧插件全历史水合路径统一渲染；新增最终模型消息manifest断言：目标卡恰好1份，原始MV要求和后续“保留副歌/不降级静帧”都在。patch.ts原有budget分支的Json窄化改为显式number检查，保留运行行为并消除该TS诊断。

恢复作者修复旧恢复夹具后，最终相关四文件测试：116 pass / 0 fail / 1419 expect() calls，683ms。日志 `/tmp/eimu-target-final-tests.log`。该结果替代前面的中间失败，不代表真实生产成片验证。

目标协议经独立 Hack 后修正：原话账本版本与制作版本已分离。`briefLedgerRevision` 包含全部真实brief，用于真正交付前核对；`effectiveGoalRevision` 只包含结构targets/来源角色、用户decisions和当前未被替代的制作解释候选，新增一句“进度怎么样”不会变制作版本或触发重渲。工具的可选 `set_targets.interpretation` 支持 sourceMessageIds、requirements、supersedes、statusOnly；空targets可登记纯艺术解释，statusOnly不能同时改目标或撤销制作解释。仍是原actor的候选，不产生用户权限。

未登记解释的原话不会阻断研究/工具，旧legacy不用新字段也能做事；真正交付前交独立critic核对全部新增原话与解释。媒体候选不因原话账本新增自动失效，发布侧应明确review_required，仅核对目标变化；该接线由最终交付作者负责。状态答复本身不触发制作/审片；“已经评片后新增状态询问，再明确要求发布”可能多一次目标核对，不能宣称解决任意语义识别。

本片最终聚焦回归：86 pass / 0 fail / 1235 assertions，184ms；`/tmp/eimu-goal-protocol-tests.log`，涵盖账本/生产版本分离、状态不重渲、艺术解释可替代追溯、引用不存在原话被拒、不能借status删除制作要求。`git diff --check`无输出。

# 共同生成预算端口（仅第一格，尚未切换工具）

新增 `gateway/project/generation-journal.ts`，组合根从明确 runtimeDir（生产默认workspace/.opencode）解析真实lib/image-journal.ts，校验合约版本1，直接加载原函数；不复制SQLite写入器，不相对import生产不存在的兄弟源码树。失败具名generation_journal_unavailable，绝不退回直接POST或新预算。`generation-scope.ts`为既有project-budget端点和新端口共用的owner/project作用域格式。

原 `image-journal.prepareSubmission` 只新增 `{created:boolean}` 原子返回，既有调用者忽略返回仍兼容。共享端口只有首次真正新增提交意图才给submitAllowed；重复、unknown与已accepted都不能取得新POST许可。accept复用原受理/registration同事务。普通图节点传lock=null，不把用户没设置的风格冻结；prepared工具仍用原冻结结构。均按同一真实owner+显式project跨session共享原表预算。

真实SQLite端口回归：5 pass / 0 fail / 15 assertions，36ms。覆盖单op只1行0.4预留、同project跨session及graph/tool混用的累计cap、普通图不冻结、prepared拒绝改profile、受理恢复收据与旧单不重投、运行依赖缺失具名阻塞。首次夹具在lazy journal建库前打开readonly连接导致SQLITE_CANTOPEN，已修为首次只读API触发建库后再开检查连接；非生产错误。

边界：这是共同端口行为，尚未把submitGeneration/image_generate真实接到端口，不宣称共同runner已完成。后续必须所有graph生成与prepared工具选同预算端口，避免一半仍用旧进程内表；存量只能按operation/receipt逐笔对账，不能把总额粗补或归零。新端口目前不导入未知旧订单、不改权限余额。改动的job-delivery只有原scope计算抽到共享纯函数，协议值不变。

# 共同runner后续实现（替代上述“尚未切换”中间状态）

现在原image_generate保留预处理并走projectGenerate→可信session/actor generate路由→原patch节点→原runProject/executePlan→原createSubmitGeneration→原SQLite journal。原POST不再有独立旁路；image/video n1..4保留，quality/规格/音轨/refs/style/frame/原payload均由signed toolSubmission透传；服务端重新报价并核真实full/auto或持久confirm原操作/模型/参数/金额，不能以body confirmed授权。受理只在journal+receipt+node inflight耐久后报告task_id。

同一稳定op只reserve/POST一次；unknown持原request_id不自动重投。新request/take保持真实新拍；已完成恢复优先持久成功receipt，不轮询导致矛盾failed抹掉实扣，返回新增0与原cost分开。旧S5账按真实ledger+receipt/node/session/signature/task/cost逐笔幂等import，已完成可继续新take；无证据保unknown，不粗补总额。只读增量ledger索引保持持续UTF8解码；EACCES/IO/损坏行拒新单，只有新账本ENOENT作空。

原工具旧task恢复须owner/project同journal+durable receipt匹配；无图的成功旧产物入既有artifact-store、加只读reference节点与legacyGenerationRefs，原taskID保留，无生成/新增扣费。证据不足具名legacy_reconciliation_required，下载失败具名legacy_artifact_recovery_unknown，原引用仍存储可接续。

旧专家真实活跃委派且原lane未定义可由服务端按child+request领取新独立节点，耐久记录toolLaneSource；显式lane=[]不扩、受限工程lane不越界、终止子会话不生成。原lane唯一同type节点可兼容无node_id旧调用。不同独立prepared节点加入同activeRun的能力由run作者维护（joinPreparedNode）；主工作代关闭接收后等待已登记join，取消共signal，非作者正在验真实跨镜并发。

后端当前聚焦：`bun test project-ledger-index.test.ts generation-journal.test.ts submit-generation.test.ts specs.test.ts`实际65 pass/0 fail/423断言，339ms，`/tmp/eimu-generation-backend-final.log`。S5采用真实runtime模块与隔离SQLite，禁止旧budget.reserve；包含已完成矛盾failed不退款、旧S5逐单import、新take不吞、跨scope工程硬cap、跨进程唯一预留、UTF8半字符和IO未知。工具作者真实HTTP入口8/8，57断言，15.28s（`/tmp/eimu-image-tool-entry.log`），涵盖HD4张/旧专家两新单与停止/视频n4/同key并发/unknown/确认；更晚join与升级前旧单补测尚待其最终回报。

明确未统一的合法能力：image_edit/upscale仍在原client入口，已补原journal CAS许可防同key双POST；render3d/其他独立工具不因本片被删除或宣称全已统一。免费/真实上游、生产UID共享写、生产自然语言到成片未验证。共享journal目录/文件权限及acl安装前置详见release-dependencies；本机无sudo授权，不能把两进程验收写成跨UID通过。无提交、部署、付费。

# 最终冻结补充

当前共同执行/生成币账范围是 **keyframe、clip、music、voice**。音乐和语音仍用原bridge/speech实现，只把既有稳定op的预留/恢复/结算接入同一SQLite，产物仍经原执行器入库；原内存预算不再为这两类生产执行重复预留。`generationOperation`从productionDeps透传ExecContext，同graph_scope同时约束音频和图像/视频，不能换显式project标签绕工程cap。

旧音乐逐笔核对真实bridge.result的cost/chargeRef/全部文件sha，再实核artifact-store；旧voice核原完成账行与实算产物sha。旧voice completed曾漏idem_key，只在tts-zh及原project/signature/take/attempt齐整时调用它原来的idempotencyKeyOf恢复操作身份，显式标来源；不能识别的正费用历史行保unknown并拒新提交。未完成音乐只查原bridge，未知voice没有幂等证明不重合成。导入旧完成音频登记原outputs与原cost，恢复新增费用0。

clip兼容核对发现并修复本轮真实成因：JSON参数toolSubmission的空默认{}不能等同真实prepared订单，现只有payload+identity.request_id完整才走原工具载荷路径。普通graph仍保原prompt处理和原主体检查。旧generation夹具补真实session_api委托、明确注入主体oracle（独立clip-admission仍测正反例），保留原动作与既有禁字合同、参数/入库/ACK断言，不下调生产闸。

最终按文件独立进程的作者证据：ledger-index3/3（UTF8半字符、IO未知、旧voice身份）、shared journal9/9（真实SQLite双scope/权限/多进程）、S5 24/24（含同步真实产物稳定receipt与恢复不再POST/poll）、generation+clip-admission31/31，日志分别`/tmp/eimu-ledger-index-final.log`、`/tmp/eimu-journal-final.log`、`/tmp/eimu-s5-final.log`、`/tmp/eimu-clip-compat-final.log`。音频作者music/voice26/26与其同SQLite混合cap回归不代签非作者整链。一次把多套全局env夹具合到单进程导致目录缓存污染，已停止该跑法；没有据此修改生产路由或减少断言，最终由非作者按独立进程全project分类。

本域已冻结交非作者execution验真实跨镜并发/取消/finish竞态、旧无图订单产物恢复、跨媒体音乐→图片与并发硬cap、bundle及TS增量。上述局部绿灯不替代其结果。image_edit/upscale继续原实现加同journal CAS，3D等其他合法工具原能力保留，均不宣称已共同runner化。真实付费上游/生产激活/跨UID写和最终成片仍未验证，本轮未提交、部署、付费。

最后精确恢复修订：真实recoverProject桥恢复只更新graph与产物/spent，没有写completed ledger；单凭原journal元数据吻合而跳过会使accepted预留价长期残留。共同对账现可用同op bridgeOperation实际恢复产物与lastRun实际费用，重新核真实bridge.result实扣/chargeRef/全批次sha和artifact后，将同一row推进completed实际金额；已completed/refunded不回退，未知保留原预留。生产只改generation-journal.ts，没有改recovery/run/执行器。新真实recoverProject+SQLite回归实证accepted预留1→completed实扣0.8，之后上游矛盾failed仍completed0.8，新增bridge.call为0。受影响独立进程journal10/10（45断言）、audio26/26（169断言）、scheduler42/42（252断言），日志`/tmp/eimu-{journal,audio,scheduler}-recovery-final.log`。随后交非作者刷新受影响入口/类型/bundle，整个源再次冻结。
