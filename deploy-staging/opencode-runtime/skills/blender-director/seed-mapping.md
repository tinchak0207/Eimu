# L1 种子数据 → bpy keyframe 映射表（3D 导演）

> 用途：director-engine（L1，three.js 白模 previz，`src/lib/director-engine/`）已上生产，
> 其机位/运动/路径数据是**免费的 blocking 初值**。本表是 Astra/agent 把 L1 种子直迁进
> Blender（L2，bpy 5.2）时的对照参考——先读 L1 数据结构，再按本表生成 bpy keyframe，
> 之后才按 recipes 精修。
>
> **铁律**：本档只是数据映射文档。director-engine 已被裁定停止新增投资——**禁止修改
> `src/lib/director-engine/` 任何文件**，本库只读。坐标系换算见 §4。

数据来源三档（只读）：
- `src/lib/director-engine/cameraPresets.ts` — 镜头组合（CAMERA_COMBOS）+ 运镜（CAMERA_MOVES）
- `src/lib/director-engine/motionTemplates.ts` — MOTION_TEMPLATES（60+ 动作模板）+ `createMotionKeyframes()` 5-KF 生成器
- `src/lib/director-engine/pathCurve.ts` — Cubic Bezier 路径采样 + 平滑/拐角控制柄

---

## 1. 相机种子（cameraPresets.ts）→ bpy 相机 keyframe

### 1.1 CAMERA_COMBOS（镜头组合 → 相机参数初值）

L1 的 combo 是**提示词字典**（`body` 是追加进生图 prompt 的文字），数值藏在文案里。
迁进 bpy 时按以下表读数（焦距=文案中的 mm，光圈=f 值），落到 `CameraData`：

| L1 combo id | 焦距 lens(mm) | 光圈 → bpy 换算 | bpy 落点 |
|---|---|---|---|
| `portrait-85` | 85 | f/1.8 → fstop=1.8 | `camera.data.lens=85; dof.focus_object=主体; dof.aperture_fstop=1.8` |
| `product-24` | 24 | f/8 → fstop=8.0 | 同上，深景深 |
| `scene-50` | 50 | f/4 → fstop=4.0 | 默认叙事机位 |
| `env-portrait-35` | 35 | f/2 → fstop=2.0 | 人物+环境 |
| `macro-100` | 100 | 极浅 → fstop=1.4 起 | 微距特写 |
| `anamorphic` | 按 2.39:1 取景 | — | `render.resolution_x/resolution_y` 调成 2.39:1；椭圆光斑后期合成做（Blender 相机无原生 anamorphic） |
| `leica-doc` | 35 | f/1.4 | 纪实机位 |
| `drone-wide` | 16 | — | 高空俯瞰机位 |
| `vintage-helios` | 58 | f/2 | 旋焦 L1 无实参数， bpy 端按 f/2 浅景深 + 后期 |
| `tele-200` | 200 | — | 空间压缩，机位拉远 |
| `fisheye` | 8 | — | `camera.data.type='PANO'; panorama_type='FISHEYE_EQUIDISTANT'` |
| `goldenhour` | 任意 | — | 不是相机参数，是灯光/时间（§3 灯光位） |

> 标注：L1 combo 里没有 camera 位置/朝向数值——L1 只到 prompt 层。位置初值来自
> `presetCameras.ts` 的 CameraPose（同样只读，不在本表展开），或 agent 按分镜放置。

### 1.2 CAMERA_MOVES（运镜 → bpy 相机动画）

L1 运镜也是 prompt 语义（无关键帧数值）。bpy 端把语义落成**相机 location/rotation
keyframe**（配合 `EMPTY_CamTarget_[Shot]` 做_track-to_约束）。标准落地：

| L1 move id | bpy keyframe 方案 |
|---|---|
| `dolly-in` / `slowpush` / `crashzoom` | 相机 location 沿视线插值：首帧远、末帧近；`slowpush` 帧距拉长、`crashzoom` 1-2 帧内完成 |
| `dolly-out` | 同上反向 |
| `pan` / `whippan` | 相机 rotation_euler[2]（或 target empty 旋转）keyframe；`whippan` 配快曲线 |
| `tilt` | rotation_euler[0] 由下至上 |
| `truck` | location 横向平移，与主体平行 |
| `pedestal` | location 竖直移动 |
| `orbit` / `arc` | 相机父级空物体 rotation_euler[2] 0→360°（orbit 整圆，arc 部分弧），配 `CAM_Turntable` 同款模板 |
| `follow` | `TRACK_TO` 约束锁 target + location 跟随主体 path |
| `handheld` / `steadicam` | 基础轨迹 + noise modifier（`handheld` 幅度大、`steadicam` 微小） |
| `dollyzoom` | location 推近同时 `camera.data.lens` 反向 keyframe（视野补偿） |
| `aerial` | 高空 location 下降接近主体 |
| `lowangle` / `overshoulder` / `pov` / `static` | 静态机位：单帧 pose，不 keyframe |

