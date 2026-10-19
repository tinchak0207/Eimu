# blender-director 配方总线索引

本档是 `recipes/` 配方库的总线索引（105 个目录，六批次）。执行环境契约（Blender 5.2、桥、输出路径）见 [../SKILL.md](../SKILL.md)；每份配方 `RECIPE.md` 档头自带来源／license／5.2 雷区注释块，上游按 3.x/4.x 编写的 API 命中雷区时以档头为准。接委托单后先到本档按「工艺→风格→运镜→拟合→特效」对口选配方。

## 节 1：工艺与资产（W1，22）

| 配方名 | 一句话用途 |
| --- | --- |
| blender-modeler | Edit Mode 建模、修改器、集合与场景组织的核心专项 |
| hard-surface | 科幻／工业／载具硬表面建模（boolean、倒角、面板线、greebles） |
| procedural-modeling | Geometry Nodes 与修改器式程序化资产（岩石、地形、植被、管线） |
| sculpting | Dyntopo／多解析度雕刻，重构前的高频表面细节 |
| retopology | 面向动画的生产级重拓扑（四边面、环线、多边形流） |
| uv-workflow | 生产级 UV 展开（接缝、打包、纹素密度、UDIM、灯光图 UV） |
| texture-workflow | 生产级纹理流程（贴图集、AO/曲率/法线/粗糙度烘焙、贴花、显存优化） |
| materials | PBR 与风格化材质（金属、木、混凝土、玻璃、锈蚀、程序化著色器） |
| geometry-nodes | 程序化建模、散布系统与可重用节点组 |
| asset-optimization | 面数、拓扑、UV 效率、材质数量与命名验证，导出前优化门禁 |
| lod-pipeline | LOD 生成、命名、萤幕尺寸目标与验证 |
| collision-proxy | 游戏碰撞代理（UCX/UHX 命名、凸包、胶囊、简易碰撞体） |
| character-artist | AAA 角色建模（解剖、风格化、面部拓扑、服装毛发、动画就绪） |
| character-archetypes | 角色原型美术方向（奇幻种族、恐怖生物、职业、mecha/chibi 等体型） |
| creature-artist | AAA 生物建模（奇幻、异形、怪物，肌肉流与骨骼结构） |
| environment-artist | AAA 环境美术（模组化套件、地形、植被、建筑、场景构成） |
| prop-artist | 日常与英雄道具建模（家具、工具、kitbash 部件） |
| vegetation-artist | 植被与树叶制作（树木、草地卡、树冠 LOD、游戏级叶片贴图集） |
| vehicle-artist | 载具专项建模（汽车、飞机、船、机甲，比例与游戏 LOD 意识） |
| hair-groom | 毛发梳理（曲线、粒子毛发、几何节点、游戏发卡） |
| cloth-sim | 服装 blockout、布料模拟、钉固组与烘焙到形状键／快取 |
| physics-sim | 刚体／软体／破坏设置（约束、cell fracture 碎屑、烘焙快取） |

## 节 2：风格／mood／世界观（W2，34）

