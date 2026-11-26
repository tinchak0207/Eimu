import type { AgentTemplate } from "./types";

export const ecommerceLaunchPackCard: AgentTemplate = 
  {
    "id": "agent-ecommerce-launch-pack",
    "name": "新品上市包",
    "harnessTemplateId": "ecom_launch",
    "note": "新品素材流水线：产品锁→场景图→模特图→主视觉→多画幅批量，一次锁定全线一致",
    "domain": "ecommerce",
    "accent": "from-[#3D2314] via-[#8C5A3B] to-[#E8A87C]",
    "glow": "#8C5A3B",
    "showcaseVideo": "/showcase/agent-templates/ecom-launch-2.mp4",
    "showcaseImage": "/showcase/agent-templates/ecom-launch-2.webp",
    "painPoint": "一套上市素材散做几十张，商品形变和风格漂移改到崩溃",
    "pipeline": {
      "summary": "白底产品锁→场景组→模特图→英雄主视觉→多画幅多 SKU 批量的电商素材流水线",
      "steps": [
        {
          "name": "锁产品",
          "shortName": "产品卡"
        },
        {
          "name": "铺场景包",
          "shortName": "场景包"
        },
        {
          "name": "出模特图",
          "shortName": "模特图"
        },
        {
          "name": "出主视觉",
          "shortName": "主视觉"
        },
        {
          "name": "排详情页",
          "shortName": "详情页"
        },
        {
          "name": "批量出画幅",
          "shortName": "画幅"
        },
        {
          "name": "放大精修",
          "shortName": "精修"
        },
        {
          "name": "审终交付",
          "shortName": "交付",
          "outputKind": "text"
        }
      ]
    }
  }
;
