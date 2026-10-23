# E2E 武侠金样真路径自验（2026-10-22 Asia/Shanghai）

## 目标
加载 `wuxia-cherry-doc.json` + `Skeleton_Warrior.glb` AnimationMixer，按 plan 时间线播放，证明「不是胶囊摆腿」。

## 环境
- 机台：`ca347797-ce97-494a-869f-61fd9b1b365f`
- `npx next dev -p 3999` + Playwright chromium `deviceScaleFactor:2`（swiftshader）
- 暂存页：`src/app/zz-tmp-previs-wuxia/page.tsx`（收工已删）
- 资产：`public/previs-fixtures/` ← 金样 JSON + Warrior.glb（自 `.asset-cache/.../Skeleton_Warrior.glb` 拷贝；**未** git add）
- `clips=95`；hero 绑 mixer，敌人保留 mannequin；bloom 默认关

## 截图清单

| 文件 | 内容时钟 | HUD / 状态 | 核对 |
|---|---|---|---|
| `01-t1-fight.png` + `-capture.png` | t≈1.0 | shot-s01 / slash / `1H_Melee_Attack_Slice_Horizontal` / ts=1 | 开打段；capture 见蒙皮 Warrior + 紫胶囊敌人 |
| `01b-slash-mid-capture.png` | t=0.85 | slash 中段 | Warrior 前倾动态姿，非 T-pose / 非胶囊 |
| `01c-slash-late-capture.png` | t=1.05 | slash 后段 | 同 clip 内姿态继续变（像素差 bbox 非空） |
| `02-t16-wipe-blood-slow.png` + `-capture.png` | t≈16.0 | **shot-s10 / wipe-blood / Interact / timeScale=0.4** | A7：升格段命中；capture 为推近盔特写（运镜切至 push） |
| `02b-wipe-mid.png` | t=16.1 | 同上 timeScale=0.4 | HUD 再证慢动作倍率 |
| `03-t24-ult.png` + `-capture.png` | t≈24.0 | shot-s13 / cast-summon / Spellcast_Summon | 大招段；高机位 + 群敌 mannequin |
| `03b-ult-mid-capture.png` | t=24.2 | cast-summon | 举招姿 |
| `03c-ult-shock-capture.png` | t=24.9 | **shockwave / Spellcast_Shoot** | 同镜内 action/clip 切换 |
| `04-burst-t1_00`…`t1_60` | 1.00→1.60 | s01→跨入 s02 | 连续截：构图/镜头切换发生 |
| `05-slow-a/b(-capture)` | 15.7 / 16.5 | S10 内 | 慢段内两帧像素差 meanAbs≈15 |
| `capture-log.json` | — | 原始 getState() | 机器可读状态 |

说明：主视口渲 orbit camera；极端特写时 orbit 构图可能空镜。**视觉 oracle 以 `captureShot`（shotCamera）为准**；HUD 以 viewport 截图为准。

## Checklist 对照（pending → 本波）

| # | 判准 | 本波结论 | 证据 |
|---|---|---|---|
| **A10** | 骨骼动作连续性（非静态 / 非胶囊摆腿） | **PASS** | Warrior 蒙皮盔甲/披风可见；slash / Spellcast_* 姿态非 T-pose；burst 与 01b↔01c、03b↔03c 像素差非零；敌人仍为紫色 mannequin（单槽 mixer 已知） |
| **A7** | 升格 5–20% 且 ≥1 段 ≥0.8s | **PASS（播放侧）** | 金样 S10 `timeScale:0.4` 共 1.63s；HUD 于 t≈16 显示 `timeScale=0.4` + `wipe-blood`；S3 已证 wall→content 时钟 |
| **镜头切换** | 多镜连播切镜发生 | **PASS** | t=1→s01 follow；t=16→s10 push 特写；t=24→s13 tilt-up 大场面；burst 跨 s01/s02 |

未在本波重判：A11–A14、A16、A19（帧率日志/穿模/占幅/粒子/场景资产）。

## 播放是否顺
- evaluateDirectorFrame + `hasMixer(id==='hero')` + playClip(seek) + updateMixer：**通**
- 金样 action → clipMap 全覆盖，**未改金样镜头结构**
- 强制 `hero.visible=false`（elementStates 会盖回 true，否则胶囊叠骨骼）
- glTF 根每帧同步 hero 位移/朝向

## 阻塞 / 噪音（非本波失败）
1. `setGltfAsset` 单槽：仅 hero mixer；敌人胶囊可接受
2. orbit 视口在极端 push 特写时易空镜 → 以 captureShot 为证
3. Navbar 进入 viewport 截图（与 S1 相同噪音）
4. 未接 per-element mixer；未改 prepare_export / S4
5. `public/previs-fixtures/Skeleton_Warrior.glb` 仅本地，**禁止 git add**

## 收工
- 删 `src/app/zz-tmp-previs-wuxia/`
- 杀 next :3999；`rm -rf .next/types`
- **未 commit**
