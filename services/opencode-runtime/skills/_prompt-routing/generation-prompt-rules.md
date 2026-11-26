# 生成 prompt 硬规则全文（按需；Expert／skill 载）

## 2I. 生成 prompt 硬规则 — 图片

1. **先增强再发送**：禁止把用户原始一句话直接当 prompt，你负责扩写成完整 prompt。
2. **六槽公式（仅图片）**：[Subject] + [Action/Composition] + [Setting/Environment] + [Style/Art Direction] + [Lighting/Color] + [Format/Aspect Ratio]，缺哪补哪槽。
3. **style／prompt 一律英文**（歌词语言例外见 §0）。
4. **正向语言**：模型把每个 token 当正向指令，写「什么是真的」，禁负面句（no/不/without）。
5. **age-blind**：永不写年龄（boy/girl/child/teen），用角色、服装、动作描述。
6. **Anti-Slop**：cinematic/epic/beautiful/high quality 是空词，换具名规格（golden-hour backlight / anamorphic 2.39:1 focus / oil-painting impasto texture）。
7. **情绪用肌肉**：不写 "she looks scared"，写 "jaw clenches, nostrils flare, shallow breath"。
8. **IP 安全**：不写版权角色名（Lü Bu 是历史人物可写；Hulk 是版权，改用视觉特征）。

**范例**：「画一个沙滩」→ "A tropical beach on a warm summer afternoon: crystal-clear turquoise waves gently lap fine white sand, palm trees sway in the breeze, a small white sailboat on the horizon. Anime illustration style, warm bright natural light, 1536x1024."

## 2V. 生成 prompt 硬规则 — 影片（状态变化合同）

1. **禁止把六槽当影片模板**。影片用「状态变化合同」：起态 → 动作 beat 1..N（带秒点与因果）→ 终态；每个镜头至少一次可见状态变化。
2. **动作必须是物理动词**：动词 + 身体机制 + 对象/环境交互（例：左脚踏前、重心压低、肩部带动刀锋从右上向左下劈落、刀刃击中盾面）；禁止只写「人物站立／看向镜头／缓慢抬头」这类静态描述。
3. **每个场景至少一次环境变化**：人群逼近、花瓣爆散、门被撞开、光位变化、尘土扬起等；禁止写 "environment stays identical"。
4. **机位是动作的结果**：一镜一主运动（推／拉／摇／移／跟／升降／手持），由动作与因果关系决定；禁止全片统一慢推。
5. **影片 prompt 禁用词**：stable composition / subject locked / arrangement holds / environment identical / identity locked through the whole shot。
6. **首帧不是默认条件**：动作镜头优先 T2V、3D 预演或首尾差异大的关键帧；需要人物一致性时才用参考图，但不让参考图锁死构图。
7. **音讯槽**：环境音 + 动作音效 + 音乐（模型支持时）。

## 9. 音讯

1. **音讯**：影片要声音时 prompt 加音讯槽（对白/环境音/音乐风格）+ generate_audio=true；规格查 specs/AUDIO-MODEL-SPECS.md。
