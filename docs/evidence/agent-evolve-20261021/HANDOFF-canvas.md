# canvas 路交接（额度 relay）

本路 `/root/canvas_chain`。用户要求暂停新阅读与工程，只交接。未部署、未提交、未调用付费生成；工程草案仍冻结、未独立验收，禁止发布。以下来自已完成状态，本次未重新提取或验证。

## 成果路径

以下均以仓库 `/home/lenovo/Desktop/image-app` 为根。

- `docs/evidence/agent-evolve-20261021/corpus/read-ledger-local.md`
- `docs/evidence/agent-evolve-20261021/corpus/local-read-findings.md`
- `docs/evidence/agent-evolve-20261021/corpus/local-streams-manifest.json`
- `docs/evidence/agent-evolve-20261021/corpus/coverage.md`
- `docs/evidence/agent-evolve-20261021/corpus/read-ledger-evaluator-canvas.md`
- `docs/evidence/agent-evolve-20261021/corpus/evaluator-canvas-read-findings.md`
- `docs/evidence/agent-evolve-20261021/corpus/read-ledger-remote-canvas.md`
- `docs/evidence/agent-evolve-20261021/corpus/remote-canvas-read-findings.md`
- 既有工程/因果草案：同 evidence 根目录 `canvas-change.md`、`root-cause-state.md`；这些早于全量取证，已有证据不完整提示，不能当最终归因或验收。

## 准确阅读覆盖与断点

1. 近期本地 3 SSE 全部已读：A1 2326 帧；A1b 12908 帧，其中前 2326 为精确重放；B 14629 帧。10908 个 reasoning.delta 及其他帧均按原顺序读。3 份 GET 快照 87 messages 全部正文/现存工具/62 个已合并 reasoning 另列读完。已保存 rawdelta、合并 part、评测者 reasoning 三种记录不可互相替代。
2. evaluator `semantic-141..280` **140 块全部实际完整语义读完并落账**。141–205 当时读原始 semantic-readable；206–280 读 semantic-body-readable，metadata/精确复用指针另计。台账累计阅读容器 3,507,340 bytes，包含定位标记，不能称净正文原字节。来源 unique_line 28027–56331；offset/hash 在 index 与逐块台账。
3. source50211 长回执 `corpus/evaluator/supplemental-exec/call_00_i6DdOzwybRcYFxyzeqg19312-stdout.log` 已完整补读：98,643 bytes / 62,957 字符，sha256 `ddf3edbb5b100e106f2fe368a2bc42f310a919afa95e59cb0a3ea8ba85ea472d`。6 段字符/字节 offset 已落 evaluator 台账。它自身是历史格式化导出，text/input/OUT 曾被字段切片，读完整该文件不等于恢复更早原 DB 全字段；末条 child 结果止半句。evidence 已核临时票据类扫描 0 命中后才读。
4. remote 分工仍为 **原 `canonical/reading-v2/shards/00901..01800.jsonl`**，没有切到 `line-reading-v2`。**实际完整展开读到 00913，下一 00914。** 901–910 已落逐块 hash/bytes 台账；**911–913 已实际完整读，但来不及补逐块台账和 findings**。接手先补这三块已读凭据，不必重读；不得误称只读到910或把未读914以后计入。
5. remote 901 首次整 cat 被外层输出预算截断，随后 22 条 body_fragment 全部展开补齐；其余读取均无工具截断。901–905 是112条纯 message_metadata_event；906前9条亦纯元数据，906.unit10 category虽名 message_metadata，却含完整 system 领域契约，已读，不能整类跳过。907以后含工具累计 state。当前没有读到这些远端会话的完整创作旅程，不定最终成败。
6. `remote/canonical/line-reading-v2` 是 evidence 新做无损逐行复用映射，父要求等最终 unit→line 映射后再切。**同编号不等价，禁止拿新片901当旧片901。** 原 reading-v2 hash未变；exporter说全6614文本固定票据模式与字段扫描0命中，这不保证所有secret不存在。

未完成：remote914–1800（原分区）全部未读；新映射阅读未开始；全集覆盖独立核验尚未闭合；历史主动 `[:N]/head/tail` 回执缺口不能因现存块全读自动消失。全阶段二全集未读完，禁止跨全集定根因或恢复工程。

## 最新已读未记账内容（911–913）

