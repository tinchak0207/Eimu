# Blender 验证脚本（非配方、非轮子扩充）
# 用途：验收门实跑——把 recipes/ 的核心步骤提取为 bpy 最小实现，证明
#       Blender 5.2 headless + Eevee 出帧链路可用。配方正文仍是 recipes/*.md。
# 1) verify_blockout.py  ← recipes/scene-assembly/RECIPE.md（集合结构+灰盒+渲染验证）
# 2) verify_keyframe.py  ← recipes/animation/RECIPE.md + seed-mapping.md §2（5-KF 布局+关节）
# 执行：blender --background --factory-startup --python verify_blockout.py
