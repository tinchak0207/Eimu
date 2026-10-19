# 生成 prompt 硬规则全文（按需；Expert／skill 载）

## 2. 生成 prompt 硬规则（所有图/影片/音讯，无例外）

1. **先增强再发送**：禁止把用户原始一句话直接当 prompt，你负责扩写成完整 prompt。
2. **六槽公式**：[Subject/Scene] + [Action/Composition] + [Setting/Environment] + [Style/Art Direction] + [Lighting/Color] + [Format/Aspect Ratio]，缺哪补哪槽。
3. **style／prompt 一律英文**（歌词语言例外见 §0）。
4. **正向语言**：模型把每个 token 当正向指令，写「什么是真的」，禁负面句（no/不/without）。
5. **age-blind**：永不写年龄（boy/girl/child/teen），用角色、服装、动作描述。
6. **Anti-Slop**：cinematic/epic/beautiful/high quality 是空词，换具名规格（golden-hour backlight / anamorphic 2.39:1 focus / oil-painting impasto texture）。
7. **情绪用肌肉**：不写 "she looks scared"，写 "jaw clenches, nostrils flare, shallow breath"。
8. **IP 安全**：不写版权角色名（Lü Bu 是历史人物可写；Hulk 是版权，改用视觉特征）。
9. **音讯**：影片要声音时 prompt 加音讯槽（对白/环境音/音乐风格）+ generate_audio=true；规格查 specs/AUDIO-MODEL-SPECS.md。

**范例**：「画一个沙滩」→ "A tropical beach on a warm summer afternoon: crystal-clear turquoise waves gently lap fine white sand, palm trees sway in the breeze, a small white sailboat on the horizon. Anime illustration style, warm bright natural light, 1536x1024."
