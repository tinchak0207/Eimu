# 工程执行与接续责任（2026-10-29）

隔离树基底 cba3b54b5；本片未提交、未部署、未调用付费上游。

已原地接通：

- `runProject` 在收尾时把本轮执行身份、原 targets、具体待办和责任写进 `ProjectGraph.continuation`。作者内容、结果未知、必要用户动作、平台故障、QC返工分开。执行完成只要求父席位核对真实交付，不冒充整单完成。
- `ProjectStore` 先提交 project.json，再通知现有 `onProjectEvents`。未提交或原子rename失败的事件不能引发唤醒。重复或旧执行代的finishRun不能覆盖新责任。
- 原事件消费者在 `run_finished` / `node_output` 发生时消费责任，复用既有父席位 note 唤醒；父回合忙时等既有 idle flusher，无轮询定时器。投递前在图里占位 delivering；超时记 unknown，启动时遗留 delivering 转 unknown，不盲重投。仅 pending 在重启时可投。投递状态不等于消费ACK。
- 等待的作者产物或未知订单产物真正写回、节点done且有outputs时，原责任完成，只创建一个原 targets 增量接续任务。无关patch不唤醒。QC缺陷原文落任务，唤父定向返工；不会自动对同一素材重新打分。
- 用户stop接到真实 AbortSignal，包括后台执行与在途通知；首轮尚无continuation时也耐久写入撤销身份。迟到执行结果不采用；旧回调不得重开当前制作。已经提交上游的任务/费用不虚称取消。
- 普通run遇到既有inflight不得覆盖操作身份。恢复默认只对账；只有服务端真实auto/full仍有效才可同key重提。多take submit_unknown也不能通过恢复分支重新提交。

验证（独立临时工作目录、真实ProjectStore/patch/artifact文件，外部生成与唤醒为无付费stub）：

- scheduler.test.ts：35通过，覆盖原有缓存/预算/并发/未知提交，新增首轮stop在finish前已耐久、真实signal中止、迟到结果不采用、再次run不覆盖inflight、无授权恢复不提交。
- routes.test.ts：31通过，新增投递前占位、作者write_result事件接续、重复事件去重、父回合在途让位、平台故障不唤、超时unknown跨重启不重投、崩溃delivering不重投、启动pending投递、在途通知stop。
- store.test.ts与store-restart.test.ts：19通过；新增提交后通知和rename失败不通知。合计85通过。
- 网关tsc实际执行：`bun node_modules/typescript/bin/tsc -p deploy-staging/gateway/tsconfig.json --pretty false`；全树存在其他域类型诊断，本片run/routes/store/scheduler/index/session-read无诊断。日志 `/tmp/eimu-continuation-tsc.log`。没有宣称全树类型检查通过。

边界：这片可靠地接回父席位，未证明模型收到后必然正确派工，也未跑真实影片端到端。未知通知当前不自动重投；作者实产写回可以确定性解开原责任，但没有消费ACK时保持unknown。平台故障仅具名由operator接手，未加自动修复器。旧工程评审接线通过已有作者的upgradeLegacyVideoCandidate在run准入前升级；不安全定制图给出具体拒绝原因。没有把局部无付费夹具冒充生产或无人值守制作全闭合。

后续独立Hack修正：不能用每轮runId制造新接续任务。当前任务身份按待办kind、相关节点输入/版本/产物、原targets和有效目标摘要生成；重复缺作者的run沿用delivered，同成品全复用沿用unknown，真实输入改变才产生新责任。`run_started`不再伪造用户取消，仅保留旧投递未知并阻止并发消费。新增两个真实runProject反例回归通过，scheduler现37通过。完整count更新：scheduler37+routes31+store/restart20=88（其中scratch权限测试属于下一片交叉验证）。
