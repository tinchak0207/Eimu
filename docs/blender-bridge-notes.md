# blender-bridge 桥接说明与 deny 例外暂存（Astra 3D P0-4，片C，2026-09-06）

分工：桥（`bridge/blender-bridge`，Blender headless 沙箱执行器）由片 A 施工；本档记录工具层与桥的
HTTP 契约、错误分类，以及 deny 表暂存条目。**桥的启动方式与内部实现以片 A 的桥源码/README 为准，
本档不重复，避免漂移。**

## 1. 工具层现状（诚实标注）

- 三工具定义+handler 真源：`src/lib/blender-tools.ts`（blender_exec / blender_render / blender_export_gltf）。
- 已登记进 harness 真源清单 `src/lib/harness-tool-registry.ts`（P0-4 片C 完成面）。
- **registry 注册 ≠ harness 能跑**（2026-08-31 诚实稽核教训）：VPS `.opencode/tools/` 落位、
  opencode-server 重启、活体注册确认、真桥 smoke 均未做，待桥（片 A）就绪后补。
- 定义形状同构 `src/vendor-bridges/opencode-tools/director_*.ts`；因 `@opencode-ai/plugin` 不在
  src/lib 可解析范围，`args` 以描述符承载，VPS 落位时逐条译成 `tool.schema` 调用、execute 体原样搬运。

## 2. 传输契约（与片 A 逐字钉死，双方不得单方面改动）

桥位址 = 环境变数 `BLENDER_BRIDGE_URL`，默认 `http://127.0.0.1:8765`。

```
GET  /v1/health → 200 {ok:true, blender_version, gpu:"egl"|"cpu", workdir}
POST /v1/execute body {script:string, timeout_ms?:number} →
  200 {ok:true, artifacts:[{path,bytes,kind}], scene_summary:string, stdout_tail:string, duration_ms:number}
  500 {ok:false, error:string, stdout_tail:string}
```

## 3. 工具 → 契约映射

| 工具 | 调用方式 | 说明 |
| --- | --- | --- |
| blender_exec | 直接 POST /v1/execute（script 原样透传） | 建场景/改场景/骨架动画 keyframe；产物写相对路径即落桥工作目录 |
| blender_render | 工具层合成 bpy 脚本 → POST /v1/execute | eevee（BLENDER_EEVEE_NEXT → BLENDER_EEVEE 逐个尝试）/cycles；frames 帧序列 PNG；turntable=true 走空物体 pivot 旋转 keyframe + FFMPEG/H264 输出 mp4（默认 1-96 帧，线性插值） |
| blender_export_gltf | 工具层合成 bpy 脚本 → POST /v1/execute | GLB（默认）/GLTF_SEPARATE；AttributeError 时自动启用 io_scene_gltf2 再导出 |

超时口径：客户端中止 = timeout_ms + 10s 宽限（让桥的结构化 500 带 stdout_tail 先到）。
默认值：exec 120s（可传 timeout_ms 参数）、render 1800s、export 300s（不可传，防长渲染被客户端误杀）。

## 4. 错误分类（工具层返回结构化 fail，绝不抛原始 fetch 错误）

| code | 触发 | 文案要点 |
| --- | --- | --- |
| bridge_unavailable | ECONNREFUSED/ENOTFOUND/ECONNRESET/TypeError | 「**桥未启动，请先启动 blender-bridge**（默认地址 + GET /v1/health 验证）」+ 指向本档 |
| bridge_timeout | 客户端中止先于桥响应 | 上限毫秒数 + 可传更大 timeout_ms 的指引 |
| blender_script_error | 桥回 500 {ok:false} | 透传桥的 error + stdout_tail（人话，非原始堆叠） |
| bridge_http_error | 非 200 且无 {ok:false} 体 | 异常状态码 + health 验证指引 |
| bridge_bad_response | HTTP 200 但缺 ok:true 成功体 | 契约形状异常，指向本档 |
| invalid_args | 本地参数校验（缺 script / engine/format 枚举外 / frames 格式） | 不发网络请求直接返回 |

防逃逸：output_name 白名单化（剥扩展名、路径分隔符转 `_`、截 80 字符）；所有嵌入 bpy 脚本的
字符串参数经 pyStr 转义。脚本内容级沙箱（bpy API blocklist 等）属桥侧职责（片 A）。