| 配方名 | 一句话用途 |
| --- | --- |
| archviz | 建筑可视化（室内外、真实比例、相机构图、PBR、静帧与动画交付） |
| isometric-style | 等距／策略游戏美术方向（透视模型盒框景、真等距相机、瓦片规则） |
| lowpoly-style | 低多边形美术方向（PS1/PS2、Lethal Company 系：可读剪影、少面数） |
| pixel-art-style | 像素艺术／纹素约束美术方向（低解析度纹理、HD-2D 邻近读感） |
| stylized-style | 风格化美术方向（形状语言、夸张、色彩和谐、NPR 渲染） |
| painterly-style | 绘画感美术方向（水彩／油画、柔边、颜料质感、插画光） |
| hand-painted-style | 手绘纹理美术方向（笔触 albedo、柔和明度过渡、风格化 PBR 节制） |
| vector-style | 向量扁平美术方向（平涂、锐利剪影、UI 级图形清晰度） |
| minimalist-style | 极简／抽象美术方向（简化形体、有限色板、负空间） |
| anime-style | 动画／赛璐璐著色美术方向（硬色阶断裂、toon shader、干净剪影） |
| manga-style | 漫画美术方向（单色明度设计、速度线、网点感、分格构图） |
| cartoon-style | 卡通美术方向（挤压拉伸可读形状、大胆配色、图形化剪影） |
| chibi-style | Q 版／SD 比例美术方向（大头、简化解剖、可爱剪影规则） |
| comic-book-style | 美漫／图像小说美术方向（墨线强调、半色调提示、高对比框景） |
| voxel-style | 体素／Minecraft 系美术方向（方块网格建模、有限色板、chunk 友好） |
| hd-2d-style | HD-2D 美术方向（像素角色与 3D 场景结合、景深、舞台灯光） |
| stop-motion-craft-style | 定格动画／手工艺质感（黏土动画、纸艺、实物材料提示） |
| realistic-style | 照写实 AAA 美术方向（摄影测量清理、真实比例、高模流程、PBR 精度） |
| cozy-wholesome-mood | 温馨治愈系 mood 方向（可爱、放松、平和） |
| dark-gritty-mood | 阴暗粗粝 mood 方向（锈蚀、废墟、工业、孤寂、颓败） |
| dream-surreal-mood | 梦境超现实 mood 方向（神秘、诡谲、希望与混沌） |
| dream-weirdcore-style | dreamcore／weirdcore 美术方向（阈限空间、错位怀旧、超现实童年场景） |
| brutalist-mood | 粗野主义 mood 方向（原始混凝土、纪念碑尺度、冷峻构图） |
| noir-style | 黑色电影美术方向（高对比灯光、湿街道、剪影、单色或限色调色） |
| frutiger-aero-style | Frutiger Aero 美术方向（光泽拟物、水感 UI、2000 年代科技乐观主义） |
| neon-retrofuturism | 霓虹复古未来 mood（合成波、铬、格线地平线、暮色色板） |
| retro-8bit-style | 8-bit 复古美术方向（NES 时代像素／低解析度约束） |
| retro-16bit-style | 16-bit 复古美术方向（SNES/MD 时代色彩丰富度、抖动提示、精灵感） |
| visual-console-eras | 主机世代视觉风格（PS1–PS5、街机、DOS、CRT、VHS、胶片颗粒） |
| apocalypse-worlds | 末世／反乌托邦世界观资产语言（丧尸、外星入侵、后人类、乌托邦对照） |
| biome-worlds | 群系与环境世界观（水下、沙漠、极地、丛林、地下、浮岛） |
| fantasy-worlds | 奇幻世界观资产语言（中世纪、高奇幻、黑暗奇幻、都市奇幻） |
| sci-fi-punk-worlds | 科幻／庞克世界观（赛博、蒸汽、柴油、原子、太阳能、生物、发条庞克） |
| historical-worlds | 历史时代世界观（海盗、武士／忍者、维京、古埃及／希腊／罗马、维多利亚、军事） |

## 节 3：产品片运镜／Polyhaven／图转 3D（W3，16）

| 配方名 | 一句话用途 |
| --- | --- |
| blender-toolkit | 自动化 Blender 任务（建 3D 形、材质管理、Mixamo 动画重定向） |
| crane-shot | 升降镜头：低位起升揭示完整产品，戏剧性揭幕 |
| dolly-rotate | 前推＋环绕复合运镜，比直线变焦更动感 |
| dynamic-full-loop | 带变速节奏的动感全环绕循环（各面慢揭示、快速甩镜，含顶底面） |
| perfect-loop | 首尾帧完全匹配的无缝 360° 循环转台 |
| slow-zoom | 电影感缓慢推入英雄细部，营造揭示效果 |
| turntable | 经典 360° 产品转台环绕动画 |
| image-to-3d | 单张照片经 Meshy API 转 3D 并汇入 Blender |
| multi-image-to-3d | 1–4 张多角度照片经 Meshy API 转高精度 3D 并汇入 |
| threejs-export | 场景汇出 GLB 并生成即用 Three.js 检视器网页（轨道控制、自动旋转） |
| product-polish | 汇入 GLB 模型套棚拍打光，出光泽产品照质感 |
| polyhaven-hdri-showcase | 同一产品跨多个 HDRI 环境渲染，输出对比网格 |
| polyhaven-material-swap | 产品轮换多种 PolyHaven 材质逐版渲染，展示色彩／表面选项 |
| polyhaven-scene-builder | 用 PolyHaven 资产搭建完整产品场景（HDRI 环境、地面／基座、道具） |
| polyhaven-studio-setup | 用 PolyHaven HDRI 与 PBR 地材搭建专业棚拍／展示厅场景 |
| polyhaven-texture-apply | 给任意物件套用 PolyHaven 写实 PBR 纹理（金属、木、混凝土、布料） |

## 节 4：参考图→3D 拟合管线／品质门禁（W4，20）

