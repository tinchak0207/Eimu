# ac-video-scene-stitch — last_frame_video_chain 场景卡嵌合 staging 稿（片AC，2026-09-06）

**性质：staging 稿，本片未上 VPS（零 SSH）。** 行为真源 = `src/lib/shortdrama-domain/index.ts`
`videoChain()`（本片新增 `scene_card_ref` / `camera_trajectory` 两可选栏接线）＋
`src/lib/scene3d-video-fusion.ts`（宽容解析＋融合，只调用片 Z 契约）。
本档只载 VPS handler 消费配方与落位命令，**行为零新增**。

## 0. 谁是真源、谁是消费端（轮子对照）

| 层 | 档 | 角色 |
|---|---|---|
| 契约（片 Z，禁改） | `src/lib/blender-to-video-bridge.ts` / `src/lib/camera-trajectory-to-prompt.ts` / `invisible-prompt-director.ts DirectorOptions` | references 组装 / Camera 词翻译 / 接线契约 |
| 融合（片AC 新增） | `src/lib/scene3d-video-fusion.ts` | unknown → 契约形宽容解析；任一形状不合回 null＝零行为变化 |
| C 端面（片AC 接线） | `src/app/api/generate-videos/route.ts` | body 增 `scene_card`/`camera_trajectory`（snake/camel 双读）→ `optimizeVideoPrompt` options 穿 DirectorOptions；data URL 参考帧 → File 进 multipart（cap 2、不顶用户上传位） |
| agent 工具面（片AC 接线） | `src/lib/shortdrama-domain/index.ts` `videoChain()` | `last_frame_video_chain` 输入增 `scene_card_ref`/`camera_trajectory`；同时合法 → 输出 `sceneDirector`（referenceDirective/cameraDirective/references/notes） |
| VPS 消费端（本稿） | `/opt/agent-harness/workspace/.opencode/lib/shortdrama-video-chain-impl.ts` 同构档 | 把 `output.sceneDirector.cameraDirective` 并进视频生成请求 prompt；references 走 C 端直调通道（见 §2） |

## 1. VPS 端 last_frame_video_chain 现状与补丁

VPS `.opencode/lib/` 的 last_frame_video_chain 实现（08-31 片4 落位，走站点
`/v1/videos/generations` 计费链）按本地真源同步时，补两件事：

1. **输入 schema** 增两可选栏（opencode tool.schema 形状，形同构 director_*.ts）：
   - `scene_card_ref`：`tool.schema.string().optional()`——3D 场景卡引用。**裁定：收
     sceneCard 物件的 JSON 字串**（`JSON.stringify(sceneCard)` 六栏直给），不收节点 id——
     VPS handler 无 canvas 节点索引，解引用＝新增 gateway 依赖；agent 从会话上下文
     （canvas_get_state 或 3D 导演回传摘要）直接拿到六栏物件，字串化传递零新依赖。
   - `camera_trajectory`：`tool.schema.string().optional()`——同为 JSON 字串，
     形如 `{ "moves": ["dolly-in","orbit"], "focalLengthMm": 35 }` 或
     `{ "keyframes": [{ "frame": 0, "position": [0,0,5] }, …] }`（L1 move id 清单
     从 3D 导演 subagent 回传的场景摘要带出）。
2. **handler 接线**（伪码，融合判定全在本地真源同步的 `videoChain` 内）：

```ts
// 融合（实现已同步进 last_frame_video_chain 行为真源；VPS 端只解析 JSON 字串入参）
let scene_card_ref: unknown
try { scene_card_ref = args.scene_card_ref ? JSON.parse(args.scene_card_ref) : undefined } catch { /* 脏栏＝缺栏 */ }
let camera_trajectory: unknown
try { camera_trajectory = args.camera_trajectory ? JSON.parse(args.camera_trajectory) : undefined } catch { /* 脏栏＝缺栏 */ }
// …videoChain(input, capabilities) 出 result.output.sceneDirector 后：
if (output.sceneDirector) {
  // ① prompt 端：cameraDirective ＋ referenceDirective 并进视频生成 prompt
  const stitched = [prompt, output.sceneDirector.cameraDirective, output.sceneDirector.referenceDirective]
    .filter(Boolean).join(" ")
  // ② 帧端：references 只在 data: URL 时转 File 上传（见 §2）；http(s) 帧在
  //    B 端 /v1/videos/generations 无帧栏位（registry 已锤「站点 B 端无 first/last_frame
  //    栏位，帧降级文生视频」），如实记进 output.notes，不宣称已附帧。
}
```

**轨迹来源裁定（写死，不许 handler 自行考古）**：sceneCard 六栏不含轨迹（片 Z 裁定
不动双白名单契约）。轨迹由 agent 显式给出——从 3D 导演 subagent 回传的场景摘要里的
L1 move id（或 canvas_get_state 场景卡节点上下文）填入 `camera_trajectory`；缺轨迹时
`camera_trajectory` 缺栏 → 融合 null → 零行为变化。

## 2. references 全生效通道（裁定）

- **站点 C 端** `POST /api/generate-videos`（登录用户，multipart）：`scene_card` /
  `camera_trajectory` 可作 JSON body 栏位直传；data URL 参考帧已由 C 端路由转 File
  进 multipart 图位（cap 2、用户已上传图优先）→ **references 全生效**。
- **VPS handler 直调 C 端**：`last_frame_video_chain` 若要帧位生效，改调
  `{SITE_ORIGIN}/api/generate-videos`（multipart：prompt/modelId + referenceImages
  File + scene_card/camera_trajectory 栏）而非 `/v1/videos/generations`；需会话鉴栏，
  落位前补 cookie/token 注入配方（待拍板，记此为 §5 前置项）。
- **B 端 `/v1/videos/generations`**（sk-biz-…）：本片不动（对外契约面，增栏属 B 端
  API 版本决策）。

## 3. 落位命令稿（照 blender-gateway PATCH-PLAN.md §2 范式；本片零执行）

```bash
# 本地真源已含两栏逻辑；VPS 同步走 repo deploy 流程（shortdrama-domain 属 src/lib，
# 随站点部署，不属 .opencode 落位面）。仅当 VPS handler 是 .opencode/lib 独立实现时：
vps.py run "sudo cp -a /opt/agent-harness/workspace/.opencode/lib /tmp/lib.bak-MMDD-acstitch"
vps.py put <同步后实现档> /tmp/shortdrama-video-chain-impl.ts
vps.py run "export PATH=\$PATH:/home/ubuntu/.bun/bin && bun build /tmp/shortdrama-video-chain-impl.ts --target=bun --outfile=/tmp/ac-stitch-check.js && echo BUILD_OK"
vps.py run "sudo install -m 644 /tmp/shortdrama-video-chain-impl.ts /opt/agent-harness/workspace/.opencode/lib/shortdrama-video-chain-impl.ts"
vps.py run "sudo systemctl restart opencode-server"
```

## 4. 验收配方（落位后）

```bash
# ① 缺栏零变化：不带两栏调 last_frame_video_chain → output 无 sceneDirector 键
# ② 带栏生效：scene_card_ref = 六栏 JSON 字串 + camera_trajectory = {"moves":["dolly-in"]}
#    → output.sceneDirector.cameraDirective 含 "Camera: " 前缀、"dolly-in" 语义词
#    → references 非空且 referenceRole ∈ {composition, style}
# ③ 脏栏不阻断：scene_card_ref="not-json" → 融合 null → 与①同形
# ④ C 端：POST /api/generate-videos body 带 scene_card+camera_trajectory（JSON）
#    → 200 videoUrl；同 body 不带栏 → 行为与旧客户端逐字同
```