对应配方：`recipes/camera-cinematography/RECIPE.md`（运镜表一节同构）。

## 2. 动作种子（motionTemplates.ts）→ bpy 骨架 keyframe

### 2.1 模板 → 5 关键帧布局（createMotionKeyframes 的形状）

L1 `createMotionKeyframes(action, durationSec, from, to)` 固定产出 **5 个关键帧**
（times = `[0, 0.18, 0.5, 0.82, 1]`），bpy 端按同布局落帧（frame = timeSec × fps，fps 默认 30）：

| KF index | progress | timeSec | 语义 | bpy 落帧 | interpolation |
|---|---|---|---|---|---|
| 0 | 0.0 | 0 | 起势 | pose.location = from | `ease-out`（bpy: Bezier，末柄平） |
| 1 | 0.18 | 0.18·D | 起步 | lerp(from,to,0.18) | `smooth`（Bezier 自动手柄） |
| 2 | 0.5 | 0.5·D | 动作峰值 | lerp 0.5 | `smooth` |
| 3 | 0.82 | 0.82·D | 收步 | lerp 0.82 | `smooth` |
| 4 | 1.0 | D | 收势 | pose.location = to | `ease-out` |

L1 的 `defaultDurationSec`（每模板自带，0.7–3.0s）直接 × fps = bpy 帧距。
L1 interpolation 枚举 `'hold'|'linear'|'smooth'|'ease-in'|'ease-out'` → bpy：

| L1 值 | bpy fcurve 处理 |
|---|---|
| `hold` | `keyframe.interpolation='CONSTANT'` |
| `linear` | `='LINEAR'` |
| `smooth` | `='BEZIER'` + auto clamped handles |
| `ease-in` | Bezier，起柄平 |
| `ease-out` | Bezier，末柄平 |

### 2.2 L1 动作 id → bpy 骨架驱动方式

L1 的 60+ 模板分两类落地：

**A. 位移类（moving=true，带 suggestedDistance）**——根运动走 root/hips bone 或 mesh 的
location keyframe（沿 §3 路径），步态由骨骼循环盖：

| L1 id | suggestedDistance（米） | bpy 方案 |
|---|---|---|
| `walk` | 2 | root location 沿路径 + walk 循环（见 2.3 步态参数） |
| `fast-walk` | 2.6 | 同上，步频 ×1.8 |
| `run` | 3.2 | 步频 ×2.3，幅度加大 |
| `step-forward` / `step-back` | ±0.7 | 单段 root 位移 |
| `follow` / `pass-by` / `dodge` / `enter-car` / `exit-car` | 1.2–2.4 | root 沿路径位移 |

**B. 关节类（站立/视线/手部/姿态/情绪/专项）**——按 `animatedJoints()`（playback.ts）
的关节参数直接译成骨骼旋转 keyframe。L1 JointName → bpy 骨骼映射（§2.3），L1 关节
Vec3 是**欧拉角（度）**。代表性模板的译法（其余同构，值 playback.ts 逐条可查）：

| L1 模板 | L1 关节参数（度，envelope 包络） | bpy 关键帧 |
|---|---|---|
| `nod` | neck.x = sin(p·4π)·16 | `neck` bone X 轴旋转 keyframe，4 个半周期 |
| `shake-head` | neck.y = sin(p·4π)·24 | neck Y 轴 |
| `wave` | shoulderR z=-145 恒举 + elbowR z=-25+sin(p·8π)·28 | shoulderR 定帧 + elbowR 多帧摆动 |
| `turn` | hips.y=p·55, spine.y=p·28, neck.y=p·18 | 三骨 Y 轴递进 keyframe（头先回） |
| `look-back` | spine.y=sin(pπ)·22, neck.y=sin(pπ)·55 | 回望弧线 |
| `pick-up`/`put-down` | spine.x=sin(pπ)·38, knee 38, shoulderR.x=72… | 弯腰弧，p=0.5 最低点 |
| `sit`/`stand-up` | hip -90 / knee 90 × (1-ease(p)) | 坐姿定值 + 起身缓出 |
| `speak`/`sew`/`read`/`write` | 手臂定姿 + 肘/颈正弦微动 | 定姿帧 + 微动帧 |

### 2.3 JointName → bpy 骨骼对照（mannequin 拓扑）

