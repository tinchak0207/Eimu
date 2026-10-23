# S3 polish 自验（2026-10-22 Asia/Shanghai）

## 交付

### 1. timeScale（慢动作）
- `DirectorSequenceShot.timeScale?: number`（`types.ts`，缺省兼容旧计划）
- `resolveShotTimeScale()`（`playback.ts`）
- `DirectorMiniViewport` tick：`t += dt * resolveShotTimeScale(currentShot)`（缺省 1；0.4≈升格）
- 时钟证明（verify-raw.json）：wall 1s @ slow → content +0.4（2.5→2.9）；@ normal → +1.0

### 2. 光照 / bloom
- **已接**：Hemisphere + Ambient + Directional（投射阴影）+ 地面 `receiveShadow` + 元素 `castShadow`
- **HDRI/PMREM**：尝试加载 `/hdri/studio_small_09.hdr`（`public/hdri` → `.blender-work/assets/hdri` 符号链接）；失败则保留加强灯
- **Bloom**：`postprocessing` **未**在 package.json → **未 npm install**；用 three 自带 `UnrealBloomPass`（+ EffectComposer/RenderPass/OutputPass）
  - 强度微光档 `strength=0.08 / radius=0.4 / threshold=0.9`
  - **默认关闭**（`bloomEnabled=false`），避免人物根部过曝；`setBloomEnabled(true)` 可选开启
- 方向光强度 1.05、半球 0.45（相对初版略降，配合关 bloom）

### 3. 与 S1 冲突
- S1 已写入 `gltfMixer` / `playClip` / `updateMixer` / clip 级 `timeScale`
- S3 **保留**全部 mixer API，仅叠加灯光/阴影/可选 bloom 与 shot 级 `timeScale`
- 无字段名冲突；`playClip` 的 action `timeScale` ≠ shot `timeScale`（互补）

## 截图
| 文件 | 含义 |
|---|---|
| `01-normal-mid.png` | 内容 t=1.25，shot 正常×1，timeScale=1；立方体落地清晰、阴影可见、无过曝 |
| `02-slow-mid.png` | 内容 t=3.75，shot 慢动作×0.4；机位不同，证明进入慢段 |
| `03-capture-normal.png` | `captureShot` 正常镜中点 |
| `04-capture-slow.png` | `captureShot` 慢镜中点 |
| `verify-raw.json` | HUD / 时钟 / bloom 默认关 |

## 禁项核对
- 未装 Theatre studio / Remotion / mediabunny / `postprocessing` npm 包
- 未动 Blender / 网关 / 测试

## 收工
- 删 `src/app/zz-tmp-s3-polish/`
- 杀 next :3999
