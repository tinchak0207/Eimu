# Eimu Blender 本地基础资产库 — CATALOG

**资产优先**：能 append 现成资产就不要手搓基础几何；主体人物必须用 `human_base` 而不是胶囊体拼接。街具、家具、车辆、路障先用 `models/` 里的尺度参照物，PBR 先套 `textures/` 的现成三通道贴图，环境光先挂 `hdri/`。

- 资产根目录：`$BLENDER_WORK/assets/`（本机 = `/home/lenovo/Desktop/image-app/.blender-work/assets`）
- 唯一索引：`manifest.json`（11 条资产 / 17 个文件 / 78.36 MiB）
- 实测环境：桥主机（本机 Arch Linux x86_64）+ **Blender 5.2.1 LTS**（build 2026-08-25），headless；2026-10-22 实测通过。
- 许可证：全部 **CC0**，逐条在 `manifest.json` 的 `license_note` 里保留抓取到的原文短语与页面 URL。非 CC0 或核不到许可证的资产一律不收。
- 重建/校验：`python3 provision.py --verify`（只校验）／`python3 provision.py`（下载重建）。

## 资产清单

| id | 类型 | 用途 | 标签 | 加载方式 | 许可证 | 体积 |
|---|---|---|---|---|---|---|
| `hdri_studio_small_09` | hdri 1k | 影棚/室内中性光：产品图、人物肖像、需要干净补光的室内 | hdri, studio, indoor, neutral, artificial-light | `load_hdri(path, strength=1.0)` | CC0 | 1.54 MB |
| `hdri_cobblestone_street_night` | hdri 1k | 城市夜景/黄昏：街景、夜戏、霓虹反射底光 | hdri, night, urban, street, city, moody | `load_hdri(path, strength=1.0)` | CC0 | 1.68 MB |
| `hdri_autumn_road` | hdri 1k | 阴天户外：低反差基础光、白模检查、户外背景 | hdri, overcast, outdoor, day, low-contrast | `load_hdri(path, strength=1.0)` | CC0 | 1.62 MB |
| `tex_brushed_concrete_03` | texture_set 1k | 混凝土/水泥地坪与墙体（diffuse+roughness+normal） | texture, concrete, pbr, floor, wall | `apply_pbr_texture(obj, set_dir)` | CC0 | 2.45 MB |
| `tex_metal_plate_02` | texture_set 1k | 磨损金属板：车辆、器械、工业道具 | texture, metal, pbr, rusted, industrial | `apply_pbr_texture(obj, set_dir)` | CC0 | 1.64 MB |
| `tex_fabric_leather_02` | texture_set 1k | 布/皮革软装：沙发、座椅、衣物、包袋 | texture, fabric, leather, upholstery, pbr | `apply_pbr_texture(obj, set_dir)` | CC0 | 1.40 MB |
| `model_modular_street_seating` | model .glb 1k | 街边长椅（约 1.8 m）：街景家具、坐姿人物尺度参照 | model, street, bench, furniture, scale-reference | `append_model(path)` | CC0 | 7.26 MB |
| `model_fire_hydrant` | model .glb 1k | 消防栓（约 0.8 m）：街道前景、人体尺度锚点 | model, street, hydrant, scale-reference, urban | `append_model(path)` | CC0 | 5.28 MB |
| `model_metal_trash_can` | model .glb 1k | 金属垃圾桶（约 0.9 m）：街具簇与尺度参照 | model, street, trash-can, scale-reference, urban | `append_model(path)` | CC0 | 4.77 MB |
| `model_concrete_road_barrier` | model .glb 1k | 混凝土路障（约 1.7 m 宽）：街道阻断、构图前景 | model, barrier, concrete, scale-reference, urban | `append_model(path)` | CC0 | 3.58 MB |
| `human_base_meshes_v1_4_1` | human_base .blend | Blender Studio 人体基础网格（男/女 × 写实/风格化 + 头/手/骨架）；主体人物必须用它 | human, base-mesh, body, head, hands, skeleton | `append_human_base(path, variant=...)` | CC0 | 47.13 MB |

体积合计 78.36 MiB（上限 300 MiB）。

## 人体网格变体