## 5. deny 情况（本地勘察结论 + 暂存条目）

**本地勘察**（2026-09-06）：`grep -rn "deny" src/lib --include=*.ts` 零命中——repo 内无本地
deny/沙箱配置真源。deny 表唯一真源 = VPS `/opt/agent-harness/workspace/.opencode/opencode.json`
的 `permission.bash`；repo 内 `deploy-staging/opencode.json` 是 08-24 旧快照，已与 live 漂移，
勿当真源（记忆 agent-harness-deny-table-architecture）。08-29 放宽后 live 表为「预设 allow +
主机破坏红线 deny」，gateway 每 60s 自动重读，改表免重启 gateway。

**暂存条目**（本片未动 VPS；落位时按此对账）：

1. **工具层无需任何 deny 放行**：opencode 工具执行是 node 进程内 fetch（桥 127.0.0.1:8765），
   不经 bash permission 表。
2. **桥/Blender 进程安全**：桥必须绑 127.0.0.1（禁止 0.0.0.0 对外）；桥侧 bpy 脚本执行前建议
   blocklist `import os/subprocess/socket/shutil/ctypes` 与绝对路径 `open()`（白名单仅桥工作目录）。
   属片 A 施工建议，非 deny 表条目。
3. **若 agent 需要用 bash 工具直跑 Blender CLI**（如 `blender --background --python xxx.py`）：
   暂存建议 `"blender *": "allow"`。按 08-29 后 live 表预设 allow 无需改动；仅当日后回退为
   「预设 deny + 白名单」时，才按同构加此条目（并同步确认 `*blender-bridge*` 启动命令放行）。
4. **不新增任何 deny**：blender 工具族没有需要收紧的 bash 面；主机破坏红线（sudo/dd/systemctl 等）
   维持现状。

## 6. 落位时的验收对账（后续片/Astra P0 收尾用）

- [ ] 桥 GET /v1/health 返回 200 且 gpu 栏位非空（片 A 交付物）
- [ ] VPS `.opencode/tools/blender_{exec,render,export_gltf}.ts` 落位 + opencode-server 重启
- [ ] `/experimental/tool/ids` 活体列出三 id
- [ ] bun 直调 smoke：桥关闭 → bridge_unavailable 人话错误；桥开启 → exec/render/export 真产物
- [ ] 本档 §5 与 live opencode.json 对账一次（防 08-29 后再漂移）

## 7. 委托单与回传接线（P1-4 片H，2026-09-06）

委托单构造器 `composeDelegation(input)`（`src/lib/blender-delegate.ts`）：schema
{effect_description, reference_refs?, shot_count, duration_sec?, style_constraints?,
deliverables[]}，deliverables 白名单 turntable/stills/blend/glb，序列化后 ≤2k token
超限结构化报错。回传接线：bridge `/v1/execute` 成功体 artifacts 按 kind 分拣成
Scene3dCardMetadata 六栏（turntable=mp4、stills=png、blend/glb 路径；缺 mp4 用首张
png 兜底并标注 summary；缺 blend/glb 返回结构化错误不产半形）；写入画布走既有
canvas_apply_ops 的 add_node op（`buildScene3dCanvasOp`），经 canvas.ops SSE →
前端 normalizeAgentNode（缺尺寸取 420×360 预设）→ toScene3dCard 白名单 →
Scene3dCardBody 渲染。产物 URL 映射 resolveArtifactUrl 可注入（既有
image-proxy/下载连结形，不自造上传通道）。契约测试 blender-delegate.test.ts 16 案。

## 8. 3D 资产入库与脚本指纹（P1-5 片I，2026-09-06）

`src/lib/blender-asset-store.ts`：bridge 产物（blend/glb）+ bpy 脚本全文入资产包
（kind `scene_3d`/`bpy_script`，真源 `asset-pack-store.ts` 同构扩展）。
`fingerprintScript`＝引号外去注释＋空白折叠（保留缩进）后双通道 FNV-1a 64 指纹；
`findTemplateByFingerprint` 命中即回脚本模板零 token 复用（成本护栏核心）。
`saveSceneAssets` 幂等入库固定包 `blender-3d-assets`。契约测试 blender-asset-store.test.ts。

## 9. viewport 预览通路（P1-3 片P，2026-09-06）