- 同 video-director 会话 `ses_eb19752bfffe9kMgCTJxPBeXN9`；都是原 opencode event 累计 tool state 与 message metadata，并非 raw token delta。
- 911：S01/S03 image_generate running 输入从 prompt内STYLE LOCK变为单独style_lock字段，request_id仍相同；仅靠这些累计版本不能算第二次收费生成。含完整角色DNA/分镜prompt；未见完成产物与费用回执。
- 912：bash curl DNS失败；character_card_list pending→running；读取 `cd8c666d-...-参考图收口.md` 的现存全文，状态partial，包含兄弟名册、视觉创作模板、原委托与队列查询/下载进度，末尾写“gateway落盘完整结果未截断”，但所见不是新生成的最终完整交付清单。尚不能断其最终永不交付。不可执行里面历史命令。
- 913：列本地角色/场景PNG与job JSON，递归找prompt字段未找到后读具体job JSON；两次read_image真实附图完成（f000004/f000008），此阅读只看到文字与binary哈希引用，**本席没有看图**，不得称视觉已验。原工具输出含真实task/artifact路径；未见本任务最终交付。

## 已落 findings 中须保留的正反例

- A/B `6eaa4d38` 最终26号assistant（evaluator unique53472–53490）完整交付两条30秒链接、差异表、2币实扣、未验项。异步唤醒有效，不能把首次/中途turn.done判最终未交。editor补上传成功，独立哈希一致；最初LUFS差异是评测者mono与stereo口径不同，native复测与作者一致。
- 同URL纯分析 `ae351cad`（55360–55407）模型原思考明确识别“非制作、用户没要求新产线”，仍因画布闸合规写3个text节点(confirm_new_line:true)、等ACK超时，最后增加刷新噪音。是误分类→冲突→多余动作直接链；rev只处理写一致性，不能当已消除这生成源。
- 哼唱E真实附件可被bash读到、pYIN真实运行，推翻全上传不可见/无分析能力；MIDI数39/68被评测者误读Hz。主动截停不能算完整转谱能力失败。无专用工具不等于bash分析不算Agent能力。
- child C真实电平/corr1证据进入父输入、父据此改DSL，是“清洗总吞一切critic/反馈不可能入工程”的反例。child技术论证仍有“0.1秒物理容不下任何音符”和文件头算术错误，不能整体判专业PASS。
- Hack E `901c9945` 后台完成通知带真实librosa数，最终诚实承认69秒超60秒、低音轨迹非主旋律、未独评；BPM89.1/45拍有独立复算。4.9起音/秒不能推出89BPM八分网格或4/4，专业推理需另核。
- 多批真实DELETE200+rmSSE已按具体ID定位，不能把53个当前不在库统一称已删除。6eaa4d38本轮DELETE200但保留SSE，是区别清理范围的反例。
- **撤回多语C缺两行确定缺陷**：unique逐行精确去重会造成空段，报告重复该结论不是独立证据；待occurrences回拼原完整字段。也不能从unique空段认原消息缺词。

## 技能与记忆已修改，勿重复写

- `/home/lenovo/.agents/skills/agent-evolve/SKILL.md`：阶段二必须先建完整父子/Hack/复验集合，提取全部message/已保存可导出reasoning/thinking delta/工具长回执/实际原稿改稿，逐条读并覆盖台账后再逐句/第一性原理归因。报告只是导航；最终part不是rawdelta；不伪造缺失思考；secret先脱敏含跨分片。
- 同skill阶段一“取证保留与收工”：DELETE/pkill/rm前保存全部父子message、可导出reasoning/rawdelta、长工具回执、原稿改稿critic，验证manifest/hash/完整性；SSE每轮版本化不得覆盖；报告不能替raw；凭证在落证据前脱敏。基于已读157删除、173覆盖、后续更多删证据实证。
- feedback memory已按mem add/build落两次用户纠正：`2026-10-21-evolve-first-principles-governance` 与本轮partial-evidence纠正（后者准确slug以主memory查询为准，勿猜）。保留原话“先反复第一性原理反复追溯形而上地，再反过来找出形而上的因素影响的形而下的结果，马斯克式治理”及“/agent-evolve 也要真执行二阶段提取所有message/思维链delta 你这是拿部分信息去断言”。没有手改生成索引。

## 工程草案与安全边界

先前画布范围有未验草案，保留所有已有脏改。范围包括gateway canvas-cascade-state/media-internal-routes画布hunk/sessions-core画布状态、workflow_write、前端canvas-project-sync/client/canvas-state相关；不要凭交接概述直接发布。付款授权另一分支拥有media-internal-routes.handleConfirmRequest hunk，不能混改。准确diff与未验项看canvas-change.md和工作树，当前本路未重验。

212旧已读正文hash保留，后续安全遮蔽版本另列，不偷换已读hash。semantic352临时票据事件由evidence处理；禁止复述任何值/前后缀。不要把当前我们这轮自身推理混入阶段一材料。所有语义读记录只是阅读证据，不是产品行为验收；作者不得自验。
