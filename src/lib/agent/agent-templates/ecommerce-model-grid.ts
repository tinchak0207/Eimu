import type { AgentTemplate } from "./types";

export const ecommerceModelGridCard: AgentTemplate = 
  {
    "id": "agent-ecommerce-model-grid",
    "name": "模特种草线",
    "harnessTemplateId": "ecom_model",
    "note": "平铺图到种草图流水线：服装提取→虚拟试穿→一致性网格→详情页排版",
    "domain": "ecommerce",
    "accent": "from-[#0E3B2E] via-[#2E7D64] to-[#9BD4B4]",
    "glow": "#2E7D64",
    "showcaseVideo": "/showcase/agent-templates/ecom-model-2.mp4",
    "showcaseImage": "/showcase/agent-templates/ecom-model-2.webp",
    "painPoint": "模特档期贵难约，一套种草图等两周还接不上详情页",
    "pipeline": {
      "summary": "服装平铺提取→AI 试穿→一致性网格→详情页排版四段式流水线",
      "steps": [
        {
          "name": "抠取服装资产",
          "shortName": "服装"
        },
        {
          "name": "选定模特人设",
          "shortName": "模特卡"
        },
        {
          "name": "上身虚拟试穿",
          "shortName": "试穿"
        },
        {
          "name": "精修试穿质感",
          "shortName": "质感"
        },
        {
          "name": "拍齐九宫格",
          "shortName": "九宫格"
        },
        {
          "name": "排版详情页",
          "shortName": "详情页"
        },
        {
          "name": "适配分发尺寸",
          "shortName": "分发"
        }
      ]
    }
  }
;
