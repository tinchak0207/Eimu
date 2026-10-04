# Blender 驗證腳本（非配方、非輪子擴充）
# 用途：驗收門實跑——把 recipes/ 的核心步驟提取為 bpy 最小實現，證明
#       Blender 5.2 headless + Eevee 出幀鏈路可用。配方正文仍是 recipes/*.md。
# 1) verify_blockout.py  ← recipes/scene-assembly/RECIPE.md（集合結構+灰盒+渲染驗證）
# 2) verify_keyframe.py  ← recipes/animation/RECIPE.md + seed-mapping.md §2（5-KF 佈局+關節）
# 執行：blender --background --factory-startup --python verify_blockout.py
