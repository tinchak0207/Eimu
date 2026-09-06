# 验证脚本（按 recipes/scene-assembly/SKILL.md + rendering/SKILL.md 核心步骤提取，非配方本体）
# 阶段①blockout：集合结构 + 灰盒比例 + 相机 + 灯光 + Eevee 验证帧
# 跑法：blender --background --factory-startup --python verify_blockout.py
import os
import bpy

OUT = os.environ.get("BLENDER_WORK_OUT", "/tmp/blender-director-verify")
os.makedirs(OUT, exist_ok=True)

# --- 集合结构（scene-assembly：COL_Layout / COL_Lights / COL_Cameras） ---
def ensure_col(name):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(col)
    return col

col_layout = ensure_col("COL_Layout")
col_lights = ensure_col("COL_Lights")
col_cams = ensure_col("COL_Cameras")

# 清 factory 默认对象（factory-startup 下只有 Cube/Light/Camera，按名清）
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob, do_unlink=True)

# --- 灰盒（greybox）：地面 + 人体比例块（1.75m 身高的块状 mannequin） ---
def grey_box(name, size, loc, col):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    col.objects.link(ob)
    return ob

grey_box("BLK_Ground", (20, 20, 0.1), (0, 0, -0.05), col_layout)
grey_box("BLK_Torso", (0.45, 0.25, 0.6), (0, 0, 1.15), col_layout)
grey_box("BLK_Head", (0.22, 0.24, 0.24), (0, 0, 1.62), col_layout)
grey_box("BLK_LegL", (0.16, 0.2, 0.85), (-0.12, 0, 0.425), col_layout)
grey_box("BLK_LegR", (0.16, 0.2, 0.85), (0.12, 0, 0.425), col_layout)

# --- 相机（camera-cinematography：CAM_[Shot]_[Angle]，50mm 标准场景） ---
bpy.ops.object.camera_add(location=(4.2, -4.2, 1.7))
cam = bpy.context.active_object
cam.name = "CAM_SH01_3Q"
cam.data.lens = 50
cam.rotation_euler = (1.178, 0.0, 0.785)  # 3/4 高度俯视主体
for c in list(cam.users_collection):
    c.objects.unlink(cam)
col_cams.objects.link(cam)
bpy.context.scene.camera = cam

# --- 灯光（lighting：LGT_[Role]_[Desc]，三点布光简化：Sun + Rim） ---
bpy.ops.object.light_add(type="SUN", location=(3, -3, 6))
key = bpy.context.active_object
key.name = "LGT_Key_Sun"
key.data.energy = 3.0
key.rotation_euler = (0.6, 0.2, 0.6)
for c in list(key.users_collection):
    c.objects.unlink(key)
col_lights.objects.link(key)

# --- 渲染设置（rendering：Eevee 默认快稿，1280x1280 转台验证帧） ---
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"  # Blender 5.2：4.2 起 Eevee Next 已合并为唯一 Eevee，enum=BLENDER_EEVEE
scene.render.resolution_x = 1280
scene.render.resolution_y = 1280
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = os.path.join(OUT, "blockout_frame")

# 场景查询（validation：物体数/集合归属）
counts = {c.name: len(c.objects) for c in (col_layout, col_lights, col_cams)}
print("VERIFY_BLOCKOUT collections:", counts)
assert counts == {"COL_Layout": 5, "COL_Lights": 1, "COL_Cameras": 1}, counts

bpy.ops.render.render(write_still=True)
out = os.path.join(OUT, "blockout_frame.png")
print("VERIFY_BLOCKOUT PASS frame:", out, os.path.exists(out))
