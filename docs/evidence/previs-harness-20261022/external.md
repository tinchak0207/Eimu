# Previs Harness 外部对称差调研（external.md）

- 日期：2026-10-22（Asia/Shanghai，UTC+8）
- 性质：只读调研；没有改我方代码
- 方法：`gh api`（已登录）读 repo 元数据、目录树和 LICENSE；`curl raw.githubusercontent.com` 读源码，逐字引文都来自这些 raw 文件；`npm view` / `npm pack` 核对发布包的 License；WebSearch/WebFetch 只用来核对 Mixamo、Quaternius、RPM、CMU 的条款
- ★ 数：`gh api repos/<r> .stargazers_count` 在 2026-10-22 抓取的值。License 以 LICENSE 文件或 package.json 为准；GitHub 显示 NOASSERTION 的，都已人工读过原文
- License 判定口径（AGENTS 铁律）：✅ 可抄/可依赖（MIT/Apache/BSD/CC0；Zlib 也是宽松许可，判为可用，但它不在铁律白名单里，单独标出）；⚠️ 只能作为依赖使用、不改源码（MPL-2.0 是文件级 copyleft）；⛔ 只学形态（GPL/AGPL/EULA/无 License/有地域或用户规模限制）

---

## 0. 总表（快速索引）

| 轴 | 项目 | ★ | License | 结论 |
|---|---|---|---|---|
| 1 编排 | HITsz-TMG/VideoClaw（内含 FilmAgent） | 1873 | MIT | ✅ 学其「闭集选择 + 相似度纠偏 + 多轮校验」，prompt 可抄 |
| 1 编排 | wonderunit/storyboarder（Shot Generator） | 3889 | **无 OSS License，build 里是 EULA** | ⛔ 只学形态（场景对象 schema、342 个姿势预设） |
| 1 编排 | robincourant/DIRECTOR (E.T.) | 79 | MIT（代码）；数据 License 未核实 | 文本→相机轨迹扩散模型，研究参考 |
| 1 编排 | HITsz-TMG/Anim-Director | 263 | 无 License | ⛔ 2D 视频生成 agent，与 3D previs 关系弱 |
| 1 编排 | DarlingHang/ChatCam | 23 | 无 License | ⛔ 只学形态（未深读源码） |
| 1 编排 | ahujasid/mcp-for-blender | 31950 | MIT | LLM 直接写 Blender Python；形态参考：「代码即 IR」的反例 |
| 2 动作 | Tencent-Hunyuan/HY-Motion-1.0 | 2617 | 腾讯社区协议（排除欧盟/英国/韩国，>1M MAU 需另行授权） | ⛔/⚠️ 只做离线研究；SaaS 主链路不建议用 |
| 2 动作 | GuyTevet/motion-diffusion-model | 4121 | MIT（代码）；训练数据 AMASS/SMPL 非商用 | 权重商用风险 ⚠️ |
| 2 动作 | EricGuo5513/momask-codes | 1337 | MIT（代码）；同上 | 权重商用风险 ⚠️；自带 BVH 导出 |
| 2 动作 | OpenMotionLab/MotionGPT | 1984 | MIT（代码）；同上 | 同上 |
| 2 动作 | Mael-zys/T2M-GPT | 781 | Apache-2.0（代码）；同上 | 同上 |
| 2 动作库 | Quaternius Universal Animation Library 1/2 | — | **CC0** | ✅ 首选：120+ 与 130+ 个动画，含剑击连招 |
| 2 动作库 | CMU Graphics Lab Mocap | — | 「may be copied, modified, or redistributed without permission」 | ✅ 可用；以 asf/amc 为主，BVH 是第三方转换 |
| 2 动作库 | Mixamo | — | 免版税，但**禁止分发原始文件**、禁止训练 ML、**中国区账号不可用** | ⚠️ SaaS 往浏览器下发 GLB 处于灰色地带 |
| 2 动作库 | Ready Player Me | — | **2026-01-31 已停服** | ⛔ 不要依赖 |
| 2 重定向 | three.js `SkeletonUtils.retargetClip` | 116753 | MIT | ✅ 直接用 |
| 2 重定向 | pmndrs/viverse（`loadCharacterAnimation`） | 132 | LICENSE 文件为 MIT 文本 | ✅ 现成的 mixamo/bvh/fbx/vrma→VRM 骨骼映射 |
| 2 行为 | @drawcall/acta（npm） | — | `SEE LICENSE IN LICENSE`，但发布包里没有 LICENSE 文件，repo 404 | ⛔ 只学形态（「JSON 描述角色行为」的 IR） |
| 3 时间线 | theatre-js/theatre | 12783 | **core/r3f/dataverse/react = Apache-2.0；studio = AGPL-3.0-only** | ✅ 运行时用 core；⛔ 不要把 studio 打进 SaaS |
| 3 后期 | pmndrs/postprocessing | 2891 | Zlib | ✅（不在白名单但属宽松许可） |
| 3 后期 | pmndrs/react-postprocessing | 1476 | MIT | ✅ |
| 3 后期 | three.js TSL `MotionBlur.js`（WebGPU） | — | MIT | ✅ 需要 WebGPURenderer |
| 3 后期 | 0beqz/realism-effects | 1738 | MIT | ✅ 但 2024-02 后无提交，three 版本兼容性未核实 |
| 3 后期 | N8python/n8ao | 503 | CC0-1.0 | ✅ AO |
| 3 粒子 | Alchemist0823/three.quarks | 1112 | MIT | ✅ 首选（带 Trail、JSON 预制件、r3f 封装） |
| 3 粒子 | creativelifeform/three-nebula | 1239 | MIT | ✅ 备选 |
| 3 镜头 | yomotsu/camera-controls | 2439 | MIT | ✅ 用于交互和过渡；不是时间线 |
| 3 场景 | pmndrs/drei | 10037 | MIT | ✅ Sky/Environment/Sparkles/Trail/Cloud/ContactShadows |
| 5 录制 | spite/ccapture.js v2.0.0 | 3777 | MIT | ✅ 首选：虚拟时钟 + WebCodecs mp4 + 累积运动模糊 |
| 5 录制 | Vanilagy/mediabunny | 7359 | MPL-2.0 | ⚠️ 作为依赖使用、不改源码即可；mp4-muxer 已废弃，由它接替 |
| 5 录制 | Vanilagy/mp4-muxer | 616 | MIT | 已 deprecated |
| 5 录制 | puppeteer/puppeteer | 95731 | Apache-2.0 | ✅ 无头服务端渲染 |
| 5 录制 | remotion-dev/remotion | 66189 | **Remotion License（>3 人的营利公司需要 Company License；禁止转售衍生品）** | ⛔ 默认不用 |

