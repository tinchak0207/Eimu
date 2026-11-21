// audio-capability-notes.ts — 「音频该自己听还是用工具」这条规则的**唯一来源**。
//
// 为什么单独成档（2026-11-22 暴君追问「提示词治理是不是不太行」）：同一条规则曾散在 6 处各写各的
// （网关回合尾、critic 子会话注入、attachments.md、video_transcribe 描述、critic prompt…），逐处补丁，
// 每处措辞不同、每处都留着同一个口子（「需要时间戳就可以用工具」），模型就从口子钻出去用 ASR／ffmpeg 画 RMS 曲线。
// 现在：规则正文只写在本档；attachments.md／工具描述／critic prompt 只写「以回合尾的【本轮音频附件·…】为准」，
// 不再复述规则。要改措辞只改这里。能力来源仍只有 registry 旗标（isAudioModel）。

export const MARK_CAN_LISTEN = "【本轮音频附件·可直接收听】"
export const MARK_CANNOT_LISTEN = "【本轮音频附件·无法直接收听】"

/** 主会话：模型能原生听，音频已作为 file part 送入。 */
export function mainCanListenNote(filenames: string[]): string {
  return (
    `本轮模型能原生听音频：用户上传的音频（${filenames.join("、")}）已作为音频输入直接给你。` +
    "你自己听，并直接给出：歌词／内容、段落结构与时间码（主歌／副歌／间奏／高潮的起止，精确到秒）、情绪起伏、速度与节奏、" +
    "可剪切的句尾／小节点、说话人与音色。这些全部凭你自己的听力完成——不要为了拿结构／时间码／歌词／节奏去调 " +
    "video_transcribe、bash、ffmpeg、ffprobe、RMS／波形曲线，也不要派子代理去「测算／分析这首歌」" +
    "（子代理听不到音频，只有你听得到；你把听出的时间码、歌词、情绪直接写进给它们的任务书）。" +
    "只有两种情况才用工具：①用户要字幕文件（srt／vtt）或超过 10 分钟音频的逐字稿；" +
    "②你已凭听力给出剪点，落到成片帧级精度时，在你给的区间内用工具校准。听不清的地方如实说，不要编造。"
  )
}

/** 主会话：模型不能听（或音频没送成）。 */
export function mainCannotListenNote(): string {
  return "本轮音频无法直接收听（模型不支持或格式转换失败）：用户上传了音频，请用 video_transcribe（source 传文件名）取得转写，需要声学细节时再用 video_evidence 探测；只有转写没有听感，要如实告知，不要假装听过。"
}

/** critic 子会话：被审音频已送入。 */
export function criticCanListenNote(artifacts: string[], skipped: Array<{ artifact: string; reason: string }>): string {
  return (
    `被审的音频已作为音频输入附在本消息（${artifacts.join("、")}）。请自己听，qc 里写你真实听到的：音色／配器、节奏与速度、情绪走向、人声清晰度与咬字、` +
    "段落结构、与交付契约（风格／情绪／歌词）是否相符、有无爆音／截断／静音。转写文字、ffprobe 时长只能证明文字和格式，不是听感，不要拿它们当听感证据；没听出的维度标 PARTIAL。" +
    (skipped.length > 0 ? `未能附上的音频：${skipped.map((x) => `${x.artifact}（${x.reason}）`).join("、")}，这些标 PARTIAL。` : "")
  )
}

/** critic 子会话：音频没送成（模型不能听／抓取转码失败）。 */
export function criticCannotListenNote(canListen: boolean): string {
  return (
    `本轮没有把被审音频送进模型（${canListen ? "音频抓取／转码失败" : "当前审核模型不支持音频输入"}）。` +
    "音频听感一栏只能标 PARTIAL，不得写出任何「听起来…」式结论；只能就文字、契约栏位、时长等可核对事实下判。"
  )
}
