import type { WorkflowTemplate } from "./types";

export const singleVideoTemplate: WorkflowTemplate = 
  // ── 单镜头影片 ──
  {
    id: "single_video",
    name: "单支影片",
    description: "镜头脚本 → 一支影片（可带参考图）。",
    nodes: [
      {
        role: "shot",
        kind: "text",
        title: "镜头脚本",
        deliverable: "镜头脚本（景别/机位/运镜/时长秒数 + 运动与情绪描述，按「听见→停顿→眼神→表情→说话」拆反应）",
        notes: [
          "运动提示词只描述起止之间的运动与情绪变化，不重复静态外观；MiniMax H3 单镜 5-15 秒（推荐 15 秒），超长拆段拼接",
        ],
        tools: [
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      {
        role: "reference",
        kind: "image",
        title: "参考图（可选）",
        deliverable: "参考图（角色/场景锚点），带上可保人物一致性",
        notes: [
          "角色/场景图辅助一致性，不保证硬锁首尾；运镜写 camera.start/end/trajectory/timing/parallax 或时间 keyframes。physical dolly 是连续机位位移与视差，optical zoom 是固定机位变焦，合法 static 保留；首帧跳变不能当运镜",
        ],
      },
      {
        role: "generation",
        kind: "config",
        title: "影片配置",
        defaults: { size: "16:9", duration_seconds: 15, kind: "video", },
        deliverable: "视频生成参数（模型/画幅/时长，MiniMax H3 单镜 5-15 秒、推荐 15 秒）",
      },
      {
        role: "result",
        kind: "video",
        title: "影片",
        deliverable: "镜头 MP4 URL + 实际花费",
        gate: "抽首/中/尾 3 帧质检：出现明显形变/闪帧/角色漂移即重生成",
        notes: [
          "出片后抽首/中/尾 3 帧与参考图比对角色漂移/形变/闪帧，不合格即重生成",
        ],
        tools: [
          { id: "last_frame_video_chain", input: "首尾帧 + 镜头顺序", output: "镜头视频链" },
        ],
      },
    ],
    connections: [
      { fromRole: "shot", toRole: "generation" },
      { fromRole: "reference", toRole: "generation" },
      { fromRole: "generation", toRole: "result" },
    ],
  }
;