---

## 轴 1：LLM → 动画序列 / 镜头编排

### 1.1 FilmAgent（现位于 HITsz-TMG/VideoClaw/FilmAgent）— MIT ✅
- 原 `HITsz-TMG/FilmAgent` 现在被 GitHub 重定向到 `HITsz-TMG/VideoClaw`（★1873，MIT，`Copyright (c) 2026 Video-Claw`）。FilmAgent 代码在子目录 `FilmAgent/FilmAgent/` 下
- 文件清单：
  - https://raw.githubusercontent.com/HITsz-TMG/VideoClaw/main/FilmAgent/FilmAgent/main.py （721 行）
  - https://raw.githubusercontent.com/HITsz-TMG/VideoClaw/main/FilmAgent/FilmAgent/Prompt/cinematographer.txt
  - `Prompt/director_1..9.txt`、`screenwriter_1..5.txt`、`actor.txt`、`shot_review.txt`
  - https://raw.githubusercontent.com/HITsz-TMG/VideoClaw/main/FilmAgent/FilmAgent/Locations/Roadside/position.json
  - https://raw.githubusercontent.com/HITsz-TMG/VideoClaw/main/FilmAgent/FilmAgent/scripts/cot/4o/1/script.json
- **中间表示**：LLM 不写坐标，也不写关键帧，只在**闭集枚举**里做选择。可选内容包括位置（`Position N`，带 `sittable` 属性）、动作名（Unity 动画库里的名字）和镜头类型（Track/Long/Close/Mid/Pan/Zoom Shot）。真实运镜和动画都是在 Unity 里预制好的
- 逐字引文（`cinematographer.txt`）：
  > `- If you want to use Zoom Shot, you must ensure the preceding shot is a Long Shot.`
  > `- If you want to use Pan Shot during dialogue, it should be used multiple times in a row.`
  > ```json
  > { "scene 1": { "selected-shot-1": {"reasoning": "...", "shot": "Name of shot"}, ...
  > ```
- 逐字引文（`script.json` 产物）：
  > `{"speaker": "Jack", "content": "It's been a while, hasn't it?", "actions": [{"character": "Jack", "state": "standing", "action": "Standing Talking"}], "selected shot": "Track Shot"}`
- 校验与纠偏的实作（`main.py`），逐字引文：
  > `def find_unknown_actions(self, scenes: List) -> List:` … `Output: The list of actions appearing in the script that are not set in Unity.`
  > `new_item['action'] = return_most_similar(item['action'], v_actions)`
  > `if new_item['action'] == "Standing Talking":`
  > `    new_item['action'] = "Standing Talking " + str(random.randint(1, 6))`
  > `return "Track Shot " + str(random.randint(1, int(info[location]['track'])))`
- 流程还包括 `stage1_verify` / `stage2_verify` / `stage3_verify`（director↔screenwriter↔cinematographer 互评后再修订），以及 `revise_shot_annotation(self, src, feedback)`
- **对我方的启示（可直接抄形态和 prompt，MIT）**：
  1. `DirectorSequenceShot.cameraMove`（24 种）和 `actions` 应保持**闭集枚举**。LLM 只做选择，不写数值；数值由我方模板加随机变体（`"Track Shot " + randint`）来填
  2. 校验做三层：schema 校验 → 「未知动作/镜头」集合差（`find_unknown_actions`）→ 最近邻纠偏（`return_most_similar`），而不是直接报错让 LLM 重写
  3. 镜头语法规则（如 Zoom 前必须接 Long）写成 prompt 约束，再加一个 review agent 二次检查
- 能否接入：✅ 只需要形态和 prompt，不涉及引擎代码（它的引擎是 Unity，没开源到这个 repo 里）

### 1.2 Storyboarder Shot Generator（wonderunit/storyboarder）— ⛔ 只学形态
- ★3889；GitHub 显示 License 为 none。repo 根目录**没有 LICENSE**；`package.json` 打包时引用的是 `build/license_en.txt`，逐字引文开头是：
  > `End User License Agreement for Wonder Unit Software`
  README 只有一个外链（`## Notes on Open Source License` → `https://wonderunit.com/thoughts-on-free-and-open-source/`）。**结论：不能抄代码**
- 文件清单：
  - https://raw.githubusercontent.com/wonderunit/storyboarder/master/src/js/shared/reducers/shot-generator.js （1840 行）
  - https://raw.githubusercontent.com/wonderunit/storyboarder/master/src/js/shot-generator/components/Three/Character.js （465 行）
  - https://raw.githubusercontent.com/wonderunit/storyboarder/master/src/js/shared/reducers/shot-generator-presets/poses.json （342 个姿势预设）
  - `src/js/shared/IK/SGIkHelper`、`src/js/shot-generator/SceneManagerR3fLarge.js`（实作是 three.js + R3F）
