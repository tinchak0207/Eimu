---
name: orthographic-registration
description: Register front, side, back, and top orthographic reference views into a shared Blender coordinate contract. Use when a 3D model must match multi-view wireframes/templates, when side/back/top silhouettes are off, or before adding depth to a front-locked contour model.
when_to_use: Multi-view mascot/object reconstruction, depth fitting from side/back/top views, orthographic blueprint alignment, reference planes/cameras with shared scale and centerline.
allowed-tools: Read Bash Glob Grep mcp__blender__execute_blender_code mcp__blender__get_scene_info
---
<!--
来源（轮子）: https://github.com/RobLe3/cc-blender-skill — plugin/skills/orthographic-registration/SKILL.md
License: MIT · 原作者: RobLe3 (https://github.com/RobLe3)
入库批次: 2026-09-06 对称差扩容 W4（参考图→3D 拟合管线/品质门禁）。执行环境契约见 ../../SKILL.md（bridge POST /v1/execute、产物写 $BLENDER_WORK/out/、Blender 5.2.1）。
Blender 5.2 雷区：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；上游 MCP 调用表述执行时改走我方 bridge /v1/execute 同构协议。
-->

# Orthographic Registration

This skill prevents the common failure where the front view looks plausible but the side/back/top views are wrong.

## Coordinate contract

- Front view defines `X/Z` silhouette.
- Side view defines `Y/Z` depth envelope.
- Top view defines `X/Y` spread.
- Back view defines rear silhouette/material only; it must not rewrite the front silhouette.

## Workflow

1. Run `scripts/register_views.py` on the available view images.
2. Create orthographic reference planes/image empties with a single shared scale.
3. Align centerline and bbox centers before modeling.
4. Lock front X/Z boundary vertices.
5. Add Y depth from side/top envelopes using modifiers/displacement or vertex groups.
6. Validate all four cameras before export.

## Failure policy

If views disagree, front brand read wins. Document the conflict in `registration_report.json`.


## Front-plane rotation rule

In this Blender coordinate convention, the front camera looks along the Y axis and the reference silhouette lives in the X/Z plane. Therefore 2D rotations inside the front view are rotations around the **Y axis**, not around Z. Use `rotation_euler = (0, angle, 0)` for 2D component orientation in the front projection. Z rotation spins objects into/out of screen-space incorrectly for X/Z-plane meshes.

## Sources distilled

- Blender Image Empty/reference image controls for orthographic blueprints.
- OpenCV homography/alignment and geometric transforms for view registration.
