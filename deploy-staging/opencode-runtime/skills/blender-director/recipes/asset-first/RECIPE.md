---
name: asset-first
description: 资产优先的 3D 装配法：开工先查本地 CC0 资产库 manifest（HDRI／PBR 纹理／模型／人形基础网格），命中即 append，查空才自建；给出装配顺序、禁止清单、可照抄脚本与失败回退。
license: MIT
metadata:
  author: Eimu image-app（2026-10-22 实测配方，非上游轮子）
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: asset, asset library, manifest, HDRI, PBR, texture, human base mesh, append, 资产优先, 资产复用, 基础网格, 人物建模, 场景搭建
  related-skills: scene-assembly, set-dressing, materials, lighting, rendering, qa-review
---
<!--
资产库来源与许可：Poly Haven（CC0）与 Blender Studio human-base-meshes（CC0）；
每件资产的许可证以本地 `$BLENDER_WORK/assets/manifest.json` 的 `license` / `license_url` / `source_page` 字段为准。
装配函数来自 `skills/blender-director/assets/load_recipes.py`（本仓，MIT）。
-->

# 资产优先（Asset First）

先把现成资产架上灶，再谈建模。**瓶颈是资产，不是提示词**（2026-10-22 实测：胶囊体拼人形 + 几千条细几何拼窗格 → 满屏摩尔纹；只给上限判准后 agent 用「删除」达标 → 塑料玩偶在空天台对打）。

## 何时使用

- 交付档（`delivery`）里的**人物／场景／多资产**任务：开工第一件事。
- 任何出现「建模做出来／成品／场景／单帧画面」且主体超过一个几何体的委托。
- 单件几何（立方体／球体等）仍走 SKILL 的「单物体快路径」，不强制走本配方（允许只用 `load_hdri` 替掉平色世界）。

## 0. 开工三问（先答完，再碰 bpy）

| 问题 | 判据 | 动作 |
|---|---|---|
| ① 主体是人还是物？ | 委托里有人／角色／对打／站姿／肖像 | 人形 → **必须 `append_human_base`**（禁胶囊体拼接）；纯器物 → 先找 `kind=model`；纯抽象单件 → 走单物体快路径 |
| ② 有没有现成资产？ | 读本地 `manifest.json`（免费、无网络），按 `kind`/`tags` 过滤 | 命中即 append；查空才自建，且自建必须写进 ledger 的理由栏 |
| ③ 参考图有没有？ | 委托附件／用户给的概念图 | 有 → 先按参考图定资产与构图；没有 → **不许审美微调**，只按数值判准收敛并在交付声明「无视觉基准」（qa-review 制作纪律） |

三问缺答任意一条就动手 = 返工高发。

## 1. 选资产：读 manifest，不猜

唯一索引：`$BLENDER_WORK/assets/manifest.json`（默认 `/home/lenovo/Desktop/image-app/.blender-work/assets/`）。字段：

| 字段 | 用法 |
|---|---|
| `id` | ledger 与失败回报里引用的唯一名 |
| `kind` | `hdri` \| `texture_set` \| `model` \| `human_base` |
| `tags[]` | 选品过滤（`studio`／`street`／`fabric`／`railing`…） |
| `path` | 相对 `assets/` 的路径，拼绝对路径后交给 `load_recipes` |
| `license` / `license_url` / `source_page` | 交付说明照抄；只接受 `CC0` |
| `bytes` / `sha256` | 校验用；`provision.py --verify` 全绿才开工 |
| `load_recipe` | 一句话 bpy 用法 |

选品规则：

1. 先 `kind` 精确过滤，再 `tags` **全含**匹配；全含无命中退化为**任一**命中，并在 ledger 记「tag 放宽」。
2. 同 kind 多命中：取 tags 命中数最多、`bytes` 最小的一件（先跑通再换高清）。
3. **命中就用**，不许因为「自己想搭」而跳过；自建一个命中项的同类资产 = 违反本节。
4. 查空才自建：ledger 每行加 `source` 栏（manifest id，或 `自建：manifest 无 kind=<kind>/tags=<tags>` + 面数预算）再动手；qa-review §1 的 ledger 表加这一列，不删原列。
5. 选完把 id 列表写进 ledger（交付附件），失败时才能一眼报出缺哪个 id。