- **中间表示**：扁平的 `sceneObjects` 字典，用 `type: 'camera'|'character'|'light'|'object'`，相机参数是 `fov/x/y/z/rotation/tilt/roll`。逐字引文：
  > `type: 'camera',` `fov: 22.25,` `x: 0,` `y: 6,` `z: 1,` `rotation: -0.0,` `tilt: 0,` `roll: 0.0,`
  > `characterPresetId: '7C694D0F-9D45-4B74-BA70-38479E520091',` … `posePresetId: defaultPosePreset.id,` `skeleton: defaultPosePreset.skeleton`
- 姿势的应用方式（`Character.js`），逐字引文：
  > `let modified = sceneObject.skeleton[bone.name]` … `bone.rotation.setFromVector3(state.rotation)`
  也就是说，姿势 = `{骨骼名: {rotation}}` 的稀疏覆盖，对未指定的骨骼回落到 `originalSkeleton`
- 启示：我方 mannequin（11 关节、12 个 pose）可以照这个形态升级为「真实 GLB 骨骼 + 稀疏骨骼旋转覆盖 + 姿势预设库」。不过它**只有静态姿势，没有时间线动画**，补不了「丝滑播放」这块

### 1.3 文本→相机轨迹：DIRECTOR / E.T.（robincourant/DIRECTOR）— MIT（代码）
- ★79。README 逐字引文：`This code is distributed under an [MIT LICENSE](LICENSE).`，还有 `uses datasets which each have their own respective licenses`。E.T. 数据集取自电影片段，其 License **未核实**
- 形态：扩散模型根据文本（+角色轨迹）生成相机轨迹。需要 GPU 和 PyTorch3D；与我方「LLM 选 cameraMove 枚举 + 参数化轨迹」相比太重。**建议只作远期参考**
- 其他：`hehao13/CameraCtrl`（★666，Apache-2.0）是视频扩散模型的相机控制，不产出 3D 轨迹，不相关；`DarlingHang/ChatCam`（★23，无 License）⛔，源码未深读；`HITsz-TMG/Anim-Director`（★263，无 License）是 2D 视频生成 agent，⛔
- `ahujasid/mcp-for-blender`（★31950，MIT）：LLM 直接执行 Blender Python。属于「代码即 IR」，**不可校验、不可回放**。我方应坚持结构化文档（DirectorSequenceShot），这一点反证了我方路线是对的

### 1.4 轴 1 结论
- 没有找到一个开源项目做的是「LLM 直接写 three.js 时间线」并且带成熟校验。最接近且可抄的是 FilmAgent 的「闭集选择 + 校验纠偏」，以及 Theatre.js core 的关键帧 JSON 作为**底层播放格式**（见 3.1）
- 推荐的 IR 分层：LLM 输出 `DirectorSequenceShot`（语义层：枚举 + 少量数值）→ 我方编译器 → Theatre.js `BasicKeyframe[]` 或 three.js `AnimationClip`（播放层：数值关键帧）

---

## 轴 2：文本 → 角色动作

### 2.1 HY-Motion 1.0（Tencent-Hunyuan/HY-Motion-1.0）— ⛔ 不进 SaaS 主链路
- ★2617，License 文件是 `License.txt`。逐字引文：
  > `TENCENT HY-MOTION 1.0 COMMUNITY LICENSE AGREEMENT`
  > `THIS LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA AND IS EXPRESSLY LIMITED TO THE TERRITORY, AS DEFINED BELOW.`
  > `If, on the Tencent HY-MOTION 1.0 version release date, the monthly active users of all products or services made available by or for Licensee is greater than 1 million monthly active users ... You must request a license from Tencent`
  > `c. You must not use, reproduce, modify, distribute, or display the Tencent HY-MOTION 1.0 Works, Output or results ... outside the Territory.`（输出物也受地域限制）
- 硬件，README 逐字引文：
  > `| **HY-Motion-1.0** | Standard Text2Motion Model | 2025-12-30 | 1.0B | ... | 26GB |`
  > `| **HY-Motion-1.0-Lite** | Lightweight Text2Motion Model | 2025-12-30 | 0.46B | ... | 24GB |`
  > `text prompt with less than 30 words, and motion length less than 5 seconds.`
- 输出：SMPL-H，rot6d → FBX。文件 https://raw.githubusercontent.com/Tencent-Hunyuan/HY-Motion-1.0/master/hymotion/utils/smplh2woodfbx.py（`import fbx`，依赖 Autodesk FBX SDK）、`hymotion/utils/t2m_runtime.py`。t2m_runtime 逐字引文：
  > `# Calculate frame length from duration (assuming 30fps output, 20fps internal)`
  > `print(">>> Warning: FBX export requested but FBX SDK is not available. Falling back to dict format.")`
  它的 Gradio 预览页 `scripts/gradio/templates/index_wooden_static.html` 用的就是 `three@0.160.0`，说明结果可以在浏览器里播放
- 延迟：README 没有给出单条推理时长，**未核实**
- 能否接入：技术上可以走 SMPL-H→FBX/GLB→`SkeletonUtils.retargetClip`；但 License 有地域和输出限制，并且需要 24–26GB 显存，**不建议进 SaaS 主链路**

### 2.2 MDM / MoMask / MotionGPT / T2M-GPT — 代码宽松，权重/数据非商用风险 ⚠️
- 代码 License（README 逐字引文）：
  - MDM：`This code is distributed under an [MIT LICENSE](LICENSE).` + `Note that our code depends on other libraries, including CLIP, SMPL, SMPL-X, PyTorch3D, and uses datasets that each have their own respective licenses that must also be followed.`
  - MoMask：`This code is distributed under an [MIT LICENSE]...` + 相同的数据集提醒
  - MotionGPT：MIT；T2M-GPT：Apache-2.0（取自 GitHub 元数据）
- 训练数据都是 HumanML3D（https://raw.githubusercontent.com/EricGuo5513/HumanML3D/main/README.md），逐字引文：
  > `Due to the distribution policy of AMASS dataset, we are not allowed to distribute the data directly.`
  AMASS 和 SMPL 是研究/非商用许可（AMASS 条款原文**未在本次逐字核实**）。因此**预训练权重用于商业 SaaS 存在风险**
