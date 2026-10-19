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
        deliverable: "镜头脚本＝状态变化 + 动作 beat 时间线（state_change.from → beats[].at_seconds/action/environment_change → state_change.to；至少一次可见状态变化与一次环境变化）+ 景别/机位/运镜/时长秒数",
        notes: [
          "先回答「这一镜里什么在变」：主体动作、空间关系、环境状态至少一项；答不出来＝不能开拍。只写景别/机位/运镜/静帧外观＝静态六槽，模型只会做慢推",
          "写 `state_change:{from,to}` 与 `beats:[{at_seconds?,action,environment_change?}]`：action 用物理动词+身体机制+对象交互（压低重心起步冲刺/跃起挥刀/落地滑行），不写「缓缓抬头」这类形容词",
          "动作/走位/多人/空间关系镜头必须接 3D 预演节点；单人物微表情/产品特写等不涉及精确几何的镜头可跳过预演，直接首帧 I2V。MiniMax H3 单镜 5-15 秒（推荐 15 秒），超长拆段拼接",
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
      // 3D 预演（2026-10-20 影片范式改革）：kind 必须是 text——gateway 会 skip director kind
      // 节点。动作/走位/多人/空间关系镜头先预演定 blocking/机位/动作；微表情/产品特写可跳过。
      {
        role: "previz",
        kind: "text",
        title: "3D 预演（白模 blocking / 机位路径 / 动作模板）",
        deliverable: "本镜白模 blocking + 机位路径 + 动作模板，渲染首/中/尾关键帧；预演帧作为视频生成的参考条件，不是成片",
        gate: "预演穿模/遮挡矛盾/走位方向冲突不得进入生成；预演帧只锁 blocking 与构图，动作过程仍由 beats 时间线表达",
        notes: [
          "动作/走位/多人/空间关系镜头先用 director-engine 白模（L1，免费）或 Blender（L2）定 blocking、机位路径与动作模板；渲染首/中/尾关键帧后，把关键帧 + 运镜 + beats 一起交给视频模型",
          "预演帧是参考条件，不是成片也不是首帧硬锁：首帧负责起点，beats 负责过程；单人物微表情/产品特写等不涉及精确几何的镜头可跳过预演，直接首帧 I2V",
          "机位路径与动作事件对齐（跟拍从哪个动作起、急推落在哪个 beat），预演阶段发现的穿模/遮挡/轴线错误先改白模，不留给视频模型猜",
        ],
        tools: [
          { id: "director_manage_shot", input: "镜头操作指令", output: "白模镜头序列更新结果" },
          { id: "director_set_camera_keyframe", input: "机位关键帧（时点+位置）", output: "机位路径时间线" },
          { id: "director_set_motion_keyframe", input: "动作关键帧（时点+姿态）", output: "动作模板时间线" },
          { id: "blender_exec", input: "Blender 建模/摆位脚本", output: "白模场景与动作" },
          { id: "blender_render", input: "白模镜头 + 帧范围", output: "首/中/尾关键帧 PNG" },
        ],
      },
      {
        role: "generation",
        kind: "config",
        title: "影片配置",
        defaults: { size: "16:9", duration_seconds: 15, kind: "video", },
        deliverable: "视频生成参数（模型/画幅/时长，MiniMax H3 单镜 5-15 秒、推荐 15 秒；动作镜头优先 T2V 或用预演关键帧作参考条件，首帧不是默认条件）",
      },
      {
        role: "result",
        kind: "video",
        title: "影片",
        deliverable: "镜头 MP4 URL + 实际花费 + 动态证据（video_evidence action=motion 的 median_diff/static_ratio）",
        gate: "抽首/中/尾 3 帧质检形变/闪帧/角色漂移，并用 video_evidence action=motion 验动态；verdict=static 或不合格即重生成",
        notes: [
          "出片后抽首/中/尾 3 帧与参考图比对角色漂移/形变/闪帧，不合格即重生成",
          "模型输出必须过 `video_evidence action=motion` 验收：median_diff 接近 0、static_ratio 过高（verdict=static）即重做或如实标未达标，不伪签通过",
        ],
        tools: [
          { id: "last_frame_video_chain", input: "预演关键帧/首尾帧 + 镜头顺序", output: "镜头视频链" },
          { id: "video_evidence", input: "镜头 MP4", output: "动态证据（motion 指标 median_diff/static_ratio + 帧/边界）" },
        ],
      },
    ],
    connections: [
      { fromRole: "shot", toRole: "previz" },
      { fromRole: "previz", toRole: "generation" },
      { fromRole: "reference", toRole: "generation" },
      { fromRole: "generation", toRole: "result" },
    ],
  }
;
