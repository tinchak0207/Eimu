# H3 Content IR

H3 吃的不是口语摘要。官方托管预处理器叫 H3-Context-IR，不在开源权重里。自建替代就是下面这次改写：先判定素材和成片的关系，再写成固定栏目。栏目名、顺序、标签、时码按这里写，不要翻译字段名。

整段 prompt ≤ 4000 字符。正文用英文。对白、歌词、画面里看得见的字保持原文。

提交给 minimax-h3 的字符串就是这份改写。平台认出这三栏或六栏后，不再追加六槽、运动合同或同形词替换。

## 先选模式

| 模式 | 什么时候 | 成片结构 |
|---|---|---|
| T2VA | 没有参考图 | 直接三栏 |
| I2VA | 一张图是 0.00 秒的真实首帧 | 首帧指令 + 三栏 |
| FL2VA | 图 1 是开头、图 2 是结尾，中间要连续走过去 | 首尾对齐指令 + 三栏。默认单镜头 |
| L2VA | 只有一张图，而且是结尾，不是开头 | 尾帧对齐指令 + 三栏 |
| Ref2VA | 图/视频/音频提供人物、服装、场景、风格、动作、运镜或声音，但不是成片里的某一帧 | 六栏。不要写成首尾帧 |

多张角色图、场景图、风格图不是 FL2VA。把第二张图写成结尾帧，模型会在两张身份之间插值。参考图存在不等于首尾硬锁。只有用户明确要锁首帧、尾帧或首尾时，才用 I2VA / L2VA / FL2VA。

## 关键帧三栏

字段顺序固定，中间空一行：

```text
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

指令行（有则放最前，再空一行）：

- I2VA：`For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`
- FL2VA：`How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.`
- L2VA：`How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.`

`N` 是最后一镜的镜号。`S.SS` 是片长，正好两位小数，并且等于本次 `duration_seconds`。

### 时间线里写什么

`[Shot 1]` 开头写风格和初始构图，不要先写剧情梗概。风格用具体类：`live-action`、`cinematic`、`2D-animated`、`3D CG`、`claymation`、`watercolor`、`vintage film`。有参考图就从图像出风格，不要另起一套。

镜头路径：

- I2VA：首帧锚点（身份、衣服、颜色、关键物、空间关系保持）→ 动作开始 → 连续发展 → 结果
- FL2VA：首帧状态 → 看得见的中间变化 → 差异逐渐收束 → 末帧状态。不要把两张图各描述一遍
- L2VA：合理的更早状态 → 明确动作 → 最后一镜逐渐落到参考图的姿势、构图、光线

切镜才新开镜头。第一镜不加时码。后面每镜：`[Shot 2] At 00:03.500, the camera cuts to ...`。时码严格递增，落在片长以内。只改景别或小角度时用运镜，不要切。

运镜写成句中的动作，三项里有意义的才写：类型、幅度（`with small amplitude` / `with large amplitude`）、速度（`at slow speed` / `at fast speed`）。中等幅度和常速省略。类型用这些词，不要堆同义词：

`Zoom In/Out`（机位不动，焦距变）、`Push In` / `Pull Out`（机位前后）、`Pan Left/Right`、`Truck Left/Right`、`Tilt Up/Down`、`Pedestal Up/Down`、`Arc Shot`、`Tracking Shot`、`Static Shot`、`Shake Slightly/Strongly`、`POV`、`Roll Clockwise/Counterclockwise`。

例：`The camera pushes in with small amplitude at slow speed toward the folded letter.`

说话的人给稳定编号 `(S1)` `(S2)`，跨镜不换号。不说话的人不编号。身份（谁、在不在画内、音高、音色、语速）写在 `<d>` 外面。`<d>` 里面只有语言标签和用户原文，不翻译、不改词：

`The young woman with a quiet, breathy voice (S1) says: <d>[Chinese] 下一站下车。</d>`

画外音用 `says in an off-screen voiceover`，紧接着写对应角色嘴唇保持闭合。对白跨切点时两边都标明声音不断。画面上的招牌、字幕、霓虹用英文双引号包原文，不翻译。

`overall_soundscape`：1 到 4 句，只写环境声、肢体声、非语言人声（风、雨、脚步、呼吸）。对白、唱歌、角色听得见的音乐不要重复到这里。只有用户明确要求全片无声才写 `N/A`。禁止用 “natural ambience consistent with the scene” 这类空句。

`non_diegetic_music`：1 到 3 句，只写观众听得见、角色听不见的配乐。写乐器、速度、节奏、强弱变化。不写情绪功能，不用 cinematic / beautiful。没有就 `N/A`。角色听得见的收音机、手机、现场乐器写进时间线，不写进这一栏。

## Ref2VA 六栏

参考素材不是具体帧时用这个，顺序固定：

```text
subject_definitions:
<Subject 1> is the woman in <Picture 1>, with the features that must stay.

summary:
[reference generation] ...

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - ...

detailed_description:
<style, one or two sentences>
[Shot 1] ...

overall_soundscape:
...

non_diegetic_music:
...
```

标签一旦赋义，六栏里含义不变，后面不许新造标签。

- `<Subject N>`：会被用到的可见内容（人、动物、物、场景、服装、界面、风格、动作、姿态）。一个主体可以来自多份素材。只用来认人的图，写进 Subject，不要再单列 Picture。
- `<Picture N>`：这张图本身是某一镜的首帧、关键帧、尾帧或分镜锚点时才单列。
- `<Video N>`：整段视频关系（被剪、被续、提供剪辑节奏）。视频里的人仍是 Subject。
- `<Audio N>`：单独音轨，或明确启用的参考视频同步声。普通参考视频自带声音，不会自动变成 Audio。编号和 Video 各自计数，不表示配对。

`summary` 用一个英文短段，开头是任务类型，可组合且不重复：`keyframe completion`、`reference generation`、`video editing`、`video continuation`、`audio reuse`、`audio reference`。视频只提供运镜或节奏时是 `reference generation`，不是 `video editing`。

`retention_analysis` 每个标签一行。画面用 `fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`。音频用 `fully_copy` / `partially_copy` / `reference` / `weak_reference`。标记必须和 subject_definitions 里的角色一致。成片里新加的动作不算「没保住参考」。

`detailed_description` 按播放顺序写，风格句放在 `[Shot 1]` 之前。主体第一次出现时写清被参考的特征和当前动作，之后只用同一标签。帧锚点用 `the shot begins from <Picture 1>`、`the shot ends on <Picture 3>`。说话的主体写成 `<Subject 2> (S1)`。`(S1)` 按成片里真实发声的顺序编号，retention_analysis 里不写说话人编号。听不清写 `[unclear]`，不要猜词。生成类成片这段通常 350 到 500 个英文词；对白密的片子以说完为准，不为字数注水。

声音栏的分工和三栏相同。参考音频的复制或参照关系，写在它实际响起的那一栏。

完整例子在 `upstream/h3-prompt-writing/references/base-en.txt` 与 `ref-en.txt`。

## 提交前核对

- 模式和素材角色一致：身份图没有被写成首尾帧。
- 字段名、顺序、`<Picture N>` / `<Subject N>` / `<d>` / `(S1)` 和指南一致。
- 片长、切点、首尾对齐秒数是同一个 duration。
- 每个镜头有看得见的状态变化，运镜没有代替主体动作。
- 对白在 `<d>` 里且是原文；soundscape 没有把对白再抄一遍。
- 没有调用 `hub_generate_video`、`hub_generate_image` 或任何 Hub 画布节点。
