import type { AgentTemplate } from "./types";

export const shortdramaPosterLineCard: AgentTemplate = 
  {
    "id": "agent-shortdrama-poster-line",
    "name": "投放海报线",
    "harnessTemplateId": "shortdrama_poster",
    "note": "短剧投放物料流水线：剧设锚定→主演海报→CP对戏图→信息流切片封面批量",
    "domain": "shortdrama",
    "accent": "from-[#0D1B3E] via-[#2E3A8C] to-[#7E6BD9]",
    "glow": "#2E3A8C",
    "showcaseVideo": "/showcase/agent-templates/drama-poster-2.mp4",
    "showcaseImage": "/showcase/agent-templates/drama-poster-2.webp",
    "painPoint": "投放封面靠从成片截图截到崩，一套物料跟不上日更投放",
    "pipeline": {
      "summary": "剧设视觉锚→主演海报→CP 对戏→信息流切片封面批量的投放物料链",
      "steps": [
        {
          "name": "锚定视觉基调",
          "shortName": "基调"
        },
        {
          "name": "提炼主演海报",
          "shortName": "海报"
        },
        {
          "name": "排布CP对戏图",
          "shortName": "对戏"
        },
        {
          "name": "切片封面批量",
          "shortName": "切片"
        },
        {
          "name": "生成变体测试包",
          "shortName": "变体"
        },
        {
          "name": "回流迭代风格",
          "shortName": "迭代",
          "outputKind": "text"
        },
        {
          "name": "锁定交付参数",
          "shortName": "参数"
        }
      ]
    }
  }
;