L1 十关节（types.ts `JointName`）对应标准 humanoid rig（`recipes/rigging/RECIPE.md`
的 `ARM_Character` 层级，rigify/rename 后按此对号）：

| L1 JointName | bpy 骨骼（rigify 命名） | 轴语义（L1） |
|---|---|---|
| `hips` | torso / Hips | 骨盆旋转（度） |
| `spine` | spine | 脊柱 |
| `neck` | neck | 颈（x=俯仰, y=水平转） |
| `shoulderL` / `shoulderR` | shoulder.L / shoulder.R | 肩（x=前后摆, z=侧举） |
| `elbowL` / `elbowR` | forearm.L / forearm.R | 肘（负值=自然弯曲方向） |
| `hipL` / `hipR` | thigh.L / thigh.R | 腿根（x=前后摆） |
| `kneeL` / `kneeR` | shin.L / shin.R | 膝（正值=弯曲） |

步态参数直迁（walk 组：amplitude 28°/38°，swing=sin(p·2π·cycles)，cycles=1.35·D；
run 组：hip 52°、knee 18+75°、elbow -75°、spine 13°，cycles=2.3·D）→ bpy 每步
两个接触帧 keyframe，循环收尾复制首帧（`recipes/animation/RECIPE.md` 循环验证节）。

## 3. 路径种子（pathCurve.ts）→ bpy 路径/控制柄

L1 关键帧的路径模型与 bpy fcurve/Bezier 完全同构：

| L1 结构（DirectorMotionKeyframe） | bpy 对应 |
|---|---|
| `position: Vec3` | keyframe 的 bone/mesh location |
| `pathIn` / `pathOut`（**相对 position 的偏移量**） | Bezier 控制柄位移（相对同样以该帧位置为原点）：`keyframe.handle_left/handle_right` 的偏移（注意 bpy 存的是绝对坐标，需 `handle_left_type='FREE'` 后写入 `position + pathIn`） |
| `pathMode: 'corner'` | `handle_left_type='FREE'`（L1 清柄 = 线性段）；等价 `='VECTOR'` |
| `pathMode: 'smooth'` | `='AUTO_CLAMPED'`（L1 `smoothPathFrame` tension=0.28 的均衡柄 ≈ bpy auto clamp） |
| 无柄（缺省） | `='AUTO_CLAMPED'`（L1 缺柄 = 线性插值段；若要严格线性用 `='VECTOR'`） |
| `sampleMotionPath(subdivisions=16)` | 仅 L1 播放器消费；bpy 端 fcurve 自身即曲线，无需采样落帧 |
| `cubicBezier(a,b,c,d,t)` | 与 bpy Bezier 插值同算式，无需转换 |

## 4. 坐标系与单位换算（易错点）

| 项 | L1（three.js） | Blender |
|---|---|---|
| 上轴 | Y up | Z up |
| 前向约定 | forward = (sin(yaw), 0, cos(yaw))，yaw 用 atan2(dx,dz) | 前向 -Y；yaw 绕 Z |
| 位置换算 | L1 (x, y, z) | bpy (x, **z_L1**, **-y_L1**) |
| 朝向换算 | L1 yaw（绕 Y） | bpy 绕 Z，同角度同号（Y-up→Z-up 的右手系旋转面映射后 yaw 不变号） |
| 关节角度 | 度（UI 友好） | `bone.rotation_euler` 弧度 = deg × π/180 |
| 时间 | timeSec（相对动作片段） | frame = timeSec × fps（fps 默认 30） |
| 位移 | suggestedDistance（米） | 1 Blender 单位 = 1 米（`unit_settings.scale_length=1`），直迁 |

> 换算标注：L1→bpy 映射 = three.js Y-up → Blender Z-up 标准变换（x 不变，y↑变 z，
> z 变 -y）。**本表是初值参考，落帧后必须按 `recipes/camera-cinematography/RECIPE.md`
> 起幅/中点/落幅三帧检查，并过 `recipes/qa-review/RECIPE.md` 门禁。**

## 5. 直迁工作流（agent 操作序）

```
L1 分镜/动作数据（只读 director-engine 导出）
  → §1 相机：combo 数值落 camera.data，move 语义落相机 keyframe
  → §2 动作：模板 5-KF 布局 + JointName→骨骼 落骨架 keyframe
  → §3 路径：pathIn/pathOut → Bezier 控制柄（FREE/AUTO_CLAMPED）
  → §4 坐标换算（Y-up→Z-up）
  → 按 SKILL.md 五阶段：②相机 blocking 判据 → ④动画判据 → ⑤渲染
```
