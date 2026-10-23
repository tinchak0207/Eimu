# S2 金样对照 A1–A20 checklist

- 日期：2026-10-22（Asia/Shanghai，UTC+8）
- 金样：`wuxia-cherry-plan.json` / `wuxia-cherry-doc.json`
- 校验：`npx tsx docs/evidence/previs-harness-20261022/s2-golden/validate-golden.mts`

图例：`[x]` 金样静态可打勾 · `[ ]` pending（依赖 mixer / 实时渲染 / 导出）

| # | 判准 | 状态 | 金样证据 / 说明 |
|---|---|---|---|
| A1 | 总时长 26–34s | [x] | 30.00s（S01 start 0 → S15 end 30） |
| A2 | 镜头数 10–22 | [x] | 15 段，与 reference/shots.json 对齐 |
| A3 | 平均镜头长 1.3–3.0s | [x] | 30/15 = 2.00s |
| A4 | 单镜最长 2.5–5.0s | [x] | S11 = 4.17s |
| A5 | 运镜类型 4–7 | [x] | 7：follow / handheld / crane-up / orbit / push / pull / tilt-up |
| A6 | 景别 ≥4 且含特写+大远/全 | [x] | close-up + extreme-wide + wide + medium + medium-close |
| A7 | 升格 5–20% 且 ≥1 段 ≥0.8s | [x] | S10 `timeScale:0.4` 共 1.63s ≈5.4%；S03/S13 局部升格记 notes.localSlow |
| A8 | 有效攻击 12–30 | [x] | 金样攻击类 action 计数 18（validate） |
| A9 | 战斗段攻击密度 0.5–1.5/s | [x] | 静态估：战斗段 ~18.6s、攻击≥14 → ≈0.75/s（按 action 事件，非命中帧） |
| A10 | 骨骼动作连续性 | [ ] | pending：需 AnimationMixer / 关节轨迹采样（S1 mixer + S3） |
| A11 | 播放帧率 | [ ] | pending：预演播放器帧时间日志 |
| A12 | 穿模 0 | [ ] | pending：碰撞/深度检测 |
| A13 | 主体占画面高度分档 | [ ] | pending：渲染 bbox；金样仅按 shotScale 设机位距离 |
| A14 | 主体出画 | [ ] | pending：播放采样 |
| A15 | 同屏敌人峰值 8–40 | [x]/[ ] | 静态：`enemy-crowd` 3×5=15 + 近身≤3 → 峰值设计达标；实体实例化 pending mixer/引擎 |
| A16 | 特效五件套 | [ ] | pending：粒子/bloom（S3）；notes 已标注剑气/符阵/冲击波意图 |
| A17 | 起承转合（低谷+大招 70–90%） | [x] | S09–S10 低谷；S13 大招约 23.7/30≈79% |
| A18 | 硬切 ≥2 且 ≤段落数−3 | [x] | notes/参考：S14、S15 硬切；另有 S11 跳切 |
| A19 | 场景要素 | [ ] | pending：草地/樱花树/远山/云天/体积光需场景资产（非 DirectorPlan 字段） |
| A20 | 委托逐项对账 | [x] | 15 段覆盖 breakdown §3 时间点；无 >3s 额外段 |

## 汇总

- 静态可勾：**12**（A1–A9、A17、A18、A20；A15 半勾按设计计 1）
- pending：**8**（A10–A14、A16、A19；A15 渲染侧）
- 严格计：通过 **11**，半通过 **1**，pending **8**

## 闭集 / 产物路径

- `src/lib/director-engine/actionClipCatalog.ts` — `CLOSED_*` / `normalizeActionId` / `normalizeCameraMove`
- `src/lib/director-engine/clipMap.ts` — Kaykit 映射（S1+S2，勿平行第二份）
- `src/lib/director-engine/planning-core.ts` — `buildPlanFromClosedBeats` / `compileReferenceWuxiaPlan`
- 新增 DirectorActionId（相对 S1 批次）：`slash-spin` `slash-diagonal` `slash-combo` `jump` `flip-air` `land` `roll` `dash` `charge` `knockback` `slide-land` `cast-summon` `cast-circle` `cast-release` `raise-sword` `shout` `shockwave` `launch` `wipe-blood`
