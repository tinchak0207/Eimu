#!/usr/bin/env python3
# 更新 workflow-director SKILL.md：加入 shot JSON 結構化影片提示詞段落。
# 冪等：已含 "shot JSON" 標記則跳過。
import sys

PATH = "/opt/agent-harness/workspace/.opencode/skills/workflow-director/SKILL.md"

SHOT_SECTION = """
## 影片提示詞：優先填 shot JSON（2026-08-21 起，後端強制支持）

**任何 video 節點的提示詞，優先用結構化 shot JSON 而不是散文 prompt。** 你填 JSON，gateway 按模型族（veo/kling/runway/luma/seedance）自動編譯成該模型最愛吃的格式（Veo 吃原生 JSON、Kling 吃時間軸 beat 模板、Runway 吃精確 camera token、Luma 吃攝影機短語）。散文會原樣透傳、不做任何優化。

### schema（subject/action 必填，其餘可選）

```json
{
  "subject": "主體（誰/什麼）",
  "appearance": "外觀、服裝、材質",
  "action": "按 beat 的動作：具體計數與計時（'走了三步後回頭'），不要模糊形容詞",
  "camera": { "shot_type": "close-up | medium shot | wide establishing | aerial", "angle": "low angle | eye level | high angle", "movement": "dolly in | pan left | tracking | crane up | handheld | static", "lens": "35mm anamorphic, shallow DOF" },
  "environment": { "time_of_day": "golden hour | dusk | morning", "lighting": "soft window light, 45° key right", "elements": ["neon signs", "wet asphalt", "puddles"] },
  "style": { "look": "cinematic | documentary | UGC phone camera", "mood": "tense | warm | melancholic", "color_grading": "teal and orange" },
  "audio": { "dialogue": [{ "character": "偵探", "tone": "weary", "line": "我不相信巧合。" }], "ambience": "room tone, distant traffic", "sfx": ["footsteps", "door creak"] },
  "output": { "duration_seconds": 5, "aspect_ratio": "16:9" }
}
```

### 怎麼填

- **模板路徑**（workflow_start content）：text 角色（shot/character/scene）可直接給 `shot: { ...上述 schema... }`（與 content 二選一，shot 優先）。
- **自訂路徑**（workflow_add_node）：text 或 video 節點 metadata 加 `shot: { ... }`；也可以把 JSON 字串直接放 content，後端能解析。
- **規則**：一鏡一機位運動 + 一主體動作；對話每行 ≤5 秒；不要寫否定句（描述存在什麼，不是沒有什麼）；negative 數組不會進正文（平台無此欄位）。
- **填錯會被 400 擋下**：缺 subject/action 時錯誤訊息帶完整 schema，補齊重試即可。

### 何時仍用散文

靜態描述節點（角色描述、場景描述、故事腳本）不需要鏡頭語言——照舊填 content 字串。**只有會變成影片的鏡頭節點用 shot JSON。**
"""

with open(PATH, "r", encoding="utf-8") as f:
    content = f.read()

if "shot JSON" in content:
    print("SKIP: already patched")
    sys.exit(0)

# 插在「## 標準流程：自訂工作流（無模板）」段落之前
anchor = "## 標準流程：自訂工作流（無模板）"
if anchor not in content:
    print("FAIL: anchor not found")
    sys.exit(1)

content = content.replace(anchor, SHOT_SECTION.strip() + "\n\n" + anchor, 1)
with open(PATH, "w", encoding="utf-8") as f:
    f.write(content)
print("PATCHED OK")