| 配方名 | 一句话用途 |
| --- | --- |
| animation-quality-gate | 动画验收门禁：接触表渲染、剪影稳定性、闪烁、构图、主体占比检查 |
| atlas-uv-fitting | 侦测纹理贴图集区域，把各源部件 1:1 映射到各自的 UV 矩形／投影面 |
| blender-pro-workflow | 端到端生产工序（block-out→相机→灯光→形体→材质→细节→渲染→合成→导出）与批判协议 |
| blender-skill-harmonizer | 多 skill 协调成连贯管线：启用优先级、交接产物、依赖门禁、冲突裁决 |
| closed-surface-uv-coverage | 确保纹理／贴花覆盖封闭面全部可见表面（背盖、侧墙），不靠局部投影 |
| contour-to-mesh | 从提取的 2D 轮廓／遮罩直接建网格面（1:1 吉祥物／logo 重建、浮雕） |
| fit-repair-optimizer | 把拟合报告转成有序修复伫列，迭代修线框／纹理／灯光／投影错位 |
| landmark-fit-repair | 用命名地标（叶尖、壳角、眼睛、微笑、边框厚度）校验修复源锁定模型 |
| mascot-logo-reconstruction | 门禁式源锁定吉祥物／logo／品牌头像重建编排，要求 1:1 而非近似 |
| multiview-constraint-solver | 判定前／侧／背／顶模板能否由单一刚体模型满足，选真源策略并出约束 |
| multiview-fit-loop | 对照四视图模板与原图的闭环「比较—调整—复验」拟合流程 |
| orbital-hud-motion | 围绕主体的圆形／HUD 光环动画（弧线、轨道标记，与 logo／吉祥物关联） |
| orthographic-registration | 把前／侧／背／顶正交参考视图注册到共享 Blender 座标契约 |
| quality-refinement-autoloop | 结果不佳时的自我精修循环：诊断缺口→修复产物或补技能→消毒沉淀 |
| reference-analysis-validator | 宣告 1:1 之前对参考图／线框／贴图集／渲染成品做量测验证 |
| reference-look-calibration | 对照原图用可量测统计校准材质、灯光、裁切、发光、色彩管理 |
| reference-to-3d | 从参考图集／正交四视图／品牌模板重建高保真 Blender 模型 |
| source-part-segmentation | 重建前从源图／线框／贴图集分割接触或重叠的视觉部件 |
| texture-driven-mesh-fitting | 反向拟合：让网格边界贴合纹理轮廓 1:1（模型迁就纹理而非拉伸纹理） |
| text-to-blender | 自然语言驱动 Blender 的总编排：转 bpy 代码并分派链载入专项子技能 |

## 节 5：特效（W6，1）

| 配方名 | 一句话用途 |
| --- | --- |
| vfx-fx | 电影与游戏特效（烟、火、粒子、拖尾、Geometry Nodes FX 设置） |

## 节 6：基础 12 份（07-18 片B 首批）

| 配方名 | 一句话用途 |
| --- | --- |
| animation | 游戏级动画（走／跑／待机循环、战斗、机械、相机动画、Graph Editor、NLA） |
| camera-cinematography | 电影感镜头工作（取景、镜头、构图、相机动画、镜头语言） |
| compositing | 合成器工作流（美板堆叠、渲染通道、调色、辉光、交付输出） |
| export-pipeline | 生产级导出（FBX、GLTF、OBJ、USD、Alembic＋比例轴向法线验证） |
| lighting | 电影感与游戏灯光（三点布光、HDRI、体积光、轮廓光、情绪照明） |
| lookdev | 资产外观开发循环（材质×灯光×相机截图对比直到著色达标） |
| qa-review | 资产生产 QA 门禁（视口截图、验证清单、命名审计、ship/no-ship 裁决） |
| rendering | Cycles 与 Eevee 渲染（采样、降噪、渲染通道、色彩管理、优化） |
| rigging | 生产级绑定（骨架、IK/FK、约束、权重绘制、机械与面部绑定、驱动器） |
| scene-assembly | 大型场景布局（集合组织、连结、重载、流式友好的结构化组装） |
| set-dressing | 场景陈设与环境叙事摆位（道具密度、叙事簇、可读性规则） |
| references/ | 共享参考档：9 份规范（asset-pipeline、mcp-integration、mcp-tools、naming-conventions、polycount-budgets、reference-analysis-template、reference-image-match、validation-checklist、visual-match-checklist）＋2 份 roble3 文档（roble3-BLENDER_BEST_PRACTICES、roble3-SKILL_FOUNDATION） |

## 姐妹 skill 域

- [../../make-blender-education-video/SKILL.md](../../make-blender-education-video/SKILL.md) — Blender 教育视频全链：科学／工程／建筑主题的电影级教育动画制作
- [../../motion-design/](../../motion-design/) — 动态设计域（四 skill：motion-design 动效原理、blender-motion、aftereffects-motion、motion-design-critique 评审）
- [../../astra-ad-studio/SKILL.md](../../astra-ad-studio/SKILL.md) — Astra 广告工作室：创意方向到成品广告战役的全链制作
- [../../web-3d-awwwards/SKILL.md](../../web-3d-awwwards/SKILL.md) — Awwwards 级卷动驱动 3D 网站（Active Theory、Lusion 等视觉语言）
- [../../blender-agent-os/](../../blender-agent-os/) — agent 执行合同域（四 skill：blender-agent-core 契约先行纪律、blender-image-to-3d、blender-knowledge-workbench、img2threejs，附 knowledge 知识库与 system-architecture.md）
