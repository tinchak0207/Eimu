# NL → 丝滑 3D 预演 Harness 方案（2026-10-22）

## 目标
一句话 → agent 编排 → 实时可播、流畅美观的 3D 预演（真骨骼动作 + 运镜节奏）→ 帧/视频喂下游。
参考标杆：樱花草原剑客 30s（`reference/`）。禁新 schema；禁用 Blender 静帧冒充主路径。

## 证据
- anatomy.md：最大杠杆 = Kaykit clip → AnimationMixer；propose 现为关键词 fallback
- external.md：FilmAgent 闭集枚举；Quaternius/Kaykit CC0；theatre core 可选；ccapture 录制
- reference/：15 段、A1–A20 双侧判准

## 切片
### S1 动作层（本波）
- 扩展 `assetLoader` / `setGltfAsset`：加载带 AnimationClip 的 GLB，挂 AnimationMixer
- 追加 DirectorActionId（斩/刺/闪/跳/受击…）→ Kaykit clip 名映射表
- `playback.evaluateDirectorFrame`：有 mixer 则播 clip，否则回退程序化关节
- 本地 zz-tmp 页：Warrior 连斩 5s，截图自验

### S2 样例编排（本波）
- 把 reference/shots.json 编译成 DirectorPlan 金样（复用既有 SequenceShot 字段）
- FilmAgent 式闭集：LLM/agent 只从枚举选 cameraMove + action
- 可选恢复 planning-core LLM 路径（仍输出 RawPlan→既有类型）

### S3 节奏与美观（紧随）
- shot 级 timeScale（慢动作，对应 A7）
- 轻量 bloom + HDRI 一档；粒子大招库可后置

### S4 导出（紧随）
- plan 逐帧 capture → 自动填 shot.previz.keyframes（打通 4a34357c）
- SequenceShot→bpy 转换器仍是 L2，非主线

## 非目标
- 新 previs_compile / 第二套 shot schema
- Blender 静帧采样、判准、资产库扩充当主交付
- HY-Motion / Mixamo 主链路；Remotion；theatre studio（AGPL）
