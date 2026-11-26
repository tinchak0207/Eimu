---
name: previs-director
description: >-
  一句话武侠/打斗 → 实时丝滑 3D 白模预演（director-engine 闭集运镜+动作）。
  用户要「预演/blocking/跟拍打斗/樱花剑客/可播白模」且目标是实时预演时必载；
  禁止改走 Blender 静帧冒充预演主路径。工具：director_get_state / propose / manage_shot / upsert_action / transport / capture_previz。
---

# 预演导演（Previs Director）

> 真源契约：`DirectorSequenceShot` / `DirectorPlan`（`src/lib/director-engine/types.ts`）。  
> **禁止**第二套 shot schema、`previs_compile`、平行 Kaykit clipMap。  
> 记忆锚：`2026-10-22-director-sequence-shot-is-previz-contract`。

## 目标硬闸

- **目标 = 实时丝滑预演**（白模可播、运镜/动作可读）。
- **禁止**把本任务改成 Blender 静帧 / Eevee 成品主路径（那是 `blender-director`；仅当用户明确要 `.blend`/成品渲染时才转）。
- 成片视频是下游；本 skill 先交可播 plan +（可选）`director_capture_previz` 关键帧。

## 何时用

用户用自然语言要一段**可播 3D 预演**（武侠/打斗/跟拍节奏/樱花剑客），而不是立刻出付费成片。

## 工具序（严格）

1. `director_get_state` — 读 elements / plans / capabilities（action、cameraMove 注册表）。
2. **可选**：`director_propose_plans({ instruction })` — 武侠/打斗/樱花/剑客等关键词时，服务端应把 S2 金样插为**第一候选**；展示给用户确认后 `director_apply_proposal`。  
   或自拼：`compileReferenceWuxiaPlan()` / `buildPlanFromClosedBeats(beats, base, elements)`（`planning-core.ts`）。
3. 逐步写入：`director_manage_shot` + `director_upsert_action`（复杂运镜再 `director_set_camera_keyframe`）。
4. `director_transport` 播放核对节奏。
5. `director_capture_previz` — 把已上传的预演关键帧 URL 写回 `shot.previz.keyframes`（不保证 MP4）。

## 闭集纪律

- 运镜 ∈ `CLOSED_CAMERA_MOVES`；动作 ∈ `CLOSED_ACTIONS`（见 [references/closed-set.md](references/closed-set.md)）。
- 写完一律 `normalizeCameraMove` / `normalizeActionId`（Levenshtein 最近邻）；**不要**让模型发明新 id，或把裸坐标关键帧当主路径。
- 拆成 **10–22** 个 beat；总时长目标 **26–34s**。
- 升格：至少 1 段 `timeScale`（如 `0.4`）且 ≥0.8s；全片升格占比约 5–20%。

## 镜头语法

- 特写前尽量有中/全交代；大招（`shockwave` / `cast-release`）放在时间轴 **70–90%**。
- 节奏停顿：close-up + `wipe-blood` / `crouch`。
- 群战：`handheld` / `follow`；符阵：`crane-up`；喊招：`tilt-up` + `raise-sword`。
- Zoom 慎用；武侠主用跟/推/拉/摇/升降/环绕/手持（运镜类型数 4–7）。

## 金样路径

- Plan：`docs/evidence/previs-harness-20261022/s2-golden/wuxia-cherry-plan.json`
- Doc：`docs/evidence/previs-harness-20261022/s2-golden/wuxia-cherry-doc.json`
- 加载：`compileReferenceWuxiaPlan()`（可选传入仓库根或 `.json` 路径）
- Checklist： [references/acceptance.md](references/acceptance.md) → A1–A20 双侧（静态度 + pending 播放/渲染侧）

## 参考 prompt 候选

见 [references/prompts.md](references/prompts.md)。

## 禁区

- 新 shot schema / previs_compile / 第二份 clipMap
- Blender 静帧冒充实时预演主路径
- 付费上游；重启 gateway；大改 prompt 生产包（除非仅为挂本 skill 的最小路由行）
