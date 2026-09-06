<!--
來源（輪子）: https://github.com/kevinbadi/blender-skills — dynamic-full-loop/SKILL.md
License: 上游無 LICENSE 檔（GitHub API 2026-09-06 查證）· 原作者: kevinbadi · 僅內部使用，不對外散佈
入庫批次: 2026-09-06 對稱差擴容 W3（產品片運鏡/Polyhaven/圖轉 3D）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；上游若引用其專屬 MCP 工具面，執行時改走我方 bridge /v1/execute 同構協議。
-->
---
name: dynamic-full-loop
description: Dynamic camera loop with speed ramping - slow reveals on each face, fast whips between. Shows all sides including top and bottom.
---

## Dynamic Full Loop Camera Animation

Camera orbits the product on multiple axes with speed ramping — slow motion when revealing each side of the product, fast whip transitions between faces. Shows front, sides, back, top, and bottom.

## When to Use

- User wants to "show every angle" with dynamic motion
- User says "full loop", "speed ramp", "show all sides", "dynamic spin"
- Social media / marketing hero video

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `duration` | `10` | Video length in seconds (longer due to speed ramps) |
| `fps` | `24` | Frames per second |
| `camera_distance` | `4.0` | Camera distance from center |
| `camera_height` | `1.8` | Camera height |

## Flow

### Step 1: Set Up Camera Rig

```python
import bpy, math

bpy.ops.object.empty_add(type='PLAIN_AXES', location=(0, 0, 0))
tgt = bpy.context.active_object
tgt.name = 'DynamicTarget'

bpy.ops.object.camera_add(location=(0, -CAMERA_DISTANCE, CAMERA_HEIGHT))
cam = bpy.context.active_object
cam.name = 'DynamicCam'
cam.data.lens = 45

trk = cam.constraints.new(type='TRACK_TO')
trk.target = tgt
trk.track_axis = 'TRACK_NEGATIVE_Z'
trk.up_axis = 'UP_Y'

# Parent camera to target
bpy.ops.object.select_all(action='DESELECT')
cam.select_set(True)
tgt.select_set(True)
bpy.context.view_layer.objects.active = tgt
bpy.ops.object.parent_set(type='OBJECT', keep_transform=True)

bpy.context.scene.camera = cam
```

### Step 2: Animate with Speed Ramping

The key is BEZIER interpolation with keyframes clustered for slow/fast:
- Close keyframes with small rotation change = SLOW (lingering on a face)
- Wide keyframes with large rotation change = FAST (whip transition)

```python
TOTAL_FRAMES = DURATION * FPS  # 240 at 10s/24fps

scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end = TOTAL_FRAMES
scene.render.fps = FPS

# Z rotation (horizontal orbit) - speed ramp pattern
# SLOW on each face, FAST whip between
kf_z = [
    (1,   0),      # front start
    (30,  10),     # slow drift on front
    (45,  90),     # FAST whip to right
    (75,  100),    # slow on right
    (90,  180),    # FAST whip to back
    (120, 190),    # slow on back
    (135, 270),    # FAST whip to left
    (165, 280),    # slow on left
    (180, 330),    # FAST whip toward front
    (210, 340),    # slow near bottom
    (225, 355),    # FAST settle
    (240, 360),    # back to front
]

# X rotation (vertical tilt - over/under)
kf_x = [
    (1,   0),
    (30,  0),
    (75,  15),     # slight tilt on right
    (120, 0),      # level on back
    (135, -20),    # tilt down on left
    (165, -45),    # going under
    (180, -60),    # under/bottom view
    (210, -30),    # coming back up
    (240, 0),      # level again
]

for f, d in kf_z:
    tgt.rotation_euler[2] = math.radians(d)
    tgt.keyframe_insert(data_path='rotation_euler', index=2, frame=f)

for f, d in kf_x:
    tgt.rotation_euler[0] = math.radians(d)
    tgt.keyframe_insert(data_path='rotation_euler', index=0, frame=f)

# BEZIER interpolation for speed ramp easing
action = tgt.animation_data.action
strip = action.layers[0].strips[0]
for cb in strip.channelbags:
    for fc in cb.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = 'BEZIER'
            kp.easing = 'AUTO'
```

### Step 3: Render + Encode

```bash
ffmpeg -y -framerate 24 \
  -i "~/Desktop/Blender Videos/dynamic_loop_frames/%04d.png" \
  -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le \
  "~/Desktop/Blender Videos/dynamic_full_loop.mov"
```

## Notes

- This animation is longer (10s) due to the speed ramps needing time to breathe
- If Blender freezes on large meshes, encode whatever frames completed — partial render is usable
- The speed ramp effect comes from BEZIER curves with uneven keyframe spacing
