# 音乐桥原操作与本地故障回收

本地隔离候选，未提交、未部署、未付费。生产WATERLINE旧单没有冒称已恢复。

实际断点：桥`runMusic`先等待上游出曲，后建0755交接目录并下载。已付费以后EACCES可以被包装成provider_error并缓存。网关music执行器若后续ingest抛异常，也没有保留这一具体回收状态。

现有桥原位修改：

- gateway的ProjectStore只准备本工程`tmp`为2770，继承projects共享组；必要时只调整该受控tmp的gid。0022不再抹掉共享组写权限。不递归chmod，不碰用户资产，拒绝symlink。runtime只设置本操作目录，并在提交上游前验证实际写入权限。
- 真上游成功回执先写入现有operation记录（只选音频URL/inline内容/费用等必要字段），再回收媒体。下载/入库/磁盘失败返回platform_fault，已出曲则带recoverable，仍用原key取回；音乐执行器不退款、不换新单，scheduler保留inflight。
- POST操作身份绑定session、project、node、signature与完整参数；同key不同归属或输入409。并发join也核验。result GET必须带同一归属tuple；旧记录缺来源不会把缓存发给新请求，也不重投。
- 桥回传实际文件sha256；music入图与恢复均实算核验，不符不采用。只沿真实操作回执恢复，没有放宽write_result或接受任意URL。
- 桥现接内部`ingested` ACK：只在当前代节点持久提交、ArtifactStore实核SHA后发送，正常完成、恢复、缓存复用及启动扫描可按同身份补发。桥再次核原session/project/node/signature/runId、完整源指纹及同工程artifacts文件真实字节后耐久登记。ACK前TTL不清音乐；ACK后TTL只清桥tmp副本和原始大回执，保留操作身份，不删除ArtifactStore产物。它不是用户下载/消费ACK，GET也不当接收证明。

验证：

- runtime exec-bridge/server.test.ts：25通过。包括上游已回真临时音频后把本地目录破坏成文件→platform_fault/recoverable→丢桥内存重启→原receipt回收，工具累计1次；不同session/project/node/payload拒缓存、result拒错误归属；提交前目录坏工具0次；消费未确认时TTL不清音乐。另增done文件删除与同字节数篡改后，GET/POST各沿原receipt恢复，生成仍1次。下载字节与sha由测试独立计算。
- gateway audio.test.ts + exec-bridge-client.test.ts：32通过。包含真实HTTP桥客户端；新增ingest EACCES保留原操作、不退款、同key恢复；回执sha不符拒采用；scratch ENOSPC在桥调用前失败。
- store.test.ts：19通过，含只改tmp权限、保留0600用户文件、拒绝symlink。
- scheduler.test.ts：37通过，保留旧订单/取消/缓存/预算性质。网关tsc无本片文件诊断；全树其他域类型错误仍在，日志/tmp/eimu-music-tsc.log。

未覆盖：真实ubuntu/agentsvc两个Unix账号互写未在本机复现，当前以0022权限位、受控目录真实文件操作与生产服务组配置为依据；真实上游音乐、VPS旧操作回执与最终影片端到端均未跑。已有旧桥记录缺requestHash/归属时保守unknown，不能把它当自动恢复已通。图外音乐工具的旧结果需要其权威operation账本关联，不接受模型声称归属。

最终ACK闭环验证：runtime26通过；gateway scheduler39通过；真实HTTP bridge-client10通过；server+audio合49通过。新增覆盖ACK响应丢失后重复、JSON对象键顺序变化不影响幂等、旧run/错归属拒绝、接收副本被篡改拒绝、ACK前超过24小时仍保留、ACK后仅删除临时原件而ArtifactStore目录字节保留。gateway stub在收到ACK时直接读磁盘project.json及ArtifactStore.verify，证明不在仅拿到桥临时文件时就ACK；旧epoch不发。一次真实HTTP补测发现对象键顺序导致重复ACK误拒，已改事实规范化比较并复验通过。

尚未证明：生产文件组权限与实际用户任务均未实跑；这里的ACK是gateway耐久入库接收，并不是用户已消费最终作品。缺历史可信runId或来源的旧桥记录不会被新ACK清理。没有用磁盘TTL推断交付，也未扩媒体迁移项目。
