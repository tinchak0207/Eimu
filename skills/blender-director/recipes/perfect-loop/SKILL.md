<!--
來源（輪子）: https://github.com/kevinbadi/blender-skills — perfect-loop/SKILL.md
License: 上游無 LICENSE 檔（GitHub API 2026-09-06 查證）· 原作者: kevinbadi · 僅內部使用，不對外散佈
入庫批次: 2026-09-06 對稱差擴容 W3（產品片運鏡/Polyhaven/圖轉 3D）。執行環境契約見 ../../SKILL.md（bridge POST /v1/execute、產物寫 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷區：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；上游若引用其專屬 MCP 工具面，執行時改走我方 bridge /v1/execute 同構協議。
-->
---
name: perfect-loop
description: Seamless looping 360-degree turntable. First and last frames match perfectly for infinite loop playback.
---

## Perfect Loop Camera Animation

A seamless 360-degree turntable where the last frame connects perfectly to the first frame, creating an infinite loop. Ideal for website backgrounds, social media, and product page embeds.

## When to Use

- User wants a "looping" or "seamless" animation
- User says "perfect loop", "infinite loop", "GIF", "looping turntable"
- Website product embed, social media loop

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `duration` | `5` | Video length in seconds |
| `fps` | `24` | Frames per second |
| `camera_distance` | `4.0` | Distance from object |
| `camera_height` | `2.0` | Camera height |
| `camera_lens` | `50` | Focal length |

## Flow

### Step 1: Set Up Camera Rig

```python
import bpy, math

bpy.ops.object.empty_add(type='PLAIN_AXES', location=(0, 0, 0))
tgt = bpy.context.active_object
tgt.name = 'PerfectLoopTarget'

bpy.ops.object.camera_add(location=(0, -CAMERA_DISTANCE, CAMERA_HEIGHT))
cam = bpy.context.active_object
cam.name = 'PerfectLoopCam'
cam.data.lens = CAMERA_LENS

trk = cam.constraints.new(type='TRACK_TO')
trk.target = tgt
trk.track_axis = 'TRACK_NEGATIVE_Z'
trk.up_axis = 'UP_Y'

bpy.ops.object.select_all(action='DESELECT')
cam.select_set(True)
tgt.select_set(True)
bpy.context.view_layer.objects.active = tgt
bpy.ops.object.parent_set(type='OBJECT', keep_transform=True)

bpy.context.scene.camera = cam
```

### Step 2: Animate Seamless Loop

**Critical**: Keyframe 360 degrees at frame N+1 (one past the last rendered frame). This way frame N and frame 1 are adjacent in the loop, not duplicated.

```python
TOTAL_FRAMES = DURATION * FPS  # 120

scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end = TOTAL_FRAMES  # render 1-120
scene.render.fps = FPS

tgt.rotation_euler = (0, 0, 0)
tgt.keyframe_insert(data_path='rotation_euler', frame=1)

# 360 at frame 121 — frame 121 is NOT rendered, but ensures
# frame 120 is one step before frame 1, creating seamless loop
tgt.rotation_euler = (0, 0, math.radians(360))
tgt.keyframe_insert(data_path='rotation_euler', frame=TOTAL_FRAMES + 1)

# LINEAR interpolation is CRITICAL for perfect loop
action = tgt.animation_data.action
strip = action.layers[0].strips[0]
for cb in strip.channelbags:
    for fc in cb.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'
```

### Step 3: Render + Encode

```bash
ffmpeg -y -framerate 24 \
  -i "~/Desktop/Blender Videos/perfect_loop_frames/%04d.png" \
  -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le \
  "~/Desktop/Blender Videos/perfect_loop.mov"
```

## Critical Notes

- **LINEAR interpolation only** — BEZIER will cause the loop to stutter at the seam
- **Keyframe at N+1**: Place the 360-degree keyframe one frame PAST the render range
- **No camera movement**: Camera distance, height, and lens must be static (no keyframes on these)
- **Verify loop**: Play the video on repeat to confirm seamless transition
- Good for encoding to looping formats: GIF, WebM, or MP4 with `-loop 0`
