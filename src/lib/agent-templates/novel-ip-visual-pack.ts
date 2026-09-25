import type { AgentTemplate } from "./types";

export const novelIpVisualPackCard: AgentTemplate = 
  {
    "id": "agent-novel-ip-visual-pack",
    "name": "IP视觉包",
    "harnessTemplateId": "novel_ip",
    "note": "网文 IP 全案视觉：世界观锚定→主角色卡→名场面组图→封面主视觉一条链出齐",
    "domain": "novel",
    "accent": "from-[#0F1B2D] via-[#1F3A5F] to-[#4A7C9B]",
    "glow": "#1F3A5F",
    "showcaseVideo": "/showcase/agent-templates/ip-pack-3.mp4",
    "showcaseImage": "/showcase/agent-templates/ip-pack-3.webp",
    "painPoint": "IP 立项要整套视觉物料，约稿拼凑一周，风格还各说各话",
    "pipeline": {
      "summary": "网文 IP 立项视觉全案：风格锚先行→角色资产→名场面组图→封面与多画幅",
      "steps": [
        {
          "name": "拆解世界观",
          "shortName": "世界观",
          "outputKind": "text"
        },
        {
          "name": "炼情绪板",
          "shortName": "情绪板"
        },
        {
          "name": "铸风格锚",
          "shortName": "风格锚"
        },
        {
          "name": "建主角资产",
          "shortName": "主角卡"
        },
        {
          "name": "绘名场面组图",
          "shortName": "名场面"
        },
        {
          "name": "造封面主视觉",
          "shortName": "封面"
        },
        {
          "name": "出多画幅",
          "shortName": "多画幅"
        },
        {
          "name": "铺衍生物料",
          "shortName": "物料"
        }
      ]
    }
  }
;
