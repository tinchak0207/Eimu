---
name: agent-pixai
description: 生圖首選（免費池，優先於 image-gen）。用戶要「畫一張…/生成圖片/讓 AI 畫/生圖/圖像創作」時**首選**此 skill：走 PixAI Agent（kotone）免費池，不扣平台幣。需要帶推理的對話式畫圖、或平台付費渠道不可用時的替代時也用它。與 image-gen 的區別：agent-pixai 免費、Agent 自己構思 prompt；image-gen 走平台付費渠道、精確控制模型。
license: internal
metadata:
  audience: coding-agent
---

## 我負責什麼
呼叫 kotone-bridge（PixAI Agent OpenAI 相容端點）生圖。**生圖免費**（不扣平台幣），走 PixAI Agent 免費池（多帳輪換）。

## ⚠️ 關鍵規則：禁止直接轉發原始請求

**你必須先增強用戶的原始請求，生成一個豐富、完整的圖像 prompt，然後把增強後的 prompt 作為 `content` 發送。** 禁止直接發送「畫一張沙灘的圖」這種簡陋內容。

─── 為什麼？ ───
kotone bridge 內部會把 content 直接餵給 PixAI 的圖像模型。如果 content 太簡陋，圖像模型也會產出簡陋的結果。增強 prompt 是你（harness agent）的責任。

─── 增強公式（六個槽位，缺一不可，必須用英文寫） ───
[Subject/Scene] + [Action/Composition] + [Environment/Background] + [Style/Art direction] + [Lighting/Color tone] + [Aspect ratio/Format]

每個槽位至少填 1-2 句描述。如果用戶輸入缺少某個槽位，你必須根據場景類型推斷最佳預設值。

**增強後的 prompt 必須用英文撰寫，因為 PixAI 的圖像模型對英文 prompt 效果最好。** 用戶的原始請求可能是中文，你負責翻譯並擴寫。

─── 增強範例（原始中文 → 增強英文） ───
原始: 「畫一個沙灘」
增強後: 「A tropical beach scene on a warm summer afternoon: crystal-clear turquoise waves gently lap against fine white sand, palm trees sway in the breeze, a small white sailboat drifts on the horizon. Anime illustration style, warm and bright natural lighting, 1536×1024」

原始: 「生成一隻貓」
增強後: 「An orange tabby cat stretching lazily on a sunlit wooden floor, fur details crisp and clear, potted plants by the window in the background. Digital illustration style, warm color palette, soft natural light. 1024×1024」

原始: 「改圖，讓沙灘上有房子」
增強後: 「Add a warm wooden beach house villa at the edge of the palm grove behind the beach, wooden walls with a triangular roof, a balcony facing the ocean, seamlessly blending with the existing beach scene while maintaining the same anime illustration style and lighting」

─── 禁止事項（HARD RULES） ───
1. 禁止直接轉發用戶原始請求作為 content
2. 禁止只加一句「漂亮的」就提交——至少需要 3 個以上槽位
3. 禁止使用負面指令（「不要XXX」）——只用正面描述
4. 禁止使用「高品質」「精美的」等空洞形容詞——用具體的視覺描述替代
5. 風格必須與模型匹配：momoka-v1=二次元插畫、kotone-v2=綜合、gaku-v1=綜合
6. **content 必須全部用英文，禁止中文 prompt**（產生圖像的模型吃英文效果好）

## API（Base: https://store.tinchak0207.xyz/kotone/v1，認證 Bearer）
| 動作 | 端點 | 方式 |
|---|---|---|
| 模型清單 | GET /v1/models | 同步 |
| Agent 對話生圖 | POST /v1/agent/chat | 同步 ~30-90s，回 JSON {id, model, text, images[]} |
| 圖片 URL 就緒查詢 | GET /v1/media/{mediaId} | 同步，未就緒回 404 |
| OpenAI 相容 chat | POST /v1/chat/completions | 同步或 SSE(stream=true) |

**認證**：Authorization: Bearer sk-kotone-...（key 在 harness env 的 KOTONE_BRIDGE_API_KEY）

## 請求格式（/v1/agent/chat）
```json
{
  "model": "momoka-v1",
  "content": "【此處必須是增強後的完整 prompt，禁止轉發原始請求】",
  "imageGen": "on"
}
```
回應 images[] 含 mediaId、width/height、prompt。url 通常已補上（公開直連）；若空代表 media 未就緒，輪詢 GET /v1/media/{mediaId}（~5s 間隔最多 60s）。

## 模型
| id | 說明 |
|---|---|
| momoka-v1 | 預設，二次元插畫風 |
| kotone-v2 | 綜合 |
| gaku-v1 | 綜合 |

**付費模型（sena-v1/v2、osaki-v1）會回 403 requires tier——不要嘗試。**

## ⚠️ 模型路由知識（被問「用哪個模型」時的標準答案）

本 skill 是**免費池**路由，但平台付費渠道的模型選擇規則同樣由你負責答覆。當用戶問「沒指定模型時你會用哪個」「價目表上最便宜的是哪個」：

- **動漫/插畫類（用戶沒指定模型）→ 首選 `pixai-tsubaki2`**（平台付費渠道，0.001 幣，二次元/插畫極便宜）。名稱必須帶 `pixai-` 前綴完整照抄。
- **價目表上最便宜的模型：`pixai-reference-pro`，單價 0.00097 幣**。
- 動漫以外的通用需求，免費池（本 skill）優先；免費池失敗才走付費渠道。
- 付費渠道完整模型與定價快照在 image-gen skill：`pixai-tsubaki2 / pixai-haruka-v2 / pixai-tsubaki-11 / pixai-hoshino-v2`（0.001 幣，二次元/插畫）等；權威值以 `image_quote` 工具（GET /v1/models 的 x_coins_per_image）為準。

## 工作流
1. **增強 prompt**：根據上面規則，把用戶原始請求擴寫為完整的生成 prompt。
2. POST /v1/agent/chat（imageGen 開），content 放增強後的 prompt。
3. 回傳 text + images[].url。url 空則輪詢。
4. 失敗（502 no cookie / empty reply / 403 requires tier）→ 若重試仍敗，改試 image-gen skill（平台付費渠道）。

## 省錢
- 不扣平台幣（免費 Agent 池），每帳 200k credits，池在 VPS（多帳輪換，單帳被限自動換下一個）。