- 性能与格式：
  - MDM README：`## MDM is now 40X faster 🤩🤩🤩 (~0.4 sec/sample)`；`--motion_length (text-to-motion only) in seconds (maximum is 9.8[sec])`；`results.npy file with text prompts and xyz positions`（只输出关节 xyz，需要 IK 才能驱动骨骼）
  - MoMask 自带 BVH：`visualization/joints2bvh.py`、`visualization/smpl2bvh.py`。README 逐字引文：`* bvh files: bvh files of the generated motion, under subfolder ./animation.`
- 打斗适配：HumanML3D 里武打、特技动作稀少，最长不到 10 秒，生成「成片级武侠」**质量不足**。这一点是领域常识推断，未做实测

### 2.3 无模型路线：动作库 + LLM 选片 + 混合（**推荐主路线**）
| 来源 | License（原文） | 打斗覆盖 | 备注 |
|---|---|---|---|
| Quaternius Universal Animation Library（UAL1，120+） | itch 页：`Free to use in personal, educational and commercial projects. (CC0 License)` | `combat and gun`、Sword Attack（含 root motion 版本） | v2.0（2026-01-23）改为 GLB 导出；v3.0 给全部位移动画加了 root motion |
| Quaternius UAL2（130+） | 同上，CC0 | `3 and 4 hit combos, split into separate hits with their recoveries, and full combo anims.`；v2.2 修了 `Sword_Light animations end frames not matching with recoveries` | 天然适合「起手-命中-收招」拼接 |
| three.js 示例 RobotExpressive | `examples/models/gltf/RobotExpressive/README.md`：`Model by Tomás Laulhé ... CC0 1.0.` | 少（Punch 等） | |
| three.js 示例 Soldier / Xbot / Michelle / readyplayer.me.glb | 示例目录里**没有找到 per-model License 说明**；Soldier/Xbot 一般认为来自 Mixamo（未核实） | — | ⚠️ 不要直接商用 |
| CMU Mocap | FAQ 原文：`The motion capture data may be copied, modified, or redistributed without permission.` | 有少量格斗/武术片段（具体条目未核实） | asf/amc 为主，BVH 是第三方转换 |
| Mixamo | Adobe FAQ：可免版税用于商业项目，但社区 FAQ 写明 `NO ... Any type of free distribution of character or animation raw files`；`The only research application Mixamo content can't be used in is training machine-learning models.`；官方 FAQ：`Mixamo is not available for users who have a country code from China.` | 打斗动作最丰富 | ⚠️ SaaS 把 GLB 下发到浏览器，可能被认定为分发原始文件，属于灰色地带；中国区账号无法使用 |
| Ready Player Me | readyplayer.me 首页：`Ready Player Me services were discontinued on Jan 31, 2026.` | — | ⛔ |
| Kenney | CC0（站点惯例，本次未逐字核实具体动画角色包） | 少 | |

- **混合与重定向的现成实作（✅ MIT）**：
  - three.js `examples/jsm/utils/SkeletonUtils.js`（https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/utils/SkeletonUtils.js），逐字引文：
    > `options.hip = options.hip !== undefined ? options.hip : 'hip';`
    > `options.hipInfluence = options.hipInfluence !== undefined ? options.hipInfluence : new Vector3( 1, 1, 1 );`
  - 示例 `examples/webgpu_animation_retargeting_readyplayer.html`，逐字引文：
    > `hip: 'mixamorigHips',`
    > `// Map of target's bone names to source's bone names -> { targetBoneName: sourceBoneName }`
    > `const retargetedClip = SkeletonUtils.retargetClip( targetSkin, sourceModel.skeleton, sourceModel.clip, retargetOptions );`
  - 交叉淡入淡出 `examples/webgl_animation_skinning_blending.html`，逐字引文：
    > `startAction.crossFadeTo( endAction, duration, true );`
    > `action.setEffectiveWeight( weight );`
  - 另有 `webgl_animation_skinning_additive_blending.html`（叠加层，可用于受击抖动）和 `webgl_animation_skinning_ik.html`
  - pmndrs/viverse `packages/viverse/src/animation/index.ts`（https://raw.githubusercontent.com/pmndrs/viverse/main/packages/viverse/src/animation/index.ts）已实现多格式统一加载并重定向到 VRM 人形骨骼，逐字引文：
    > `type?: 'mixamo' | 'gltf' | 'vrma' | 'fbx' | 'bvh'`
    > `export async function loadCharacterAnimation(`
    > `boneMap ??= bvhBoneMap`
    骨骼映射表 `mixamo-bone-map.ts`：`mixamorigHips: 'hips',` `mixamorigSpine: 'spine',`；`bvh-bone-map.ts`：`Hips: 'hips',`
    LICENSE 文件是 MIT 文本（`Copyright 2024 Bela Bohlender`）；package.json 写的是 `"license": "SEE LICENSE IN LICENSE"`
- 形态参考（⛔ 不抄）：`@drawcall/acta`（npm 0.1.43）README：`Acta is a JSON format for 3D character behavior in three.js.`，`"effects": [{ "name": "muzzle", "at": 0.08 }]`（动画内时间点触发特效）。发布包里没有 LICENSE 文件，repo 404，所以只学「动画片段 + 命中帧事件」这一 IR 形态。这个事件形态很适合「出招命中帧 → 触发粒子、慢动作、震屏」
- **评估：「动作库 + LLM 选片 + 混合」能否支撑打斗？**能支撑**预演级**打斗，前提是满足以下几点：
  1. 用 UAL1+UAL2（CC0）的连招分段（hit + recovery）建「动作卡」：名称、时长、root 位移、命中帧、攻击方向、需要的对手相对位置
  2. LLM 只输出 `actions: [{actor, clipId, startSec, target}]`，由我方编译器负责对齐双方站位（攻击方命中帧对齐受击方 hit-react 起始帧）和 crossFade
  3. 慢动作用 `mixer.timeScale` / 分段 `action.timeScale` 实现，大招由粒子和后期补足
  4. 局限：做不到特定招式和精准接触（需要 IK 手部对位）；**武侠特有的轻功、兵器套路库存不足**，后续可以让 HY-Motion 离线生成、人工审核后入库（受 License 地域条款约束，需要法务确认）

