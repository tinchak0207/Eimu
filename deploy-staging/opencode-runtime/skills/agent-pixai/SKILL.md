---
name: agent-pixai
description: 生图首选（免费池，优先于 image-gen）。用户要「画一张…/生成图片/让 AI 画/生图/图像创作」时**首选**此 skill：走 PixAI Agent（kotone）免费池，不扣平台币。需要带推理的对话式画图、或平台付费渠道不可用时的替代时也用它。与 image-gen 的区别：agent-pixai 免费、Agent 自己构思 prompt；image-gen 走平台付费渠道、精确控制模型。
license: internal
metadata:
  audience: coding-agent
---

## 我负责什么
呼叫 kotone-bridge（PixAI Agent OpenAI 相容端点）生图。**生图免费**（不扣平台币），走 PixAI Agent 免费池（多帐轮换）。

## ⚠️ 关键规则：禁止直接转发原始请求

**你必须先增强用户的原始请求，生成一个丰富、完整的图像 prompt，然后把增强后的 prompt 作为 `content` 发送。** 禁止直接发送「画一张沙滩的图」这种简陋内容。

─── 为什么？ ───
kotone bridge 内部会把 content 直接喂给 PixAI 的图像模型。如果 content 太简陋，图像模型也会产出简陋的结果。增强 prompt 是你（harness agent）的责任。

─── 增强公式（六个槽位，缺一不可，必须用英文写） ───
[Subject/Scene] + [Action/Composition] + [Environment/Background] + [Style/Art direction] + [Lighting/Color tone] + [Aspect ratio/Format]

每个槽位至少填 1-2 句描述。如果用户输入缺少某个槽位，你必须根据场景类型推断最佳预设值。

**增强后的 prompt 必须用英文撰写，因为 PixAI 的图像模型对英文 prompt 效果最好。** 用户的原始请求可能是中文，你负责翻译并扩写。

─── 增强范例（原始中文 → 增强英文） ───
原始: 「画一个沙滩」
增强后: 「A tropical beach scene on a warm summer afternoon: crystal-clear turquoise waves gently lap against fine white sand, palm trees sway in the breeze, a small white sailboat drifts on the horizon. Anime illustration style, warm and bright natural lighting, 1536×1024」

原始: 「生成一只猫」
增强后: 「An orange tabby cat stretching lazily on a sunlit wooden floor, fur details crisp and clear, potted plants by the window in the background. Digital illustration style, warm color palette, soft natural light. 1024×1024」

原始: 「改图，让沙滩上有房子」
增强后: 「Add a warm wooden beach house villa at the edge of the palm grove behind the beach, wooden walls with a triangular roof, a balcony facing the ocean, seamlessly blending with the existing beach scene while maintaining the same anime illustration style and lighting」

─── 禁止事项（HARD RULES） ───
1. 禁止直接转发用户原始请求作为 content
2. 禁止只加一句「漂亮的」就提交——至少需要 3 个以上槽位
3. 禁止使用负面指令（「不要XXX」）——只用正面描述
4. 禁止使用「高品质」「精美的」等空洞形容词——用具体的视觉描述替代
5. 风格必须与模型匹配：momoka-v1=二次元插画、kotone-v2=综合、gaku-v1=综合
6. **content 必须全部用英文，禁止中文 prompt**（产生图像的模型吃英文效果好）

## API（Base: https://store.eimu.dev/kotone/v1，认证 Bearer）
| 动作 | 端点 | 方式 |
|---|---|---|
| 模型清单 | GET /v1/models | 同步 |
| Agent 对话生图 | POST /v1/agent/chat | 同步 ~30-90s，回 JSON {id, model, text, images[]} |
| 图片 URL 就绪查询 | GET /v1/media/{mediaId} | 同步，未就绪回 404 |
| OpenAI 相容 chat | POST /v1/chat/completions | 同步或 SSE(stream=true) |

**认证**：Authorization: Bearer sk-kotone-...（key 在 harness env 的 KOTONE_BRIDGE_API_KEY）

## 请求格式（/v1/agent/chat）
```json
{
  "model": "momoka-v1",
  "content": "【此处必须是增强后的完整 prompt，禁止转发原始请求】",
  "imageGen": "on"
}
```
回应 images[] 含 mediaId、width/height、prompt。url 通常已补上（公开直连）；若空代表 media 未就绪，轮询 GET /v1/media/{mediaId}（~5s 间隔最多 60s）。

## 模型
| id | 说明 |
|---|---|
| momoka-v1 | 预设，二次元插画风 |
| kotone-v2 | 综合 |
| gaku-v1 | 综合 |

**付费模型（sena-v1/v2、osaki-v1）会回 403 requires tier——不要尝试。**

## ⚠️ 模型路由知识（被问「用哪个模型」时的标准答案）

本 skill 是**免费池**路由，但平台付费渠道的模型选择规则同样由你负责答覆。当用户问「没指定模型时你会用哪个」「价目表上最便宜的是哪个」：

- **动漫/插画类（用户没指定模型）→ 首选 `pixai-tsubaki2`**（平台付费渠道，0.001 币，二次元/插画极便宜）。名称必须带 `pixai-` 前缀完整照抄。
- **价目表上最便宜的模型：`pixai-reference-pro`，单价 0.00097 币**。
- 动漫以外的通用需求，免费池（本 skill）优先；免费池失败才走付费渠道。
- 付费渠道完整模型与定价快照在 image-gen skill：`pixai-tsubaki2 / pixai-haruka-v2 / pixai-tsubaki-11 / pixai-hoshino-v2`（0.001 币，二次元/插画）等；权威值以 `image_quote` 工具（GET /v1/models 的 x_coins_per_image）为准。

## 工作流
1. **增强 prompt**：根据上面规则，把用户原始请求扩写为完整的生成 prompt。
2. POST /v1/agent/chat（imageGen 开），content 放增强后的 prompt。
3. 回传 text + images[].url。url 空则轮询。
4. 失败（502 no cookie / empty reply / 403 requires tier）→ 若重试仍败，改试 image-gen skill（平台付费渠道）。

## 省钱
- 不扣平台币（免费 Agent 池），每帐 200k credits，池在 VPS（多帐轮换，单帐被限自动换下一个）。