命令行速查（桥主机有 python3，不假设 jq）：

```bash
python3 - <<'EOF'
import json, os
root = os.path.join(os.environ.get("BLENDER_WORK", "/home/lenovo/Desktop/image-app/.blender-work"), "assets")
man = json.load(open(os.path.join(root, "manifest.json"), encoding="utf-8"))
items = man if isinstance(man, list) else (man.get("assets") or man.get("items") or [])
for a in items:
    print(f'{a["kind"]:<11} {a["id"]:<28} {a.get("tags")}  {a.get("bytes", 0)//1024}KB')
EOF
```

## 2. 标准装配顺序（照这个次序，别重排）

| 步 | 调用 | 产出 | 不过就停 |
|---|---|---|---|
| 1 | `load_hdri(path)` | 世界环境光 + 反射源（替掉平色世界） | 世界节点类型不是 Environment Texture 即报错 |
| 2 | `append_human_base(path)` | 人形主体（有躯干四肢分区），返回对象名 | 委托主体是人却没走这步 = 资产不合格 |
| 3 | `append_model(path)` | 道具／尺度参照（栏杆、街具、车辆…） | 主体同框无尺度物 = qa-review §0.1 下限不过 |
| 4 | `apply_pbr_texture(obj, set_dir)` | Principled + Base Color/Roughness(Non-Color)/Normal | 只有纯色 Base Color = 材质未做 |
| 5 | 布光 | HDRI 打底 + 有动机的 key（要三点光就按 SKILL 阶段③ 的 3:1，强度别把 HDRI 压平） | 每盏灯有动机与命名 |
| 6 | 机位解算 | `d = R / sin(fill·θ)`，`fill=0.82` | 不许拖相机凑构图（qa-review §2） |
| 7 | 渲染 | 交给 `blender_render`（delivery：`quality:"final"` + `samples:128`） | exec 内不渲染；回执 `degraded=false` |

前 4 步全部在**同一个 `blender_exec`** 里完成，最后 `save_as_mainfile` 落 `$BLENDER_WORK/out/<name>.blend`；渲染与看图在下一步，不在 exec 里做。

## 3. 禁止清单

| 禁止 | 为什么 | 替代 |
|---|---|---|
| 胶囊体／圆柱拼人形 | 无躯干四肢分区，剪影不可读；qa-review §0.1「主体细化」直接判资产不合格 | `append_human_base` |
| 几千条细几何拼窗格／百叶／栏杆 | 面数与像素互相打架 → 满屏摩尔纹（实测 1052 物体/336k 面仍不可读） | 一张 PBR 贴图（diffuse+normal）或 append 现成模型 |
| 无 HDRI、无 PBR 的纯 Principled 平色出场 | 平光 = 塑料感，且「材质未做」 | `load_hdri` + `apply_pbr_texture` |
| 用「删除」凑上限 | 上限单侧生效，委托内容被删空（qa-review §0 事故） | 保内容、换资产，不删主体与环境层 |
| 未过审的资产族复制上百次 | 未批准族复制 = NO-SHIP（qa-review §1） | 先 1 个 representative 过 QA + 视觉评审再复制 |

**唯一豁免**：委托明确要求风格化纯色／低多边形／像素风。此时仍须有 HDRI 或三灯，并在交付说明写「风格化纯色，按委托豁免」，不许默认走平色。

## 4. 示例脚本（可直接照抄）