---

## 轴 3：浏览器端美观实时渲染 / 后期 / 时间线

### 3.1 Theatre.js（theatre-js/theatre）— **重点 License：拆包**
- ★12783。各包 LICENSE 与 package.json 逐个核过：
  - `packages/core/package.json`：`"license":"Apache-2.0"`；`packages/r3f`、`packages/dataverse`、`packages/react` 也是 Apache-2.0
  - `packages/studio/LICENSE`：`GNU AFFERO GENERAL PUBLIC LICENSE Version 3`；package.json 是 `"license":"AGPL-3.0-only"`
  - npm：`@theatre/core 0.7.2 Apache-2.0`、`@theatre/studio 0.7.2 AGPL-3.0-only`、`@theatre/r3f 0.7.2 Apache-2.0`
  - **最后一次提交 2024-04-11**，维护停滞，有风险
- 结论：生产 SaaS **只装 `@theatre/core`（+`@theatre/r3f`）播放 JSON 状态** ✅。`@theatre/studio` 编辑器（AGPL）⛔ 不打进对用户提供的产品，只可在内部离线调试中使用（法务口径需要再确认）
- 关键帧 IR（`packages/core/src/types/public.ts`，https://raw.githubusercontent.com/theatre-js/theatre/main/packages/core/src/types/public.ts），逐字引文：
  > ```ts
  > export type BasicKeyframe = {
  >   id: KeyframeId
  >   value: SerializableValue
  >   position: number
  >   handles: [leftX: number, leftY: number, rightX: number, rightY: number]
  >   connectedRight: boolean
  >   type?: KeyframeType
  > }
  > ```
- 插值实作 `packages/core/src/sequences/interpolationTripleAtPosition.ts`，逐字引文：`import UnitBezier from 'timing-function/lib/UnitBezier'`（三次贝塞尔缓动）
- 确定性 seek（录制必需）：`packages/core/src/sequences/TheatreSequence.ts` 第 77/81 行有 `get position()` / `set position(position: number)`；播放接口是 `play(conf?: Partial<{ iterationCount: number; range: IPlaybackRange; rate: number; direction: IPlaybackDirection; rafDriver: IRafDriver }>)`。`rafDriver` 可以接外部时钟，`rate` 可以做慢动作
- 能否接入：✅ 我方编译器把 `DirectorSequenceShot.cameraKeyframes` 转成 `BasicKeyframe`（camera.position、target、fov 各一条 track）。`handles` 就是缓动曲线，能直接解决「丝滑」问题。替代方案是不引入 Theatre，直接用 three.js `AnimationClip`/`VectorKeyframeTrack` + `InterpolateSmooth`（MIT，零新依赖）；不过 three.js 原生没有逐帧贝塞尔 handles，缓动要靠我方自己的 easing 预采样

### 3.2 后期：pmndrs/postprocessing（Zlib）✅
- ★2891，npm `postprocessing 6.39.5 license = 'Zlib'`。LICENSE.md 逐字引文：`Copyright © 2015 Raoul van Rüschen` / `This software is provided 'as-is', without any express or implied warranty.`
- 本次核过的 `src/effects/` 文件：`BloomEffect.js`、`SelectiveBloomEffect.js`、`DepthOfFieldEffect.js`、`BokehEffect.js`、`SMAAEffect.js`、`ToneMappingEffect.js`、`ChromaticAberrationEffect.js`、`GodRaysEffect.js`、`ShockWaveEffect.js`（适合大招冲击波）、`VignetteEffect.js`、`LensDistortionEffect.js`、`NoiseEffect.js`、`SSAOEffect.js`、`OutlineEffect.js`
- **没有 MotionBlurEffect**。补法如下：
  - WebGL：`0beqz/realism-effects`（MIT，★1738）的 `src/motion-blur/MotionBlurEffect.js`。最后提交 2024-02，与新版 three/postprocessing 的兼容性**未核实**
  - WebGPU：three.js 官方 `examples/jsm/tsl/display/MotionBlur.js`（MIT），逐字引文：`@param {Node<vec2>} velocity - The motion vectors of the beauty pass.`；示例里写的是 `scenePass.setMRT( mrt( { ... velocity` 和 `const mBlur = motionBlur( beauty, vel );`
  - 离线录制：ccapture v2 自带累积式运动模糊（见轴 5），**录制时效果最好且零依赖**
- R3F 封装：pmndrs/react-postprocessing（★1476，MIT，npm `@react-three/postprocessing 3.2.2`）
- AO：N8python/n8ao（★503，CC0-1.0）

### 3.3 粒子：three.quarks（MIT）✅ 首选
- ★1112，npm `three.quarks 0.17.1 MIT`
- 文件清单：`packages/three.quarks/src/{BatchedRenderer.ts, ParticleSystem.ts, TrailBatch.ts, QuarksLoader.ts, QuarksUtil.ts, MeshSurfaceEmitter.ts}`，另有 `packages/quarks.r3f/src/index.ts`、`packages/quarks.nodes/src/WebGPURenderer.ts`
- 逐字引文（QuarksLoader.ts）：`export class QuarksLoader extends ObjectLoader {`、`object = ParticleSystem.fromJSON(data.ps, meta as any, dependencies).emitter;`。也就是说**特效是 JSON 预制件**，可以建「大招特效库」，由 LLM 按名字选用
- QuarksUtil 静态控制：`static play(obj: Object3D)`、`static stop(...)`、`static restart(...)`、`static pause(...)`、`static endEmit(...)`
- `TrailBatch.ts` 实现了拖尾（刀光、剑气）；`MeshSurfaceEmitter.ts` 能从角色网格表面发射粒子（适合气劲缠身）
- 录制注意：要把粒子更新改成「固定 dt 步进」以保证确定性；任意 seek 能力**未核实**（多半需要从头重放）
- 备选：creativelifeform/three-nebula（★1239，MIT，npm 13.3.0）

