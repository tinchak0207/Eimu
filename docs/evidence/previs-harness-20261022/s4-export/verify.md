# S4 导出下游 · 预演关键帧 → previz.keyframes

- 日期：2026-10-22（Asia/Shanghai，UTC+8）
- 性质：能力建设证据；WebGL 真截帧；上传在无会话时以 dataURL 落盘冒充（代码仍接真 upload）

## 字段形状（照抄网关，禁新 schema）

```ts
shot.previz?: { motion_ref?: string; keyframes?: string[] }
// keyframes = https URL[]（非 dataURL）
```

真源：`deploy-staging/gateway/video-prompt-schema.ts:144`（`ShotJson.previz`）。
`DirectorSequenceShot` 已叠同形可选栏位（`src/lib/director-engine/types.ts`）。

## 网关消费点

`deploy-staging/gateway/workflow-gw-submit.ts`：

- ~340–342：把 `shot.previz.keyframes` 计入首行参考图数量说明
- **403–412**：`previzRefs` 过滤非空 string 后并入 `orderedRefs` → `payload.reference_images`

## 工具

- 名：`director_capture_previz`
- 职责：把已上传的 https URL 经 `updateShot` 写回 `shot.previz.keyframes` + `save`
- WebGL 截帧 / 附件上传在前端：`capturePlanKeyframes` + `uploadPrevizDataUrls`（`uploadAgentAttachments` 通道）
- `capabilities.export_boundary`：「可截关键帧并写 previz.keyframes；仍不保证 MP4」

## 证据图（本目录）

| 文件 | 含义 |
|---|---|
| `01-start.png` | 镜 `shot-s4` 首帧（t=0.00s） |
| `02-mid.png` | 中帧（t=1.50s） |
| `03-end.png` | 尾帧（t≈2.96s，略内收避免越界） |
| `00-page.png` | 自验页整页（三缩略图） |
| `verify-raw.json` | HUD / 字节数 / 错误（空） |

Oracle：Playwright 打开 `/zz-tmp-s4-export`，读 `window.__s4Frames`（`capturePlanKeyframes` 产出）落盘。HUD：`captured=3 labels=start,mid,end`。

## 已知限制

- **鉴权 / 无会话**：`uploadPrevizDataUrls` / `mintUploadsTicket` 需登录会话；无会话时 `exportPlanPrevizKeyframes` 返回 `localOnly` dataURL + `uploadError`，不假装已写网关。
- **CORS / 票 TTL**：公网 URL 经 `buildAssetUrl` + uploads ticket；票过期后 URL 失效，需重铸或重新导出。
- **MP4**：`capturePlanVideo` 仅 stub（`mp4_not_implemented`）；MediaRecorder/ccapture 未接入。
- **工具面**：`director_capture_previz` 不跑 WebGL；agent 需前端导出或自备 https URL 再调用写回。

## 收工

- 删 `src/app/zz-tmp-s4-export/`
- 杀 next :3999
- 不写新测试