```python
# asset_first_scene.py —— 资产优先装配（Blender 5.2 headless，桥 /v1/execute 内跑）
import bpy, json, os, sys, math

WORK = os.environ.get("BLENDER_WORK", "/home/lenovo/Desktop/image-app/.blender-work")
ASSETS = os.path.join(WORK, "assets")
MANIFEST = os.path.join(ASSETS, "manifest.json")

# ---- 0) 载入装配函数库（skills/blender-director/assets/load_recipes.py）
CANDIDATES = [
    os.environ.get("BLENDER_LOAD_RECIPES", ""),
    "/home/lenovo/Desktop/image-app/deploy-staging/opencode-runtime/skills/blender-director/assets/load_recipes.py",
    os.path.expanduser("~/.opencode/skills/blender-director/assets/load_recipes.py"),
]
loader = next((p for p in CANDIDATES if p and os.path.isfile(p)), None)
if not loader:
    raise RuntimeError("找不到 load_recipes.py；设 BLENDER_LOAD_RECIPES=<绝对路径>")
sys.path.insert(0, os.path.dirname(loader))
import load_recipes as LR

# ---- 1) 读 manifest，按 kind/tags 选（命中就用；查空必须报 id，不许手搓顶替）
if not os.path.isfile(MANIFEST):
    raise RuntimeError(f"资产库未 provision：{MANIFEST} 不存在，先跑 assets/provision.py --verify")
man = json.load(open(MANIFEST, encoding="utf-8"))
items = man if isinstance(man, list) else (man.get("assets") or man.get("items") or [])

def pick(kind, *tags):
    pool = [a for a in items if a.get("kind") == kind]
    if tags:
        hit = [a for a in pool if all(t in (a.get("tags") or []) for t in tags)]
        hit = hit or [a for a in pool if any(t in (a.get("tags") or []) for t in tags)]
    else:
        hit = pool
    if not hit:
        raise LookupError(f"manifest 缺资产：kind={kind} tags={list(tags)}；"
                          f"该 kind 现有 id={[a.get('id') for a in pool][:10]}")
    return hit[0]

def apath(a):
    return os.path.join(ASSETS, a["path"])

hdri_a  = pick("hdri", "studio", "indoor")
human_a = pick("human_base")
prop_a  = pick("model", "railing", "street", "furniture")
tex_a   = pick("texture_set", "fabric", "cloth", "leather")

# ---- 2) 空场景 → HDRI → 人形基础网格 → 尺度参照 → PBR
bpy.ops.wm.read_factory_settings(use_empty=True)
LR.load_hdri(apath(hdri_a))                          # 世界环境光 + 反射源
hero_res = LR.append_human_base(apath(human_a))      # 人形主体：禁止胶囊体拼接
hero = bpy.data.objects.get(hero_res) if isinstance(hero_res, str) else hero_res
hero = hero or bpy.context.object
LR.append_model(apath(prop_a))                       # 道具与尺度参照
tex_dir = apath(tex_a)                               # texture_set 的 path 可能是目录或其中一张图
tex_dir = os.path.dirname(tex_dir) if os.path.isfile(tex_dir) else tex_dir
LR.apply_pbr_texture(hero, tex_dir)                  # diffuse + roughness + normal（接 UV）

# ---- 3) 布光：HDRI 已是主光，加一盏有动机的 key（要三点光按 SKILL 阶段③ 3:1）
key = bpy.data.lights.new("LGT_Key", "AREA")
key.energy, key.size = 320.0, 2.0
key_o = bpy.data.objects.new("LGT_Key", key)
key_o.location = (3.2, -3.0, 4.2)
key_o.rotation_euler = (math.radians(52), 0, math.radians(46))
bpy.context.collection.objects.link(key_o)

# ---- 4) 机位解算：由填充率反解距离，不是拖相机凑
def solve_camera(obj, fill=0.82, lens=55.0):
    sc = bpy.context.scene
    cam_data = bpy.data.cameras.new("CAM_Hero"); cam_data.lens = lens
    cam = bpy.data.objects.new("CAM_Hero", cam_data)
    sc.collection.objects.link(cam); sc.camera = cam
    bpy.context.view_layer.update()
    R = max(obj.dimensions) / 2.0
    half_angle = math.atan((cam_data.sensor_width / 2.0) / lens)
    d = R / math.sin(fill * half_angle)
    c = obj.matrix_world.translation
    cam.location = (c.x + d * 0.62, c.y - d * 0.72, c.z + d * 0.28)
    cam.rotation_euler = (c - cam.location).to_track_quat("-Z", "Y").to_euler()
    return cam, d

cam, cam_d = solve_camera(hero)

# ---- 5) 相机净空粗查（精确 9 条 ray 断言见 recipes/qa-review §2）
nearest = min((cam.location - o.matrix_world.translation).length
              for o in bpy.data.objects if o.type == "MESH")
if nearest < 0.5:
    raise RuntimeError(f"相机净空不足：最近 mesh 原点 {nearest:.2f}m < 0.5m")

# ---- 6) 渲染参数（delivery 档；实际渲染交给 blender_render，exec 内不渲）
sc = bpy.context.scene
sc.render.engine = "BLENDER_EEVEE"
sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
sc.view_settings.view_transform = "AgX"
sc.eevee.taa_render_samples = 128
sc.eevee.use_raytracing = True
os.makedirs(os.path.join(WORK, "out"), exist_ok=True)
blend = os.path.join(WORK, "out", "asset_first.blend")
bpy.ops.wm.save_as_mainfile(filepath=blend)

print(json.dumps({
    "blend": blend, "camera": cam.name, "camera_distance_m": round(cam_d, 2),
    "assets": {"hdri": hdri_a["id"], "human": human_a["id"],
               "prop": prop_a["id"], "texture": tex_a["id"]},
}, ensure_ascii=False))
```

