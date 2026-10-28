# Remote 取证与语义阅读交接

交接状态：用户要求 relay，已停止新阅读、提取和工程执行。以下沿用中断前现成状态，本次未重新核验文件或生产。

## 硬约束

- 工程、部署、提交仍冻结；禁止付费调用、生产写入、重启或构建。不查询生产，不重导已完成的约524MB首批。
- 取证截止：2026-10-21T13:11:42Z。来源是导出时当前只读数据库/现存文件，不能冒充截止时历史快照；截止后改写须单列。
- 原始和派生 corpus 文件权限600，不进commit；不得打印凭证。模型说法、保存的思考、实际工具结果、真实产物与账本分别判定。
- 所有路径以下相对于 /home/lenovo/Desktop/image-app/docs/evidence/agent-evolve-20261021/。

## 已交付采集层（父代理已验收采集覆盖，不等于正文已读）

- `corpus/remote/manifest.json`：schema v2及旧版本链；总原始字节524373181。
- `corpus/remote/database-records.jsonl`：460387761字节，SHA256 `14331e464ad714f5d8cf4b6f8b4f3701ac6c607f35d80e16f9792f32df8d94c7`。
- `corpus/remote/supplement-records.jsonl`：60968347字节，SHA256 `c00698242c290fd7ad8a5937543b17f8269f983783911f29d61df050c1107437`。
- `corpus/remote/actual-operation-records.jsonl`：97210字节，SHA256 `9973ac9dde61b18e637dd47d9002591523579bdcebfdf171f4ca1c36ab834ae4`。
- `corpus/remote/extra-text-records.jsonl`：500935字节，SHA256 `36d1df0efc112652081c4198c3e8e8d63ac9a84e432f1e04a4d802049085271a`；12份代码材料附录。
- `corpus/remote/full-tool-output-records.jsonl`：2418928字节，SHA256 `b3583eb131a457a9c8423f19d6860089a1b9d320535a8ff90f92ccc3fca9d926`；最后5份完整长回执2250463字符已追加，不能再把原截断part当完整。
- 同目录各批 `*-manifest`、`session-manifest.jsonl`、`file-manifest.jsonl`、`supplement-scope`等保留来源、hash、记录数、缺失类型、版本链。
- 覆盖98个OC身份：28在当前库、70当前不在；后者不是默认“已删除”。28个GW候选、68个run。456个去重文本路径；104份转录/meta（52+52）已取。依据真实parent/header/call闭包，历史正文提及不无限扩历史库。
- OC记录：5625 message、18683 part、58187 event、28 session。part类型含text3697、reasoning3573、tool3347、step-start3964、step-finish3937、compaction165。
- GW层：consumers56、receipts943、sessions9、steer2、critic4、deliveries241、durable runs68。
- GW现存bounded replay 6904帧，不是全历史SSE。OC `message.part.updated` 32145是保存的累计快照，不能称provider原逐帧delta。只读现存已提交WAL视图，未读取删除页、未备份整库。
- `corpus/session-inventory.json`、`corpus/actual-operation-candidates.json`由evidence路维护；`source-loss-evidence-overlay.json`含他路实际DELETE/rm证据。不得把已知少数删除推广至全部缺库身份。

## Canonical与阅读层

稳定层：`corpus/remote/canonical/reading-v2/`，包括 `units.jsonl`、`occurrences.jsonl`、`binary-payload-index`、`session-index`、`shard-index`及 `shards/00001.jsonl`等。

- 1..3590原稳定片；3591..3605代码附录；3606..3793最后5份完整长工具回执。编号不可与另一套新line-reading-v2混用。
- row字段：unit_id/category/first_occurrence/represented_message_bindings/occurrence_count/fragment/fragments/body_fragment。file_line的body_fragment可能是JSON封装字符串，可JSON解码展示；不得截正文。
- binary共256个、202704892字符；原始载荷保留并hash引用，阅读不必把编码当文本反复读。
- 独特内容量：message2632条/4342129字符、reasoning3529/5147414、tool7144/16466767、message metadata5625/2285734、metadata event15379/7850129、file_line30665/2137769、transcript:text71640/2774659、transcript:tool3917/406843。统计不是已读声明。
- evidence路是新 `line-reading-v2` 精确逐行复用层的单一owner，不得并发改其派生文件。它保留原顺序、offset及occurrence；领取前请确认新编号与旧unit范围映射。
- 旧 `exact-evaluator-read-reuse.json` 的大多数匹配只是结构字段，完整body等价仅31项/329字符，不能据此前缀或相似度跳读整片。

## 本路阅读准确断点

父分配本路旧reading-v2片00001..00900；canvas原00901..01800；evidence01801..02700；root02701..末。各路可能尚在完成本机evaluator阅读，不能把预分配当已读。

**本路正文已完整实读00001..00086；持久阅读账本仅登记至00082。**

- `read-ledger-remote-control.md`：当前1..82 FULL_BODY_READ，83..900仍UNREAD；显示82已读/818未读。
- `read-ledger-remote-control.jsonl`：逐已登记片的reader/hash/bytes/read scope/end marker/time。
- `read-ledger-remote-control-offsets.jsonl`：预建900片unit/fragment/raw offset/source_line，status已登记到82。
- `remote-control-findings.md`：已写至73..82批；83..86发现尚未追加。
- 83、84、85、86正文已全文读完且见END标记，无截断。恢复时先把83..86补登记并追加发现，再从87开始，**不必重读83..86**。补登记后应为86已读/814未读。
- 第55片曾显示层略去一段，已独立完整补读B12 source_line13 QC，结束标记END_FULL_00055_GAP_REPAIR；55视为完整。
- 读取高中文密度片时functions.exec外层需max_output_tokens约17000、内层exec_command约16000，避免默认10000二次截断。每片按first_occurrence.path/source_line重排便于关系理解，不删body；fragment原offset仍留账。
- 临时functions.store中曾存54..86片meta，但不能依赖跨relay运行时仍在；根据稳定片与既有账本格式补登记即可。无需新采集。

