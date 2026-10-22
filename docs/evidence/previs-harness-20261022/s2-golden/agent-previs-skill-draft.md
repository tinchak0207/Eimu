# Agent Previs Skill 草稿（S2 · 未部署）

> 教 agent：一句话 → 闭集选 shot/action → 调现有 `director_*` 工具写入。  
> **不要**引入 VideoClaw/FilmAgent 依赖；只学「闭集枚举 + 相似度纠偏」形态。  
> 真源契约：`DirectorSequenceShot`（禁第二套 schema）。

## 1. 何时用

用户要用自然语言要一段**可播 3D 预演**（武侠/打斗/跟拍节奏），而不是立刻出成片视频。

## 2. 流程（严格）

1. `director_get_state` — 读 elements / capabilities（action、cameraMove 注册表）。
2. 把用户一句话拆成 **10–22 个 beat**（景别 + 运镜 + 1–5 个动作 + 时长）。总时长目标 **26–34s**。
3. **只从闭集选**：
   - 运镜 ∈ `CLOSED_CAMERA_MOVES`（`actionClipCatalog.ts` / cameraTemplates 24+）
   - 动作 ∈ `CLOSED_ACTIONS`（含打斗 kebab-case）
   - 名单外字符串先 `normalizeActionId` / `normalizeCameraMove`（Levenshtein 最近邻），**不要**让 LLM 发明新 id 或写裸坐标关键帧作为主路径。
4. 写入：
   - `director_propose_plans` → 用户确认 → `director_apply_proposal`；或
   - 逐步 `director_manage_shot` + `director_upsert_action`（复杂运镜再 `director_set_camera_keyframe`）。
5. 升格：镜头上设可选 `timeScale`（如 `0.4`）；缺省 1。至少 1 段 ≥0.8s 升格，全片升格占比约 5–20%。
6. 金样参考：`docs/evidence/previs-harness-20261022/s2-golden/wuxia-cherry-plan.json`；可用 `compileReferenceWuxiaPlan()` 加载对照。
7. 编程拼装：`buildPlanFromClosedBeats(beats, basePlan, elements)`（planning-core）——仍落既有 `DirectorPlan`。

## 3. 镜头语法（prompt 约束）

- 特写前尽量有中/全交代；大招（shockwave / cast-release）放在时间轴 **70–90%**。
- 需要节奏停顿时插 close-up + `wipe-blood` / `crouch`（参考 S10）。
- 群战用 `handheld`/`follow`；展示符阵用 `crane-up`；喊招用 `tilt-up` + `raise-sword`。
- Zoom 类慎用；武侠主用跟/推/拉/摇/升降/环绕/手持（类型数 4–7）。

## 4. 参考 prompt 候选（breakdown §6）

1. 「做一段 30 秒的武侠打斗：红衣剑客在樱花草原上单挑一群长角恶魔，花瓣剑气、腾空翻身，最后举剑召唤天上巨剑砸下来。」
2. 「帮我预演一个动作镜头：剑客冲进魔物群连斩，中途被打倒擦血，再爆发放大招，满天花雨收尾，要有电影感运镜。」
3. 「樱花 + 剑气 + 符阵的仙侠战斗短片，30 秒左右，快切跟拍、有一段慢动作特写，结尾主角转身冲向镜头。」

## 5. 禁区

- 新 shot schema / previs_compile
- Blender 静帧冒充实时预演主路径
- 付费 API；大改 gateway
- 平行第二份 Kaykit clipMap（扩展 `clipMap.ts`）
