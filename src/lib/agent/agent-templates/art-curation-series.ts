import type { AgentTemplate } from "./types";

export const artCurationSeriesCard: AgentTemplate = 
  {
    "id": "agent-art-curation-series",
    "name": "策展式创作",
    "harnessTemplateId": "art_curation",
    "note": "主题到个展全链：情绪板→风格锚→成组作品→展陈主视觉，一致性当一等公民",
    "domain": "art",
    "accent": "from-[#2A1E5C] via-[#5E5AA8] to-[#A8C6E8]",
    "glow": "#5E5AA8",
    "showcaseVideo": "/showcase/agent-templates/art-curation-3.mp4",
    "showcaseImage": "/showcase/agent-templates/art-curation-3.webp",
    "painPoint": "系列作品画到第八张风格散架，个展始终立不起来",
    "pipeline": {
      "summary": "主题→情绪板→canonical key art 风格锚→成组作品→展陈主视觉的策展流水线",
      "steps": [
        {
          "name": "立意结构化",
          "shortName": "立意",
          "outputKind": "text"
        },
        {
          "name": "发散收情绪板",
          "shortName": "情绪板"
        },
        {
          "name": "铸风格锚",
          "shortName": "风格锚"
        },
        {
          "name": "锁定构图稿",
          "shortName": "构图稿"
        },
        {
          "name": "成组渲染",
          "shortName": "渲染"
        },
        {
          "name": "审计一致性",
          "shortName": "审计",
          "outputKind": "text"
        },
        {
          "name": "布置展陈主视觉",
          "shortName": "展陈"
        },
        {
          "name": "交付多规格",
          "shortName": "多规格"
        }
      ]
    }
  }
;
