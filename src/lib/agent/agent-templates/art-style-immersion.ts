import type { AgentTemplate } from "./types";

export const artStyleImmersionCard: AgentTemplate = 
  {
    "id": "agent-art-style-immersion",
    "name": "风格深研线",
    "harnessTemplateId": "art_style",
    "note": "艺术家风格深度内化流水线：解构→临摹对拍→变体矩阵→原创成组",
    "domain": "art",
    "accent": "from-[#4A3728] via-[#9C7A5B] to-[#E3C9A8]",
    "glow": "#9C7A5B",
    "showcaseVideo": "/showcase/agent-templates/art-style-2.mp4",
    "showcaseImage": "/showcase/agent-templates/art-style-2.webp",
    "painPoint": "风格迁移只学到滤镜皮，学不到艺术家观察世界的方式",
    "pipeline": {
      "summary": "风格解构→临摹对拍→变体矩阵→原创成组的风格内化流水线",
      "steps": [
        {
          "name": "采代表作",
          "shortName": "代表作"
        },
        {
          "name": "拆DNA",
          "shortName": "DNA"
        },
        {
          "name": "签解构表",
          "shortName": "解构表"
        },
        {
          "name": "拍临摹对照",
          "shortName": "临摹"
        },
        {
          "name": "跑变体矩阵",
          "shortName": "变体"
        },
        {
          "name": "试LoRA",
          "shortName": "LoRA",
          "outputKind": "text"
        },
        {
          "name": "做原创成组",
          "shortName": "原创"
        },
        {
          "name": "归档证物链",
          "shortName": "证物链"
        }
      ]
    }
  }
;
