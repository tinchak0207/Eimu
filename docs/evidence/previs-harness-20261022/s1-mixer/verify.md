# S1 Mixer 自验（2026-10-22 Asia/Shanghai）

## 判准
每张核对：① 是否蒙皮角色（非胶囊）② 是否有明显肢体动画（非滑步胶囊）。

## 截图

| 文件 | 时间线 | 核对 |
|---|---|---|
| `01-idle-combat.png` | Idle_Combat @ ~0.57s | **PASS** 蒙皮 Skeleton_Warrior（盔/披风/发光眼），战斗待机站姿，非胶囊 |
| `02-chop.png` | 1H_Melee_Attack_Chop @ ~0.52s | **PASS** 同蒙皮角色；斩击中段姿态与待机不同（躯干前倾/手臂抬起） |
| `03-dodge-forward.png` | Dodge_Forward @ ~0.50s | **PASS** 同蒙皮角色；明显蜷身前扑闪避姿态，肢体非滑步 |

状态条均显示 `ready clips=95`。

## 环境
- `npx next dev -p 3999` + Playwright chromium `deviceScaleFactor:2`
- 资产：`/zz-tmp-Skeleton_Warrior.glb` ← `.asset-cache/.../Skeleton_Warrior.glb`
- 暂存页：`src/app/zz-tmp-previs-mixer/page.tsx`（收工删除）

## 已知画面噪音（非 S1 阻塞）
- 根部过曝白光：角色 emissive + 引擎灯光；未为本波加后期
- 橙黄射线：DirectorEngine 自带 shotCameraHelper
- 顶栏 Navbar：走默认 app layout，不影响 mixer 判定

## 结论
**通过** — AnimationMixer 已驱动真实骨骼 clip。
