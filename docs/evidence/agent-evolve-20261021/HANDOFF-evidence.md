# Evidence 接力：立即从断点继续

用户因额度将尽要求交接；已停止新增提取、阅读、压缩与工程。冻结截止：2026-10-21T13:11:42Z。不要重跑已有导出，不据旧根因挑选材料。

## 真实覆盖与断点

- evaluator 身份闭包53会话，11次automation运行；8份REPORT、9个音乐日期目录只是导航，20日13:00有真实活动但无目录，21日21:00截至cutoff进行中。窗口覆盖10/18—21，18日清晨属边界外补充。完整身份、来源与限制见 corpus/session-inventory.json、inventory.md 和 evaluator/evaluator-source-manifest.json。
- evaluator 新response共50条（8个阅读文件）本路已全文读；request001—028共230 unique context message由root全文读，重复2533次引用保留，不重复算新消息。
- DB semantic001—100本路实际读完，下一101，101—140未读；141—280由canvas报告全文读完；281—390由root明确确认连续全文读完，下一391，391—421未读。root最新读至unique76885。随机元数据仅索引不能算正文阅读。
- read-ledger-evaluator.md正式写至100；read-ledger-primary.md正式逐片表写至345。root346—390为已收到的真实已读确认，因额度停止，仅在本交接补登记，不冒称旧表已更新。request全文补截断均闭合。
- root已完整读 supplemental-exec/call_00_WPYLWxDTjDF9USoW2u671377-stdout.log：44,869字符，按[0:16000]、[16000:32000]、[32000:44869]补读闭合。另一98,643B的call_00_i6DdOzwybRcYFxyzeqg19312-stdout.log交canvas，完成状态以HANDOFF-canvas.md为准。
- remote旧reading-v2：cancel最后明确回报1—78完整，canvas901—906完整（不少为metadata，906含system契约必须保留）。后续状态以HANDOFF-remote.md/HANDOFF-canvas.md实际ledger为准。新line-reading-final尚无任何新片语义阅读，不得标全量已读。

## 已落盘的阅读与重组层

本目录所有路径相对 corpus/evaluator/：

| 成果 | 作用 |
|---|---|
| db-records.jsonl；model-io-records.jsonl；agent-original-records.jsonl | 脱敏证据副本；原历史只读未改 |
| semantic-unique-strings.jsonl；semantic-string-occurrences.jsonl | 全量字符串叶的精确逐行去重；每次来源、JSON pointer、顺序、offset全保留 |
| semantic-body-readable/semantic-001.md…421.md；semantic-readable-index.json | 后续优先阅读正文view；metadata与exact已读内容以引用保留，不是删失 |
| semantic-dedup-manifest.json；semantic-modelio-read-reuse.json；semantic-metadata-index.json | 数量、无损重组与已读精确复用证明 |
| read-ledger-evaluator.md；read-ledger-primary.md | 已读正文范围/来源hash与局部待核发现 |
| supplemental-exec/manifest.json | 两份原先截断长回执的完整本机副本、原hash与副本hash |
| supplemental-source-loss-notes.md | DELETE/rm、跨agent pkill采集干预的具体来源定位 |
| ticket-redaction-read-gate.json；ticket-redaction-audit.json；ticket-shape-redaction-audit.json | 历史临时上传认证票据的本轮遮蔽范围、hash链；先字段扫描遗漏自由文本，后补固定值形态 |
| credential-prefix-redaction-audit.json；credential-context-scan-locations.json | 历史内部token短片段处理与检测边界 |

票据补遮蔽后84,432个DB字符串叶已与独立db-records实际字段比较：已解析者差异0；170条session_input使用payload而非data，独立比较尚未补该根指针，明确待补，不能写全84,432独立闭合。此前canonical逐行重组证明与本轮遮蔽的长度保持均保留。read ledger旧已读hash不得偷换成新hash，追加安全版本说明。

## remote新稳定层状态

corpus/remote/canonical/line-reading-final/manifest.json已经完整落盘，状态FROZEN_FOR_READING；底层line-reading-v1/v2与reading-v2均保留，不边读边改版。后续优先从final各owner目录接力，旧版仅作来源与重组定位。此为作者生成的阅读映射，未独立换手核验字段分类，不当产品验收通过；如发现分类/引用错误，保原来源、暂停相关跳过，不以摘要代正文。

底层151,918 unit、787,528叶，v2逐叶hash重组差异0；final只改变阅读分配，全部原数字、tool输入输出、system契约与occurrences仍保留。纯结构metadata字段单列367,412字符。唯一语义正文19,549,474字符，精确已读复用1,175,098字符，剩余18,374,376字符、1235片：

| owner目录 | 新片数 | 未读正文字符 |
|---|---:|---:|
| cancel | 199 | 3,126,754 |
| canvas | 283 | 4,282,815 |
| evidence | 276 | 4,183,479 |
| primary | 477 | 6,781,328 |

每组index.json含绝对路径、hash、line_id与offset；unit-leaf-map及原reading-v2/occurrences.jsonl保每次来源绑定。final没有新片被实际阅读。分配以全局首个真实正文occurrence所属旧分区归属，跨区精确重复引用一次。旧阅读ledger不覆写。

## 安全与未完成

历史上游API凭证、内部token短片段、临时上传票据曾实际进入工具返回，不能声称已清掉旧返回；活性未知，不验证不吊销。仅本轮副本遮蔽，原历史未改。字段票据扫描曾漏大写赋值/自由文本，固定票据形态全局补扫evaluator1894文件5文件5处；remote由exporter扫6614文件同形态0命中。0只是该模式范围结果，不能宣称所有secret不存在。下一次展示正文仍须先脱敏；新增副本需延续权限与hash链。

原源正文内自带truncated不等于本次工具又截断；view全文读完也不等于原长tool回执全量。尚需沿已记录exec/occurrences补可恢复长回执，无源则记缺口。unique去重的空段不能判原消息缺句；要按occurrences重组完整原字段比较。merged/快照不等于raw delta，未保存reasoning不补写。

旧root-cause与issue-map只保待核草稿，不采纳为最终归因。全量阅读尚未完成，二三阶段反哺尚未恢复。工程保持冻结，未提交未部署。接手者先补读101—140、391—421，再按final分配remote；不重新读取已闭合部分。