### 3.4 场景美术（天空/HDRI/草/阴影）
- drei（★10037，MIT）`src/core/`：`Sky.tsx`、`Environment.tsx`、`Sparkles.tsx`、`Trail.tsx`、`Cloud.tsx`、`Stars.tsx`、`ContactShadows.tsx`、`AccumulativeShadows.tsx`、`MeshReflectorMaterial.tsx`、`CameraControls.tsx`
- `src/helpers/environment-assets.ts` 逐字引文：`dawn: 'kiara_1_dawn_1k.hdr',` `forest: 'forest_slope_1k.hdr',` `sunset: 'venice_sunset_1k.hdr',`。这些文件名来自 Poly Haven（一般为 CC0，本次未逐个核实），**生产环境应自托管 HDR**，不依赖 CDN
- three.js 原生 `examples/jsm/objects/Sky.js`（MIT）可在 vanilla three 中使用
- 风格化草地：James-Smyth/three-grass-demo（★98，MIT，2021 年后无更新），可抄 shader 思路；FarazzShaikh/THREE-CustomShaderMaterial（★1347，MIT）用于在标准 PBR 材质上注入风动顶点动画。**生产级草地方案本次没找到更强的开源实现，未核实**

### 3.5 镜头控制：camera-controls（MIT）
- ★2439，npm 3.1.2。`src/CameraControls.ts` 的方法签名逐字引文：
  > `setLookAt(` (L2086)、`lerpLookAt(` (L2238)、`fitToBox( box3OrObject: _THREE.Box3 | _THREE.Object3D, enableTransition: boolean, {` (L1919)、`dolly( distance: number, enableTransition: boolean = false ): Promise<void> {` (L1670)、`update( delta: number ): boolean {` (L2633)
- 定位：适合「用户拖拽预览 + 镜头间平滑过渡」，**不是时间线**。成片运镜应由 3.1 的关键帧驱动；camera-controls 只负责交互态，以及 `fitToBox` 这种自动取景（可用来给 LLM 的「全景/特写」枚举求解初始机位）

---

## 轴 4：预演产品（只学形态）
> 以下均为闭源商业产品，只学形态。功能描述来自公开资料和常识，**本次没有逐字核实官网**，统一标「未核实」。

| 产品 | 形态要点（未核实） | 对我方可借鉴 |
|---|---|---|
| Storyboarder Shot Generator | 见 1.2（已读源码）：扁平场景对象、相机 fov/tilt/roll、342 个姿势预设、IK 拖拽 | 姿势预设库 + 稀疏骨骼覆盖 |
| FrameForge | 真实镜头/机身参数（焦距、传感器）、俯视平面图与机位图、导出分镜 | `DirectorSequenceShot` 用「焦距 mm」而不是 fov 表达，更利于 LLM 理解 |
| Cascadeur | AutoPhysics：关键姿势 → 物理校正中间帧；AutoPosing 少量控制点驱动全身 | 我方「姿势关键帧 → 补间」可以加简易质心/落地约束（远期） |
| Unreal Sequencer + MetaHuman | Shot track / Camera Cut track / 每个 Actor 一组属性轨；Movie Render Queue 离线高质量出片 | 我方 IR 分为 Shot（剪辑）和 Track（属性）两级，与 Theatre sheet/sequence 对应 |
| Previs Pro | 移动端，按真实镜头参数摆机位并生成分镜 | 同 FrameForge |

---

## 轴 5：录制导出

### 5.1 ccapture.js v2.0.0（MIT）✅ 首选（浏览器端）
- ★3777；package.json：`"version": "2.0.0"`, `"license": "MIT"`；最近提交 2026-07-27（UTC，即北京时间 2026-07-28）
- 文件清单：`src/CCapture.js`、`src/TimeWarp.js`、`src/FrameWrap.js`、`src/MotionBlur.js`、`src/GPUMotionBlur.js`、`src/encoders/WebCodecsEncoder.js`、`src/third_party/mp4-muxer.mjs`
- 逐字引文（`src/CCapture.js`）：
  > `Composes a {@link FrameWrap} (canvas capture: motion blur + encoding) with a`
  > `{@link TimeWarp} (a virtual clock), and drives them together so a live`
  > `animation records as a smooth, fixed-framerate file.`
  > `const capturer = new CCapture({ format: "mp4", framerate: 60, timeLimit: 5 });`
- 逐字引文（`src/TimeWarp.js`，被 hook 的时钟）：
  > `- performance.now` / `- Date.now, Date.prototype.getTime (gated by \`hookDate\`)` / `- requestAnimationFrame / cancelAnimationFrame` / `- setTimeout / clearTimeout`
- 逐字引文（`src/encoders/WebCodecsEncoder.js`）：`avc: ["avc1.640034", "avc1.4d0034", "avc1.640028", "avc1.42e01f"],`（H.264 编码，不支持时回落到 av1）
- 意义：同一套实时播放代码，录制时自动变成「固定帧率 + 不掉帧 + 可选累积运动模糊」，与 Theatre 的 rafDriver 和 three 的 `clock` 都兼容（因为 hook 了 rAF 和 performance.now）

