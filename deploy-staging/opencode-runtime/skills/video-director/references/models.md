# 模型与输入边界

先读实际目录的 model/capabilities/reference 限制与报价；下列是写法参考，不是平台已支持该模式的承诺。不凭模型名宣称最佳，也不导入旧 API 参数。

- **MiniMax H3**：先按平台真能力区分纯文本、首图、首尾图、参考条件。自然语言写动作、幅度、速度；push/pull 是位移，zoom 是机位固定的焦距变化，pan/tilt 是旋转。I2V 从首帧状态写动作开始→持续变化→结果；首尾图补中间如何走到末态。不要套旧 Hailuo 方括号指令。参考视频可提供运镜/剪辑/节奏，但 reference generation 不等于编辑已有视频。
- **Runway Gen4.5 I2V 写法参考**：图像负责主体/构图/光照，短 prompt 优先关键 motion，再分主体、环境、机位与速度/时序。图中模糊、扬尘或姿势与静止目标冲突时先修输入，不能只堆负面词。此处不宣称本站提供 Runway。
- **Seedance**：把空间层与时间层分开，参考逐项说明来源及作用；用事件顺序组织动作，不把精确秒点当保证。2.0 指南不能冒充 2.5 完整能力说明。
- **Agnes Video 2.5 Flash（免费兜底）**：平台自有免费额度视频档（model id `agnes-video-2.5-flash`），上游成本 ¥0，是付费视频渠道（MiniMax H3／Seedance／miaowu）余额断或全断时的**最后手段**。免费档队列与限速较慢，只有 480p/720p、5/10 秒，**不支援参考图（无图生视频）**，画质与可控性低于付费档——只在付费档不可用时才用它，**不因为「免费」就默认选它**；提交前照常按目录能力与报价核对档位。
- **复杂运动**：文本约束可引导，不等于 CameraCtrl 的 K/c2w/Plücker、MotionCtrl 每帧 RT 或 native pose 张量。没有平台原生接口就不得宣称精确轨迹锁定。

独立审阅以真实原片及时间序列对照真实生成 input；清楚区分固定镜头主体动、旋转、物理位移和仅放大。样本只有帧序列时不能宣称连续播放，不能凭全帧像素差判定 dolly。

来源：[MiniMax H3 官方 Skill](https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing)、[Runway I2V 指南](https://help.runwayml.com/hc/en-us/articles/48324313115155-Image-to-Video-Prompting-Guide)、[Seedance 2.0 官方指南](https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh)。检索日 2026-10-13；不复制长段文本。