## 83..86尚未落盘发现（均为文本层，原tool/成品/账本未因此独立验证）

83：79be结构全文确为77bar：Intro8/V1 12/V2 8/C1 12/Interlude6/V3 8/Bridge6/C2 12/Outro5，支持前述critic对“77被误引63”的反证。7a289eca JJstyle研究明确未亲听、未频谱，旋律/声区多为经验；部分source截断或空正文未采用，BPM折半来自自动数据/教学而非实测。设计模板不等于成品。

84：7aa9夜班metro为A72BPM72bar4min、B84BPM84bar4min，仅设计无音频/critic，最初坐车题材与后保洁故事须按任务演变区分。7aba B探活把first_ready/hint推断成“提交必回落付费”于是零提交；这只是作者预判，与已读真实full仍YuE失败的回执不一致，不能采“必回落”为事实。锁88BPM时262/242=108.3%，词稿100BPM口径95.3%，作者并列没擅删锁词。

85：7aba明确probe不是实际生成、0generation，也未拿A独审顶B。7b272毕业词603秒输出只有起草计划，没有歌词。7be B13重派复用6queued未新提交，为文本层防重复正例待tool核。7d880歌词v3定向修改237词，原评v2 FAIL6.5，v3未独审。7e334对替你留城复核如实指出clip30绕YuE路由偏航；ASR漏后半不能证无人声；glob查空不能证文件从未存在；melody_notation是设计非成品测量。7ebd A独审D到Bb为下行4半音，纠正前任务错称小三度。

86：7eff B11末queued无产物，capabilities误报与download可回执并存。7fbb30a0（OC ses_ea3224779ffeGAXjl41Kx2a6li）只改英文第4/6/7行，未写文件、旧out不覆盖，无旋律实测；总136/242=56.2%。7fd短窗watch实际8samplequeued、0新frame；f105 failed120min未provider提交，不能写已退款。80bf编曲重派正文称search_web4次402，smart_search只回自动生成账号凭据而无结果；本片没有凭据值，不能说已核泄漏或已拿搜索结果，需原tool核。826重提B15–17共64受理/预估192不是实扣，缺getresult/download，report namespace不是平台project；本地无bytes不能排除旧在途，taskid不同不等于工作不重复。83f0 B06主动偏离“逐帧终态再下一张”：等首张9min后为时限改成仅受理即提下一张；作者无duplicate声明未核。85fe研究的物件/时间/禁词等硬条来自自计数和推算，不是权威标准。

## 已登记发现的入口

`remote-control-findings.md`记录53..82：授权/取消与停止工具并非同一状态、probe健康不等生成、clip30实际160秒、不同prompt字段丢防错数值、报告上传notfound被误称成功、无独立听审却PASS、只局部复审放行全作品、旧文件名覆盖造成身份混淆、queued受理/预估币与实际成品/结算分离等。上述均保留证据层级，不能升级为全量最终根因。

父代理已独立读到真停止后扣费链：b857相关music source_ref、FlowMusic request_logs303及三clips可恢复；另A6 dispatch前取消、A2 probe可能被当提交、D9授权声称是不同链。父已报SSE断线曾由其它验收agent全局pkill误杀导致；不可再判产品hang。本路未因此冒称自己已读其原evaluator片。

## 凭证遮蔽状态

- `corpus/remote/ticket-display-review.candidates.json`：按完整JSON重组、ticket字段/赋值/URL参数扫描，候选0；模式覆盖有限。
- `corpus/remote/canonical/reading-v2/ticket-next-region-review.json`：75..100对应完整unit文本扫描。
- `corpus/remote/ticket-pattern-review.json`：本轮remote全部6614个文本副本、2916592169字节内部扫描upload-ticket固定形态，0命中。未打印值，未改副本，因此原hash不变；不代表绝无其它形态secret。
- 较早credential-display-review做过完整unit嵌套string的短内部token/header候选审查；3候选为普通词/变量，非真实值，同样不构成绝对保证。
- 本机evaluator短内部token、upload票据由evidence负责同长度遮蔽及hash链；remote无命中未变更。后续新疑似值先在本轮副本mask再模型阅读，禁止打印值或片段。

## 未完成与恢复顺序

1. 补记83..86真实已读及上列发现；保持原hash/offset，不把补记时间伪为阅读时间。
2. 继续旧reading-v2 87..900，或先与evidence核新line-reading-v2对等映射后迁移，避免重复读累计partial与已读全文。
3. 各路完成全体关联材料语义阅读前，不收敛最终根因，不以统计冒充已读，不恢复工程。
4. 历史草案保留但未闭环：questions真reject与pending保留、admission失败503、job-store intent/version/cancel状态、abort未来提交撤销等。music真入口未全部接线，无新增paid-execution任务系统，无作者自验、无提交部署。相关 `cancel-change.md` / `root-cause-control.md` 只视冻结草案。

本次交接仅写本文件，无新提取、验证或工程变更。
