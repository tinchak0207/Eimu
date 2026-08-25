---
name: shortdrama-production
version: 1.0.0
description: 剧本到短剧成片的可审计工具链，输出结构化场景、锁定资产、分镜门禁与交付 manifest
allowed-tools:
  - script_scene_parse
  - cast_asset_lock
  - storyboard_qc_17
  - keyframe_render
  - audio_first_timeline
  - last_frame_video_chain
  - editing_manifest
  - delivery_assets
triggers:
  - 用户要把剧本做成短剧成片
  - 用户要分镜、关键帧、配音时间轴、视频串接或剪辑投产包
  - 用户要 Jianying 或 FFmpeg 的短剧交付清单
requires:
  - src/lib/shortdrama-domain/index.ts
  - src/lib/canvas/types.ts
  - src/lib/agent-chat-types.ts
optional:
  - imageGeneration.render
  - audioGeneration.provider
  - videoGeneration.provider
  - editing.engine
---

## 用途
本技能服务剧本进入生产准备、生成、剪辑与交付的阶段。它把剧本拆成场次和节拍，锁定角色/场景资产，执行 17 道分镜门禁，再按音讯先行、关键帧、尾帧串接、剪辑 manifest 和交付资产顺序推进。所有工具都返回统一的 `ShortDramaToolResult`；其中 `canvas` 字段可被 agent harness 捕捉并挂到 Canvas。工具只声明或规划时不会冒充已生成：缺少真实上游时返回 `unsupported`。

## 工具契约
| 工具 | 入参 | 出参 | 后端 owner |
|------|------|------|-----------|
| `script_scene_parse` | `{ script }` | `scenes[]`，每项含 `sceneId/heading/beats[]` | `src/lib/shortdrama-domain/index.ts:parseScript` |
| `cast_asset_lock` | `assets[]`、`requiredIds?` | `locks[]`、`missingIds[]` | `src/lib/shortdrama-domain/index.ts:lockAssets` |
| `storyboard_qc_17` | `shots[]`、锁定卡 id、段时长 | 17 个 gate、`ready` | `src/lib/shortdrama-domain/index.ts:storyboardQc` |
| `keyframe_render` | `shots[]` | `keyframes[]` 或 `unsupported` | `src/lib/shortdrama-domain/index.ts:keyframeRender`，真实渲染由 `imageGeneration.render` 注入 |
| `audio_first_timeline` | `dialogue[]` | 音讯锚点与确定性时间轴 | `src/lib/shortdrama-domain/index.ts:audioTimeline`，真实音讯由 `audioGeneration` 注入 |
| `last_frame_video_chain` | 有序 `shots[]` | 尾帧输入链 | `src/lib/shortdrama-domain/index.ts:videoChain`，真实影片由 `videoGeneration` 注入 |
| `editing_manifest` | `clips[]`、`engine?` | Jianying/FFmpeg manifest | `src/lib/shortdrama-domain/index.ts:editingManifest` |
| `delivery_assets` | `assets[]`、`formats?` | 稳定交付 manifest | `src/lib/shortdrama-domain/index.ts:deliveryAssets` |

每个结果的 `canvas` 至少包含：`workflowId`、`tool`、`status`、`artifactKind`、`artifactId`、`inputRefs`、`outputRefs`、`gateIds`；不支持时追加 `unsupportedCode`。这些字段只描述可观察结果，不等于上游生成成功。

## 行为规则
1. `script_scene_parse` 的场次、节拍、说话人必须结构化输出；空剧本阻断，不猜内容。
2. `cast_asset_lock` 只接受唯一资产 id；角色和场景必须有外观提示词或参考图，缺失资产进入 `missingIds` 并阻断后续生成。
3. `storyboard_qc_17` 必须恰好返回 17 个门；单镜 2–5 秒、段长 ≤15 秒、角色/场景卡、关键帧、尾帧、音讯锚点和交付比例都要明确。
4. `keyframe_render` 只有收到真实 `imageGeneration.render` callback 才能返回成功；没有 callback 返回 `unsupported:image_generation_upstream_missing`。
5. `audio_first_timeline` 的时长由代码按文本长度确定性计算；没有音讯上游时只返回规划时间轴，并标记 `unsupported`。
6. `last_frame_video_chain` 第一镜吃自己的关键帧，后续镜头必须吃上一镜的 `lastFrameId`；没有影片上游时不得创建成功影片 artifact。
7. `editing_manifest` 只输出 Jianying 或 FFmpeg 可消费的 manifest；没有对应 engine 时返回 `unsupported`，不把 manifest 当成已渲染影片。
8. `delivery_assets` 只在必需资产、URI、格式和稳定 id 都齐全时返回成功；缺项返回 `blocked`。
9. 任何 `blocked` 或 `unsupported` 结果都必须保留 Canvas metadata，供 harness 展示阻塞原因和下一步；禁止把失败转成空成功。
10. 外部研究只作为编排依据，不覆盖本地 owner 与真实上游证据。

## 失败与降级
| 错误码 | 阻断 | 不阻断 |
|--------|------|--------|
| `image_generation_upstream_missing` | 关键帧生成 | 剧本、资产锁定、QC、时间轴规划 |
| `audio_generation_upstream_missing` | 真实音讯产物 | 音讯先行时间轴规划 |
| `video_generation_upstream_missing` | 真实影片产物 | 尾帧链规划与 Canvas 记录 |
| `editing_engine_missing` | 剪辑执行 | 剪辑清单之外的准备工作 |
| `delivery_storage_missing` | 交付写入 | 资产完整性门禁 |
| `blocked` | 当前工具及其下游 | 可独立运行的前置工具 |

## 来源证据
- `eternityspring/shuohao-skills`：五个 skill 分段产出 outline/cast/art/script/storyboard；README 明确 storyboard 的 17 道质量门、每段 ≤15 秒、单镜 2–5 秒，并要求每个 skill 有不调用模型的 selftest。<https://github.com/eternityspring/shuohao-skills>
- `Forget-C/Jellyfish`：README 描述 `script breakdown → shot preparation → candidate confirmation → shot ready → generation workspace`，并将资产一致性、单镜/批量 pre-check、异步任务状态/取消/恢复作为生产状态。<https://github.com/Forget-C/Jellyfish>
- `drasstry/shortdrama-pipeline`：README 明确剧本审核阻断人物生成、人物审核阻断影片生成，影片按 shot 顺序由 FFmpeg 拼接，脚本质检为 warning-only。<https://github.com/drasstry/shortdrama-pipeline>
- `wushaojun321/ai-short-film`：README 明确脚本→shot storyboard→逐镜图像→逐镜视频，影片以 `last_frame_url` 串接，图像/影片/合并任务分队列异步运行。<https://github.com/wushaojun321/ai-short-film>

## 确定性边界
- 结构化场次、资产缺失清单、17 道 gate、音讯时长、尾帧引用、manifest id 都由 `src/lib/shortdrama-domain/index.ts` 计算。
- 模型和上游只提供语义或真实 artifact callback；不得自行覆盖 gate、时长、顺序或资产锁定。