`.blender-work/out/` 不在 Next 静态服务范围，image-proxy 只收 https 公网 image/*，
故 glTF 预览走新分支 `GET /api/blender-artifact?name=<单段档名>`（requireVerifiedUser；
副档名白名单 glb/gltf/blend/png/jpg/webp/mp4/webm；禁 traversal；Content-Type 对应
model/gltf-binary 等）。GLTFLoader fetch 带不了 Bearer 头（token 在 localStorage），
Scene3dGltfViewport 先 authHeaders fetch 拉 bytes → blob URL → engine.setGltfAsset
（白模 mannequin 共存，片E默认）。场景卡「3D 预览」钮内嵌切换，壳内不叠卡。

## 10. 视频嵌合（P2 桩：previz→video 全管线，2026-09-06 片Z）

`src/lib/blender-to-video-bridge.ts`：sceneCard.stills_urls → `GenerationReference[]`
参考卡（i2v 首/尾帧通道 cap 2）；previz 档 role=composition 不占帧位，lookdev 可作
style/首尾帧。`src/lib/camera-trajectory-to-prompt.ts`：L1 运镜 id/bpy keyframes →
六槽 Camera 槽描述词（seed-mapping §1.2 反向）。接线＝invisible-prompt-director
DirectorOptions 增 sceneCard/cameraTrajectory 九行：会话有 sceneCard 才覆盖 camera
槽，用户明示运镜不干预；无 sceneCard 零行为变化（回归测试钉死）。

## 11. blender 节点 supplier channel（片Y/片AA，2026-09-06）

blender-bridge 以 supplier channel 形态进 generation-core 派发（staging 稿
`deploy-staging/blender-nodes/NODES-PLAN.md`；registry 条目
`src/lib/supplier-channels.config.ts` marker 区 blender-local、adapter 分支
`src/lib/generation-core/blender-node-upstream.ts`）。能力标签＝capability
model_id：`blender-render-eevee` / `blender-render-cycles`（catalog 条目，
不入 SUPPORTED_* → C 端选单不可见）。

### env 三件套（值不写死进库；本表只记名称与语义）

| 变数 | 样板值 | 说明 |
| --- | --- | --- |
| `BLENDER_NODE_LOCAL_URL` | `http://127.0.0.1:8765` | VPS 侧值固定此形（片W 反向隧道裁定）；本机直连同值 |
| `BLENDER_NODE_LOCAL_TOKEN` | （随机生成，不入库不入 commit） | 桥侧 Bearer 共享 token（片W §5 patch 落位前桥无鉴权，值仅满足 configured 语义） |
| `BLENDER_NODE_LOCAL_ENABLED` | `true` | 清洗后严格 `=== "true"` 才 defaultEnabled（registryChannelToDescriptor 语义） |

落位面（缺一则 seed 静默跳过/静默出队——诚实行为非缺陷）：VPS
`.env.control-plane`（worker seed 用）＋ Vercel env（站点队列用）＋本机 `.env.local`（本地验证用）。

### adapter 行为要点（`generateWithBlenderNode`）

- 同步 adapter：POST /v1/execute 单帧 job（片L 安全单位），无 provider task id，
  protocolOfAdapter 不映射、不进 provider-reconciliation。
- health 先行（GET /v1/health → workdir/gpu/queue_depth 证据）；产物 png 磁碟直读
  （workdir/out 相对路径 + traversal 守卫）→ base64；png 缺席保留 blend/glb 站内路径。
- 429 queue_full/连线抖动＝瞬态交 worker 重试；桥 500 原文（error+stdout_tail）透传。
- timeout：`BLENDER_NODE_EXECUTE_TIMEOUT_MS`（默认 600s；桥判定先行，客户端 +10s 宽限）。

## 11. 工具面穿线（片AC，2026-09-06）

sceneCard/轨迹穿进视频工具面：`scene3d-video-fusion.ts` 融合层（脏栏回 null）；
`last_frame_video_chain` 输入增 `scene_card_ref`/`camera_trajectory` → 输出
`sceneDirector`；C 端 `/api/generate-videos` body 增同名可选栏直通 DirectorOptions，
data URL 帧转 File 进 multipart（cap 2）。缺栏零行为变化。VPS 消费配方：
`deploy-staging/blender-gateway/ac-video-scene-stitch.md`。