`human_base_meshes_v1_4_1` 是 Blender Studio 的 Asset Library bundle（单文件 49.4 MB，含 13 个 asset collection）。
`append_human_base(path, variant=...)` 按变体 append 整个 collection（身体 + 双眼），并返回主对象名：

| variant | 源 collection | 主对象 | 顶点数 |
|---|---|---|---|
| `male_realistic`（默认） | `Body Male - Realistic` | `GEO-body_male_realistic` | 10,582 |
| `female_realistic` | `Body Female - Realistic` | `GEO-body_female_realistic` | 10,582 |
| `male_stylized` | `Body Male - Stylized` | `GEO-body_male_stylized` | 12,502 |
| `female_stylized` | `Body Female - Stylized` | `GEO-body_female_stylized` | 12,502 |

同文件还可 append `Body Male/Female - Primitve (Realistic|Stylized)`（分件原语块）、`Head (Animation) - Realistic`、`Head (Sculpting) - Realistic`、`Head - Stylized`、`Skeleton - Realistic`，用 `append_human_base(path, collection="<collection 名>")` 直取。

## 加载配方（bpy）

```python
import sys, os
sys.path.insert(0, os.path.dirname(__file__))  # 或 blender-director/assets
from load_recipes import load_hdri, append_human_base, apply_pbr_texture, append_model

A = os.path.join(os.environ["BLENDER_WORK"], "assets")

load_hdri(os.path.join(A, "hdri/studio_small_09.hdr"), strength=1.0)
human = append_human_base(os.path.join(A, "humans/human-base-meshes.blend"), variant="male_realistic")
append_model(os.path.join(A, "models/fire_hydrant.glb"))
# 对任何已有 UV 的 mesh：
apply_pbr_texture(bpy.data.objects["Ground"], os.path.join(A, "textures/brushed_concrete_03"), uv_scale=4.0)
```

约定：
- 路径可传绝对路径，也可传相对 `$BLENDER_WORK/assets` 的路径（`hdri/xxx.hdr` 与 `assets/hdri/xxx.hdr` 都接受）。
- `load_hdri` 重建 world 节点树：`TexEnvironment → Background → World Output`，返回 world 名。
- `apply_pbr_texture` 建 Principled BSDF：Base Color ← diffuse（sRGB）、Roughness ← roughness（Non-Color）、Normal ← normal（Non-Color + Normal Map 节点）。有 UV 用 UV 坐标，无 UV 退回 Generated 并在返回值里标记。
- `append_model` 对 `.glb/.gltf` 走 glTF 导入，对 `.blend` 走 `bpy.data.libraries.load`；返回新对象名列表。GLB 内贴图已内嵌，不依赖外部目录。
- `append_human_base` 返回主对象名（字符串），整组 collection 已链接进当前场景。

## 许可证原文（manifest 内逐条保留）

- Poly Haven（3 张 HDRI + 3 套纹理 + 4 个模型）：资产页 JSON-LD 写入
  `"license":"https://creativecommons.org/publicdomain/zero/1.0/"`，页面可见徽章文字 `CC0`。
  例：`https://polyhaven.com/a/studio_small_09`、`https://polyhaven.com/a/fire_hydrant`。
- Blender Studio 人体基础网格：Blender 官方 Demo Files 页
  `https://www.blender.org/download/demo-files/` 列出
  “Human Base Meshes v1.4.1 by Blender Studio and community contributions” 并标注 “49 MB – CC0”，
  直链 `https://download.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip`。

## 运维

```bash
# 只校验（不联网、不下载）
python3 deploy-staging/opencode-runtime/skills/blender-director/assets/provision.py --verify

# 重建缺失/损坏文件（按 manifest 里的 URL；模型会用本机 Blender 重新导出 GLB）
BLENDER_BIN=/home/lenovo/Applications/blender-5.2.1-linux-x64/blender \
  python3 deploy-staging/opencode-runtime/skills/blender-director/assets/provision.py

# 指定其他根目录
python3 .../provision.py --root /path/to/assets --verify
```

- 默认根目录：`$BLENDER_WORK/assets`；未设置时回退 `~/Desktop/image-app/.blender-work/assets`。
- 已存在且 sha256 匹配的文件会跳过；`--force` 强制重新下载。
- 模型条目重建需要本机 Blender（`BLENDER_BIN` 或 `PATH` 里的 `blender`）；HDRI/纹理/人体只需标准库 urllib。
