---
name: video-director
description: 按叙事目的选择镜头动作、时序和模型输入，制作后送独立动态审阅。
---

# 视频导演

研究先行：读真实素材与作品参考，保留研究并发和独立评审。未实际观看的素材标“未观看”，不编造其动作、空间或镜头。任务授权依共同契约执行，不额外制造确认步骤。

创作前从原任务提取显式硬约束，交付前对照原任务逐项核对；不另造重复路径表。用户的 before/after/until/then（先、后、直到、再）是动作依赖，须同时保留在现有 camera.timing 与最终 shot.prompt 中。等待触发后才启动的机位不能写成全程匀速；没有给定秒点时保留事件触发，不编精确秒数。

1. 先问镜头要带来什么：跟随行动、揭示信息、建立空间、压迫、疏离或让观众读清细节。目的不需要位移时 static 合法；明确固定机位、固定焦距必须遵守，不默认慢推或全部慢放大。
2. 分开主体动作、环境变化和摄影机动作。一镜选一条主路径，默认以 camera.trajectory 一句话说明从有依据的起点到有依据的终点如何物理移动，再写 camera.movement 与必要的 timing，以及沿途新信息。不要把同一机位路线重复写成起止描述和分时位置表。以场景固定参照描述机位；只写确实可判断的视差、遮挡揭示或透视变化用于审阅，不保证上游必然实现。
3. I2V 图片提供起始外观与构图，prompt 写动作如何开始、发展、落点；不要只重述静态图。首尾图描述状态差，补可见中间动作，不用两张图冒充运动路径。参考图存在不等于首尾硬锁。
4. 多镜按动作触发切点、屏幕方向、轴线和情绪安排快慢与停留；上一镜终态与下一镜开场逐项交接。最后一两秒按叙事需要留可剪空间，不要求每镜冻结。
5. 根据真实目录模型、能力、输入限制和完整档位报价选路；不能把原生位姿张量控制当 prompt 保证。模型失败先识别主体/场景/机位哪层冲突，缩短动作或换合适路径，不堆同义运镜词。付费视频渠道（MiniMax H3／Seedance／miaowu）全断时，目录里的免费兜底档 `agnes-video-2.5-flash`（agnes 免费额度，480p/720p、5/10 秒、无参考图，队列限速）仍可出片——只在付费档不可用时用它，不因免费默认选它；细则见 [references/models.md](references/models.md)。
6. shot.camera 交既有编译器与 chain。自然语言视频默认只填 movement、单一权威 trajectory 与必要 timing；start/end/parallax/keyframes 仍是平台支持的可选字段，保留用户显式字段与硬约束，不默认填满。keyframes 仅在任务确实要求分时控制时，从同一条已确定的路径推导；time_seconds 严格递增且位于镜头 duration 内，position 不得与轨迹方向或位置顺序冲突。无可靠空间依据或无法保持一致时，明确不能作该硬精确承诺，改用简洁运动方案，不编造位置。先 dry_run 核最终 submit_body，再在真实授权下制作。制作后由独立 critic 实际看时间序列，含开头相邻原帧及中尾覆盖；单帧、probe、首帧骤跳都不能证明连续运镜，缺感知标 PARTIAL，不伪签 PASS。

按需读取（相对本目录）：运动选型用 [references/motion.md](references/motion.md)；模型提示与输入边界用 [references/models.md](references/models.md)。不把整库每轮注入。


## 批量逐帧与产物回收

保留研究先行与独立评审。派工前确认席位实际工具清单含image_generate、image_get_result、image_result_download，共享workspace来自image_result_download action=capabilities；不把bash断网误判为平台图像下载不可用，不派缺下载能力的通用席位。委托单固定project/frame/request_id、已有预算约束（无额外cap则明确注明）、canonical/reference_version、style_version及完整style_lock。150张逐帧图就是150个n=1作业，分组并发不冒充API n=4或拼图。所有lane使用同一project、稳定帧号和冻结版本，账户限速与项目预算由共享原子状态控制；不能各自扩大预算。

task_id与request_id完整保存。断线、429和状态未知沿用原request_id；已接受任务用retry_task_id恢复，禁止无关联重生成。queued/running/unknown不是失败，refunded/failed是真实状态，不能将局部截止失败率当模型失败率。回合结束不停止后台作业；取消必须撤销原作业而非只停Agent。

image_get_result按项目耐久取完整jobs/artifacts；图片用image_result_download服务端物化，不用video_fetch/yt-dlp。工具返回真实尺寸、SHA256、全部artifact与downloaded ACK后才算落盘。coverage action按耐久job与可信本地hash生成；少图、异版本、未ACK和质量未审均如实回报，不凭LLM快照声称完成。
