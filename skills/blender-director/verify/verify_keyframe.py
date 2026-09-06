# 验证脚本（按 recipes/animation/SKILL.md + seed-mapping.md §2 核心步骤提取，非配方本体）
# 阶段④骨架动画 keyframe：骨架 + 5-KF 布局（times 0/0.18/0.5/0.82/1）+ 关节旋转 + Eevee 出 2 帧
# 跑法：blender --background --factory-startup --python verify_keyframe.py
import math
import os
import bpy

OUT = os.environ.get("BLENDER_WORK_OUT", "/tmp/blender-director-verify")
os.makedirs(OUT, exist_ok=True)
FPS = 30
D = 2.0  # L1 defaultDurationSec（walk 模板）

for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob, do_unlink=True)

# --- 地面参考 ---
bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))

# --- 骨架（rigging：ARM_[Name]，bones [side]_[region]_[name]） ---
bpy.ops.object.armature_add(location=(0, 0, 0))
arm_ob = bpy.context.active_object
arm_ob.name = "ARM_Blocky"
arm = arm_ob.data
bpy.ops.object.mode_set(mode="EDIT")

def bone(name, head, tail, parent=None):
    eb = arm.edit_bones.new(name)
    eb.head, eb.tail = head, tail
    if parent:
        eb.parent = arm.edit_bones[parent]
    return eb

bone("root", (0, 0, 0), (0, 0, 0.05))
bone("spine_01", (0, 0, 0.9), (0, 0, 1.5), "root")
bone("neck", (0, 0, 1.5), (0, 0, 1.7), "spine_01")
bone("hipL", (-0.12, 0, 0.9), (-0.12, 0, 0.5), "root")
bone("kneeL", (-0.12, 0, 0.5), (-0.12, 0, 0.05), "hipL")
bone("hipR", (0.12, 0, 0.9), (0.12, 0, 0.5), "root")
bone("kneeR", (0.12, 0, 0.5), (0.12, 0, 0.05), "hipR")
bpy.ops.object.mode_set(mode="OBJECT")

# --- 5-KF 布局（seed-mapping §2.1：times=[0,0.18,0.5,0.82,1]，walk 步态直迁） ---
# L1 walk: hip swing ±28°(deg→rad)，envelope 包络；root 前进 suggestedDistance=2m
pose = arm_ob.pose
bones = {b.name: b for b in pose.bones}
TIMES = [0.0, 0.18, 0.5, 0.82, 1.0]
ENVELOPE = [0.0, 0.18 / 0.12, 1.0, 1.0 - 0.18 / 0.12, 0.0]
ENVELOPE = [min(1.0, e) for e in ENVELOPE]
AMP_HIP = math.radians(28)
AMP_KNEE = math.radians(48)

for p, env in zip(TIMES, ENVELOPE):
    frame = round(p * D * FPS)
    swing = math.sin(p * math.pi * 2 * 1.35)
    scene = bpy.context.scene
    scene.frame_set(frame)
    # root 前向位移（-Y = Blender 前向）：
    arm_ob.location = (0, -2.0 * p, 0)
    arm_ob.keyframe_insert(data_path="location", frame=frame)
    # L1 walk 直迁：hipL = +swing·28°·env, hipR = -swing·28°·env, knee = max(0,∓swing)·48°·env
    bones["hipL"].rotation_euler = (-swing * AMP_HIP * env, 0, 0)
    bones["hipR"].rotation_euler = (swing * AMP_HIP * env, 0, 0)
    bones["kneeL"].rotation_euler = (max(0.0, swing) * AMP_KNEE * env, 0, 0)
    bones["kneeR"].rotation_euler = (max(0.0, -swing) * AMP_KNEE * env, 0, 0)
    for b in ("hipL", "hipR", "kneeL", "kneeR"):
        bones[b].keyframe_insert(data_path="rotation_euler", frame=frame)

# 循环收尾（animation：复制首帧，验证循环接缝）——末帧 +1 补首姿态
arm_ob.keyframe_insert(data_path="location", frame=round(D * FPS) + 1)

action = arm_ob.animation_data.action
action.name = "AN_Blocky_Walk"
# Blender 5.2：4.4 起 slotted action，fcurves 在 layers[0].strips[0].channelbag(slot).fcurves
# （上游 4.x 寫法：action.fcurves —— API 名變更，邏輯等價）
def action_fcurves(act):
    for layer in act.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                yield from bag.fcurves

n_curves = len(list(action_fcurves(action)))
print("VERIFY_KEYFRAME action:", action.name, "fcurves:", n_curves)
assert n_curves >= 5, "expect >=5 fcurves (root loc + 4 joints)"

# --- 相机 + 灯光 ---
bpy.ops.object.camera_add(location=(3.4, -4.6, 1.6))
cam = bpy.context.active_object
cam.name = "CAM_SH01_3Q"
cam.data.lens = 50
cam.rotation_euler = (1.24, 0.0, 0.63)
bpy.context.scene.camera = cam
bpy.ops.object.light_add(type="SUN", location=(3, -3, 6))
key = bpy.context.active_object
key.name = "LGT_Key_Sun"
key.data.energy = 3.0
key.rotation_euler = (0.6, 0.2, 0.6)

# --- Eevee 渲染首/末帧（出幀到 /tmp 验证） ---
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"  # Blender 5.2：4.2 起 Eevee Next 已合并为唯一 Eevee，enum=BLENDER_EEVEE
scene.render.resolution_x = 960
scene.render.resolution_y = 540
scene.render.image_settings.file_format = "PNG"
scene.frame_start = 0
scene.frame_end = round(D * FPS)
ok = True
for f in (0, scene.frame_end):
    scene.frame_set(f)
    scene.render.filepath = os.path.join(OUT, f"keyframe_frame_{f:04d}")
    bpy.ops.render.render(write_still=True)
    path = os.path.join(OUT, f"keyframe_frame_{f:04d}.png")
    exists = os.path.exists(path)
    print("VERIFY_KEYFRAME frame", f, "->", path, exists)
    ok = ok and exists
print("VERIFY_KEYFRAME PASS" if ok else "VERIFY_KEYFRAME FAIL")