脚本返回后：`blender_render(scene_blend_path:"out/asset_first.blend", render_engine:"eevee", quality:"final", samples:128)` → `read_image` 真看渲染图 → 再进 qa-review 的数值门。

## 5. 失败回退（报 id，不静默降级）

| 症状 | 动作 |
|---|---|
| `manifest.json` 不存在 | 报「资产库未 provision」，先跑 `assets/provision.py --verify`；**不许**改用手搓几何顶替 |
| `kind` 有、`tags` 全不命中 | 按第 1 节退化为任一命中；仍无 → 报 `kind` + 试过的 tags |
| 同 `kind` 全空 | 停手，报 `kind=<kind>`；确需自建 → 先交「自建理由 + 面数预算」，批准后再建 |
| `load_recipes.py` 找不到 | 报路径，设 `BLENDER_LOAD_RECIPES`；**不许**把函数复制进任务脚本（会漂移） |
| append 后对象为空／尺寸异常 | 报 id + 实测尺寸（human_base 身高应 1.7–1.9m）；换 id，禁止缩放硬凑 |
| 纹理缺 normal/roughness | 只接 diffuse 属降级，必须在交付说明写明；**不许**用纯色 Principled 冒充 PBR |
| HDRI 加载失败或全黑 | 报 id + 世界节点类型；换 `kind=hdri` 下一件，不许退成平色世界 |
| 本席位无 `blender_*` | 按 SKILL「能力闸门」走 bash+光栅兜底，并在交付写明「无 blender 席位」——这是**已声明的断路降级**，不是静默手搓；资产 id 仍要写清 |

**任何回退都要在交付正文写一行「缺失 id / 降级项」**；静默降级 = 骗验收。

## 6. 来源与许可

| 项 | 说明 |
|---|---|
| HDRI／纹理／模型 | Poly Haven，CC0（`https://polyhaven.com`）；1k 起步 |
| 人形基础网格 | Blender Studio `human-base-meshes` bundle，CC0（`https://www.blender.org/download/demo-files/`） |
| 许可核验 | 每件资产的 `license` 必须为 `CC0`，并带 `license_url` + `source_page`；核不到就不入 manifest |
| 资产重建 | `assets/provision.py`（从 manifest 的 URL 重建）；`--verify` 只校验 `bytes`/`sha256`，不开网络 |
| 装配函数 | `skills/blender-director/assets/load_recipes.py`（本仓，MIT） |

资产清单与加载方式对照见 `skills/blender-director/assets/CATALOG.md`。