### 5.2 WebCodecs 自组装：mediabunny（MPL-2.0 ⚠️）
- mp4-muxer README 逐字引文：`mp4-muxer has been deprecated in favor of [Mediabunny](https://github.com/Vanilagy/mediabunny), which entirely supersedes it.`
- mediabunny README 示例逐字引文：`import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, Quality } from 'mediabunny';`、`const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: new Quality('high'), });`
- MPL-2.0：作为 npm 依赖、不修改其源码，SaaS 使用没有障碍；修改了其文件就需要公开那些文件。需要更多控制（如服务端拼音轨）时再考虑；默认 ccapture 已内置 mp4-muxer

### 5.3 服务端无头：puppeteer（Apache-2.0）✅
- ★95731。做法：headless Chrome（需要 GPU 或 SwiftShader/ANGLE）打开 `/render?seq=…` 页面 → 页面内用 ccapture 或逐帧 `sequence.position = i/fps` → `canvas.toBlob` 或 WebCodecs 编码，最后回传 mp4。无头 Chrome 的 WebGL/WebCodecs 硬件可用性依赖部署环境，**未实测**

### 5.4 Remotion — ⛔ 默认不用
- LICENSE.md 逐字引文：
  > `You are eligible to use Remotion for free if you are: ... a for-profit organization with up to 3 employees`
  > `It is not allowed to copy or modify Remotion code for the purpose of selling, renting, licensing, relicensing, or sublicensing your own derivate of Remotion.`
- `@remotion/three` 的帧驱动模式（`useCurrentFrame` 驱动 R3F）值得学形态；商用需要购买 Company License，不符合铁律

---

## 推荐拼装栈

| 层 | 选型 | 理由 | SaaS License |
|---|---|---|---|
| **编排层** | 我方 LLM → `DirectorSequenceShot`（语义 IR）。照抄 FilmAgent 形态：cameraMove/actions/特效**全闭集枚举**，加三层校验（zod schema → 未知项集合差 → 最近邻纠偏 `return_most_similar`），再加 review agent 检查镜头语法（如「Zoom 前接 Long」「打斗连续镜头 180° 轴线」） | 不让 LLM 写数值；可校验、可回放；FilmAgent 已验证 | FilmAgent MIT ✅（prompt 与逻辑可抄） |
| **动作层** | 主路线：Quaternius UAL1+UAL2（CC0）建「动作卡」库（时长、命中帧、root 位移、方向）+ CMU mocap 补充 → 加载与重定向用 three.js `SkeletonUtils.retargetClip`，或直接复用 pmndrs/viverse 的 `loadCharacterAnimation` 与 bone map（统一到 VRM humanoid）→ 混合用 `AnimationMixer.crossFadeTo`、additive 层、`timeScale` 慢动作 → 角色用 Quaternius CC0 角色或 three-vrm（MIT）的 VRM。远期：HY-Motion 离线生成、人工审核后入库（需法务确认地域与输出条款）；**不用 Mixamo / RPM** | 零 GPU 推理、延迟为 0、License 干净；连招分段天然适合拼接 | CC0 / MIT ✅；Mixamo ⚠️（中国区不可用，禁止分发原始文件）；RPM 已停服 ⛔；HY-Motion ⛔ |
| **镜头层** | 编译器：`cameraMove` 枚举 + 参数 → 数值关键帧 → **@theatre/core**（`BasicKeyframe` 贝塞尔 handles，`sequence.position` 确定性 seek，`rate` 做慢动作）；交互预览与自动取景用 camera-controls（`fitToBox`/`lerpLookAt`）。备选是零依赖的 three.js `AnimationClip` + 自写 easing | 丝滑的核心在贝塞尔缓动 + 确定性时间轴；Theatre core 是 Apache | @theatre/core、@theatre/r3f Apache-2.0 ✅；**@theatre/studio AGPL ⛔ 不打包**；camera-controls MIT ✅ |
| **渲染后期层** | pmndrs/postprocessing：Bloom/SelectiveBloom + DepthOfField + ToneMapping(ACES/AgX) + SMAA + Vignette + ChromaticAberration + ShockWave（大招）；n8ao 做 AO；粒子用 three.quarks（Trail 刀光、MeshSurfaceEmitter 气劲、JSON 预制件做「大招库」，用 Acta 式命中帧事件 `{name, at}` 触发）；天空、HDRI、阴影用 drei 的 Sky/Environment（自托管 HDR）/ContactShadows；运动模糊实时版选 realism-effects（需验证兼容）或 WebGPU TSL `motionBlur`，录制时用 ccapture 的累积模糊 | 都是成熟的 pmndrs 生态，R3F 与 vanilla 都能用 | Zlib / MIT / CC0 ✅ |
| **录制层** | 浏览器端 ccapture.js v2（TimeWarp 虚拟时钟 + WebCodecs H.264 mp4 + 运动模糊）；服务端批量用 puppeteer 无头打开同一渲染页（`sequence.position` 逐帧）；需要高级封装时用 mediabunny | 实时与录制同一份代码；固定帧率不掉帧 | ccapture MIT ✅；puppeteer Apache ✅；mediabunny MPL-2.0 ⚠️（仅作依赖）；Remotion ⛔ |

### 关键未核实 / 待验证
1. HY-Motion 单条推理延迟；它的输出物在中国境内的 SaaS 中使用是否合规（条款写的是 Territory 排除欧盟/英国/韩国，中国在 Territory 内，但 >1M MAU 需要另行授权），需要法务确认
2. AMASS/SMPL 条款原文（本次只读到 HumanML3D 的转述）
3. realism-effects MotionBlur 与 three r186 / postprocessing 6.39 的兼容性
4. three.quarks 能否任意时间 seek（录制时可能需要从 0 重放到目标帧）
5. three.js 示例里 Soldier/Xbot 的模型来源与 License
6. Poly Haven HDR 逐个文件的 License；Kenney 动画角色包的具体内容
7. 无头 Chrome 在我方部署环境下的 WebGL2/WebCodecs 可用性
8. 我方 `image-app` 是 R3F 还是 vanilla three：本次尝试只读访问用户机时，用户机离线，没能核对依赖

## 附：本次读取的 raw URL 清单
- https://raw.githubusercontent.com/HITsz-TMG/VideoClaw/main/LICENSE
- https://raw.githubusercontent.com/HITsz-TMG/VideoClaw/main/FilmAgent/FilmAgent/main.py
- https://raw.githubusercontent.com/HITsz-TMG/VideoClaw/main/FilmAgent/FilmAgent/Prompt/cinematographer.txt
- https://raw.githubusercontent.com/HITsz-TMG/VideoClaw/main/FilmAgent/FilmAgent/scripts/cot/4o/1/script.json
- https://raw.githubusercontent.com/HITsz-TMG/VideoClaw/main/FilmAgent/FilmAgent/Locations/Roadside/position.json
- https://raw.githubusercontent.com/wonderunit/storyboarder/master/build/license_en.txt
- https://raw.githubusercontent.com/wonderunit/storyboarder/master/README.md
- https://raw.githubusercontent.com/wonderunit/storyboarder/master/src/js/shared/reducers/shot-generator.js
- https://raw.githubusercontent.com/wonderunit/storyboarder/master/src/js/shot-generator/components/Three/Character.js
- https://raw.githubusercontent.com/wonderunit/storyboarder/master/src/js/shared/reducers/shot-generator-presets/poses.json
- https://raw.githubusercontent.com/robincourant/DIRECTOR/main/README.md
- https://raw.githubusercontent.com/Tencent-Hunyuan/HY-Motion-1.0/master/License.txt
- https://raw.githubusercontent.com/Tencent-Hunyuan/HY-Motion-1.0/master/README.md
- https://raw.githubusercontent.com/Tencent-Hunyuan/HY-Motion-1.0/master/hymotion/utils/smplh2woodfbx.py
- https://raw.githubusercontent.com/Tencent-Hunyuan/HY-Motion-1.0/master/hymotion/utils/t2m_runtime.py
- https://raw.githubusercontent.com/Tencent-Hunyuan/HY-Motion-1.0/master/scripts/gradio/templates/index_wooden_static.html
- https://raw.githubusercontent.com/GuyTevet/motion-diffusion-model/main/README.md
- https://raw.githubusercontent.com/EricGuo5513/momask-codes/main/README.md
- https://raw.githubusercontent.com/OpenMotionLab/MotionGPT/main/README.md
- https://raw.githubusercontent.com/EricGuo5513/HumanML3D/main/README.md
- https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/utils/SkeletonUtils.js
- https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/webgpu_animation_retargeting_readyplayer.html
- https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/webgl_animation_skinning_blending.html
- https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/RobotExpressive/README.md
- https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/tsl/display/MotionBlur.js
- https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/webgpu_postprocessing_motion_blur.html
- https://raw.githubusercontent.com/pmndrs/viverse/main/LICENSE
- https://raw.githubusercontent.com/pmndrs/viverse/main/packages/viverse/src/animation/index.ts
- https://raw.githubusercontent.com/pmndrs/viverse/main/packages/viverse/src/animation/mixamo-bone-map.ts
- https://raw.githubusercontent.com/pmndrs/viverse/main/packages/viverse/src/animation/bvh-bone-map.ts
- npm tarball `@drawcall/acta@0.1.43` 的 README.md（repo github.com/drawcall-ai/acta 返回 404）
- https://raw.githubusercontent.com/theatre-js/theatre/main/LICENSE 、packages/{core,studio,r3f,dataverse,react}/LICENSE 与 package.json
- https://raw.githubusercontent.com/theatre-js/theatre/main/packages/core/src/types/public.ts
- https://raw.githubusercontent.com/theatre-js/theatre/main/packages/core/src/types/private/core.ts
- https://raw.githubusercontent.com/theatre-js/theatre/main/packages/core/src/sequences/TheatreSequence.ts
- https://raw.githubusercontent.com/theatre-js/theatre/main/packages/core/src/sequences/interpolationTripleAtPosition.ts
- https://raw.githubusercontent.com/pmndrs/postprocessing/main/LICENSE.md （以及 `src/effects/` 目录树）
- https://raw.githubusercontent.com/Alchemist0823/three.quarks/master/packages/three.quarks/src/QuarksLoader.ts
- https://raw.githubusercontent.com/Alchemist0823/three.quarks/master/packages/three.quarks/src/QuarksUtil.ts
- https://raw.githubusercontent.com/Alchemist0823/three.quarks/master/packages/three.quarks/src/TrailBatch.ts
- https://raw.githubusercontent.com/pmndrs/drei/master/src/helpers/environment-assets.ts （以及 `src/core/` 目录树）
- https://raw.githubusercontent.com/yomotsu/camera-controls/dev/src/CameraControls.ts
- https://raw.githubusercontent.com/spite/ccapture.js/master/package.json
- https://raw.githubusercontent.com/spite/ccapture.js/master/src/CCapture.js
- https://raw.githubusercontent.com/spite/ccapture.js/master/src/TimeWarp.js
- https://raw.githubusercontent.com/spite/ccapture.js/master/src/encoders/WebCodecsEncoder.js
- https://raw.githubusercontent.com/Vanilagy/mp4-muxer/main/README.md
- https://raw.githubusercontent.com/Vanilagy/mediabunny/main/README.md
- https://raw.githubusercontent.com/remotion-dev/remotion/main/LICENSE.md
- 网页：https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html 、https://community.adobe.com/questions-696/mixamo-faq-licensing-royalties-ownership-eula-and-tos-589400 、https://quaternius.itch.io/universal-animation-library 、https://quaternius.itch.io/universal-animation-library-2 、https://readyplayer.me/ 、http://mocap.cs.cmu.edu/faqs.php
